/**
 * Retention engine: attribution, cohort aggregation and incremental recompute.
 *
 * One cache state is kept per report configuration. When the event store
 * advances, only users touched by the new revisions are re-summarised and only
 * the cohort days those users belong to are re-aggregated. The report returns
 * exactly which cohorts were recomputed so the UI can show the cost.
 */

import {
  CONVENTION_LABELS,
  addDaysToKey,
  dayOffsetOf,
  keyRange,
  localDateKey,
  normalizeConvention,
  resolveZones,
  slotEnd,
  slotLength,
  slotStart,
} from './retention.js';
import {
  UNITS,
  formatOffset,
  isValidDateKey,
  offsetMsAt,
  transitionsForDays,
  weekdayOfKey,
} from './time.js';

const { DAY_MS, HOUR_MS } = UNITS;

export const DIMENSIONS = ['plan', 'platform', 'region', 'appVersion', 'cohortSource'];
const DEFAULT_ACTIVITY = ['signup', 'app_open', 'purchase'];
const REPORT_CACHE_LIMIT = 40;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function canonical(parent, id) {
  if (!parent.has(id)) return id;
  let root = id;
  let guard = 0;
  while (parent.get(root) !== root && guard < 10_000) {
    root = parent.get(root);
    guard += 1;
  }
  return root;
}

function normalizeSegments(segments) {
  const out = {};
  if (!segments || typeof segments !== 'object') return out;
  for (const dim of DIMENSIONS) {
    const v = segments[dim];
    if (v === undefined || v === null || v === '' || v === 'all') continue;
    out[dim] = Array.isArray(v) ? v.map(String).sort() : [String(v)];
  }
  return out;
}

export function matchesSegments(props, segments) {
  for (const [dim, allowed] of Object.entries(segments)) {
    const value = props?.[dim] ?? 'unknown';
    if (!allowed.includes(String(value))) return false;
  }
  return true;
}

function defaultConfig(store) {
  const today = localDateKey(store.now, 'America/New_York');
  return {
    convention: 'calendar',
    reportingZone: 'UTC',
    businessZone: 'America/New_York',
    from: addDaysToKey(today, -75),
    to: today,
    days: 14,
    segments: {},
    latePolicy: 'include',
    lateGraceHours: 72,
    cohortEvent: 'signup',
    activityEvents: DEFAULT_ACTIVITY,
    asOf: store.now,
  };
}

export function normalizeConfig(input, store) {
  const d = defaultConfig(store);
  const merged = { ...d, ...(input || {}) };
  const convention = normalizeConvention(merged.convention);
  const reportingZone = String(merged.reportingZone || 'UTC');
  const businessZone = String(merged.businessZone || reportingZone);
  const zones = resolveZones(convention, reportingZone, businessZone);
  const from = isValidDateKey(merged.from) ? merged.from : d.from;
  const to = isValidDateKey(merged.to) ? merged.to : d.to;
  const days = Math.max(0, Math.min(60, Number.isFinite(Number(merged.days)) ? Math.floor(Number(merged.days)) : d.days));
  const graceHours = Math.max(0, Math.min(24 * 30, Number(merged.lateGraceHours ?? d.lateGraceHours)));
  return {
    convention,
    conventionLabel: CONVENTION_LABELS[convention],
    reportingZone,
    businessZone,
    zones,
    from,
    to,
    days,
    segments: normalizeSegments(merged.segments),
    latePolicy: merged.latePolicy === 'settled' ? 'settled' : 'include',
    lateGraceHours: graceHours,
    cohortEvent: String(merged.cohortEvent || 'signup'),
    activityEvents: Array.isArray(merged.activityEvents) && merged.activityEvents.length
      ? merged.activityEvents.map(String)
      : DEFAULT_ACTIVITY,
    asOf: Number.isFinite(Number(merged.asOf)) ? Number(merged.asOf) : store.now,
    requestedVersion:
      merged.version === undefined || merged.version === null || merged.version === 'latest'
        ? null
        : Number(merged.version),
  };
}

export function configSignature(config) {
  return hashString(
    stableStringify({
      convention: config.convention,
      reportingZone: config.reportingZone,
      businessZone: config.businessZone,
      from: config.from,
      to: config.to,
      days: config.days,
      segments: config.segments,
      latePolicy: config.latePolicy,
      lateGraceHours: config.lateGraceHours,
      cohortEvent: config.cohortEvent,
      activityEvents: config.activityEvents,
      asOf: config.asOf,
      version: config.requestedVersion,
    }),
  );
}

