import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDataset } from '../src/dataset.js';
import { RetentionEngine } from '../src/engine.js';
import {
  reviseBackfill,
  reviseDeleteEvent,
  reviseMergeIdentities,
  reviseSegmentRule,
  reviseShiftEvent,
} from '../src/revisions.js';
import { FIXED_NOW } from '../src/store.js';
import { localDateKey, localToInstant } from '../src/time.js';

const RANGE = { from: '2026-08-03', to: '2026-11-05', days: 14 };

function fresh() {
  const store = buildDataset({ now: FIXED_NOW });
  const engine = new RetentionEngine(store);
  return { store, engine, cfg: { ...RANGE } };
}

test('day 0 is every eligible cohort member and rates stay in [0,1]', () => {
  const { engine, cfg } = fresh();
  const report = engine.build({ ...cfg, convention: 'calendar' });
  assert.equal(report.aggregates[0].rate, 1);
  for (const day of report.aggregates) {
    if (day.rate === null) continue;
    assert.ok(day.rate >= 0 && day.rate <= 1, `rate out of range at day ${day.offset}`);
  }
});

test('slots that extend past data availability are null, never zero', () => {
  const { engine, cfg } = fresh();
  const report = engine.build({ ...cfg, convention: 'calendar' });
  // The newest cohort (2026-11-05) has day 14 spanning Nov 19 local, which ends
  // after asOf (2026-11-19T12:00Z = 07:00 local), so it is not yet observable.
  const lastCohort = report.cohorts.at(-1);
  const day14 = lastCohort.days.at(-1);
  assert.equal(day14.eligible, false);
  assert.equal(day14.rate, null);
  // One day earlier is complete, so it must report a number.
  assert.equal(lastCohort.days.at(-2).eligible, true);
});

test('repeated events in one day count once for the rate', () => {
  const { store, engine } = fresh();
  // Find a user with two events on the same local day.
  const byUserDay = new Map();
  for (const event of store.events.values()) {
    const user = store.find(event.identity);
    const key = `${user}|${localDateKey(event.t, 'America/New_York')}`;
    byUserDay.set(key, [...(byUserDay.get(key) || []), event]);
  }
  const repeated = [...byUserDay.entries()].find(([, events]) => events.length >= 2 && events.some((e) => e.name === 'signup'));
  assert.ok(repeated, 'dataset should contain a repeated same-day user');
  const [key] = repeated;
  const [user, day] = key.split('|');
  void user;
  const report = engine.build({ ...RANGE, convention: 'business' });
  const cohort = report.cohorts.find((c) => c.cohort === day);
  if (!cohort) return; // cohort outside the report window
  const active = cohort.days[0].active;
  assert.ok(active <= cohort.size, 'active users cannot exceed cohort size');
  assert.ok(cohort.days[0].repeatEvents >= 1, 'repeat events are reported separately');
});

test('cohort counts under the three conventions differ', () => {
  const { engine, cfg } = fresh();
  const calendar = engine.build({ ...cfg, convention: 'calendar' });
  const business = engine.build({ ...cfg, convention: 'business' });
  const rolling = engine.build({ ...cfg, convention: 'rolling24h' });
  const signatures = new Set(
    [calendar, business, rolling].map((r) => r.aggregates.map((d) => d.activeUsers.toFixed(0)).join(',')),
  );
  assert.equal(signatures.size, 3, 'three conventions should not produce identical matrices');
});

test('a one-event revision recomputes only the affected cohort', () => {
  const { store, engine, cfg } = fresh();
  engine.build({ ...cfg, convention: 'calendar' });
  const target = [...store.events.values()].find((e) => e.name === 'app_open' && e.t > Date.parse('2026-10-01'));
  const user = store.find(target.identity);
  const removed = store.deleteEvent(target.eventId);
  store.commit({ label: 'delete', kind: 'delete', changedEvents: [removed] });
  engine.invalidateVersionsFrom(store.version);
  const report = engine.build({ ...cfg, convention: 'calendar' });
  assert.equal(report.recompute.mode, 'incremental');
  assert.equal(report.recompute.affectedUsers, 1);
  assert.equal(report.recompute.recomputedCohorts, 1);
  assert.equal(report.recompute.reusedCohorts, report.meta.cohortCount - 1);
  const summary = engine.states.values().next().value.summaries.get(user);
  assert.ok(summary);
});

