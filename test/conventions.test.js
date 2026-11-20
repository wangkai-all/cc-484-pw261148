import test from 'node:test';
import assert from 'node:assert/strict';

import { dayOffsetOf, resolveZones, slotEnd, slotStart } from '../src/retention.js';
import { localToInstant, startOfDay } from '../src/time.js';

const NY = resolveZones('calendar', 'America/New_York', 'America/New_York');
const BIZ = resolveZones('business', 'UTC', 'America/New_York');
const ROLL = resolveZones('rolling24h', 'America/New_York', 'America/New_York');

test('natural-day offsets use the reporting zone civil day', () => {
  // 2026-08-23 23:55 EDT and 2026-08-24 00:05 EDT are different days.
  assert.equal(dayOffsetOf(Date.parse('2026-08-24T03:55:30Z'), '2026-08-23', NY), 0);
  assert.equal(dayOffsetOf(Date.parse('2026-08-24T04:05:30Z'), '2026-08-23', NY), 1);
});

test('same instants land differently under a business zone', () => {
  // UTC signup at 23:30 belongs to the next day in UTC, same day in New York.
  const t = Date.parse('2026-09-01T23:30:00Z');
  assert.equal(dayOffsetOf(t, '2026-09-01', resolveZones('calendar', 'UTC')), 0);
  assert.equal(dayOffsetOf(t, '2026-09-01', BIZ), 0);
  // An event before the cohort day begins returns null, never a negative offset.
  assert.equal(dayOffsetOf(t, '2026-09-02', resolveZones('calendar', 'UTC')), null);
  assert.equal(dayOffsetOf(t, '2026-09-02', BIZ), null);
  // Cross the local boundary and the two zones disagree: 01:30Z is still Sep 1
  // in New York but already Sep 2 in UTC.
  const boundary = Date.parse('2026-09-02T01:30:00Z');
  assert.equal(dayOffsetOf(boundary, '2026-09-01', resolveZones('calendar', 'UTC')), 1);
  assert.equal(dayOffsetOf(boundary, '2026-09-01', BIZ), 0);
});

test('rolling 24h windows are anchored at the entry instant, not midnight', () => {
  const entry = localToInstant('2026-09-27', 'America/New_York', 22, 0).ms;
  const cohortKey = '2026-09-27';
  // 22:30 same evening is day 0; 23:30 the next evening is still elapsed < 24h.
  assert.equal(dayOffsetOf(entry + 30 * 60_000, cohortKey, ROLL, entry), 0);
  assert.equal(dayOffsetOf(entry + 23.5 * 3_600_000, cohortKey, ROLL, entry), 0);
  assert.equal(dayOffsetOf(entry + 24 * 3_600_000, cohortKey, ROLL, entry), 1);
  assert.equal(dayOffsetOf(entry - 1, cohortKey, ROLL, entry), null);
  // An event before the entry instant is never in a window.
  assert.equal(dayOffsetOf(entry - 3_600_000, cohortKey, ROLL, entry), null);
});

test('rolling 24h slots are exactly 24h across a DST boundary', () => {
  const entry = localToInstant('2026-10-31', 'America/New_York', 20, 0).ms;
  for (let offset = 0; offset < 4; offset += 1) {
    assert.equal(
      slotEnd('2026-10-31', offset, ROLL, entry) - slotStart('2026-10-31', offset, ROLL, entry),
      86_400_000,
    );
  }
});

test('business slots follow 23h/25h DST days while natural slots do too', () => {
  assert.equal(slotEnd('2026-11-01', 0, BIZ) - slotStart('2026-11-01', 0, BIZ), 25 * 3_600_000);
  assert.equal(slotEnd('2026-03-08', 0, BIZ) - slotStart('2026-03-08', 0, BIZ), 23 * 3_600_000);
  assert.equal(
    slotStart('2026-03-08', 0, BIZ),
    startOfDay('2026-03-08', 'America/New_York'),
  );
});

test('an event at 00:05 on a fall-back day is still day N, not N+1', () => {
  const cohort = '2026-10-25';
  const midnightAfter = startOfDay('2026-11-01', 'America/New_York');
  assert.equal(dayOffsetOf(midnightAfter, cohort, BIZ), 7);
  // 01:30 EDT and 01:30 EST are the same civil day.
  assert.equal(dayOffsetOf(Date.parse('2026-11-01T05:30:00Z'), cohort, BIZ), 7);
  assert.equal(dayOffsetOf(Date.parse('2026-11-01T06:30:00Z'), cohort, BIZ), 7);
});

test('day offsets account for accumulated DST shift in civil conventions', () => {
  const cohort = '2026-10-20';
  const target = startOfDay('2026-11-15', 'America/New_York');
  assert.equal(dayOffsetOf(target, cohort, BIZ), 26);
  // And the instant one ms earlier belongs to the previous day.
  assert.equal(dayOffsetOf(target - 1, cohort, BIZ), 25);
});
