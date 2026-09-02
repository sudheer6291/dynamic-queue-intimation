# Dynamic Queue Intimation — Prototype

A clickable prototype that replays one full day of an OPD queue from a
static event log, and compares a naive "people ahead × median time"
estimate against a drift-aware p50/p80 range estimator. No backend, no
database, no auth — everything is derived from JSON at request time in
the browser.

## Running it

Any static file server works — the app is plain ES modules, no build step.

```bash
python3 -m http.server 8080
# open http://localhost:8080/index.html
```

## UI

The interface is built on **Bootstrap 5.3** (navbar, nav-pills, cards,
badges, alerts, list-groups, tables) plus **Bootstrap Icons**, for a
polished, familiar, accessible customer experience out of the box —
color-coded resource/queue status, a phone-frame mock for the patient
screen, a dark ops-console styling for the clock toolbar and display
board, and responsive layouts down to a 390px mobile viewport (with a
collapsing navbar). Both libraries are vendored under `vendor/` (self-hosted,
not loaded from a CDN) — MIT licensed, see `vendor/NOTICE.md` — so the
prototype has no runtime dependency on third-party network availability.
All application logic still targets plain element IDs and a handful of
functional classes (`.speed-btn`, `#entity-select`, …), so the visual
layer can be restyled again without touching `src/engine/`.

## The core idea (§3 of the brief)

There are no screens populated from a fixed snapshot. `data/<vertical>/events.json`
is a full day's append-only event log with timestamps. A virtual clock
(`src/clock.js`) drives every view — play / pause / step / jump / speed
(×1, ×10, ×60, ×180). `deriveState()` (`src/engine/deriveState.js`) is a
pure function of `(events up to now, config)`: scrub to any time and the
queue/resource/entity state at that instant is recomputed from scratch.
That's what makes "it's 11:14, the doctor just stepped out — watch what
every screen does" actually true, not scripted.

## Data layer

Six static JSON files per vertical, under `data/<vertical>/`:
`config.json`, `stations.json`, `resources.json`, `routes.json`,
`entities.json`, `events.json` — matching §4 of the brief. `routes.json`
expresses the chain, including the revisit-to-an-earlier-station case
(lab → back to consultation). `config.json` is also where all UI copy and
vocabulary lives (`locale.strings`), so a vertical swap never touches
application code — see M6 below.

Seed data is authored by small deterministic generator scripts
(`tools/generate-opd-seed.mjs`, `tools/generate-vehicle-seed.mjs`, run
once with `node`, not part of the running app) rather than by hand, so the
day is internally consistent (arrivals, service times, queue positions all
actually add up) while still hitting every scenario in §10:

- doctor starts 18 minutes late (`resource_paused` at day start)
- a 27-minute emergency pause mid-morning — timed to land between two
  consultations, never mid-service, and with a genuine queue backlog
  waiting when it hits (**this is the M2 demo moment**, see below)
- two no-shows, each followed by a `resequence_suggested` → `pull_forward`
  recovery
- one late arrival
- three priority insertions, each with a stated reason
- five entities on the lab-and-return route
- one entity whose total journey exceeds 3 hours (tagged
  `long_journey_gt_3h` in `entities.json`)

## The estimator comparison (§5)

`src/engine/estimator.js` exports two pure functions, switchable from the
Patient view's "Estimator" dropdown:

- **`baselineEstimate`** — what the market ships: `people_ahead ×
  station.service_time.median_min` at the *current* station only. A
  single number. It never looks at `resource_paused` state at all.
- **`proposedEstimate`** — p50/p80 across the entity's *entire remaining
  route* (§4's differentiator — M4's exit criterion), adjusted for:
  - a rolling mean of the last 5 completed services at that station today,
    blended with the station's prior distribution while sample size is low
  - `resource_paused` state, with an explicit reason string and a fallback
    that treats the stated `expected_resume_at` loosely — once a pause
    outlasts its own stated estimate, the remaining-time estimate grows
    with elapsed pause time rather than quietly drifting back to normal
  - conditional route steps (lab, pharmacy) expanded by their prior
    probability until an actual event resolves them, at which point that
    condition becomes certain for every future step sharing it
  - a "bound the update swing" check: a big jump in the headline number
    always carries a reason string, even a generic one

