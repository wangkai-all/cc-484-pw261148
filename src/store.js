/**
 * In-memory event store with identity merging, deduplication and immutable
 * version snapshots. Revisions never mutate an existing snapshot, so any two
 * versions can be compared exactly.
 */

export const FIXED_NOW = Date.parse('2026-11-19T12:00:00.000Z');
export const LATE_GRACE_HOURS = 72;

function cloneMapOfMaps(map) {
  const out = new Map();
  for (const [k, v] of map) out.set(k, new Map(v));
  return out;
}

export class EventStore {
  constructor({ now = FIXED_NOW } = {}) {
    this.now = now;
    this.events = new Map(); // eventId -> event (active, deduplicated)
    this.identities = new Map(); // identityId -> { id, type, props, firstSeenAt }
    this.parent = new Map(); // union-find parent
    this.deleted = new Set();
    this.version = 0;
    this.history = [];
    this.revisions = [];
    this.ledger = {
      rawIngested: 0,
      duplicateOccurrences: 0,
      conflictingDuplicates: 0,
      invalidOccurrences: 0,
      invalidSamples: [],
      deletedOccurrences: 0,
    };
    this.seq = 0;
  }

  ensureIdentity(id, type, props = {}, firstSeenAt = null) {
    let rec = this.identities.get(id);
    if (!rec) {
      rec = { id, type, props: { ...props }, firstSeenAt };
      this.identities.set(id, rec);
      this.parent.set(id, id);
    } else {
      if (props && Object.keys(props).length) rec.props = { ...rec.props, ...props };
      if (firstSeenAt !== null && (rec.firstSeenAt === null || firstSeenAt < rec.firstSeenAt)) {
        rec.firstSeenAt = firstSeenAt;
      }
    }
    return rec;
  }

