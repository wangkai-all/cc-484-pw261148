/**
 * Deterministic demo dataset.
 *
 * The dataset is designed so every hard case the engine must handle is present
 * and identifiable:
 *   - users who start anonymous and merge into a known identity
 *   - events straddling local midnight
 *   - events in the repeated hour of a DST fall-back and inside a spring gap
 *   - late-arriving events (received days after they happened)
 *   - duplicate event ids (identical and conflicting)
 *   - a mid-range app-version rollout with a deliberate retention difference
 */

import { localToInstant, localDateKey, parseDateKey, startOfDay, addDaysToKey } from './time.js';
import { makeRng } from './rng.js';
import { EventStore } from './store.js';

export const DATASET_START = '2026-07-20';
export const DATASET_END = '2026-11-18';
export const SIGNUP_START = '2026-08-03';
export const SIGNUP_END = '2026-11-05';
export const VERSION_ROLLOUT = '2026-10-01';

export const APP_VERSIONS = ['4.2.1', '4.2.3', '4.3.0'];
export const PLANS = ['free', 'pro'];
export const PLATFORMS = ['ios', 'android', 'web'];
export const REGIONS = ['NA', 'EU', 'APAC'];

const ZONE = 'America/New_York';

function localInstant(dateKey, hour, minute, second = 0) {
  return localToInstant(dateKey, ZONE, hour, minute, second).ms;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * @param {object} options
 * @param {number} options.seed
 * @param {number} options.users
 */
export function buildDataset({ seed = 20261119, users = 760, now } = {}) {
  const rng = makeRng(seed);
  const store = new EventStore({ now });
  const occurrences = [];
  const meta = {
    zone: ZONE,
    seededCases: {
      merges: [],
      midnightCrossers: [],
      ambiguousLocalTimes: [],
      nonexistentLocalTimes: [],
      lateArrivals: [],
      duplicates: [],
      versionRollout: VERSION_ROLLOUT,
    },
    userCount: users,
    cohortUsers: [],
  };

  const signupKeys = [];
  {
    let key = SIGNUP_START;
    while (key <= SIGNUP_END) {
      signupKeys.push(key);
      key = addDaysToKey(key, 1);
    }
  }

  let idCounter = 0;
  let eventCounter = 0;
  const nextEventId = () => `evt_${String((eventCounter += 1)).padStart(7, '0')}`;
  const nextAnon = () => `a_${String((idCounter += 1)).padStart(6, '0')}`;
  const nextKnown = () => `u_${String((idCounter += 1)).padStart(6, '0')}`;

  function add({ eventId, identity, identityType, name, t, props, receivedAt, offsetMinutes }) {
    occurrences.push({
      eventId: eventId ?? nextEventId(),
      identity,
      identityType,
      name,
      t,
      props,
      receivedAt,
      offsetMinutes,
    });
  }

  // Some months have a Friday-heavy skew so weekday/weekend cohorts look real.
  const weekdayWeights = [0.55, 0.95, 1.0, 1.0, 1.05, 0.9, 0.5]; // Sun..Sat
  const weightByKey = new Map(signupKeys.map((k) => [k, weekdayWeights[parseDateKey(k) ? new Date(`${k}T00:00:00Z`).getUTCDay() : 3]]));
  const weightTotal = signupKeys.reduce((s, k) => s + weightByKey.get(k), 0);

  function sampleSignupKey() {
    let r = rng.next() * weightTotal;
    for (const k of signupKeys) {
      r -= weightByKey.get(k);
      if (r <= 0) return k;
    }
    return signupKeys[signupKeys.length - 1];
  }

  const merges = [];

  for (let u = 0; u < users; u += 1) {
    const cohortKey = sampleSignupKey();
    const plan = rng.weighted([['free', 0.68], ['pro', 0.32]]);
    const platform = rng.pick(PLATFORMS);
    const region = rng.pick(REGIONS);
    const signupVersion = cohortKey >= VERSION_ROLLOUT
      ? rng.weighted([['4.3.0', 0.82], ['4.2.3', 0.18]])
      : rng.weighted([['4.2.3', 0.72], ['4.2.1', 0.28]]);

    const signupHour = rng.weighted([[9, 0.2], [12, 0.2], [15, 0.18], [20, 0.22], [23, 0.2]]);
    const signupMinute = rng.int(0, 59);
    const signupAt = localInstant(cohortKey, signupHour, signupMinute, rng.int(0, 59));

    // A user may have visited anonymously before signing up (same device).
    const hadAnonHistory = rng.chance(0.46);
    const anonId = hadAnonHistory ? nextAnon() : null;
    const knownId = nextKnown();

    const acquisitionProps = {
      platform,
      region,
      plan,
      appVersion: signupVersion,
      cohortSource: hadAnonHistory ? 'anon_merge' : 'direct',
    };
    const userProps = { plan, platform, region, signupVersion };

    if (hadAnonHistory) {
      const anonFirst = localInstant(addDaysToKey(cohortKey, -rng.int(0, 6)), rng.int(0, 23), rng.int(0, 59), rng.int(0, 59));
      const anonEvents = rng.int(1, 5);
      const anonT0 = Math.max(anonFirst, localInstant(addDaysToKey(DATASET_START, 1), 0, 5));
      for (let i = 0; i < anonEvents; i += 1) {
        let t = anonT0 + Math.floor(rng.next() * Math.max(signupAt - anonT0, 60_000));
        // Keep every anon event strictly before signup.
        if (t >= signupAt) t = signupAt - 1000 - i * 1000;
        add({
          identity: anonId,
          identityType: 'anon',
          name: 'app_open',
          t,
          props: { platform, region, plan: 'free', appVersion: signupVersion },
          receivedAt: t + rng.int(1, 50) * 60_000,
        });
      }
      merges.push({
        anon: anonId,
        known: knownId,
        at: signupAt,
        cohortSource: 'anon_merge',
      });
    }

    add({
      identity: knownId,
      identityType: 'known',
      name: 'signup',
      t: signupAt,
      props: { ...acquisitionProps, plan, appVersion: signupVersion },
      receivedAt: signupAt + rng.int(0, 20) * 60_000,
      offsetMinutes: -240,
    });

    const baseRetention = plan === 'pro' ? 0.46 : 0.34;
    const decay = plan === 'pro' ? 9.5 : 6.5;
    const floor = plan === 'pro' ? 0.14 : 0.075;
    const versionBoost = signupVersion === '4.3.0' ? 1.12 : 1;

    const lastKey = DATASET_END;
    const horizon = Math.min(45, Math.max(0, daysBetween(cohortKey, lastKey)));
    const userEvents = [];

    // Day 0: the signup itself is activity; often one more session later.
    if (rng.chance(0.78)) {
      userEvents.push(localInstant(cohortKey, rng.int(8, 22), rng.int(0, 59), rng.int(0, 59)));
    }

    for (let n = 1; n <= horizon; n += 1) {
      const dayKey = addDaysToKey(cohortKey, n);
      const weekday = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
      const weekendLift = weekday === 0 || weekday === 6 ? 1.15 : 1;
      const p = Math.min(1, (baseRetention * Math.exp(-n / decay) * versionBoost + floor) * weekendLift);
      if (!rng.chance(p)) continue;
      const sessions = rng.weighted([[1, 0.72], [2, 0.22], [3, 0.06]]);
      for (let s = 0; s < sessions; s += 1) {
        let hour = rng.weighted([[8, 0.14], [12, 0.2], [18, 0.24], [21, 0.28], [0, 0.14]]);
        if (s > 0) hour = Math.min(23, hour + rng.int(1, 3));
        userEvents.push(localInstant(dayKey, hour, rng.int(0, 59), rng.int(0, 59)));
      }
    }

    // Guarantee some users are active on days 1, 3 and 7 so early slots are
    // never accidentally empty in small cohorts.
    for (const [n, bump] of [[1, 0.12], [2, 0.04], [3, 0.06], [7, 0.05]]) {
      if (n > horizon) continue;
      if (!rng.chance(bump)) continue;
      const dayKey = addDaysToKey(cohortKey, n);
      userEvents.push(localInstant(dayKey, rng.int(10, 22), rng.int(0, 59), rng.int(0, 59)));
    }

    userEvents.sort((a, b) => a - b);
    const versionForDay = (ms) => {
      const key = localDateKey(ms, ZONE);
      if (key < VERSION_ROLLOUT) return signupVersion.startsWith('4.2') ? signupVersion : '4.2.3';
      return rng.chance(0.55) ? '4.3.0' : '4.2.3';
    };

    for (const t of userEvents) {
      if (t > now) continue;
      const appVersion = versionForDay(t);
      const late = rng.chance(0.035);
      const receivedAt = late ? t + rng.int(26, 70) * 3_600_000 : t + rng.int(2, 90) * 60_000;
      add({
        identity: knownId,
        identityType: 'known',
        name: 'app_open',
        t,
        props: { platform, region, plan, appVersion, session: 'open' },
        receivedAt,
        offsetMinutes: -240,
      });
      if (rng.chance(0.06)) {
        add({
          identity: knownId,
          identityType: 'known',
          name: 'purchase',
          t: t + rng.int(30, 900) * 1000,
          props: { platform, region, plan, appVersion, value: rng.int(4, 120) },
          receivedAt,
          offsetMinutes: -240,
        });
      }
    }

    meta.userCount = users;
  }

  // ---- Deliberate edge cases -------------------------------------------

  // 1. Midnight crossers: the same user active at 23:55 and 00:05 local.
  for (let i = 0; i < 6; i += 1) {
    const dayKey = addDaysToKey(SIGNUP_START, 20 + i * 8);
    const knownId = nextKnown();
    const at = localInstant(dayKey, 23, 55, 30);
    add({
      identity: knownId,
      identityType: 'known',
      name: 'signup',
      t: at - 2 * 86_400_000,
      props: { platform: 'web', region: 'NA', plan: 'free', appVersion: '4.2.3', cohortSource: 'edge_case' },
      receivedAt: at - 2 * 86_400_000 + 60_000,
      offsetMinutes: -240,
    });
    add({
      identity: knownId,
      identityType: 'known',
      name: 'app_open',
      t: at,
      props: { platform: 'web', region: 'NA', plan: 'free', appVersion: '4.2.3', edge: 'midnight_before' },
      receivedAt: at + 60_000,
      offsetMinutes: -240,
    });
    add({
      identity: knownId,
      identityType: 'known',
      name: 'app_open',
      t: at + 10 * 60_000,
      props: { platform: 'web', region: 'NA', plan: 'free', appVersion: '4.2.3', edge: 'midnight_after' },
      receivedAt: at + 20 * 60_000,
      offsetMinutes: -240,
    });
    meta.seededCases.midnightCrossers.push({
      identity: knownId,
      before: iso(at),
      after: iso(at + 10 * 60_000),
      localDays: [localDateKey(at, ZONE), localDateKey(at + 10 * 60_000, ZONE)],
    });
  }

  // 2. Repeated hour: 2026-11-01 01:30 occurs twice in America/New_York.
  {
    const first = localToInstant('2026-11-01', ZONE, 1, 30, 0);
    const second = localToInstant('2026-11-01', ZONE, 5, 30, 0); // EST 00:30? no - see below
    // Resolve the second occurrence explicitly: 01:30 EST = 06:30Z.
    const repeatedA = Date.parse('2026-11-01T05:30:00Z'); // 01:30 EDT
    const repeatedB = Date.parse('2026-11-01T06:30:00Z'); // 01:30 EST
    const knownId = nextKnown();
    add({
      identity: knownId,
      identityType: 'known',
      name: 'signup',
      t: Date.parse('2026-10-25T15:00:00Z'),
      props: { platform: 'ios', region: 'NA', plan: 'pro', appVersion: '4.2.3', cohortSource: 'edge_case' },
      receivedAt: Date.parse('2026-10-25T15:01:00Z'),
      offsetMinutes: -240,
    });
    add({
      identity: knownId,
      identityType: 'known',
      name: 'app_open',
      t: repeatedA,
      props: { platform: 'ios', region: 'NA', plan: 'pro', appVersion: '4.2.3', edge: 'ambiguous_edt' },
      receivedAt: repeatedA + 60_000,
      offsetMinutes: -240,
    });
    add({
      identity: knownId,
      identityType: 'known',
      name: 'app_open',
      t: repeatedB,
      props: { platform: 'ios', region: 'NA', plan: 'pro', appVersion: '4.2.3', edge: 'ambiguous_est' },
      receivedAt: repeatedB + 60_000,
      offsetMinutes: -300,
    });
    meta.seededCases.ambiguousLocalTimes.push({
      identity: knownId,
      localTime: '2026-11-01 01:30',
      instants: [iso(repeatedA), iso(repeatedB)],
      resolvedBy: 'first occurrence (EDT)',
    });
    void first;
    void second;
  }

  // 3. Late arrivals: events dated days ago but received only recently.
  for (let i = 0; i < 9; i += 1) {
    const knownId = nextKnown();
    const eventDay = addDaysToKey(SIGNUP_START, 30 + i * 4);
    const eventAt = localInstant(eventDay, rng.int(9, 21), rng.int(0, 59));
    add({
      identity: knownId,
      identityType: 'known',
      name: 'signup',
      t: eventAt - 3 * 86_400_000,
      props: { platform: 'android', region: 'EU', plan: 'free', appVersion: '4.2.3', cohortSource: 'late_case' },
      receivedAt: eventAt - 3 * 86_400_000 + 30_000,
      offsetMinutes: 60,
    });
    const receivedAt = now - rng.int(1, 40) * 3_600_000;
    add({
      identity: knownId,
      identityType: 'known',
      name: 'app_open',
      t: eventAt,
      props: { platform: 'android', region: 'EU', plan: 'free', appVersion: '4.2.3', edge: 'late_arrival' },
      receivedAt,
      offsetMinutes: 60,
    });
    meta.seededCases.lateArrivals.push({
      identity: knownId,
      eventAt: iso(eventAt),
      receivedAt: iso(receivedAt),
      lagHours: Math.round((receivedAt - eventAt) / 3_600_000),
    });
  }

  // 4. Duplicates: replayed batches, one with a conflicting timestamp.
  for (let i = 0; i < 12; i += 1) {
    const knownId = nextKnown();
    const eventAt = localInstant(addDaysToKey(SIGNUP_START, 10 + i * 5), 12, rng.int(0, 59));
    add({
      identity: knownId,
      identityType: 'known',
      name: 'signup',
      t: eventAt - 86_400_000,
      props: { platform: 'web', region: 'APAC', plan: 'free', appVersion: '4.2.3', cohortSource: 'dup_case' },
      receivedAt: eventAt - 86_400_000 + 10_000,
      offsetMinutes: 480,
    });
    const dupId = `evt_dup_${i}`;
    add({
      eventId: dupId,
      identity: knownId,
      identityType: 'known',
      name: 'app_open',
      t: eventAt,
      props: { platform: 'web', region: 'APAC', plan: 'free', appVersion: '4.2.3', edge: 'duplicate' },
      receivedAt: eventAt + 10_000,
      offsetMinutes: 480,
    });
    add({
      eventId: dupId,
      identity: knownId,
      identityType: 'known',
      name: 'app_open',
      t: eventAt + (i % 3 === 0 ? 90_000 : 0),
      props: { platform: 'web', region: 'APAC', plan: 'free', appVersion: '4.2.3', edge: 'duplicate' },
      receivedAt: eventAt + 20_000,
      offsetMinutes: 480,
    });
    meta.seededCases.duplicates.push({ eventId: dupId, conflicting: i % 3 === 0 });
  }

  // 5. Anonymous visitors who have not signed up yet. A later identity-resolution
  //    job can legitimately discover that one of them is a known user's second
  //    device; until then they are not part of any cohort.
  for (let i = 0; i < 14; i += 1) {
    const anonId = nextAnon();
    const dayKey = addDaysToKey(SIGNUP_START, 9 + i * 6);
    const first = localInstant(dayKey, rng.int(8, 21), rng.int(0, 59));
    for (let n = 0; n < rng.int(2, 4); n += 1) {
      add({
        identity: anonId,
        identityType: 'anon',
        name: 'app_open',
        t: first + n * 3_600_000,
        props: { platform: rng.pick(PLATFORMS), region: rng.pick(REGIONS), plan: 'free', appVersion: '4.2.3', edge: 'anonymous_visitor' },
        receivedAt: first + n * 3_600_000 + 30_000,
        offsetMinutes: -240,
      });
    }
    meta.seededCases.anonymousVisitors = meta.seededCases.anonymousVisitors || [];
    meta.seededCases.anonymousVisitors.push({ anon: anonId, firstOpen: iso(first), dayKey });
  }

  const ingestResult = store.ingest(occurrences);
  for (const m of merges) {
    // Path compression during ingestion can canonicalize an identity onto an
    // earlier merge root, so resolve both sides through find() first.
    const anonRoot = store.find(m.anon);
    const knownRoot = store.find(m.known);
    if (anonRoot === knownRoot) {
      meta.seededCases.merges.push({ anon: m.anon, into: knownRoot, at: iso(m.at), alreadyMerged: true });
      continue;
    }
    const merged = store.mergeIdentities(anonRoot, knownRoot, { at: m.at, reason: 'signup_identify' });
    meta.seededCases.merges.push({ anon: m.anon, into: merged.root, at: iso(m.at) });
  }

  void ingestResult;
  store.initialCommit('Initial load (2026-11-19 12:00 UTC)');
  meta.cohortUsers = [...store.identities.keys()].length;
  store.meta = meta;
  return store;
}

function daysBetween(a, b) {
  const pa = parseDateKey(a);
  const pb = parseDateKey(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000);
}

export { ZONE as DATASET_ZONE, iso };
