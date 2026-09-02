// Deterministic seed-data generator for the OPD prototype day.
// Produces data/opd/entities.json and data/opd/events.json.
// Run with: node tools/generate-opd-seed.mjs
//
// This script is a one-time authoring tool, not part of the running app.
// The app only ever reads the static JSON it produces.

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { injectStepOutDemo } from "./seedkit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data", "opd");

// ---------- deterministic PRNG ----------
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260902);

const DATE = "2026-09-02";
const TZ = "+05:30";
const DAY_START_MIN = 8 * 60; // 08:00

function toISO(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${DATE}T${hh}:${mm}:00${TZ}`;
}

// ---------- sampling helpers ----------
// Sample a duration such that ~50% of samples land near `median`
// and ~80% land at or below `p80`, with an occasional long tail.
function sampleDuration(median, p80) {
  const r = rand();
  if (r < 0.5) {
    // 0.55x .. 1.0x of median
    return median * (0.55 + 0.45 * rand());
  } else if (r < 0.85) {
    // between median and p80
    return median + (p80 - median) * rand();
  } else {
    // occasional long tail beyond p80
    return p80 + (p80 - median) * rand() * 1.4;
  }
}

// ---------- entity roster ----------
const N = 45;
const PRIORITY_IDX = new Set([5, 22, 38]); // 0-based
const NO_SHOW_IDX = new Set([10, 30]);
const LATE_ARRIVAL_IDX = 20;
const LAB_IDX = new Set([4, 12, 19, 27, 41]); // exactly 5 -> lab-and-return route
const LONG_JOURNEY_TARGET_IDX = 4; // will be nudged to exceed 3h total journey

const entities = [];
for (let i = 0; i < N; i++) {
  const idx = i; // 0-based
  const baseArrival = DAY_START_MIN + i * 9 + Math.round((rand() - 0.5) * 4);
  const isLate = idx === LATE_ARRIVAL_IDX;
  const scheduledArrival = baseArrival;
  const actualArrival = isLate ? baseArrival + 25 : baseArrival;
  const isLab = LAB_IDX.has(idx);
  const medicinePrescribed = rand() < 0.7;

  entities.push({
    id: `e${String(idx + 1).padStart(2, "0")}`,
    display_token: `T-${String(idx + 1).padStart(2, "0")}`,
    route_id: "route_standard",
    scheduled_arrival_min: scheduledArrival,
    actual_arrival_min: actualArrival,
    is_late_arrival: isLate,
    is_priority: PRIORITY_IDX.has(idx),
    is_no_show_candidate: NO_SHOW_IDX.has(idx),
    lab_ordered: isLab,
    pre_flagged_lab: isLab, // known ahead of consult (e.g. standing lab referral) so front desk can pre-route
    medicine_prescribed: medicinePrescribed,
    scenario_tags: []
  });
}
// (the long-journey scenario tag is assigned after simulation, once we know
// which entity's journey actually ended up exceeding 3 hours)

// priority reasons / no-show narrative text (seed-only, plain text is fine here)
const PRIORITY_REASONS = [
  "Senior citizen (68y) — priority assistance",
  "Reported acute chest discomfort — triaged urgent by nurse",
  "Doctor requested priority follow-up on yesterday's case"
];
let priorityReasonCursor = 0;
function nextPriorityReason() {
  return PRIORITY_REASONS[priorityReasonCursor++ % PRIORITY_REASONS.length];
}

// ---------- resource pause windows (minutes since midnight) ----------
// The late start is a fixed clock window (nothing is being served yet at
// day start, so it can't land mid-consultation). The emergency pause is
// triggered dynamically, right after a service *completes*, so it never
// interrupts an in-progress consultation — see EMERGENCY_TRIGGER_COUNT below.
const DOCTOR_PAUSES = [
  {
    start: DAY_START_MIN,
    end: DAY_START_MIN + 18,
    reason_key: "doctor_late_start",
    reason_text: "Doctor arriving later than scheduled",
    expected_resume_stated_min: DAY_START_MIN + 12 // initial guess understates it
  }
];
const EMERGENCY_TRIGGER_COUNT = 20; // doctor's Nth completed service today
const EMERGENCY_DURATION_MIN = 27;
let emergencyTriggered = false;
let doctorServiceCount = 0;

function nextFreeTime(fromMin, pauses) {
  let t = fromMin;
  let moved = true;
  while (moved) {
    moved = false;
    for (const p of pauses) {
      if (t >= p.start && t < p.end) {
        t = p.end;
        moved = true;
      }
    }
  }
  return t;
}

// ---------- event log ----------
const events = [];
let seq = 0;
function emit(type, ts_min, fields) {
  seq += 1;
  events.push({
    id: `ev${String(seq).padStart(4, "0")}`,
    type,
    ts: toISO(ts_min),
    ts_min,
    ...fields
  });
}

// entity_registered for everyone at their actual arrival time
for (const e of entities) {
  emit("entity_registered", e.actual_arrival_min, {
    entity_id: e.id,
    display_token: e.display_token,
    route_id: e.route_id,
    priority: e.is_priority
  });
  emit("queue_joined", e.actual_arrival_min, {
    entity_id: e.id,
    station_id: "st_reception",
    step_index: 0
  });
}

// doctor pause events (environmental, always scripted)
for (const p of DOCTOR_PAUSES) {
  emit("resource_paused", p.start, {
    resource_id: "res_doctor_1",
    station_id: "st_opd_gen",
    reason_key: p.reason_key,
    reason_text: p.reason_text,
    expected_resume_at: toISO(p.expected_resume_stated_min)
  });
  emit("resource_resumed", p.end, {
    resource_id: "res_doctor_1",
    station_id: "st_opd_gen",
    actual_duration_min: p.end - p.start
  });
}

// ---------- generic single-resource FIFO station simulator ----------
// queue: array of entity ids waiting, in order.
// Handles: priority reorder (flag-driven), no-show + pull-forward recovery,
// resource pause windows. Emits called/service_started/service_completed/no_show
// /priority_insert/resequence_suggested/pull_forward, and returns a map of
// entityId -> completion time (minutes) plus each entity's service duration.
function simulateStation({
  stationId,
  resourceId,
  arrivals, // [{entityId, atMin}] sorted or not
  serviceTimeFor, // (entityId) => {median, p80}
  pauses = [],
  entityFlags, // Map entityId -> {isPriority, isNoShowCandidate}
  priorityApplied, // Set to mark priority already inserted
  noShowResolved, // Set to mark no-show already resolved
  minGapAfterArrival = 0
}) {
  const queue = [];
  const pending = arrivals.slice().sort((a, b) => a.atMin - b.atMin);
  let resourceFreeAt = pauses.length ? nextFreeTime(0, pauses) : 0;
  const completions = {}; // entityId -> {completeMin, durationMin}
  let pendingIdx = 0;

  // helper: admit all arrivals with atMin <= t into queue
  function admitUpTo(t) {
    while (pendingIdx < pending.length && pending[pendingIdx].atMin <= t) {
      queue.push(pending[pendingIdx].entityId);
      pendingIdx += 1;
    }
  }

  // helper: pick index to serve next, applying priority rule
  function pickNextIndex() {
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      const flags = entityFlags.get(id);
      if (flags && flags.isPriority && !priorityApplied.has(id)) {
        return i;
      }
    }
    return 0;
  }

  let clock = 0;
  // drive the simulation: admit arrivals as we go, serve while queue non-empty
  while (pendingIdx < pending.length || queue.length > 0) {
    if (queue.length === 0) {
      // fast-forward to next arrival
      clock = pending[pendingIdx].atMin;
      admitUpTo(clock);
      continue;
    }
    admitUpTo(Math.max(clock, resourceFreeAt));
    const startCandidate = nextFreeTime(Math.max(resourceFreeAt, clock), pauses);
    admitUpTo(startCandidate);

    const idx = pickNextIndex();
    const entityId = queue[idx];
    const flags = entityFlags.get(entityId) || {};
    const startAt = startCandidate;

    if (flags.isPriority && !priorityApplied.has(entityId) && idx !== 0) {
      emit("priority_insert", startAt - 1, {
        entity_id: entityId,
        station_id: stationId,
        reason: nextPriorityReason()
      });
    }
    priorityApplied.add(entityId);
    queue.splice(idx, 1);

    if (flags.isNoShowCandidate && !noShowResolved.has(entityId)) {
      // call them, wait a grace period, mark no-show
      const grace = 4;
      emit("called", startAt, { entity_id: entityId, station_id: stationId, resource_id: resourceId });
      emit("no_show", startAt + grace, { entity_id: entityId, station_id: stationId });
      noShowResolved.add(entityId);
      resourceFreeAt = startAt + grace;

      emit("resequence_suggested", startAt + grace, {
        suggestion: "pull_forward",
        reason_key: "no_show_gap",
        station_id: stationId,
        related_entity_id: entityId,
        accepted: true
      });
      // pull a waiting entity (a few slots back) to the front to recover the slot
      admitUpTo(resourceFreeAt);
      if (queue.length > 0) {
        const pullIdx = Math.min(2, queue.length - 1);
        const [pulledId] = queue.splice(pullIdx, 1);
        queue.unshift(pulledId);
        emit("pull_forward", startAt + grace + 1, {
          entity_id: pulledId,
          station_id: stationId,
          reason: "Recovering slot freed by no-show"
        });
      }
      clock = resourceFreeAt;
      continue;
    }

    const { median, p80 } = serviceTimeFor(entityId);
    const duration = Math.max(1, Math.round(sampleDuration(median, p80)));
    emit("called", startAt, { entity_id: entityId, station_id: stationId, resource_id: resourceId });
    emit("service_started", startAt, { entity_id: entityId, station_id: stationId, resource_id: resourceId });
    const completeAt = startAt + duration;
    emit("service_completed", completeAt, {
      entity_id: entityId,
      station_id: stationId,
      resource_id: resourceId,
      duration_min: duration
    });
    completions[entityId] = { completeMin: completeAt, durationMin: duration };
    resourceFreeAt = completeAt;
    clock = completeAt;
  }
  return completions;
}

// ---------- 1. Reception ----------
const receptionArrivals = entities.map((e) => ({ entityId: e.id, atMin: e.actual_arrival_min }));
const receptionFlags = new Map(entities.map((e) => [e.id, { isPriority: false, isNoShowCandidate: false }]));
const receptionCompletions = simulateStation({
  stationId: "st_reception",
  resourceId: "res_reception_1",
  arrivals: receptionArrivals,
  serviceTimeFor: () => ({ median: 3, p80: 6 }),
  pauses: [],
  entityFlags: receptionFlags,
  priorityApplied: new Set(),
  noShowResolved: new Set()
});

// ---------- 1.5. Doctor's Secretary ----------
// The realistic hand-off checkpoint between "checked in" and "actually
// seeing the doctor": confirms the appointment and applies triage/priority
// ordering before the file reaches the doctor's queue. Uses fractional
// step_index 0.5 (between reception's 0 and opd_gen's 1) specifically so
// this insertion never has to renumber lab/pharmacy's existing step_index
// values downstream — deriveState/actions.js only need step_index to be
// strictly increasing along a route, not contiguous integers.
for (const [entityId, c] of Object.entries(receptionCompletions)) {
  emit("queue_joined", c.completeMin, { entity_id: entityId, station_id: "st_secretary", step_index: 0.5 });
}
const secretaryArrivals = Object.entries(receptionCompletions).map(([entityId, c]) => ({ entityId, atMin: c.completeMin }));
// priority ordering is genuinely this role's job in a real OPD — it's who
// actually decides whose file goes in to the doctor next — so it (unlike
// no-show, which stays modeled only at the doctor's own call) applies here.
const secretaryFlags = new Map(entities.map((e) => [e.id, { isPriority: e.is_priority, isNoShowCandidate: false }]));
const secretaryCompletions = simulateStation({
  stationId: "st_secretary",
  resourceId: "res_secretary_1",
  arrivals: secretaryArrivals,
  serviceTimeFor: () => ({ median: 3, p80: 5 }),
  pauses: [],
  entityFlags: secretaryFlags,
  priorityApplied: new Set(),
  noShowResolved: new Set()
});

// ---------- 2 & 3. Doctor (opd_gen) shared queue for first-visit AND revisit, interleaved with lab ----------
// We run this as a manual event-driven loop since opd_gen depends on lab completions.
const opdFlags = new Map(
  entities.map((e) => [e.id, { isPriority: e.is_priority, isNoShowCandidate: e.is_no_show_candidate }])
);
const opdPriorityApplied = new Set();
const opdNoShowResolved = new Set();

// arrivals into opd_gen queue: first-visit arrivals come from the
// secretary's completions (known up front, since the secretary station
// runs to completion before this loop starts). Revisit arrivals come from
// lab completions (not known up front) -> we simulate opd_gen and lab
// together, station by station in small time-ordered batches.
const firstVisitArrivals = entities
  .map((e) => ({ entityId: e.id, atMin: secretaryCompletions[e.id].completeMin, kind: "first" }))
  .sort((a, b) => a.atMin - b.atMin);
// the engine only ever learns about a queue via an explicit queue_joined
// event — the DES loop below tracks its own in-memory admission order for
// scheduling, but that's a separate concern from the emitted log.
for (const a of firstVisitArrivals) {
  emit("queue_joined", a.atMin, { entity_id: a.entityId, station_id: "st_opd_gen", step_index: 1 });
}

const labArrivalsQueue = []; // {entityId, atMin} filled in as first-visit consults complete
const revisitArrivalsQueue = []; // filled in as lab completes
const pharmacyArrivalsQueue = []; // filled in as opd_gen (first or revisit) completions decide pharmacy is needed
const labCompletions = {};
const opdFirstCompletions = {};
const opdRevisitCompletions = {};

const opdQueue = [];
const labQueue = [];
let opdResourceFreeAt = nextFreeTime(0, DOCTOR_PAUSES);
let labResourceFreeAt = 0;
let fvIdx = 0;

function admitOpd(t) {
  while (fvIdx < firstVisitArrivals.length && firstVisitArrivals[fvIdx].atMin <= t) {
    opdQueue.push({ entityId: firstVisitArrivals[fvIdx].entityId, visit: "first" });
    fvIdx += 1;
  }
  while (revisitArrivalsQueue.length && revisitArrivalsQueue[0].atMin <= t) {
    const a = revisitArrivalsQueue.shift();
    opdQueue.push({ entityId: a.entityId, visit: "revisit" });
  }
}
function admitLab(t) {
  while (labArrivalsQueue.length && labArrivalsQueue[0].atMin <= t) {
    const a = labArrivalsQueue.shift();
    labQueue.push(a.entityId);
  }
}

function pickOpdIndex() {
  for (let i = 0; i < opdQueue.length; i++) {
    const id = opdQueue[i].entityId;
    const flags = opdFlags.get(id);
    if (flags.isPriority && !opdPriorityApplied.has(id)) return i;
  }
  return 0;
}

let globalClock = 0;
const HORIZON = 20 * 60; // safety bound, 20:00
while (
  fvIdx < firstVisitArrivals.length ||
  opdQueue.length > 0 ||
  labQueue.length > 0 ||
  labArrivalsQueue.length > 0 ||
  revisitArrivalsQueue.length > 0
) {
  admitOpd(globalClock);
  admitLab(globalClock);

  let progressed = false;

  // --- lab step ---
  if (labQueue.length > 0) {
    const startAt = Math.max(labResourceFreeAt, globalClock);
    admitLab(startAt);
    const entityId = labQueue.shift();
    const duration = Math.max(1, Math.round(sampleDuration(12, 20)));
    emit("called", startAt, { entity_id: entityId, station_id: "st_lab", resource_id: "res_lab_1" });
    emit("service_started", startAt, { entity_id: entityId, station_id: "st_lab", resource_id: "res_lab_1" });
    const completeAt = startAt + duration;
    emit("service_completed", completeAt, {
      entity_id: entityId,
      station_id: "st_lab",
      resource_id: "res_lab_1",
      duration_min: duration
    });
    labCompletions[entityId] = { completeMin: completeAt, durationMin: duration };
    labResourceFreeAt = completeAt;
    emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_opd_gen", step_index: 3 });
    revisitArrivalsQueue.push({ entityId, atMin: completeAt });
    revisitArrivalsQueue.sort((a, b) => a.atMin - b.atMin);
    progressed = true;
  }

  // --- opd_gen step ---
  admitOpd(globalClock);
  if (opdQueue.length > 0) {
    const startCandidate = nextFreeTime(Math.max(opdResourceFreeAt, globalClock), DOCTOR_PAUSES);
    admitOpd(startCandidate);
    const idx = pickOpdIndex();
    const { entityId, visit } = opdQueue[idx];
    const flags = opdFlags.get(entityId);

    if (flags.isPriority && !opdPriorityApplied.has(entityId) && idx !== 0) {
      emit("priority_insert", startCandidate - 1, {
        entity_id: entityId,
        station_id: "st_opd_gen",
        reason: nextPriorityReason()
      });
    }
    opdPriorityApplied.add(entityId);
    opdQueue.splice(idx, 1);

    if (flags.isNoShowCandidate && !opdNoShowResolved.has(entityId) && visit === "first") {
      const grace = 4;
      emit("called", startCandidate, { entity_id: entityId, station_id: "st_opd_gen", resource_id: "res_doctor_1" });
      emit("no_show", startCandidate + grace, { entity_id: entityId, station_id: "st_opd_gen" });
      opdNoShowResolved.add(entityId);
      opdResourceFreeAt = startCandidate + grace;

      emit("resequence_suggested", startCandidate + grace, {
        suggestion: "pull_forward",
        reason_key: "no_show_gap",
        station_id: "st_opd_gen",
        related_entity_id: entityId,
        accepted: true
      });
      admitOpd(opdResourceFreeAt);
      if (opdQueue.length > 0) {
        const pullIdx = Math.min(2, opdQueue.length - 1);
        const [pulled] = opdQueue.splice(pullIdx, 1);
        opdQueue.unshift(pulled);
        emit("pull_forward", startCandidate + grace + 1, {
          entity_id: pulled.entityId,
          station_id: "st_opd_gen",
          reason: "Recovering slot freed by no-show"
        });
      }
      globalClock = opdResourceFreeAt;
      progressed = true;
    } else {
      const svc = visit === "first" ? { median: 8, p80: 15 } : { median: 4, p80: 7 };
      const duration = Math.max(1, Math.round(sampleDuration(svc.median, svc.p80)));
      emit("called", startCandidate, { entity_id: entityId, station_id: "st_opd_gen", resource_id: "res_doctor_1" });
      emit("service_started", startCandidate, {
        entity_id: entityId,
        station_id: "st_opd_gen",
        resource_id: "res_doctor_1"
      });
      const completeAt = startCandidate + duration;
      emit("service_completed", completeAt, {
        entity_id: entityId,
        station_id: "st_opd_gen",
        resource_id: "res_doctor_1",
        duration_min: duration
      });
      opdResourceFreeAt = completeAt;
      globalClock = completeAt;
      progressed = true;
      doctorServiceCount += 1;

      if (!emergencyTriggered && doctorServiceCount >= EMERGENCY_TRIGGER_COUNT) {
        emergencyTriggered = true;
        const pauseStart = completeAt; // fires the instant the resource is free — never mid-consultation
        const pauseEnd = pauseStart + EMERGENCY_DURATION_MIN;
        DOCTOR_PAUSES.push({
          start: pauseStart,
          end: pauseEnd,
          reason_key: "doctor_emergency",
          reason_text: "Doctor called away for an emergency in the ward",
          expected_resume_stated_min: pauseStart + 15 // initial guess understates it
        });
        emit("resource_paused", pauseStart, {
          resource_id: "res_doctor_1",
          station_id: "st_opd_gen",
          reason_key: "doctor_emergency",
          reason_text: "Doctor called away for an emergency in the ward",
          expected_resume_at: toISO(pauseStart + 15)
        });
        emit("resource_resumed", pauseEnd, {
          resource_id: "res_doctor_1",
          station_id: "st_opd_gen",
          actual_duration_min: EMERGENCY_DURATION_MIN
        });
        opdResourceFreeAt = pauseEnd;
        globalClock = pauseEnd;
      }

      const entity = entities.find((e) => e.id === entityId);
      if (visit === "first") {
        opdFirstCompletions[entityId] = { completeMin: completeAt };
        if (entity.lab_ordered) {
          emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_lab", step_index: 2 });
          labArrivalsQueue.push({ entityId, atMin: completeAt });
          labArrivalsQueue.sort((a, b) => a.atMin - b.atMin);
        } else if (entity.medicine_prescribed) {
          emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_pharmacy", step_index: 4 });
          pharmacyArrivalsQueue.push({ entityId, atMin: completeAt });
        } else {
          emit("journey_completed", completeAt, { entity_id: entityId });
        }
      } else {
        opdRevisitCompletions[entityId] = { completeMin: completeAt };
        if (entity.medicine_prescribed) {
          emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_pharmacy", step_index: 4 });
          pharmacyArrivalsQueue.push({ entityId, atMin: completeAt });
        } else {
          emit("journey_completed", completeAt, { entity_id: entityId });
        }
      }
    }
  }

  if (!progressed) {
    // nothing to do right now at either lab or opd_gen; jump clock forward
    const candidates = [];
    if (fvIdx < firstVisitArrivals.length) candidates.push(firstVisitArrivals[fvIdx].atMin);
    if (labArrivalsQueue.length) candidates.push(labArrivalsQueue[0].atMin);
    if (revisitArrivalsQueue.length) candidates.push(revisitArrivalsQueue[0].atMin);
    if (candidates.length === 0) break;
    globalClock = Math.min(...candidates);
  }
  if (globalClock > HORIZON) break;
}

// ---------- 4. Pharmacy ----------
const pharmacyCompletions = simulateStation({
  stationId: "st_pharmacy",
  resourceId: "res_pharmacy_1",
  arrivals: pharmacyArrivalsQueue,
  serviceTimeFor: () => ({ median: 5, p80: 9 }),
  pauses: [],
  entityFlags: new Map(entities.map((e) => [e.id, { isPriority: false, isNoShowCandidate: false }])),
  priorityApplied: new Set(),
  noShowResolved: new Set()
});
for (const entityId of Object.keys(pharmacyCompletions)) {
  emit("journey_completed", pharmacyCompletions[entityId].completeMin, { entity_id: entityId });
}

// ---------- demonstrate "step out & get notified" for long waits ----------
const stepOutCount = injectStepOutDemo(events, emit);

// ---------- finalize ----------
events.sort((a, b) => a.ts_min - b.ts_min || a.id.localeCompare(b.id));

// ---------- tag the entity whose journey actually exceeded 3 hours ----------
const journeyStats = entities.map((e) => {
  const arr = e.actual_arrival_min;
  let done = null;
  const jc = events.find((ev) => ev.type === "journey_completed" && ev.entity_id === e.id);
  if (jc) done = jc.ts_min;
  return { id: e.id, arr, done, journeyMin: done != null ? done - arr : null, lab: e.lab_ordered };
});
const longest = journeyStats
  .filter((j) => j.journeyMin != null)
  .sort((a, b) => b.journeyMin - a.journeyMin)[0];
if (longest && longest.journeyMin > 180) {
  const e = entities.find((x) => x.id === longest.id);
  e.scenario_tags.push("long_journey_gt_3h");
}
for (const idx of NO_SHOW_IDX) {
  entities[idx].scenario_tags.push("no_show");
}
for (const idx of PRIORITY_IDX) {
  entities[idx].scenario_tags.push("priority_insert");
}
if (entities[LATE_ARRIVAL_IDX]) {
  entities[LATE_ARRIVAL_IDX].scenario_tags.push("late_arrival");
}

// strip helper field before writing
const cleanEvents = events.map(({ ts_min, ...rest }) => rest);

writeFileSync(path.join(OUT_DIR, "entities.json"), JSON.stringify(entities, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "events.json"), JSON.stringify(cleanEvents, null, 2) + "\n");

console.log("Longest journeys:");
journeyStats
  .filter((j) => j.journeyMin != null)
  .sort((a, b) => b.journeyMin - a.journeyMin)
  .slice(0, 6)
  .forEach((j) => console.log(j));
console.log("Total events:", cleanEvents.length);
console.log("Entities without journey_completed:", journeyStats.filter((j) => j.journeyMin == null).map((j) => j.id));
console.log("Tagged long journey entity:", longest && longest.journeyMin > 180 ? longest.id : "none — tune seed");
console.log("Step-out demo entities:", stepOutCount);