export class RetentionEngine {
  constructor(store) {
    this.store = store;
    this.states = new Map();
    this.versionData = new Map();
    this.historicalCache = new Map();
  }

  versionDataFor(version) {
    let data = this.versionData.get(version);
    if (data) return data;
    const snapshot = this.store.getSnapshot(version);
    if (!snapshot) throw new Error(`Unknown dataset version: ${version}`);
    const byUser = new Map();
    for (const event of snapshot.events.values()) {
      const root = canonical(snapshot.parent, event.identity);
      let list = byUser.get(root);
      if (!list) {
        list = [];
        byUser.set(root, list);
      }
      list.push(event);
    }
    for (const list of byUser.values()) list.sort((a, b) => a.t - b.t || a.seq - b.seq);
    data = { snapshot, byUser, version };
    this.versionData.set(version, data);
    return data;
  }

  /**
   * Evidence changed at `version`. Snapshots are immutable and version numbers
   * only grow, so only derived caches for that version and later need dropping;
   * live states stay and catch up from the store's revision log.
   */
  invalidateVersionsFrom(version) {
    for (const key of [...this.versionData.keys()]) if (key > version) this.versionData.delete(key);
    for (const key of [...this.historicalCache.keys()]) this.historicalCache.delete(key);
  }

  /**
   * Summarise one canonical user. Every decision that affects retention lives
   * here, so a revision touching this user is handled by recomputing this.
   */
  summarizeUser(userId, events, config, versionData) {
    const asOf = config.asOf;
    const summary = {
      user: userId,
      cohortKey: null,
      entryT: null,
      entryProps: null,
      offsets: new Map(),
      firstActivityT: null,
      anonAdopted: 0,
      mergedIdentities: 0,
      counts: {
        receivedAfterAsOf: 0,
        futureEvent: 0,
        lateBeyondPolicy: 0,
        beyondHorizon: 0,
        beforeCohort: 0,
        repeatInSlot: 0,
        noCohortEvent: 0,
      },
    };

    // Count raw identities, not merge roots: after a merge every event shares
    // one root, which would hide the fact that two identities were involved.
    const rawIds = new Set();
    for (const event of events) {
      rawIds.add(event.identity);
      if (versionData.snapshot.identities.get(event.identity)?.type === 'anon') summary.anonAdopted += 1;
    }
    summary.rawIdentities = [...rawIds];
    summary.mergedIdentities = Math.max(0, rawIds.size - 1);

    // Cohort entry: earliest visible cohort event. Segment rules use the
    // properties captured at entry, never later mutations.
    let entry = null;
    for (const event of events) {
      if (event.name !== config.cohortEvent) continue;
      if (event.t > asOf || event.receivedAt > asOf) continue;
      entry = event;
      break;
    }
    if (!entry) {
      summary.counts.noCohortEvent = 1;
      return summary;
    }
    summary.entryT = entry.t;
    summary.entryProps = entry.props || {};
    summary.cohortKey = localDateKey(entry.t, config.zones.cohortZone);
    // Rolling 24h windows are anchored at this user's entry instant. Civil
    // conventions anchor at local midnight, so they pass null.
    summary.anchorMs = config.convention === 'rolling24h' ? entry.t : null;
    if (!matchesSegments(summary.entryProps, config.segments)) {
      summary.excludedBySegment = true;
      return summary;
    }

    for (const event of events) {
      if (!config.activityEvents.includes(event.name)) continue;
      if (event.t > asOf) {
        summary.counts.futureEvent += 1;
        continue;
      }
      if (event.receivedAt > asOf) {
        summary.counts.receivedAfterAsOf += 1;
        continue;
      }
      if (config.latePolicy === 'settled' && event.receivedAt - event.t > config.lateGraceHours * HOUR_MS) {
        summary.counts.lateBeyondPolicy += 1;
        continue;
      }
      const offset = dayOffsetOf(event.t, summary.cohortKey, config.zones, summary.anchorMs);
      if (offset === null || offset < 0) {
        summary.counts.beforeCohort += 1;
        continue;
      }
      if (offset > config.days) {
        summary.counts.beyondHorizon += 1;
        continue;
      }
      const prev = summary.offsets.get(offset) || 0;
      if (prev > 0) summary.counts.repeatInSlot += 1;
      summary.offsets.set(offset, prev + 1);
      if (summary.firstActivityT === null || event.t < summary.firstActivityT) {
        summary.firstActivityT = event.t;
      }
    }
    return summary;
  }

