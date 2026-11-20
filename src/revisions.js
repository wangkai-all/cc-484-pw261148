/**
 * Named data revisions. Each one mutates the store through the public API and
 * commits an immutable snapshot with the affected users recorded, so every
 * cached report can recompute only what changed.
 */

import { localDateKey } from './time.js';

/**
 * Earliest occurrence of the active cohort event per canonical user, mirroring
 * the engine: cohort membership is defined by `cohortEvent`, not always signup.
 * Returns Map<user, entryEvent>.
 */
function entryEvents(store, cohortEvent) {
  const byUser = new Map();
  for (const event of store.events.values()) {
    if (event.name !== cohortEvent) continue;
    if (event.t > store.now || event.receivedAt > store.now) continue;
    const user = store.find(event.identity);
    const prev = byUser.get(user);
    if (!prev || event.t < prev.t) byUser.set(user, event);
  }
  return byUser;
}

function commit(store, payload) {
  const { revision } = store.commit(payload);
  return revision;
}

/** Delete one event (a stray duplicate that survived dedup). */
export function reviseDeleteEvent(store, { eventId = null, pick = null } = {}) {
  let target = eventId ? store.events.get(eventId) : null;
  if (!target && typeof pick === 'function') target = [...store.events.values()].filter(pick)[0] ?? null;
  if (!target) {
    // Default: a mid-range app_open well after signup, so the demo always has
    // a deterministic target without taking a function over the wire.
    const candidates = [...store.events.values()]
      .filter((e) => e.name === 'app_open' && e.t < store.now - 5 * 86_400_000)
      .sort((a, b) => a.t - b.t);
    target = candidates[Math.floor(candidates.length / 2)] ?? null;
  }
  if (!target) throw new Error('No matching event to delete');
  const removed = store.deleteEvent(target.eventId);
  return commit(store, {
    label: `Remove event ${removed.eventId}`,
    kind: 'delete',
    changedEvents: [removed],
    summary: `Deleted one ${removed.name} event for ${removed.identity}`,
  });
}

/** Correct an event timestamp (a client clock skew fixed upstream). */
export function reviseShiftEvent(store, { minutes = 90, match = null } = {}) {
  const fallback = (e) => e.name === 'app_open' && e.t < store.now - 5 * 86_400_000;
  const target = [...store.events.values()].find(match || fallback);
  if (!target) throw new Error('No matching event to shift');
  const { after } = store.correctEvent(target.eventId, { t: target.t + minutes * 60_000 });
  return commit(store, {
    label: `Shift ${target.eventId} by ${minutes}m`,
    kind: 'correct',
    changedEvents: [after],
    summary: `Corrected timestamp of one ${target.name} event`,
  });
}

/**
 * Restate the segment attribute for one cohort, in a chosen cohort zone.
 * Only entrants of that cohort are touched: an activity event stamped with a
 * plan does not move a user between cohorts, and restating users who merely
 * passed through the day would recompute unrelated cohorts for nothing.
 */
export function reviseSegmentRule(
  store,
  { cohortKey, dimension = 'plan', from = 'free', to = 'pro', zone = 'America/New_York', cohortEvent = 'signup' } = {},
) {
  if (!cohortKey) throw new Error('cohortKey is required');
  // Group by canonical user so anonymous history merged into the entrant is
  // restated with it, and record one affected user rather than many events.
  const entrants = new Map();
  for (const [user, entry] of entryEvents(store, cohortEvent)) {
    if (localDateKey(entry.t, zone) !== cohortKey) continue;
    entrants.set(user, entry);
  }
  if (!entrants.size) throw new Error(`No cohort entries on ${cohortKey}`);
  const changed = [];
  const touchedUsers = [];
  for (const [user, signup] of entrants) {
    if (String(signup.props?.[dimension]) !== from) continue;
    touchedUsers.push(user);
    for (const event of store.eventsOfUser(user)) {
      if (event.name === 'signup') continue;
      if (String(event.props?.[dimension]) !== from) continue;
      const { after } = store.correctEvent(event.eventId, {
        props: { ...event.props, [dimension]: to, restated: true },
      });
      changed.push(after);
    }
    const { after } = store.correctEvent(signup.eventId, {
      props: { ...signup.props, [dimension]: to, restated: true },
    });
    changed.push(after);
  }
  if (!changed.length) throw new Error(`No ${dimension}=${from} entries in cohort ${cohortKey}`);
  return commit(store, {
    label: `Restate ${dimension} for cohort ${cohortKey}`,
    kind: 'restate',
    changedEvents: changed,
    affectedUsers: touchedUsers,
    summary: `${touchedUsers.length} cohort entries in ${cohortKey} changed ${dimension}: ${from} → ${to}`,
  });
}