Headline = p80, lower bound = p50 (config-driven, `display.headline_percentile`)
— under-promising is deliberate.

### Try the demo moment yourself

Patient view → pick a token queued for the doctor around late morning →
scrub the clock to **11:30**. Watch the *baseline* estimator sit at **0
min** ("you'll be seen immediately") for the entire 27-minute emergency
pause, because it never looks at resource state. Switch to *proposed* and
it jumps immediately with an explicit reason ("Doctor called away for an
emergency in the ward") and keeps growing for as long as the pause
actually runs — because it's honest about not knowing when it'll end,
rather than trusting a stale guess.

## Screens (§6)

- **Patient view** — token, current station, range estimate (p50–p80,
  labelled "heuristic, not AI"), a "why" line when delayed, and an
  actionable "go to X now" alert (suppressed unless there's real lead
  time — `display.min_lead_time_min`).
- **Front desk** — a multi-station operator console (tabs per station):
  live queue, Call Next → Confirm Arrival → Complete / No-show, priority
  insert, pull-forward, and the live M5 suggestion banners with an Apply
  button. Every button appends real events at the current clock time (and
  auto-pauses the clock first, so a manual action never races the replay).
  Front desk can drive *any* station's queue end to end this way — verified
  by walking a synthetic entity through an entire OPD route (reception →
  consult → lab → revisit → pharmacy → done) using only these actions.
- **Doctor view** — one station, one button. It completes whoever's
  in service (if anyone) and immediately calls the next — literally
  nothing else on the screen. `config.doctor_view_station_id` points it
  at whichever station is this vertical's core value-add step.
- **Admin dashboard** — station load (current vs. baseline vs. proposed),
  no-shows, slots recovered today, mean journey time vs. a configured
  "yesterday" baseline, and today's delay log with reasons.
- **Display board** — now serving / next up / waiting, per station.

## Active re-sequencing (M5, §7)

`src/engine/suggestions.js` computes exactly the two interventions the
brief calls for, live, from derived state (not just replayed from the
seed):

- **on `no_show`**: suggest pulling a waitlisted entity forward to
  recover the freed slot
- **on `resource_paused`** (only when *every* resource at that station is
  paused): suggest sending entities flagged for a configured alternate
  station (`config.resequencing.pause_alt_route`) there first instead of
  idling — e.g. lab-bound patients can get their standing test done while
  the doctor is out

Front Desk surfaces both as a banner with an Apply button; Admin counts
accepted pull-forwards as "slots recovered today."

## M6 — vertical swap: car and bike servicing

Two more verticals, each a fully independent config/seed with zero
application-code changes — same engine, same views, different JSON:

- **`data/car_service/`** — check-in → a 2-technician service bay →
  conditional diagnostic-and-return (the fair transfer test vs. OPD's
  lab-and-return: same shape, different domain) → optional wash →
  billing. Its own dramatic day: both bay technicians start 20 minutes
  late, then — unlike OPD's full-stop pause — just *one* of the two bays
  goes down for 30 minutes mid-day waiting on a delivered part, a
  partial-capacity pause that exercises a code path OPD's single-resource
  station never does (effective capacity drops to 1, not 0). Two
  no-shows, a late arrival, five diagnostic-and-return visits, and one
  job that turns out to be a much bigger repair than expected (tagged
  `long_journey_gt_3h`).
- **`data/bike_service/`** — check-in → a 3-mechanic bay → optional wash
  → billing, deliberately *without* a revisit loop — a faster,
  higher-volume, lower-drama day than either OPD or car servicing, which
  is the point: it's the contrast case showing the estimator's rolling-mean
  adaptation and pause-awareness still work when the shape is simpler.
  One mechanic starts late, another is pulled away mid-day to collect a
  spare part, two no-shows, a late arrival.

Switching the "Vertical" dropdown in the top bar re-renders every screen
immediately. Both new verticals also exercise `capacity > 1` stations
(2 and 3 servers respectively) with genuinely parallel scheduling.

## Checkpoints (§8) — self-assessment

- **No domain words in the engine.** `deriveState.js`, `estimator.js`,
  and `suggestions.js` are clean. `actions.js` (shared action logic, not
  a view) was also cleaned — the doctor-specific action is named
  `actionStationDone`. `app.js` still imports files named `patient.js` /
  `doctor.js` and uses `"patient"` / `"doctor"` as internal routing ids —
  those are the view-layer screen identifiers from §6 of the brief itself
  (view components are explicitly exempted by this checkpoint); all
  user-visible tab labels are pulled from `config.locale.strings`
  (`screen.*` keys), so relabeling them per vertical needs no code change,
  as the car/bike verticals demonstrate ("Customer view", "Bay view").
- **Events are append-only.** Nothing in `deriveState.js` mutates an
  event; state is always rebuilt from the full log up to `now`.
- **Every prediction is logged.** `prediction_shown` events are appended
  (throttled to avoid re-logging an unchanged value every animation
  frame) whenever Patient view computes and displays an estimate —
  visible in that view's own "prediction log" panel.
- **Every delay has a reason string.** `resource_paused` always carries
  `reason_text`; the proposed estimator always surfaces it.
- **Minimum lead time.** The patient-facing "go to X now" alert is
  suppressed unless there's at least `display.min_lead_time_min` of
  actual slack to act on it.
- **Bounded update swing.** A jump in the proposed headline beyond
  `display.max_swing_per_update_min` always carries a reason string.
- **Degrade honestly.** An entity that hasn't arrived yet, or has already
  finished/no-showed, shows an explicit state rather than a number
  (`estimate.not_available`, done, no-show).
- **Accessibility floor.** Large type (17px root), high contrast, no
  build step or app install, plain CSS (flex/grid, no fixed pixel
  layouts) — verified at a 390px mobile viewport.
- **Locale from day one.** English and Hindi are both wired end-to-end
  through `config.locale.strings`, verified working, not just declared.

## Out of scope (§9)

No login/roles, no database, no HIS/EMR integration, no real SMS/WhatsApp
(the patient view is a rendered phone-frame mock instead), no ML, no
billing, no native apps — as specified.

## Regenerating seed data

```bash
node tools/generate-opd-seed.mjs    # data/opd/{entities,events}.json
node tools/generate-car-seed.mjs    # data/car_service/{entities,events}.json
node tools/generate-bike-seed.mjs   # data/bike_service/{entities,events}.json
```

All three are deterministic (seeded PRNG) — re-running produces the same
day. `tools/seedkit.mjs` holds the shared multi-resource FIFO station
simulator (pause/priority/no-show support, including pauses triggered
dynamically after a resource's Nth completion so they can never land
mid-service) used by the car and bike generators; OPD's generator predates
it and keeps its own inline version.

A note on two bugs this uncovered along the way, in case you're extending
a vertical yourself: (1) a station transition only exists in derived state
if the generator emits an explicit `queue_joined` event for it — the
in-memory arrival list you feed a simulator only drives *that simulator's*
own scheduling, not the log; and (2) a pause window handed to the scheduler
for timing purposes still needs its own `resource_paused`/`resource_resumed`
events, or the state engine never finds out it happened. Both classes of
bug are easy to introduce when hand-rolling a new station chain and easy to
miss visually (the day still "runs," just with an empty-looking queue or
a missing delay banner) — worth specifically checking for after any new
generator script.