  emptyState(config, signature, version) {
    return {
      signature,
      config,
      version: 0,
      targetVersion: version,
      summaries: new Map(),
      members: new Map(),
      cohorts: new Map(),
      lastRecompute: null,
      log: [],
    };
  }

  buildCohort(cohortKey, config, members, summaries) {
    const size = members.size;
    const activeCounts = new Array(config.days + 1).fill(0);
    const repeatCounts = new Array(config.days + 1).fill(0);
    const eligibleCounts = new Array(config.days + 1).fill(0);
    const composition = Object.fromEntries(DIMENSIONS.map((dim) => [dim, {}]));
    // Observability is bounded by data availability (asOf) alone. The report's
    // `to` date selects which cohorts are listed; it must not truncate how far
    // each of those cohorts can be followed, or a one-day range would blank
    // every offset past day 0.
    const horizonEnd = config.asOf;
    const rolling = config.convention === 'rolling24h';
    for (const user of members) {
      const s = summaries.get(user);
      if (!s) continue;
      for (const [offset, count] of s.offsets) {
        if (offset <= config.days) {
          activeCounts[offset] += 1;
          repeatCounts[offset] += Math.max(0, count - 1);
        }
      }
      for (let offset = 0; offset <= config.days; offset += 1) {
        // Rolling eligibility is per user because each window is anchored at
        // that user's own entry instant.
        if (rolling) {
          if (slotEnd(cohortKey, offset, config.zones, s.anchorMs) <= horizonEnd) eligibleCounts[offset] += 1;
        }
      }
      for (const dim of DIMENSIONS) {
        const value = String(s.entryProps?.[dim] ?? 'unknown');
        composition[dim][value] = (composition[dim][value] || 0) + 1;
      }
    }
    const days = [];
    for (let offset = 0; offset <= config.days; offset += 1) {
      const start = slotStart(cohortKey, offset, config.zones);
      const end = slotEnd(cohortKey, offset, config.zones);
      const eligibleUsers = rolling ? eligibleCounts[offset] : end <= horizonEnd ? size : 0;
      const eligible = eligibleUsers > 0;
      days.push({
        offset,
        active: activeCounts[offset],
        eligible,
        eligibleUsers,
        rate: eligible ? activeCounts[offset] / eligibleUsers : null,
        repeatEvents: repeatCounts[offset],
        slotStart: rolling ? null : new Date(start).toISOString(),
        slotEnd: rolling ? null : new Date(end).toISOString(),
        slotLengthMs: rolling ? DAY_MS : end - start,
      });
    }
    return {
      cohort: cohortKey,
      weekday: weekdayOfKey(cohortKey),
      size,
      days,
      composition,
      anchoredAtEntry: rolling,
    };
  }