  find(id) {
    let root = id;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) {
      root = this.parent.get(root);
    }
    let cur = id;
    while (cur !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  /** Merge two identities; known identities win as the canonical root. */
  mergeIdentities(a, b, { at = null, reason = 'identify' } = {}) {
    if (!this.identities.has(a) || !this.identities.has(b)) {
      throw new Error(`Cannot merge unknown identity: ${!this.identities.has(a) ? a : b}`);
    }
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return { root: ra, changed: false };
    const ia = this.identities.get(ra);
    const ib = this.identities.get(rb);
    const rank = (rec) => (rec.type === 'known' ? 0 : 1);
    let winner = ra;
    let loser = rb;
    if (rank(ia) > rank(ib)) {
      winner = rb;
      loser = ra;
    } else if (rank(ia) === rank(ib)) {
      const fa = ia.firstSeenAt ?? Number.POSITIVE_INFINITY;
      const fb = ib.firstSeenAt ?? Number.POSITIVE_INFINITY;
      if (fb < fa || (fb === fa && rb < ra)) {
        winner = rb;
        loser = ra;
      }
    }
    this.parent.set(loser, winner);
    this.mergeLog = this.mergeLog || [];
    this.mergeLog.push({ at: at ?? this.now, reason, from: loser, into: winner });
    return { root: winner, changed: true, from: loser, into: winner };
  }

  /**
   * Ingest raw occurrences. Duplicate event ids are dropped (first write wins)
   * and counted. Invalid records are rejected without failing the batch.
   */
  ingest(occurrences, { receivedAt = null } = {}) {
    const addedEvents = [];
    const addedIdentities = new Set();
    for (const raw of occurrences) {
      this.ledger.rawIngested += 1;
      if (!raw || typeof raw !== 'object') {
        this.ledger.invalidOccurrences += 1;
        this.ledger.invalidSamples.push({ reason: 'not_an_object' });
        continue;
      }
      const t = typeof raw.t === 'number' ? raw.t : Date.parse(raw.t);
      if (!Number.isFinite(t)) {
        this.ledger.invalidOccurrences += 1;
        if (this.ledger.invalidSamples.length < 8) {
          this.ledger.invalidSamples.push({ eventId: raw.eventId ?? null, reason: 'invalid_timestamp' });
        }
        continue;
      }
      if (!raw.eventId || !raw.identity || !raw.name) {
        this.ledger.invalidOccurrences += 1;
        if (this.ledger.invalidSamples.length < 8) {
          this.ledger.invalidSamples.push({ eventId: raw.eventId ?? null, reason: 'missing_field' });
        }
        continue;
      }
      const existing = this.events.get(raw.eventId);
      if (existing) {
        this.ledger.duplicateOccurrences += 1;
        if (
          existing.t !== t ||
          existing.identity !== raw.identity ||
          existing.name !== raw.name
        ) {
          this.ledger.conflictingDuplicates += 1;
        }
        continue;
      }
      const identityType = raw.identityType || (String(raw.identity).startsWith('a_') ? 'anon' : 'known');
      this.ensureIdentity(raw.identity, identityType, raw.identityProps || {}, t);
      addedIdentities.add(raw.identity);
      const event = Object.freeze({
        eventId: raw.eventId,
        identity: raw.identity,
        identityType,
        name: raw.name,
        t,
        props: raw.props ? { ...raw.props } : {},
        receivedAt: raw.receivedAt ?? receivedAt ?? this.now,
        offsetMinutes: Number.isFinite(raw.offsetMinutes) ? raw.offsetMinutes : null,
        seq: this.seq++,
      });
      this.events.set(event.eventId, event);
      addedEvents.push(event);
    }
    return { addedEvents, addedIdentities: [...addedIdentities] };
  }

  deleteEvent(eventId) {
    if (!this.events.has(eventId)) return null;
    const event = this.events.get(eventId);
    this.events.delete(eventId);
    this.deleted.add(eventId);
    this.ledger.deletedOccurrences += 1;
    return event;
  }

  restoreEvent(eventId, event) {
    if (this.events.has(eventId) || !event) return false;
    this.events.set(eventId, event);
    this.deleted.delete(eventId);
    this.ledger.deletedOccurrences = Math.max(0, this.ledger.deletedOccurrences - 1);
    return true;
  }

  correctEvent(eventId, patch) {
    const existing = this.events.get(eventId);
    if (!existing) throw new Error(`Unknown event: ${eventId}`);
    const next = Object.freeze({
      ...existing,
      ...patch,
      props: patch.props ? { ...existing.props, ...patch.props } : existing.props,
      seq: existing.seq,
    });
    this.events.set(eventId, next);
    return { before: existing, after: next };
  }

  snapshot(label) {
    return {
      version: this.version,
      label,
      at: this.now,
      events: new Map(this.events),
      identities: new Map(this.identities),
      parent: new Map(this.parent),
      now: this.now,
      deleted: new Set(this.deleted),
    };
  }

  commit({ label, kind, changedEvents = [], changedIdentities = [], affectedUsers = [], summary = null, fullRebuild = false }) {
    this.version += 1;
    const snapshot = this.snapshot(label);
    this.history.push(snapshot);
    const users = new Set(affectedUsers);
    for (const event of changedEvents) {
      users.add(this.find(event.identity));
    }
    for (const identity of changedIdentities) users.add(this.find(identity));
    const revision = {
      version: this.version,
      label,
      kind,
      at: this.now,
      changedEvents,
      changedIdentities,
      affectedUsers: [...users],
      summary,
      fullRebuild,
    };
    this.revisions.push(revision);
    return { revision, snapshot };
  }

  /** Canonical user for an identity (after merges). */
  userOf(identity) {
    return this.find(identity);
  }

  /** All event ids currently attached to a canonical user. */
  eventsOfUser(userId) {
    return [...this.events.values()].filter((e) => this.find(e.identity) === userId);
  }

  initialCommit(label = 'Seeded dataset') {
    this.version = 0;
    return this.commit({ label, kind: 'seed' });
  }

  getSnapshot(version) {
    return this.history.find((s) => s.version === version) || null;
  }

  latestVersions(limit = 20) {
    return this.history.slice(-limit).map((s) => ({
      version: s.version,
      label: s.label,
      at: s.at,
      events: s.events.size,
      identities: s.identities.size,
    }));
  }

  datasetStats() {
    const known = [...this.identities.values()].filter((i) => i.type === 'known').length;
    return {
      version: this.version,
      events: this.events.size,
      identities: this.identities.size,
      knownIdentities: known,
      anonIdentities: this.identities.size - known,
      merges: (this.mergeLog || []).length,
      now: this.now,
    };
  }

  resetTo(snapshot) {
    this.events = new Map(snapshot.events);
    this.identities = new Map(snapshot.identities);
    this.parent = new Map(snapshot.parent);
    this.deleted = new Set(snapshot.deleted ?? []);
    this.seq = this.events.size + 10_000;
  }
}