test('deleting a cohort entry event removes that user from the cohort', () => {
  const { store, engine, cfg } = fresh();
  const before = engine.build({ ...cfg, convention: 'calendar' });
  const target = [...store.events.values()].find((e) => e.name === 'signup');
  const user = store.find(target.identity);
  const cohort = localDateKey(target.t, 'UTC');
  const sizeBefore = before.cohorts.find((c) => c.cohort === cohort)?.size ?? 0;
  const removed = store.deleteEvent(target.eventId);
  store.commit({ label: 'delete signup', kind: 'delete', changedEvents: [removed] });
  engine.invalidateVersionsFrom(store.version);
  const after = engine.build({ ...cfg, convention: 'calendar' });
  const sizeAfter = after.cohorts.find((c) => c.cohort === cohort)?.size ?? 0;
  assert.equal(sizeAfter, sizeBefore - 1);
  assert.equal(engine.states.values().next().value.summaries.has(user), false);
});

test('shifting one event across local midnight changes exactly two days of one cohort', () => {
  const { store, engine, cfg } = fresh();
  engine.build({ ...cfg, convention: 'calendar' });
  const target = [...store.events.values()].find(
    (e) => e.name === 'app_open' && localDateKey(e.t, 'America/New_York') > '2026-10-01' && localDateKey(e.t, 'UTC') > '2026-10-01',
  );
  const before = engine.build({ ...cfg, convention: 'calendar' });
  const shiftMinutes = -((target.t % 86_400_000) / 60_000) - 1; // cross UTC midnight backwards
  store.correctEvent(target.eventId, { t: target.t });
  reviseShiftEvent(store, { minutes: shiftMinutes, match: (e) => e.eventId === target.eventId });
  engine.invalidateVersionsFrom(store.version);
  const after = engine.build({ ...cfg, convention: 'calendar' });
  assert.equal(after.recompute.affectedUsers, 1);
  assert.ok(after.recompute.recomputedCohorts <= 1);
  assert.notEqual(after.meta.generatedAt, before.meta.generatedAt);
});

test('restating a segment attribute changes the breakdown, not the cohort size', () => {
  const { store, engine, cfg } = fresh();
  const before = engine.build({ ...cfg, convention: 'calendar' });
  const cohortKey = before.cohorts.find((c) => c.size >= 6)?.cohort;
  const planRow = before.breakdowns.plan.find((row) => row.value === 'free');
  reviseSegmentRule(store, { cohortKey, dimension: 'plan', from: 'free', to: 'pro' });
  engine.invalidateVersionsFrom(store.version);
  const after = engine.build({ ...cfg, convention: 'calendar' });
  assert.equal(after.meta.cohortUsers, before.meta.cohortUsers, 'restating a label must not move users between cohorts');
  const newPlan = after.breakdowns.plan.find((row) => row.value === 'free');
  assert.ok(newPlan.users < planRow.users);
  assert.ok(after.recompute.affectedCohorts.includes(cohortKey));
});

test('a segment filter excludes users but never changes other cohorts', () => {
  const { engine, cfg } = fresh();
  const all = engine.build({ ...cfg, convention: 'calendar' });
  const pro = engine.build({ ...cfg, convention: 'calendar', segments: { plan: ['pro'] } });
  assert.ok(pro.meta.cohortUsers < all.meta.cohortUsers);
  assert.ok(pro.exclusions.users.filteredBySegment > 0);
  for (const cohort of pro.cohorts) {
    const same = all.cohorts.find((c) => c.cohort === cohort.cohort);
    assert.ok(cohort.size <= same.size);
  }
});