/** Backfill: late events that finally arrive for a set of cohorts. */
export function reviseBackfill(
  store,
  { cohortKeys = [], extraActivity = 2, zone = 'America/New_York', cohortEvent = 'signup' } = {},
) {
  if (!cohortKeys.length) throw new Error('cohortKeys is required');
  const wanted = new Set(cohortKeys);
  const byUser = new Map();
  for (const [user, entry] of entryEvents(store, cohortEvent)) {
    if (!wanted.has(localDateKey(entry.t, zone))) continue;
    byUser.set(user, entry);
  }
  const occurrences = [];
  let seq = 0;
  for (const [user, signup] of byUser) {
    for (let i = 0; i < extraActivity; i += 1) {
      const t = signup.t + (1 + i) * 86_400_000 + 10 * 3_600_000 + i * 60_000;
      seq += 1;
      occurrences.push({
        eventId: `evt_backfill_${store.version}_${seq}`,
        identity: user,
        identityType: 'known',
        name: 'app_open',
        t,
        props: { ...signup.props, backfilled: true },
        receivedAt: store.now,
        offsetMinutes: -240,
      });
    }
  }
  if (!occurrences.length) throw new Error('No users in the selected cohorts');
  const { addedEvents } = store.ingest(occurrences, { receivedAt: store.now });
  return commit(store, {
    label: `Backfill ${cohortKeys.length} cohort${cohortKeys.length > 1 ? 's' : ''}`,
    kind: 'backfill',
    changedEvents: addedEvents,
    summary: `${addedEvents.length} late events added across ${byUser.size} users`,
  });
}

/**
 * Merge a late-identified anonymous identity into a known user. Every event
 * moves to the canonical user; the cohorts of all touched users are recomputed.
 * When `left` is omitted, the first still-standalone anonymous identity with
 * activity is chosen.
 */
export function reviseMergeIdentities(store, { left = null, right = null } = {}) {
  let anon = left ? store.find(left) : null;
  if (!anon) {
    const roots = new Map();
    for (const event of store.events.values()) {
      const root = store.find(event.identity);
      roots.set(root, (roots.get(root) || 0) + 1);
    }
    anon = [...roots.keys()].find((id) => store.identities.get(id)?.type === 'anon' && roots.get(id) >= 2);
  }
  if (!anon) throw new Error('No standalone anonymous identity left to merge');
  let known = right ? store.find(right) : null;
  if (!known) {
    const anonEvents = store.eventsOfUser(anon);
    const day = anonEvents.length ? localDateKey(anonEvents[0].t, 'America/New_York') : null;
    const candidate = [...store.identities.values()].find(
      (i) =>
        i.type === 'known' &&
        store.find(i.id) === i.id &&
        store.eventsOfUser(i.id).some((e) => localDateKey(e.t, 'America/New_York') === day),
    );
    known = candidate?.id ?? null;
  }
  if (!known) throw new Error('No known identity to merge into');
  if (anon === known) throw new Error('Identities are already merged');
  const result = store.mergeIdentities(anon, known, { at: store.now, reason: 'manual_merge' });
  const affected = store.eventsOfUser(result.root);
  return commit(store, {
    label: `Merge ${anon} into ${known}`,
    kind: 'merge',
    changedEvents: affected,
    changedIdentities: [anon, known],
    summary: `${store.eventsOfUser(result.root).length} events now belong to canonical user ${result.root}`,
    fullRebuild: false,
  });
}

export const REVISION_KINDS = ['delete', 'shift', 'restate', 'backfill', 'merge'];
