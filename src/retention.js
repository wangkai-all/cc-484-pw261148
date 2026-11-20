/**
 * Retention attribution engine.
 *
 * Three conventions decide which calendar day an event belongs to. The
 * retention "slot" is always counted in calendar days of the *reporting* zone:
 *
 *  - calendar        natural day in the reporting time zone (default UTC).
 *  - rolling24h      activity is bucketed into rolling 24h windows measured
 *                    from the cohort's day boundary. A day slot N is
 *                    [start + N*24h, start + (N+1)*24h) in *elapsed* time, so a
 *                    DST day is still 24 elapsed hours and long days are not
 *                    silently 25h.
 *  - business        the business time zone decides the civil day (and thus the
 *                    cohort and the day offset), while slot boundaries fall on
 *                    business-local midnight — including 23h/25h days.
 *
 * Cohort = local calendar day of the user's FIRST qualifying event, in the
 * convention's cohort zone. Day 0 is the cohort day; Day N is N calendar days
 * later (for rolling24h: N*24h later).
 */

import {
  UNITS,
  addDaysToKey,
  dateKeyFromParts,
  daysBetweenKeys,
  keyRange,
  localDateKey,
  parseDateKey,
  startOfDay,
  transitionsForDays,
  weekdayOfKey,
} from './time.js';

const { DAY_MS, HOUR_MS } = UNITS;

export const CONVENTIONS = ['calendar', 'rolling24h', 'business'];

export const CONVENTION_LABELS = {
  calendar: 'Natural day',
  rolling24h: 'Rolling 24h',
  business: 'Business time zone',
};

export function normalizeConvention(value) {
  return CONVENTIONS.includes(value) ? value : 'calendar';
}

/**
 * Resolve the concrete time zones a convention uses.
 *
 * `reportingZone` is the calendar used for the report. `businessZone` applies
 * only to the business convention; when absent the reporting zone is used.
 * Rolling 24h deliberately has no civil day beyond the cohort start, so its
 * cohort is taken in the reporting zone.
 */
export function resolveZones(convention, reportingZone, businessZone) {
  const conv = normalizeConvention(convention);
  const report = reportingZone || 'UTC';
  if (conv === 'business') {
    return { convention: conv, cohortZone: businessZone || report, slotZone: businessZone || report };
  }
  return { convention: conv, cohortZone: report, slotZone: report };
}

/** Local calendar day key for an instant under a convention's cohort zone. */
export function cohortDayKey(ms, zones) {
  return localDateKey(ms, zones.cohortZone);
}

/**
 * Slot boundary for day offset N.
 *
 * rolling24h windows are anchored at the user's cohort entry instant (the
 * first qualifying event), not at midnight — that is the whole point of the
 * convention: a user who signs up at 22:00 gets 22:00→22:00 windows. Pass
 * `anchorMs`; without it the cohort day boundary is used only as a display
 * approximation.
 *
 * calendar / business slots are civil midnights in the slot zone, including
 * 23h and 25h DST days.
 */
export function slotStart(cohortKey, offset, zones, anchorMs = null) {
  if (zones.convention === 'rolling24h') {
    const anchor = anchorMs ?? startOfDay(cohortKey, zones.slotZone);
    return anchor + offset * DAY_MS;
  }
  return startOfDay(addDaysToKey(cohortKey, offset), zones.slotZone);
}

export function slotEnd(cohortKey, offset, zones, anchorMs = null) {
  if (zones.convention === 'rolling24h') return slotStart(cohortKey, offset, zones, anchorMs) + DAY_MS;
  return startOfDay(addDaysToKey(cohortKey, offset + 1), zones.slotZone);
}

/**
 * Day offset of an instant relative to a cohort.
 * Returns null when the instant precedes the attribution start (cohort
 * midnight for civil conventions, the user's entry instant for rolling24h).
 */