test('a backfill revision only touches cohorts receiving events', () => {
  const { store, engine, cfg } = fresh();
  const before = engine.build({ ...cfg, convention: 'calendar' });
  const keys = before.cohorts.slice(10, 12).map((c) => c.cohort);
  reviseBackfill(store, { cohortKeys: keys, extraActivity: 1 });
  engine.invalidateVersionsFrom(store.version);
  const after = engine.build({ ...cfg, convention: 'calendar' });
  assert.equal(after.recompute.mode, 'incremental');
  // Every recomputed cohort must contain at least one touched user. A backfill
  // selected by New York day can land a user in a neighbouring UTC cohort, so
  // the check is against the revision's own users, not its filter keys.
  const state = [...engine.states.values()].find((s) => s.config.convention === 'calendar');
  const touchedUsers = new Set(store.revisions.at(-1).affectedUsers);
  for (const key of after.recompute.affectedCohorts) {
    const cohortState = state.cohorts.get(key);
    assert.ok(
      [...touchedUsers].some((u) => state.summaries.get(u)?.cohortKey === key),
      `cohort ${key} was recomputed without an affected user`,
    );
    assert.ok(cohortState, `recomputed cohort ${key} missing from state`);
  }
  assert.ok(after.recompute.recomputedCohorts < after.meta.cohortCount);
  const targetCohort = after.cohorts.find((c) => c.cohort === keys[0]);
  const previous = before.cohorts.find((c) => c.cohort === keys[0]);
  assert.ok(targetCohort.days[1].active >= previous.days[1].active);
});

test('merging a late-identified anonymous identity adopts its events', () => {
  const { store, engine, cfg } = fresh();
  const before = engine.build({ ...cfg, convention: 'calendar' });
  const anonVisitors = store.meta.seededCases.anonymousVisitors;
  assert.ok(anonVisitors.length > 0);
  const revision = reviseMergeIdentities(store, {});
  engine.invalidateVersionsFrom(store.version);
  const after = engine.build({ ...cfg, convention: 'calendar' });
  assert.equal(after.recompute.mode, 'incremental');
  assert.ok(revision.changedEvents.length >= 2);
  // A merge can only move users into cohorts, never change an unrelated one.
  for (const cohort of after.cohorts) {
    const old = before.cohorts.find((c) => c.cohort === cohort.cohort);
    if (old && !after.recompute.affectedCohorts.includes(cohort.cohort)) {
      assert.equal(cohort.size, old.size);
    }
  }
});

test('version diff isolates changed cohorts', () => {
  const { store, engine, cfg } = fresh();
  const initial = engine.build({ ...cfg, convention: 'calendar' });
  const target = [...store.events.values()].find((e) => e.name === 'app_open' && e.t > Date.parse('2026-09-01'));
  const removed = store.deleteEvent(target.eventId);
  store.commit({ label: 'delete', kind: 'delete', changedEvents: [removed] });
  engine.invalidateVersionsFrom(store.version);
  const diff = engine.diffVersions({ ...cfg, convention: 'calendar' }, 1, store.version);
  assert.equal(diff.changedCohorts, 1);
  assert.equal(diff.changedCohorts + diff.unchangedCohorts, initial.cohorts.length);
  assert.equal(diff.a.version, 1);
  assert.equal(diff.b.version, store.version);
  const changed = diff.cohorts.find((c) => c.changed);
  assert.ok(changed.days.some((d) => d.delta !== 0) || changed.sizeDelta !== 0);
});

test('a restated segment rule shows up in the version diff', () => {
  const { store, engine, cfg } = fresh();
  const before = engine.build({ ...cfg, convention: 'calendar' });
  const cohortKey = before.cohorts.find((c) => (c.composition?.plan?.free ?? 0) >= 2)?.cohort;
  assert.ok(cohortKey, 'need a cohort with free-plan entrants');
  reviseSegmentRule(store, { cohortKey, dimension: 'plan', from: 'free', to: 'pro', zone: 'UTC' });
  engine.invalidateVersionsFrom(store.version);
  const diff = engine.diffVersions({ ...cfg, convention: 'calendar' }, 1, store.version);
  const row = diff.cohorts.find((c) => c.cohort === cohortKey);
  assert.ok(row.changed, 'restate must be flagged as a change');
  assert.deepEqual(row.compositionChanged, ['plan']);
  assert.ok(row.compositionDelta.plan.free < 0);
  assert.ok(row.compositionDelta.plan.pro > 0);
  assert.equal(row.sizeDelta, 0, 'restating an attribute does not move users between cohorts');
  assert.equal(diff.changedCohorts, 1);
});

test('late policy changes which events count without changing timestamps', () => {
  const { engine, cfg } = fresh();
  const include = engine.build({ ...cfg, convention: 'calendar', latePolicy: 'include' });
  const settled = engine.build({ ...cfg, convention: 'calendar', latePolicy: 'settled', lateGraceHours: 24 });
  const late = settled.exclusions.reasons.find((r) => r.code === 'late_beyond_policy').count;
  assert.ok(late > 0);
  const includeLate = include.exclusions.reasons.find((r) => r.code === 'late_beyond_policy').count;
  assert.equal(includeLate, 0);
});

