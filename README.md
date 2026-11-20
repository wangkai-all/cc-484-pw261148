# Retention Studio

Cohort retention analysis where the day definition is an explicit choice, not an
accident. Three conventions run over the same events, every exclusion is
accounted for, and a data revision recomputes only the cohorts it touched.

```
npm start          # http://localhost:4173
npm test           # node --test, 42 tests
```

Zero dependencies. Node 22+ (uses `Intl.DateTimeFormat` for IANA zones). No build
step: `web/` is served as-is.

## The three conventions

| Convention | Cohort day | Day *N* window | DST behaviour |
|---|---|---|---|
| `calendar` — natural day | civil date in the **reporting** zone | local midnight → next local midnight | 23h / 25h days; a DST day is still one day |
| `rolling24h` | civil date of the user's entry instant | entry instant + 24h × *N* | none — elapsed time only |
| `business` | civil date in the **business** zone | local midnight → next local midnight | same as calendar, but in the business zone |

Rolling 24h exists to answer a different question: it is anchored at each user's
own first cohort event, so "day 1" is the first 24 hours after that person
arrived, not the next calendar date. A user who signs up at 23:50 counts 00:10
the following morning as day 0 under calendar but as day 0 under rolling too —
the divergence appears a day later, which is why the convention comparison chart
matters more than any single number.

The cohort rule itself is configurable (`Cohort on`: signup / first app open /
first purchase). Changing it re-cohorts the entire report, and the sample ledger
shows exactly what fell out.

## What the sample ledger reconciles

`sample-ledger` accounts for every identity in the dataset, and the arithmetic
closes:

```
identities in dataset
  −  no qualifying cohort event
  −  outside the selected segment
  −  cohort outside the report date range
  =  cohort users in report
```

Below it, events are classified rather than silently dropped: duplicates whose
payloads agreed (`first write wins`), duplicates that disagreed (kept, flagged),
malformed records rejected at ingest, events after the `asOf`, events beyond the
late-arrival policy, activity past the horizon, pre-cohort activity adopted from
merged anonymous identities, and repeat activity within one day slot (deduped
for rates but kept for event counts).

## Handle with care: the edge cases in the seed

The dataset is deterministic (seed `20261119`, fixed `now` 2026-11-19T12:00Z) and
contains every case named in the brief. The **Boundary cases** panel opens any of
them and shows each event's day offset under all three conventions side by side,
highlighting rows where the conventions disagree:

- **Cross-day** — a session from 23:55 to 00:05 local.
- **Repeated hour** — 2026-11-01 fall-back in `America/New_York`; 01:30 occurs
  twice, the day is 25 hours long.
- **Late arrival** — an event-time in September that reached the warehouse in
  November. `Include` counts it by event time; `Settled 72h` drops it.
- **Duplicate id** — a replayed id (first write wins) plus conflicting replays.
- **Identity merge** — pre-signup anonymous activity adopted by the known user,
  so it cannot form a phantom cohort.
- **Anonymous only** — activity with no cohort event: counted in the ledger,
  excluded from every cohort.

DST is handled by binary-searching real UTC offsets, so 23h/25h days,
midnight transitions (`America/Santiago`), half-hour shifts
(`Australia/Lord_Howe`) and skipped calendar days (`Pacific/Apia`, 2011-12-30)
all resolve correctly. `test/time.test.js` asserts each.

## Incremental recomputation

Every mutation commits an immutable version snapshot carrying
`affectedUsers`. The engine keys live state by report shape only, so a revision
marks those users' cohorts dirty and rebuilds just those:

```
restate plan for one cohort   → recomputed 1 of 95 cohorts
delete one event              → recomputed 1 of 95 cohorts
backfill two cohorts          → recomputed 2 of 95 cohorts
merge an anonymous identity   → recomputed 1 of 95 cohorts
```

Each revision is also checked against a cold rebuild: the test suite applies
all five revisions and asserts the incrementally-updated report is byte-identical
to one built by a fresh engine, cohort by cohort and day by day.

The revisions panel shows the readout after each action. Historical reports are
reproducible from a snapshot; selecting a version diffs it against its
predecessor. The diff reports both kinds of movement — active users per
cohort-day, and restated entry attributes (`plan: pro +3, free -3`) — because a
segment restatement changes composition without moving anyone between cohorts.

Observability is bounded by `asOf` only. The `to` date chooses which cohorts are
listed; it does not truncate how far each one is followed, so a single-day range
still shows days 1–14. If the requested horizon has not happened yet, the hero
falls back to the last observable day and says so.

## Layout

```
src/time.js         IANA zone math, day boundaries, DST transitions
src/retention.js    convention → zone resolution, slot arithmetic, anchors
src/store.js        event store, union-find identities, snapshots, ledger
src/dataset.js      deterministic seeded dataset with the edge cases
src/engine.js       summarisation, cohorts, incremental sync, diffs
src/revisions.js    the five named revisions
src/server.js       HTTP API + static serving
web/                dashboard (no framework, no build)
test/               42 tests: DST, conventions, incremental, revisions
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/bootstrap` | zones, conventions, cohort rules, versions, seeded cases |
| POST | `/api/report` | one convention's full report |
| POST | `/api/compare` | all three conventions at once |
| POST | `/api/diff` | per-cohort deltas between two versions |
| POST | `/api/revisions` | apply `delete`/`shift`/`restate`/`backfill`/`merge` |
| POST | `/api/reset` | restore the seeded dataset |
| GET | `/api/case?identity=` | per-event offsets under all three conventions |

Report body fields: `convention`, `reportingZone`, `businessZone`, `from`, `to`,
`days`, `cohortEvent`, `latePolicy` (`include`/`settled`), `lateGraceHours`,
`segments`, `asOf`, `version`.
