/**
 * Zero-dependency HTTP server for the retention dashboard and JSON API.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIGNUP_END, SIGNUP_START, buildDataset } from './dataset.js';
import { RetentionEngine } from './engine.js';
import { REVISION_KINDS, reviseBackfill, reviseDeleteEvent, reviseMergeIdentities, reviseSegmentRule, reviseShiftEvent } from './revisions.js';
import { FIXED_NOW } from './store.js';
import { formatOffset, isValidDateKey, keyRange, localDateKey, offsetMsAt, zonedParts } from './time.js';
import { dayOffsetOf, resolveZones } from './retention.js';

/**
 * Day offset for each event under one convention, relative to the user's own
 * cohort entry. This is the "verify by hand" view for boundary cases.
 */
function buildCaseCatalog(store) {
  const cases = [];
  const sc = store.meta.seededCases;
  const first = (list) => list?.[0] ?? null;
  const known = (list, index = 0) => list?.[index]?.identity ?? null;
  const midnight = first(sc.midnightCrossers);
  if (midnight) {
    cases.push({
      id: 'midnight',
      kind: 'Cross-day',
      title: '23:55 → 00:05 local',
      description: 'One session spans local midnight in the business zone. Any convention whose day boundary falls between the two events splits them across two days; the elapsed-time window does not. Change a zone and watch which row separates.',
      identity: midnight.identity,
    });
  }
  const ambiguous = first(sc.ambiguousLocalTimes);
  if (ambiguous) {
    cases.push({
      id: 'repeat-hour',
      kind: 'DST repeated hour',
      title: '01:30 happens twice',
      description: 'On 2026-11-01 America/New_York falls back. Both 01:30 instants are the same civil day, so a 25-hour day still counts once — but only for a zone that observes the transition.',
      identity: ambiguous.identity,
    });
  }
  const late = first(sc.lateArrivals);
  if (late) {
    cases.push({
      id: 'late',
      kind: 'Late arrival',
      title: 'Event received weeks later',
      description: 'The event time is in September but it only reached the warehouse in November. Include vs settled changes whether it counts.',
      identity: late.identity,
    });
  }
  const duplicate = first(sc.duplicates);
  if (duplicate) {
    cases.push({
      id: 'duplicate',
      kind: 'Duplicate id',
      title: 'Replayed event id',
      description: 'The same event id arrived twice. First write wins; the conflicting replay is counted and surfaced.',
      identity: null,
    });
  }
  const merge = first(sc.merges);
  if (merge) {
    cases.push({
      id: 'merge',
      kind: 'Identity merge',
      title: 'Anonymous history adopted',
      description: 'Activity under an anonymous id that predates signup is attributed to the known user after the merge. Pre-entry activity lands before day 0 and cannot form a phantom cohort.',
      identity: merge.into,
    });
  }
  const visitor = first(sc.anonymousVisitors);
  if (visitor) {
    cases.push({
      id: 'anon-visitor',
      kind: 'Anonymous only',
      title: 'Never identified',
      description: 'Activity with no signup event: counted in the sample ledger, excluded from every cohort.',
      identity: visitor.anon,
    });
  }
  void known;
  return cases;
}

function engineOffsetTable(events, convention, reportingZone, businessZone) {
  const zones = resolveZones(convention, reportingZone, businessZone);
  const entry = events.find((e) => e.name === 'signup') ?? events[0];
  if (!entry) return new Map();
  const cohortKey = localDateKey(entry.t, zones.cohortZone);
  const anchor = convention === 'rolling24h' ? entry.t : null;
  const table = new Map();
  for (const e of events) {
    table.set(e.eventId, {
      cohortKey,
      offset: dayOffsetOf(e.t, cohortKey, zones, anchor),
    });
  }
  return table;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 4173);

const STORE = buildDataset({ now: FIXED_NOW });
const ENGINE = new RetentionEngine(STORE);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** Accept both ?segments=... JSON and flat ?plan=free&platform=ios parameters. */
function configFromQuery(searchParams) {
  const config = {};
  for (const [key, value] of searchParams) {
    if (key === 'segments') {
      try {
        config.segments = JSON.parse(value);
      } catch {
        throw new Error('segments must be a JSON object');
      }
    } else if (key === 'days' || key === 'version' || key === 'asOf' || key === 'lateGraceHours') {
      config[key] = value === 'latest' ? 'latest' : Number(value);
    } else if (key === 'latePolicy' || key === 'convention' || key === 'reportingZone' || key === 'businessZone') {
      config[key] = value;
    } else if ((key === 'plan' || key === 'platform' || key === 'region' || key === 'appVersion' || key === 'cohortSource') && value) {
      config.segments = config.segments || {};
      config.segments[key] = value.split(',').filter(Boolean);
    }
  }
  if (config.asOf === undefined) config.asOf = STORE.now;
  return config;
}