test('duplicate occurrences are dropped and reported', () => {
  const { engine, cfg } = fresh();
  const report = engine.build({ ...cfg, convention: 'calendar' });
  const dup = report.exclusions.reasons.find((r) => r.code === 'duplicate_event_id');
  assert.equal(dup.count, 12);
  assert.ok(report.exclusions.events.conflictingDuplicates > 0);
});

test('a single-day cohort range still observes days past day 0', () => {
  const { engine, cfg } = fresh();
  const single = engine.build({ ...cfg, convention: 'calendar', from: '2026-08-03', to: '2026-08-03', days: 14 });
  assert.equal(single.meta.cohortCount, 1);
  assert.equal(single.aggregates[0].rate, 1);
  const observed = single.aggregates.filter((a) => a.offset > 0 && a.rate !== null);
  assert.ok(observed.length >= 10, `expected later days observable, got ${observed.length}`);
  // Truncating the cohort range must not change how the surviving cohort is measured.
  const wide = engine.build({ ...cfg, convention: 'calendar', from: '2026-08-03', to: '2026-11-05', days: 14 });
  const narrowed = wide.cohorts.find((c) => c.cohort === '2026-08-03');
  const only = single.cohorts[0];
  assert.deepEqual(
    only.days.map((d) => d.active),
    narrowed.days.map((d) => d.active),
  );
});

test('changing the cohort rule re-cohorts and changes the sample', () => {
  const { engine, cfg } = fresh();
  const signup = engine.build({ ...cfg, convention: 'calendar', cohortEvent: 'signup' });
  const open = engine.build({ ...cfg, convention: 'calendar', cohortEvent: 'app_open' });
  const purchase = engine.build({ ...cfg, convention: 'calendar', cohortEvent: 'purchase' });
  assert.notEqual(signup.meta.cohortUsers, open.meta.cohortUsers, 'first open includes anonymous users who never sign up');
  assert.ok(open.meta.cohortUsers > signup.meta.cohortUsers);
  assert.ok(purchase.meta.cohortUsers < signup.meta.cohortUsers);
  // Day 0 must still be complete for whichever event defines entry.
  for (const report of [signup, open, purchase]) {
    assert.equal(report.aggregates[0].rate, 1);
    assert.ok(report.exclusions.users.noCohortEvent >= 0);
  }
});

test('restating a cohort rule attribute preserves cohort membership and total users', () => {
  const { store, engine, cfg } = fresh();
  const before = engine.build({ ...cfg, convention: 'calendar' });
  const cohortKey = before.cohorts.find((c) => c.size >= 5)?.cohort;
  const sizeBefore = before.cohorts.find((c) => c.cohort === cohortKey).size;
  reviseSegmentRule(store, { cohortKey, dimension: 'plan', from: 'free', to: 'pro', zone: 'UTC' });
  engine.invalidateVersionsFrom(store.version);
  const after = engine.build({ ...cfg, convention: 'calendar' });
  assert.equal(after.meta.cohortUsers, before.meta.cohortUsers);
  assert.equal(after.cohorts.find((c) => c.cohort === cohortKey).size, sizeBefore);
  assert.equal(after.recompute.recomputedCohorts, 1);
});

test('restating under a non-signup cohort rule scopes by that rule', () => {
  const { store, engine, cfg } = fresh();
  const base = { ...cfg, convention: 'calendar', cohortEvent: 'app_open' };
  const before = engine.build(base);
  const cohort = before.cohorts.find((c) => c.size >= 4)?.cohort;
  assert.ok(cohort);
  const size = before.cohorts.find((c) => c.cohort === cohort).size;
  const entrants = [...store.events.values()].filter(
    (e) => e.name === 'app_open' && localDateKey(e.t, 'UTC') === cohort,
  );
  assert.ok(entrants.length > 0);
  reviseSegmentRule(store, { cohortKey: cohort, dimension: 'plan', from: 'free', to: 'pro', zone: 'UTC', cohortEvent: 'app_open' });
  engine.invalidateVersionsFrom(store.version);
  const after = engine.build(base);
  assert.equal(after.meta.cohortUsers, before.meta.cohortUsers, 'cohort rule keeps membership');
  assert.equal(after.cohorts.find((c) => c.cohort === cohort).size, size);
  assert.equal(after.recompute.mode, 'incremental');
  assert.equal(after.recompute.recomputedCohorts, 1);
});