  syncState(state, version) {
    const started = performance.now();
    const versionData = this.versionDataFor(version);
    const previousVersion = state.version;
    const config = state.config;

    if (state.version === version) {
      return {
        mode: 'reused',
        fromVersion: version,
        toVersion: version,
        recomputedCohorts: 0,
        reusedCohorts: state.cohorts.size,
        affectedUsers: 0,
        affectedCohorts: [],
        durationMs: 0,
      };
    }

    if (state.version === 0) {
      const summaries = new Map();
      const members = new Map();
      for (const [user, events] of versionData.byUser) {
        const summary = this.summarizeUser(user, events, config, versionData);
        if (!summary.cohortKey || summary.excludedBySegment) continue;
        if (summary.cohortKey < config.from || summary.cohortKey > config.to) continue;
        summaries.set(user, summary);
        let set = members.get(summary.cohortKey);
        if (!set) {
          set = new Set();
          members.set(summary.cohortKey, set);
        }
        set.add(user);
      }
      state.summaries = summaries;
      state.members = members;
      state.cohorts = new Map();
      for (const cohortKey of members.keys()) {
        state.cohorts.set(cohortKey, this.buildCohort(cohortKey, config, members.get(cohortKey), summaries));
      }
      state.version = version;
      const result = {
        mode: previousVersion === 0 ? 'full' : 'rebuild',
        fromVersion: previousVersion,
        toVersion: version,
        recomputedCohorts: state.cohorts.size,
        reusedCohorts: 0,
        affectedUsers: summaries.size,
        affectedCohorts: [...state.cohorts.keys()].sort(),
        durationMs: performance.now() - started,
      };
      this.record(state, result);
      return result;
    }

    const touched = new Set();
    let fullRebuild = false;
    for (const rev of this.store.revisions) {
      if (rev.version <= state.version || rev.version > version) continue;
      if (rev.fullRebuild) fullRebuild = true;
      for (const user of rev.affectedUsers || []) touched.add(user);
    }
    if (fullRebuild) {
      state.version = 0;
      return this.syncState(state, version);
    }

    const dirtyCohorts = new Set();
    const changedCohorts = new Set();
    for (const user of touched) {
      const old = state.summaries.get(user);
      if (old) {
        dirtyCohorts.add(old.cohortKey);
        state.members.get(old.cohortKey)?.delete(user);
        state.summaries.delete(user);
      }
      const events = versionData.byUser.get(user);
      const summary = events ? this.summarizeUser(user, events, config, versionData) : null;
      if (
        summary &&
        summary.cohortKey &&
        !summary.excludedBySegment &&
        summary.cohortKey >= config.from &&
        summary.cohortKey <= config.to
      ) {
        state.summaries.set(user, summary);
        let set = state.members.get(summary.cohortKey);
        if (!set) {
          set = new Set();
          state.members.set(summary.cohortKey, set);
        }
        set.add(user);
        dirtyCohorts.add(summary.cohortKey);
        changedCohorts.add(summary.cohortKey);
      }
    }

    for (const cohortKey of dirtyCohorts) {
      const members = state.members.get(cohortKey);
      if (!members || members.size === 0) {
        state.members.delete(cohortKey);
        state.cohorts.delete(cohortKey);
      } else {
        state.cohorts.set(cohortKey, this.buildCohort(cohortKey, config, members, state.summaries));
      }
    }
    state.version = version;
    const result = {
      mode: 'incremental',
      fromVersion: previousVersion,
      toVersion: version,
      recomputedCohorts: dirtyCohorts.size,
      reusedCohorts: Math.max(0, state.cohorts.size - dirtyCohorts.size),
      affectedUsers: touched.size,
      affectedCohorts: [...dirtyCohorts].sort(),
      durationMs: performance.now() - started,
    };
    this.record(state, result);
    return result;
  }

  record(state, result) {
    state.lastRecompute = result;
    state.log.push(result);
    if (state.log.length > 20) state.log.shift();
  }

  build(rawConfig) {
    const config = normalizeConfig(rawConfig, this.store);
    const requestedVersion = config.requestedVersion ?? this.store.version;
    // The incremental state is keyed by report shape only. The version is not
    // part of the key; the state advances itself as the store grows.
    const configKey = configSignature(normalizeConfig({ ...rawConfig, version: undefined }, this.store));
    const latest = this.store.version;

    if (requestedVersion !== latest) {
      const cacheKey = `${configKey}@${requestedVersion}`;
      let report = this.historicalCache.get(cacheKey);
      if (!report) {
        const state = this.emptyState(config, configKey, requestedVersion);
        const savedVersion = this.store.version;
        this.store.version = requestedVersion;
        try {
          this.syncState(state, requestedVersion);
        } finally {
          this.store.version = savedVersion;
        }
        report = this.assembleReport(config, state, requestedVersion);
        report.recompute = { ...state.lastRecompute, mode: 'historical' };
        this.historicalCache.set(cacheKey, report);
      }
      return report;
    }

    let state = this.states.get(configKey);
    if (!state) {
      state = this.emptyState(config, configKey, latest);
      this.states.set(configKey, state);
      if (this.states.size > REPORT_CACHE_LIMIT) {
        const oldest = this.states.keys().next().value;
        if (oldest !== configKey) this.states.delete(oldest);
      }
    }
    const recompute = this.syncState(state, latest);
    const report = this.assembleReport(config, state, latest);
    report.recompute = recompute;
    return report;
  }