function validateConfig(config) {
  const errors = [];
  if (config.from !== undefined && !isValidDateKey(config.from)) errors.push('from must be YYYY-MM-DD');
  if (config.to !== undefined && !isValidDateKey(config.to)) errors.push('to must be YYYY-MM-DD');
  if (config.from && config.to && config.from > config.to) errors.push('from must not be after to');
  if (config.from && config.to && keyRange(config.from, config.to).length > 400) errors.push('range is limited to 400 days');
  if (config.version !== undefined && config.version !== 'latest') {
    const v = Number(config.version);
    if (!Number.isInteger(v) || !STORE.getSnapshot(v)) errors.push(`unknown version: ${config.version}`);
  }
  if (config.convention && !['calendar', 'rolling24h', 'business'].includes(config.convention)) {
    errors.push('convention must be calendar, rolling24h or business');
  }
  return errors;
}

const ROUTES = {
  'GET /api/bootstrap': () => {
    const zones = new Set(['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Kolkata', 'Australia/Sydney', 'Australia/Lord_Howe', 'America/Santiago', 'Pacific/Auckland']);
    return {
      dataset: { ...STORE.datasetStats(), signupStart: SIGNUP_START, signupEnd: SIGNUP_END },
      now: STORE.now,
      nowIso: new Date(STORE.now).toISOString(),
      todayLocal: localDateKey(STORE.now, 'America/New_York'),
      versions: STORE.latestVersions(30),
      zones: [...zones].sort(),
      conventions: [
        { id: 'calendar', label: 'Natural day', hint: 'Calendar days in the reporting time zone. A DST day is still one day.' },
        { id: 'rolling24h', label: 'Rolling 24h', hint: '24-hour windows anchored at each user’s first event.' },
        { id: 'business', label: 'Business time zone', hint: 'Calendar days in a chosen business zone, with 23h/25h DST days.' },
      ],
      seededCases: STORE.meta.seededCases,
      cases: buildCaseCatalog(STORE),
      lateGraceHours: 72,
      activityEvents: ['signup', 'app_open', 'purchase'],
      cohortEvents: [
        { id: 'signup', label: 'Signup', hint: 'Cohort every user by first signup.' },
        { id: 'app_open', label: 'First app open', hint: 'Cohort by first open, including anonymous sessions that later merge.' },
        { id: 'purchase', label: 'First purchase', hint: 'Cohort only users who purchased; small cohorts, useful for rule changes.' },
      ],
      dimensions: ['plan', 'platform', 'region', 'appVersion', 'cohortSource'],
      revisionKinds: REVISION_KINDS,
    };
  },

  'POST /api/report': async (req) => {
    const body = await readBody(req);
    const config = { ...body, asOf: body.asOf ?? STORE.now };
    const errors = validateConfig(config);
    if (errors.length) return { status: 400, body: { error: 'invalid_config', details: errors } };
    const report = ENGINE.build(config);
    return { body: report };
  },

  'POST /api/diff': async (req) => {
    const body = await readBody(req);
    const a = Number(body.a);
    const b = Number(body.b);
    const errors = validateConfig(body);
    if (!Number.isInteger(a) || !STORE.getSnapshot(a)) errors.push('a must be a known version');
    if (!Number.isInteger(b) || !STORE.getSnapshot(b)) errors.push('b must be a known version');
    if (errors.length) return { status: 400, body: { error: 'invalid_config', details: errors } };
    return { body: ENGINE.diffVersions(body, a, b) };
  },

  'POST /api/revisions': async (req) => {
    const body = await readBody(req);
    const kind = String(body.kind || '');
    const handlers = {
      delete: reviseDeleteEvent,
      shift: reviseShiftEvent,
      restate: reviseSegmentRule,
      backfill: reviseBackfill,
      merge: reviseMergeIdentities,
    };
    if (!handlers[kind]) {
      return { status: 400, body: { error: 'unknown_revision', details: [`kind must be one of ${REVISION_KINDS.join(', ')}`] } };
    }
    let revision;
    try {
      revision = handlers[kind](STORE, body.args || {});
    } catch (err) {
      return { status: 409, body: { error: 'revision_rejected', details: [err.message] } };
    }
    ENGINE.invalidateVersionsFrom(STORE.version);
    const recompute = ENGINE.build({ ...(body.config || {}), asOf: STORE.now }).recompute;
    return {
      body: {
        revision: {
          version: revision.version,
          label: revision.label,
          kind: revision.kind,
          summary: revision.summary,
          affectedUsers: revision.affectedUsers.length,
        },
        recompute,
        dataset: { ...STORE.datasetStats(), signupStart: SIGNUP_START, signupEnd: SIGNUP_END },
        versions: STORE.latestVersions(30),
      },
    };
  },

  'POST /api/reset': async () => {
    const fresh = buildDataset({ now: FIXED_NOW });
    STORE.events = fresh.events;
    STORE.identities = fresh.identities;
    STORE.parent = fresh.parent;
    STORE.deleted = fresh.deleted;
    STORE.history = fresh.history;
    STORE.revisions = fresh.revisions;
    STORE.version = fresh.version;
    STORE.ledger = fresh.ledger;
    STORE.mergeLog = fresh.mergeLog;
    STORE.seq = fresh.seq;
    STORE.meta = fresh.meta;
    ENGINE.versionData.clear();
    ENGINE.historicalCache.clear();
    ENGINE.states.clear();
    return { body: { ok: true, dataset: STORE.datasetStats(), versions: STORE.latestVersions(30) } };
  },

  'POST /api/compare': async (req) => {
    const body = await readBody(req);
    const config = { ...body, asOf: body.asOf ?? STORE.now };
    const errors = validateConfig(config);
    if (errors.length) return { status: 400, body: { error: 'invalid_config', details: errors } };
    const out = {};
    for (const convention of ['calendar', 'rolling24h', 'business']) {
      const report = ENGINE.build({ ...config, convention });
      out[convention] = {
        label: report.meta.conventionLabel,
        slotZone: report.meta.slotZone,
        aggregates: report.aggregates,
        cohortUsers: report.meta.cohortUsers,
        cohortCount: report.meta.cohortCount,
        recompute: report.recompute,
      };
    }
    return { body: out };
  },

  'GET /api/case': (req, url) => {
    const id = url.searchParams.get('identity');
    if (!id || !STORE.identities.has(id)) return { status: 404, body: { error: 'not_found' } };
    // Use the report's live zones so the case rows match the matrix the user is
    // looking at, rather than a hardcoded default.
    const reportingZone = url.searchParams.get('reportingZone') || 'UTC';
    const businessZone = url.searchParams.get('businessZone') || 'America/New_York';
    const cohortEvent = url.searchParams.get('cohortEvent') || 'signup';
    const root = STORE.find(id);
    const eventList = STORE.eventsOfUser(root).sort((a, b) => a.t - b.t);
    const entry = eventList.find((e) => e.name === cohortEvent) ?? eventList[0];
    const perConvention = {};
    for (const convention of ['calendar', 'rolling24h', 'business']) {
      perConvention[convention] = engineOffsetTable(eventList, convention, reportingZone, businessZone);
    }
    const events = eventList.map((e) => {
      const p = zonedParts(e.t, reportingZone);
      return {
        eventId: e.eventId,
        name: e.name,
        t: e.t,
        iso: new Date(e.t).toISOString(),
        local: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`,
        offsetLabel: formatOffset(offsetMsAt(e.t, reportingZone)),
        receivedAt: e.receivedAt,
        receivedIso: new Date(e.receivedAt).toISOString(),
        lagHours: Math.round(((e.receivedAt - e.t) / 3_600_000) * 10) / 10,
        identity: e.identity,
        identityType: e.identityType,
        props: e.props,
        offsets: Object.fromEntries(
          Object.entries(perConvention).map(([conv, table]) => [conv, table.get(e.eventId) ?? null]),
        ),
      };
    });
    return {
      body: {
        identity: id,
        canonicalUser: root,
        reportingZone,
        businessZone,
        cohortEvent,
        knownIdentities: [...new Set(events.map((e) => e.identity))],
        entryAt: entry ? new Date(entry.t).toISOString() : null,
        events,
      },
    };
  },
};

async function serveStatic(req, res, pathname) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(WEB_ROOT, safe === '/' ? 'index.html' : safe);
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // SPA fallback for unknown paths without an extension.
    if (!path.extname(pathname)) filePath = path.join(WEB_ROOT, 'index.html');
    else {
      res.writeHead(404).end('Not found');
      return;
    }
  }
  try {
    const ext = path.extname(filePath).toLowerCase();
    const info = await stat(filePath);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': info.size,
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const routeKey = `${req.method} ${url.pathname}`;
  const route = ROUTES[routeKey];

  if (url.pathname.startsWith('/api/')) {
    if (!route) return sendJson(res, 404, { error: 'unknown_route' });
    try {
      const result = await route(req, url);
      if (result && typeof result.status === 'number' && result.body !== undefined) {
        return sendJson(res, result.status, result.body);
      }
      return sendJson(res, 200, result?.body ?? result);
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'internal_error', details: [err.message] });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  return serveStatic(req, res, url.pathname);
});

export function start(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, () => {
      const actual = server.address().port;
      resolve({ server, port: actual });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start().then(({ port }) => {
    console.log(`Retention Studio → http://localhost:${port}`);
    console.log(`Dataset: ${STORE.events.size} events, ${STORE.identities.size} identities, version ${STORE.version}`);
  });
}

export { server, ENGINE, STORE, configFromQuery, readFile };
