/**
 * Time-zone primitives used by the retention engine.
 *
 * Node here does not ship Temporal, so the civil-time <-> instant conversion is
 * done with Intl.DateTimeFormat. All public functions take millisecond instants
 * and IANA zone names.
 */

const formatterCache = new Map();
const dayStartCache = new Map();
const transitionCache = new Map();

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function formatterFor(timeZone) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Civil date/time fields for an instant in a zone. */
export function zonedParts(ms, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: new Date(Date.UTC(Number(out.year), Number(out.month) - 1, Number(out.day))).getUTCDay(),
  };
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function dateKeyFromParts({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** YYYY-MM-DD in the given zone. */
export function localDateKey(ms, timeZone) {
  return dateKeyFromParts(zonedParts(ms, timeZone));
}

/** UTC day key; the "natural day" convention. */
export function utcDateKey(ms) {
  return localDateKey(ms, 'UTC');
}

/** Zone UTC offset in milliseconds at an instant (second precision). */
export function offsetMsAt(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Human readable UTC offset, e.g. UTC-04:00. */
export function formatOffset(ms) {
  const sign = ms < 0 ? '-' : '+';
  const totalMinutes = Math.round(Math.abs(ms) / 60000);
  return `UTC${sign}${pad2(Math.floor(totalMinutes / 60))}:${pad2(totalMinutes % 60)}`;
}

export function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

export function isValidDateKey(key) {
  return parseDateKey(key) !== null;
}

/** Civil addition to a YYYY-MM-DD key (timezone independent). */
export function addDaysToKey(key, days) {
  const p = parseDateKey(key);
  if (!p) throw new Error(`Invalid date key: ${key}`);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return dateKeyFromParts({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  });
}

export function weekdayOfKey(key) {
  const p = parseDateKey(key);
  if (!p) return null;
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

export function daysBetweenKeys(a, b) {
  const pa = parseDateKey(a);
  const pb = parseDateKey(b);
  if (!pa || !pb) throw new Error('Invalid date key');
  return Math.round(
    (Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / DAY_MS,
  );
}

export function keyRange(from, to) {
  const out = [];
  if (!isValidDateKey(from) || !isValidDateKey(to)) return out;
  let key = from;
  let guard = 0;
  while (key <= to && guard < 3660) {
    out.push(key);
    key = addDaysToKey(key, 1);
    guard += 1;
  }
  return out;
}

/**
 * Convert a civil date/time in a zone to an instant.
 *
 * Returns { ms, ambiguous, nonexistent }. When a local time occurs twice
 * (fall-back), the earlier instant is chosen. When it does not exist (spring
 * forward gap), the instant immediately after the gap is chosen.
 */
export function localToInstant(dateKey, timeZone, hour = 0, minute = 0, second = 0) {
  const p = parseDateKey(dateKey);
  if (!p) throw new Error(`Invalid date key: ${dateKey}`);
  const base = Date.UTC(p.year, p.month - 1, p.day, hour, minute, second);
  const offsets = new Set();
  for (const delta of [-2 * DAY_MS, -DAY_MS, DAY_MS, 2 * DAY_MS]) {
    offsets.add(offsetMsAt(base + delta, timeZone));
  }
  offsets.add(offsetMsAt(base, timeZone));
  const matches = [];
  for (const offset of offsets) {
    const candidate = base - offset;
    const cp = zonedParts(candidate, timeZone);
    if (
      cp.year === p.year &&
      cp.month === p.month &&
      cp.day === p.day &&
      cp.hour === hour &&
      cp.minute === minute &&
      cp.second === second
    ) {
      matches.push(candidate);
    }
  }
  if (matches.length === 1) return { ms: matches[0], ambiguous: false, nonexistent: false };
  if (matches.length > 1) {
    return { ms: Math.min(...matches), ambiguous: true, nonexistent: false };
  }
  // Nonexistent civil time: use the offset from before the transition, which
  // lands just after the gap (e.g. 02:30 -> 03:30 on a spring-forward day).
  const beforeOffset = offsetMsAt(base - 2 * DAY_MS, timeZone);
  return { ms: base - beforeOffset, ambiguous: false, nonexistent: true };
}

/**
 * First instant whose local date is `dateKey`.
 *
 * Binary search over local-date monotonicity. This handles zones whose DST
 * transition is at midnight (Santiago/Havana) and 30-minute shifts (Lord Howe)
 * without special cases.
 */
export function startOfDay(dateKey, timeZone) {
  const cacheKey = `${timeZone}|${dateKey}`;
  const cached = dayStartCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const p = parseDateKey(dateKey);
  if (!p) throw new Error(`Invalid date key: ${dateKey}`);
  const utcMidnight = Date.UTC(p.year, p.month - 1, p.day);
  let lo = utcMidnight - 30 * HOUR_MS;
  let hi = utcMidnight + 30 * HOUR_MS;
  if (localDateKey(lo, timeZone) >= dateKey) {
    // Extremely rare (whole calendar day skipped, e.g. Samoa 2011). Step until
    // the date appears, bounded to a week.
    let probe = lo;
    for (let i = 0; i < 24 * 8; i += 1) {
      probe += HOUR_MS;
      if (localDateKey(probe, timeZone) >= dateKey) {
        hi = probe;
        lo = probe - HOUR_MS;
        break;
      }
    }
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDateKey(mid, timeZone) >= dateKey) hi = mid;
    else lo = mid;
  }
  let result = hi;
  if (localDateKey(result, timeZone) !== dateKey) {
    // The day does not exist in this zone; callers should not normally ask for
    // it. Return the first instant after it to keep arithmetic total.
    result = startOfDay(addDaysToKey(dateKey, 1), timeZone);
  }
  dayStartCache.set(cacheKey, result);
  return result;
}

export function endOfDay(dateKey, timeZone) {
  return startOfDay(addDaysToKey(dateKey, 1), timeZone);
}

export function dayLengthMs(dateKey, timeZone) {
  return endOfDay(dateKey, timeZone) - startOfDay(dateKey, timeZone);
}

/** True when the instant's civil time is repeated because clocks fell back. */
export function isAmbiguousLocalTime(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return localToInstant(dateKeyFromParts(p), timeZone, p.hour, p.minute, p.second).ambiguous;
}

/**
 * DST / offset transitions touching the given day keys.
 * Returns [{ date, at, fromOffset, toOffset, dayLengthMs, direction }].
 */
export function transitionsForDays(keys, timeZone) {
  const out = [];
  for (const key of keys) {
    const start = startOfDay(key, timeZone);
    const end = endOfDay(key, timeZone);
    // Compare the offset immediately before the day begins with the offset in
    // force just before it ends. Comparing at the boundaries themselves misses
    // transitions that happen exactly at local midnight (Santiago, Havana).
    const before = offsetMsAt(start - 1000, timeZone);
    const after = offsetMsAt(end - 1000, timeZone);
    const length = end - start;
    if (before === after && length === DAY_MS) continue;
    const cacheKey = `${timeZone}|${key}`;
    let observed = transitionCache.get(cacheKey);
    if (observed === undefined) {
      // Offset changes are monotone in practice within a day. Walk hourly then
      // binary-search the exact second if a change is found. Start one hour
      // before the day so a transition exactly at local midnight is located.
      let prev = offsetMsAt(start - HOUR_MS, timeZone);
      let at = null;
      for (let t = start - HOUR_MS + HOUR_MS; t <= end; t += HOUR_MS) {
        const cur = offsetMsAt(t, timeZone);
        if (cur !== prev) {
          let lo = t - HOUR_MS;
          let hi = t;
          while (hi - lo > 1000) {
            const mid = Math.floor((lo + hi) / 2000) * 1000;
            if (offsetMsAt(mid, timeZone) === prev) lo = mid;
            else hi = mid;
          }
          at = hi;
          break;
        }
        prev = cur;
      }
      observed = at;
      transitionCache.set(cacheKey, at);
    }
    out.push({
      date: key,
      at: observed,
      fromOffset: before,
      toOffset: after,
      dayLengthMs: length,
      direction: before < after ? 'spring-forward' : before > after ? 'fall-back' : 'midnight-shift',
    });
  }
  return out;
}

export const UNITS = { DAY_MS, HOUR_MS };