  assembleReport(config, state, version) {
    const cohortKeys = [...state.cohorts.keys()].sort();
    const aggregates = [];
    for (let offset = 0; offset <= config.days; offset += 1) {
      let eligible = 0;
      let active = 0;
      let repeatEvents = 0;
      let eligibleCohorts = 0;
      for (const key of cohortKeys) {
        const cohort = state.cohorts.get(key);
        const day = cohort.days[offset];
        if (!day || !day.eligible) continue;
        eligible += day.eligibleUsers ?? cohort.size;
        active += day.active;
        repeatEvents += day.repeatEvents;
        eligibleCohorts += 1;
      }
      aggregates.push({
        offset,
        eligibleCohorts,
        eligibleUsers: eligible,
        activeUsers: active,
        rate: eligible > 0 ? active / eligible : null,
        repeatEvents,
      });
    }

    const compositionTotals = Object.fromEntries(DIMENSIONS.map((d) => [d, {}]));
    let cohortUsers = 0;
    for (const cohort of state.cohorts.values()) {
      cohortUsers += cohort.size;
      for (const dim of DIMENSIONS) {
        for (const [value, count] of Object.entries(cohort.composition[dim])) {
          compositionTotals[dim][value] = (compositionTotals[dim][value] || 0) + count;
        }
      }
    }

    const focusDays = [1, 7, 14, 30].filter((d) => d <= config.days);
    const rolling = config.convention === 'rolling24h';
    const horizonEnd = config.asOf;
    const rollingEligible = (day, cohort, s) =>
      rolling
        ? slotEnd(cohort.cohort, day.offset, config.zones, s.anchorMs) <= horizonEnd
        : true;
    const breakdowns = {};
    for (const dim of DIMENSIONS) {
      const rows = new Map();
      for (const cohort of state.cohorts.values()) {
        for (const user of state.members.get(cohort.cohort) || []) {
          const s = state.summaries.get(user);
          if (!s) continue;
          const value = String(s.entryProps?.[dim] ?? 'unknown');
          let row = rows.get(value);
          if (!row) {
            row = { value, users: 0, days: {} };
            for (const d of focusDays) row.days[d] = { active: 0, eligible: 0 };
            rows.set(value, row);
          }
          row.users += 1;
          for (const d of focusDays) {
            const day = cohort.days[d];
            if (!day?.eligible) continue;
            if (rollingEligible(day, cohort, s)) {
              row.days[d].eligible += 1;
              if (s.offsets.has(d)) row.days[d].active += 1;
            }
          }
        }
      }
      breakdowns[dim] = [...rows.values()]
        .map((row) => ({
          value: row.value,
          users: row.users,
          days: Object.fromEntries(
            focusDays.map((d) => [
              d,
              {
                active: row.days[d].active,
                eligible: row.days[d].eligible,
                rate: row.days[d].eligible ? row.days[d].active / row.days[d].eligible : null,
              },
            ]),
          ),
        }))
        .sort((a, b) => b.users - a.users);
    }

    const exclusions = this.exclusionLedger(config, state, version);
    const dst = this.dstMetadata(config);
    const alerts = this.buildAlerts(config, cohortKeys, aggregates, exclusions, dst);
    const versionSnap = this.store.getSnapshot(version);
    const offsetLabel = formatOffset(offsetMsAt(config.asOf, config.zones.slotZone));

    const noteParts = [];
    if (config.convention === 'rolling24h') noteParts.push('24h elapsed windows from the cohort start');
    else noteParts.push(`${config.zones.slotZone} calendar days`);

    return {
      meta: {
        convention: config.convention,
        conventionLabel: config.conventionLabel,
        reportingZone: config.reportingZone,
        businessZone: config.businessZone,
        cohortZone: config.zones.cohortZone,
        slotZone: config.zones.slotZone,
        from: config.from,
        to: config.to,
        days: config.days,
        segments: config.segments,
        latePolicy: config.latePolicy,
        lateGraceHours: config.lateGraceHours,
        cohortEvent: config.cohortEvent,
        activityEvents: config.activityEvents,
        asOf: config.asOf,
        asOfIso: new Date(config.asOf).toISOString(),
        offsetLabel,
        note: noteParts.join(' · '),
        version,
        versionLabel: versionSnap?.label ?? null,
        cohortCount: cohortKeys.length,
        cohortUsers,
        generatedAt: Date.now(),
      },
      cohorts: cohortKeys.map((key) => state.cohorts.get(key)),
      aggregates,
      composition: { totals: compositionTotals, dimensions: DIMENSIONS },
      breakdowns,
      exclusions,
      dst,
      alerts,
      revisions: state.log.slice(-8),
    };
  }