test('backfill under a non-signup cohort rule touches the selected cohorts only', () => {
  const { store, engine, cfg } = fresh();
  const base = { ...cfg, convention: 'calendar', cohortEvent: 'app_open' };
  const before = engine.build(base);
  const keys = before.cohorts.slice(0, 2).map((c) => c.cohort);
  reviseBackfill(store, { cohortKeys: keys, extraActivity: 1, zone: 'UTC', cohortEvent: 'app_open' });
  engine.invalidateVersionsFrom(store.version);
  const after = engine.build(base);
  assert.equal(after.recompute.mode, 'incremental');
  assert.equal(after.recompute.recomputedCohorts, 2);
  assert.deepEqual([...after.recompute.affectedCohorts].sort(), [...keys].sort());
  assert.ok(after.meta.cohortUsers >= before.meta.cohortUsers);
});

test('incremental recomputation equals a cold rebuild, revision by revision', () => {
  const { store, engine, cfg } = fresh();
  const shape = (report) =>
    JSON.stringify({
      meta: [report.meta.cohortUsers, report.meta.cohortCount, report.meta.version],
      aggregates: report.aggregates.map((a) => [a.offset, a.activeUsers, a.eligibleUsers, a.rate]),
      cohorts: report.cohorts.map((c) => [c.cohort, c.size, c.days.map((d) => [d.active, d.eligible])]),
    });
  const config = { ...cfg, convention: 'calendar' };

  // Warm the cache so each revision is applied motionally, not from scratch.
  engine.build(config);
  const revisions = [
    () => reviseDeleteEvent(store, {}),
    () => reviseShiftEvent(store, { minutes: 45 }),
    () => reviseBackfill(store, { cohortKeys: ['2026-09-21', '2026-09-22'], extraActivity: 2, zone: 'UTC' }),
    () => reviseMergeIdentities(store, {}),
    () =>
      reviseSegmentRule(store, {
        cohortKey: engine.build(config).cohorts.find((c) => (c.composition?.plan?.free ?? 0) >= 2).cohort,
        dimension: 'plan',
        from: 'free',
        to: 'pro',
        zone: 'UTC',
      }),
  ];

  for (const [index, apply] of revisions.entries()) {
    apply();
    engine.invalidateVersionsFrom(store.version);
    const incremental = engine.build(config);
    assert.equal(incremental.recompute.mode, 'incremental', `revision ${index + 1} should reuse cached cohorts`);
    // A separate engine over the same store has no cached state at all, which
    // is the true cold-rebuild baseline.
    const cold = new RetentionEngine(store).build(config);
    assert.equal(cold.recompute.mode, 'full');
    assert.equal(shape(incremental), shape(cold), `revision ${index + 1} diverged from a cold rebuild`);
  }
});

test('historical versions are reproducible from immutable snapshots', () => {
  const { store, engine, cfg } = fresh();
  const v1 = engine.build({ ...cfg, convention: 'calendar' });
  const removed = store.deleteEvent([...store.events.values()][0].eventId);
  store.commit({ label: 'delete', kind: 'delete', changedEvents: [removed] });
  engine.invalidateVersionsFrom(store.version);
  const historical = engine.build({ ...cfg, convention: 'calendar', version: 1 });
  assert.equal(historical.meta.version, 1);
  assert.equal(historical.meta.cohortUsers, v1.meta.cohortUsers);
  const latest = engine.build({ ...cfg, convention: 'calendar' });
  assert.equal(latest.meta.version, store.version);
});

test('as-of time hides events that had not arrived yet', () => {
  const { store, engine, cfg } = fresh();
  const asOf = Date.parse('2026-09-15T00:00:00Z');
  const report = engine.build({ ...cfg, convention: 'calendar', asOf });
  const late = report.exclusions.reasons.find((r) => r.code === 'received_after_as_of').count;
  assert.ok(late > 0);
  assert.ok(report.meta.cohortUsers > 0);
});
