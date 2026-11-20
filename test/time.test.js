import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDaysToKey,
  dayLengthMs,
  endOfDay,
  formatOffset,
  isValidDateKey,
  localDateKey,
  localToInstant,
  keyRange,
  offsetMsAt,
  startOfDay,
  transitionsForDays,
  weekdayOfKey,
  zonedParts,
} from '../src/time.js';

test('natural day is midnight to midnight in the reporting zone', () => {
  const start = startOfDay('2026-10-15', 'America/New_York');
  const end = endOfDay('2026-10-15', 'America/New_York');
  assert.equal(new Date(start).toISOString(), '2026-10-15T04:00:00.000Z');
  assert.equal(end - start, 24 * 3_600_000);
  assert.equal(localDateKey(start, 'America/New_York'), '2026-10-15');
  assert.equal(localDateKey(end - 1, 'America/New_York'), '2026-10-15');
});

test('spring-forward day is 23h and starts at the correct instant', () => {
  assert.equal(dayLengthMs('2026-03-08', 'America/New_York'), 23 * 3_600_000);
  assert.equal(new Date(startOfDay('2026-03-08', 'America/New_York')).toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(new Date(endOfDay('2026-03-08', 'America/New_York')).toISOString(), '2026-03-09T04:00:00.000Z');
});

test('fall-back day is 25h; the repeated hour does not create a second day', () => {
  assert.equal(dayLengthMs('2026-11-01', 'America/New_York'), 25 * 3_600_000);
  assert.equal(localDateKey(Date.parse('2026-11-01T05:30:00Z'), 'America/New_York'), '2026-11-01');
  assert.equal(localDateKey(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York'), '2026-11-01');
  assert.equal(offsetMsAt(Date.parse('2026-11-01T05:30:00Z'), 'America/New_York'), -4 * 3_600_000);
  assert.equal(offsetMsAt(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York'), -5 * 3_600_000);
});

test('half-hour DST shift (Lord Howe) is 23.5h / 24.5h', () => {
  assert.equal(dayLengthMs('2026-10-04', 'Australia/Lord_Howe'), 23.5 * 3_600_000);
  assert.equal(dayLengthMs('2026-04-05', 'Australia/Lord_Howe'), 24.5 * 3_600_000);
});

test('midnight DST transition (Santiago) still finds the first instant of the day', () => {
  assert.equal(dayLengthMs('2026-09-06', 'America/Santiago'), 23 * 3_600_000);
  const start = startOfDay('2026-09-06', 'America/Santiago');
  assert.equal(zonedParts(start, 'America/Santiago').date ?? zonedParts(start, 'America/Santiago').day, 6);
  assert.equal(localDateKey(start - 1, 'America/Santiago'), '2026-09-05');
});

test('a calendar day skipped by a zone change is handled without hanging', () => {
  // Samoa skipped 2011-12-30 entirely: it has zero length and the day before
  // it runs straight into the 31st.
  assert.equal(dayLengthMs('2011-12-30', 'Pacific/Apia'), 0);
  assert.equal(localDateKey(startOfDay('2011-12-30', 'Pacific/Apia'), 'Pacific/Apia'), '2011-12-31');
  assert.equal(localDateKey(endOfDay('2011-12-29', 'Pacific/Apia'), 'Pacific/Apia'), '2011-12-31');
  assert.equal(dayLengthMs('2011-12-29', 'Pacific/Apia'), 12 * 3_600_000 * 2);
});

test('nonexistent local times resolve forward instead of throwing', () => {
  const res = localToInstant('2026-03-08', 'America/New_York', 2, 30);
  assert.equal(res.nonexistent, true);
  assert.equal(new Date(res.ms).toISOString(), '2026-03-08T07:30:00.000Z'); // 03:30 EDT
});

test('ambiguous local times pick the earlier (DST) instant and are flagged', () => {
  const res = localToInstant('2026-11-01', 'America/New_York', 1, 30);
  assert.equal(res.ambiguous, true);
  assert.equal(new Date(res.ms).toISOString(), '2026-11-01T05:30:00.000Z');
});

test('transition instants are located to the second, including at local midnight', () => {
  const [ny] = transitionsForDays(['2026-03-08'], 'America/New_York');
  assert.equal(new Date(ny.at).toISOString(), '2026-03-08T07:00:00.000Z');
  assert.equal(ny.direction, 'spring-forward');
  const [santiago] = transitionsForDays(['2026-09-06'], 'America/Santiago');
  assert.equal(new Date(santiago.at).toISOString(), '2026-09-06T04:00:00.000Z');
  assert.equal(formatOffset(santiago.fromOffset), 'UTC-04:00');
  assert.equal(formatOffset(santiago.toOffset), 'UTC-03:00');
});

test('date key arithmetic is civil, not elapsed-time based', () => {
  assert.equal(addDaysToKey('2026-02-28', 1), '2026-03-01');
  assert.equal(addDaysToKey('2024-02-28', 1), '2024-02-29');
  assert.equal(addDaysToKey('2026-03-08', 1), '2026-03-09');
  assert.equal(addDaysToKey('2026-01-01', -1), '2025-12-31');
  assert.equal(weekdayOfKey('2026-11-01'), 0);
});

test('invalid date keys are rejected everywhere they enter', () => {
  for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', '', 'nope', '2026-00-10']) {
    assert.equal(isValidDateKey(bad), false, bad);
  }
  assert.equal(isValidDateKey('2024-02-29'), true);
});

test('key ranges are inclusive, ordered and bounded', () => {
  assert.deepEqual(keyRange('2026-03-07', '2026-03-10'), ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  assert.deepEqual(keyRange('2026-03-09', '2026-03-07'), []);
  assert.equal(keyRange('2025-01-01', '2026-01-01').length, 366);
});