  exclusionLedger(config, state, version) {
    const versionData = this.versionDataFor(version);
    const eventTotals = {
      receivedAfterAsOf: 0,
      futureEvent: 0,
      lateBeyondPolicy: 0,
      beyondHorizon: 0,
      beforeCohort: 0,
      repeatInSlot: 0,
    };
    let usersIncluded = 0;
    let adoptedEvents = 0;
    let mergedIdentities = 0;
    for (const summary of state.summaries.values()) {
      usersIncluded += 1;
      adoptedEvents += summary.anonAdopted;
      mergedIdentities += summary.mergedIdentities;
      for (const key of Object.keys(eventTotals)) eventTotals[key] += summary.counts[key] || 0;
    }
    let usersNoCohort = 0;
    let usersFiltered = 0;
    let usersOutsideRange = 0;
    for (const [user, events] of versionData.byUser) {
      const included = state.summaries.has(user);
      if (included) continue;
      const summary = this.summarizeUser(user, events, config, versionData);
      if (summary.counts.noCohortEvent) usersNoCohort += 1;
      else if (summary.excludedBySegment) usersFiltered += 1;
      else usersOutsideRange += 1;
    }
    // The flow must reconcile against canonical users, not raw identities:
    // merged anonymous ids are already represented by their canonical user.
    const canonicalUsers = new Set();
    for (const identity of versionData.snapshot.identities.keys()) {
      canonicalUsers.add(canonical(versionData.snapshot.parent, identity));
    }
    const ledger = this.store.ledger;
    const reasons = [
      {
        code: 'duplicate_event_id',
        label: 'Duplicate event ids dropped (first write wins)',
        count: ledger.duplicateOccurrences,
        unit: 'events',
      },
      {
        code: 'conflicting_duplicate',
        label: 'Duplicate ids whose payloads disagreed',
        count: ledger.conflictingDuplicates,
        unit: 'events',
      },
      { code: 'invalid_event', label: 'Malformed events rejected at ingest', count: ledger.invalidOccurrences, unit: 'events' },
      { code: 'received_after_as_of', label: 'Events received after the as-of time', count: eventTotals.receivedAfterAsOf, unit: 'events' },
      { code: 'future_event', label: 'Event timestamps after the as-of time', count: eventTotals.futureEvent, unit: 'events' },
      {
        code: 'late_beyond_policy',
        label: `Late events outside the ${config.lateGraceHours}h grace window`,
        count: eventTotals.lateBeyondPolicy,
        unit: 'events',
      },
      { code: 'beyond_horizon', label: `Activity beyond day ${config.days}`, count: eventTotals.beyondHorizon, unit: 'events' },
      { code: 'before_cohort', label: 'Activity before the cohort day (merged anonymous history)', count: eventTotals.beforeCohort, unit: 'events' },
      { code: 'repeat_in_slot', label: 'Repeat activity in one day slot (deduplicated for rates)', count: eventTotals.repeatInSlot, unit: 'events' },
      { code: 'deleted_event', label: 'Events removed by a data revision', count: ledger.deletedOccurrences, unit: 'events' },
      { code: 'no_cohort_event', label: 'Identities with no qualifying cohort event', count: usersNoCohort, unit: 'identities' },
      { code: 'filtered_by_segment', label: 'Users outside the selected segment', count: usersFiltered, unit: 'users' },
      { code: 'outside_cohort_range', label: 'Cohort day outside the report range', count: usersOutsideRange, unit: 'users' },
    ];
    return {
      users: {
        included: usersIncluded,
        noCohortEvent: usersNoCohort,
        filteredBySegment: usersFiltered,
        outsideRange: usersOutsideRange,
        totalIdentities: canonicalUsers.size,
      },
      events: {
        adoptedEvents,
        mergedIdentities,
        duplicatesDropped: ledger.duplicateOccurrences,
        conflictingDuplicates: ledger.conflictingDuplicates,
      },
      reasons,
    };
  }