export function dayOffsetOf(ms, cohortKey, zones, anchorMs = null) {
  if (zones.convention === 'rolling24h') {
    const anchor = anchorMs ?? startOfDay(cohortKey, zones.slotZone);
    if (ms < anchor) return null;
    return Math.floor((ms - anchor) / DAY_MS);
  }
  const start = startOfDay(cohortKey, zones.slotZone);
  if (ms < start) return null;
  // Civil day difference, robust across DST and skipped days because it only
  // compares date keys.
  const eventKey = localDateKey(ms, zones.slotZone);
  return daysBetweenKeys(cohortKey, eventKey);
}

/** Slot length in ms, used to distinguish activity vs exposure windows. */
export function slotLength(cohortKey, offset, zones, anchorMs = null) {
  return slotEnd(cohortKey, offset, zones, anchorMs) - slotStart(cohortKey, offset, zones, anchorMs);
}

/**
 * Build a pruned index of events for one user.
 * Events are { t, name, props }. The engine calls `matcher(event)` to decide
 * inclusion; the caller supplies the predicate.
 */
export function indexUserEvents(events, matcher) {
  const matched = [];
  for (const e of events) {
    if (matcher(e)) matched.push(e);
  }
  matched.sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0));
  return matched;
}

/**
 * Compute, for one user, the day offsets at which they were active.
 * Deduplicates by slot so repeated events in one day do not inflate retention
 * (retention is user-count based) but are still reported for diagnostics.
 */
export function activeOffsets(events, cohortKey, zones) {
  const offsets = new Set();
  let first = null;
  for (const e of events) {
    if (first === null || e.t < first) first = e.t;
    const n = dayOffsetOf(e.t, cohortKey, zones);
    if (n !== null && n >= 0) offsets.add(n);
  }
  return { offsets: [...offsets].sort((a, b) => a - b), first };
}

/** Weekday (0=Sun..6=Sat) of a cohort key in the slot zone. Purely civil. */
export function cohortWeekday(cohortKey) {
  return weekdayOfKey(cohortKey);
}

/**
 * The maximum day offset that could be observed inside a date range.
 * Used to size matrices and to bound incremental work.
 */
export function maxObservableOffset(rangeStartKey, rangeEndKey, nowMs, zones) {
  if (!isValidKey(rangeStartKey) || !isValidKey(rangeEndKey)) return 0;
  const endCap = Math.min(
    startOfDay(addDaysToKey(rangeEndKey, 1), zones.slotZone),
    nowMs,
  );
  const start = startOfDay(rangeStartKey, zones.slotZone);
  if (endCap <= start) return 0;
  if (zones.convention === 'rolling24h') return Math.floor((endCap - start) / DAY_MS);
  return daysBetweenKeys(rangeStartKey, localDateKey(endCap - 1, zones.slotZone));
}

function isValidKey(k) {
  return parseDateKey(k) !== null;
}

/** DST/slot metadata for a range of cohort days, for the UI and tests. */
export function slotMetadata(rangeStartKey, rangeEndKey, zones) {
  const keys = keyRange(rangeStartKey, rangeEndKey);
  if (zones.convention === 'rolling24h') {
    return {
      convention: zones.convention,
      note: 'Each slot is exactly 24 elapsed hours from that user\'s entry instant; DST does not stretch a slot.',
      dayLengths: keys.map((key) => ({ date: key, dayLengthMs: DAY_MS })),
      transitions: [],
    };
  }
  const transitions = transitionsForDays(keys, zones.slotZone);
  return {
    convention: zones.convention,
    slotZone: zones.slotZone,
    dayLengths: keys.map((key) => ({
      date: key,
      dayLengthMs: slotLength(key, 0, zones),
      startUtc: new Date(slotStart(key, 0, zones)).toISOString(),
    })),
    transitions,
  };
}

export { dateKeyFromParts, addDaysToKey, keyRange, startOfDay, localDateKey, HOUR_MS, DAY_MS };