  dstMetadata(config) {
    const keys = keyRange(config.from, config.to);
    const slotZone = config.zones.slotZone;
    const transitions = transitionsForDays(keys, slotZone).map((t) => ({
      date: t.date,
      at: t.at,
      atIso: t.at === null ? null : new Date(t.at).toISOString(),
      direction: t.direction,
      fromOffset: t.fromOffset,
      toOffset: t.toOffset,
      fromOffsetLabel: formatOffset(t.fromOffset),
      toOffsetLabel: formatOffset(t.toOffset),
      dayLengthMs: t.dayLengthMs,
      hours: t.dayLengthMs / HOUR_MS,
    }));
    const shiftedDays = [];
    if (config.convention !== 'rolling24h') {
      for (const key of keys) {
        const length = slotLength(key, 0, config.zones);
        if (length !== DAY_MS) {
          shiftedDays.push({
            date: key,
            lengthMs: length,
            hours: length / HOUR_MS,
            slotStart: new Date(slotStart(key, 0, config.zones)).toISOString(),
            slotEnd: new Date(slotEnd(key, 0, config.zones)).toISOString(),
          });
        }
      }
    }
    const notes = [];
    if (config.convention === 'rolling24h') {
      notes.push('Rolling 24h slots are measured from the cohort start instant; every slot is exactly 24h, even across DST.');
      notes.push('Returning users who appear a few elapsed hours into day 1 count in day 1, not day 0.');
    } else if (config.convention === 'business') {
      notes.push(`Cohorts and offsets use business-local calendar days in ${slotZone}.`);
      notes.push('DST days are 23h or 25h; later slots shift by the accumulated offset difference.');
    } else {
      notes.push(`Natural calendar days in ${slotZone}. A DST-shortened or -lengthened day is still one cohort day.`);
    }
    for (const day of shiftedDays) notes.push(`${day.date} is ${day.hours}h long in ${slotZone}.`);
    for (const t of transitions) notes.push(`${t.date} ${t.direction} at ${t.atIso}: ${t.fromOffsetLabel} → ${t.toOffsetLabel}.`);
    return { slotZone, convention: config.convention, transitions, shiftedDays, notes };
  }

  buildAlerts(config, cohortKeys, aggregates, exclusions, dst) {
    const alerts = [];
    if (config.convention === 'rolling24h') {
      alerts.push({
        level: 'info',
        title: 'Rolling 24h is not calendar-aligned',
        detail: 'Each slot is 24 elapsed hours from the cohort start. Rates are comparable across DST but do not line up with local midnight.',
      });
    }
    if (config.convention === 'business') {
      if (config.businessZone === config.reportingZone) {
        alerts.push({
          level: 'warn',
          title: 'Business zone equals the reporting zone',
          detail: `Both are ${config.businessZone}, so this report is identical to natural day by construction. Change either zone to see the difference.`,
        });
      } else {
        alerts.push({
          level: 'info',
          title: `Business calendar: ${config.businessZone}`,
          detail: `Reporting zone ${config.reportingZone} only affects labels here; cohorting and day offsets follow ${config.businessZone}.`,
        });
      }
    }
    if (dst.transitions.length) {
      alerts.push({
        level: 'info',
        title: `${dst.transitions.length} DST transition${dst.transitions.length > 1 ? 's' : ''} in range`,
        detail: dst.transitions
          .map((t) => `${t.date}: ${t.fromOffsetLabel} → ${t.toOffsetLabel}${t.hours === 24 ? '' : ` (${t.hours}h day)`}`)
          .join(' · '),
      });
    }
    const late = exclusions.reasons.find((r) => r.code === 'late_beyond_policy')?.count || 0;
    if (config.latePolicy === 'settled') {
      alerts.push({
        level: late > 0 ? 'warn' : 'info',
        title: late > 0 ? `${late} late events excluded by the settle window` : 'Settled mode has no late exclusions',
        detail: `Events received more than ${config.lateGraceHours}h after they occurred are ignored in settled mode.`,
      });
    }
    const beyond = exclusions.reasons.find((r) => r.code === 'beyond_horizon')?.count || 0;
    if (beyond > 0) {
      alerts.push({
        level: 'info',
        title: `${beyond} events beyond day ${config.days}`,
        detail: 'They fall outside the retention horizon and do not affect any rate.',
      });
    }
    const incomplete = cohortKeys.length - (aggregates[0]?.eligibleCohorts ?? 0);
    if (incomplete > 0) {
      alerts.push({
        level: 'info',
        title: `${incomplete} cohorts have not completed day 0`,
        detail: 'Incomplete slots are blank, not zero, so young cohorts cannot drag rates down.',
      });
    }
    if (exclusions.events.mergedIdentities > 0) {
      alerts.push({
        level: 'info',
        title: `${exclusions.events.mergedIdentities} anonymous identities merged`,
        detail: 'Anonymous events are attributed to the canonical user before cohorting; pre-signup activity cannot create a phantom cohort.',
      });
    }
    return alerts;
  }

  diffVersions(rawConfig, versionA, versionB) {
    const base = normalizeConfig({ ...rawConfig, version: undefined, asOf: undefined }, this.store);
    const reportA = this.build({ ...rawConfig, version: versionA, asOf: base.asOf });
    const reportB = this.build({ ...rawConfig, version: versionB, asOf: base.asOf });
    const byCohortA = new Map(reportA.cohorts.map((c) => [c.cohort, c]));
    const byCohortB = new Map(reportB.cohorts.map((c) => [c.cohort, c]));
    const cohortKeys = [...new Set([...byCohortA.keys(), ...byCohortB.keys()])].sort();
    let changedCohorts = 0;
    const cohorts = cohortKeys.map((key) => {
      const a = byCohortA.get(key);
      const b = byCohortB.get(key);
      const sizeA = a?.size ?? 0;
      const sizeB = b?.size ?? 0;
      let changed = sizeA !== sizeB;
      // A restated segment rule changes entry attributes without moving anyone
      // between cohorts, so attribute composition is part of "changed" too.
      const compositionDelta = {};
      const compositionChanged = [];
      for (const dim of DIMENSIONS) {
        const before = a?.composition?.[dim] ?? {};
        const after = b?.composition?.[dim] ?? {};
        const delta = {};
        for (const value of new Set([...Object.keys(before), ...Object.keys(after)])) {
          const diff = (after[value] ?? 0) - (before[value] ?? 0);
          if (diff !== 0) delta[value] = diff;
        }
        if (Object.keys(delta).length) {
          compositionDelta[dim] = delta;
          compositionChanged.push(dim);
        }
      }
      if (compositionChanged.length) changed = true;
      const days = [];
      for (let offset = 0; offset <= base.days; offset += 1) {
        const da = a?.days[offset];
        const db = b?.days[offset];
        const activeA = da?.active ?? 0;
        const activeB = db?.active ?? 0;
        if (activeA !== activeB) changed = true;
        days.push({
          offset,
          activeA,
          activeB,
          delta: activeB - activeA,
          rateA: da?.rate ?? null,
          rateB: db?.rate ?? null,
          eligibleA: da?.eligible ?? false,
          eligibleB: db?.eligible ?? false,
        });
      }
      if (changed) changedCohorts += 1;
      return {
        cohort: key,
        sizeA,
        sizeB,
        sizeDelta: sizeB - sizeA,
        days,
        changed,
        compositionDelta,
        compositionChanged,
      };
    });
    const aggregates = reportB.aggregates.map((day, i) => {
      const a = reportA.aggregates[i];
      const activeA = a?.activeUsers ?? 0;
      const activeB = day.activeUsers;
      return {
        offset: day.offset,
        activeA,
        activeB,
        delta: activeB - activeA,
        eligibleA: a?.eligibleUsers ?? 0,
        eligibleB: day.eligibleUsers,
        rateA: a?.rate ?? null,
        rateB: day.rate,
        rateDelta: a?.rate != null && day.rate != null ? day.rate - a.rate : null,
      };
    });
    return {
      config: {
        convention: base.convention,
        conventionLabel: base.conventionLabel,
        from: base.from,
        to: base.to,
        days: base.days,
        segments: base.segments,
        slotZone: base.zones.slotZone,
      },
      a: { version: reportA.meta.version, label: reportA.meta.versionLabel, cohortUsers: reportA.meta.cohortUsers },
      b: { version: reportB.meta.version, label: reportB.meta.versionLabel, cohortUsers: reportB.meta.cohortUsers },
      cohorts,
      aggregates,
      aggregatesChanged: reportA.meta.cohortUsers !== reportB.meta.cohortUsers
        || aggregates.some((d) => d.delta !== 0 || d.rateDelta !== 0),
      changedCohorts,
      unchangedCohorts: cohortKeys.length - changedCohorts,
    };
  }
}

export { stableStringify };
