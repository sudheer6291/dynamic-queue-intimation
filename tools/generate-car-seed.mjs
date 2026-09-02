// Seed generator for the car-service vertical: a 2-technician bay with a
// conditional diagnostic-and-return loop (the fair transfer test vs OPD's
// lab-and-return — same shape, different domain), plus a genuinely
// dramatic day: both bays start late, then one bay alone goes down mid-day
// waiting on a part (a partial-capacity pause, unlike OPD's full pause).
// Run with: node tools/generate-car-seed.mjs

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import {
  mulberry32,
  makeSampler,
  makeIsoFormatter,
  makeEmitter,
  simulateStation,
  nextFreeTime,
  injectStepOutDemo
} from "./seedkit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data", "car_service");

const rand = mulberry32(20260905);
const sampleDuration = makeSampler(rand);
const DATE = "2026-09-02";
const TZ = "+05:30";
const DAY_START_MIN = 8 * 60;
const toISO = makeIsoFormatter(DATE, TZ);
const { emit, events } = makeEmitter(toISO);

const N = 23;
const LATE_ARRIVAL_IDX = 2;
const PRIORITY_IDX = new Set([6, 16, 21]);
const PRIORITY_BLOCKER_IDX = [5, 15, 20]; // paired 1:1 with PRIORITY_IDX below — arrives just
// before its priority counterpart so there's a real entity to jump ahead of,
// rather than leaving it to chance whether a backlog happens to exist.
const NO_SHOW_IDX = new Set([12, 18]);
const DIAGNOSTIC_IDX = new Set([3, 7, 13, 19, 22]); // exactly 5, mirrors OPD's lab-and-return count
const MAJOR_REPAIR_IDX = 13; // a diagnostic-and-return case that also turns out to be a major repair

const PRIORITY_REASONS = [
  "Fleet customer — contracted SLA, escalated by dispatch",
  "Extended warranty claim — insurer adjuster waiting on findings",
  "VIP loyalty customer — priority bay slot"
];
let priorityCursor = 0;

const entities = [];
for (let i = 0; i < N; i++) {
  const base = DAY_START_MIN + i * 30 + Math.round((rand() - 0.5) * 8);
  const isLate = i === LATE_ARRIVAL_IDX;
  const needsDiagnostic = DIAGNOSTIC_IDX.has(i);
  entities.push({
    id: `c${String(i + 1).padStart(2, "0")}`,
    display_token: `C-${String(i + 1).padStart(2, "0")}`,
    route_id: "route_standard",
    scheduled_arrival_min: base,
    actual_arrival_min: isLate ? base + 30 : base,
    is_late_arrival: isLate,
    is_priority: PRIORITY_IDX.has(i),
    is_no_show_candidate: NO_SHOW_IDX.has(i),
    diagnostic_needed: needsDiagnostic,
    pre_flagged_diagnostic: needsDiagnostic, // known ahead (e.g. a standing dashboard-light complaint) so front desk can pre-route
    wash_requested: rand() < 0.6,
    scenario_tags: []
  });
}

// tighten each priority/blocker pair's arrival gap to a few minutes so the
// priority vehicle demonstrably arrives while its blocker is still waiting
const priorityList = [...PRIORITY_IDX];
PRIORITY_BLOCKER_IDX.forEach((blockerIdx, i) => {
  const priorityIdx = priorityList[i];
  if (priorityIdx == null) return;
  const anchor = entities[blockerIdx].scheduled_arrival_min;
  entities[blockerIdx].actual_arrival_min = anchor;
  entities[priorityIdx].actual_arrival_min = anchor + 4;
});

for (const e of entities) {
  emit("entity_registered", e.actual_arrival_min, {
    entity_id: e.id,
    display_token: e.display_token,
    route_id: e.route_id,
    priority: e.is_priority
  });
  emit("queue_joined", e.actual_arrival_min, { entity_id: e.id, station_id: "st_checkin", step_index: 0 });
}

// --- 1. Check-in ---
const checkinCompletions = simulateStation({
  stationId: "st_checkin",
  resources: [{ id: "res_frontdesk_1", pauses: [] }],
  arrivals: entities.map((e) => ({ entityId: e.id, atMin: e.actual_arrival_min })),
  serviceTimeFor: () => ({ median: 5, p80: 9 }),
  emit,
  sampleDuration
});

// --- 1.5. Service Advisor ---
// The real-world hand-off between "checked in" and "actually in a bay":
// the advisor walks the vehicle, notes the complaint, opens the job card.
// Fractional step_index 0.5 (between check-in's 0 and bay's 1) so this
// insertion never has to renumber diagnostic/wash/billing's existing
// step_index values downstream.
for (const [entityId, c] of Object.entries(checkinCompletions)) {
  emit("queue_joined", c.completeMin, { entity_id: entityId, station_id: "st_advisor", step_index: 0.5 });
}
const advisorCompletions = simulateStation({
  stationId: "st_advisor",
  resources: [{ id: "res_advisor_1", pauses: [] }],
  arrivals: Object.entries(checkinCompletions).map(([entityId, c]) => ({ entityId, atMin: c.completeMin })),
  serviceTimeFor: () => ({ median: 6, p80: 10 }),
  entityFlags: new Map(entities.map((e) => [e.id, { isPriority: e.is_priority, isNoShowCandidate: false }])),
  priorityApplied: new Set(),
  noShowResolved: new Set(),
  emit,
  sampleDuration
});

// --- 2 & 3. Bay (2 techs) interleaved with Diagnostic, including revisit ---
const LATE_START_PAUSE = {
  start: DAY_START_MIN,
  end: DAY_START_MIN + 20,
  reasonKey: "technicians_late_start",
  reasonText: "Technicians arriving later than scheduled",
  expectedResumeAtISO: toISO(DAY_START_MIN + 12)
};
const bayResources = [
  { id: "res_bay_1", pauses: [LATE_START_PAUSE] },
  { id: "res_bay_2", pauses: [LATE_START_PAUSE] }
];
// LATE_START_PAUSE above governs *scheduling* (nextFreeTime respects it) —
// it still needs its own resource_paused/resumed events for each resource,
// same as any other pause, so the derived state and estimator see it too.
for (const r of bayResources) {
  emit("resource_paused", LATE_START_PAUSE.start, {
    resource_id: r.id,
    station_id: "st_bay",
    reason_key: LATE_START_PAUSE.reasonKey,
    reason_text: LATE_START_PAUSE.reasonText,
    expected_resume_at: LATE_START_PAUSE.expectedResumeAtISO
  });
  emit("resource_resumed", LATE_START_PAUSE.end, {
    resource_id: r.id,
    station_id: "st_bay",
    actual_duration_min: LATE_START_PAUSE.end - LATE_START_PAUSE.start
  });
}
let midPauseInjected = false;
let bay1CompletionCount = 0;

const bayFlags = new Map(entities.map((e) => [e.id, { isPriority: e.is_priority, isNoShowCandidate: e.is_no_show_candidate }]));
const bayPriorityApplied = new Set();
const bayNoShowResolved = new Set();

const firstVisitArrivals = Object.entries(advisorCompletions)
  .map(([entityId, c]) => ({ entityId, atMin: c.completeMin, visit: "first" }))
  .sort((a, b) => a.atMin - b.atMin);
// the engine only ever learns about a queue via an explicit queue_joined
// event — the DES loop below tracks its own in-memory admission order for
// scheduling, but that's a separate concern from the emitted log.
for (const a of firstVisitArrivals) {
  emit("queue_joined", a.atMin, { entity_id: a.entityId, station_id: "st_bay", step_index: 1 });
}

const diagnosticArrivalsQueue = [];
const revisitArrivalsQueue = [];
const washArrivals = [];
const billingArrivals = [];

const bayQueue = [];
let fvIdx = 0;
function admitBay(t) {
  while (fvIdx < firstVisitArrivals.length && firstVisitArrivals[fvIdx].atMin <= t) {
    bayQueue.push({ entityId: firstVisitArrivals[fvIdx].entityId, visit: "first" });
    fvIdx += 1;
  }
  while (revisitArrivalsQueue.length && revisitArrivalsQueue[0].atMin <= t) {
    const a = revisitArrivalsQueue.shift();
    bayQueue.push({ entityId: a.entityId, visit: "revisit" });
  }
}
const diagnosticQueue = [];
function admitDiagnostic(t) {
  while (diagnosticArrivalsQueue.length && diagnosticArrivalsQueue[0].atMin <= t) {
    diagnosticQueue.push(diagnosticArrivalsQueue.shift().entityId);
  }
}
function pickBayIndex() {
  for (let i = 0; i < bayQueue.length; i++) {
    const flags = bayFlags.get(bayQueue[i].entityId);
    if (flags.isPriority && !bayPriorityApplied.has(bayQueue[i].entityId)) return i;
  }
  return 0;
}

const bayFreeAt = { res_bay_1: nextFreeTime(0, bayResources[0].pauses), res_bay_2: nextFreeTime(0, bayResources[1].pauses) };
let diagnosticFreeAt = 0;
let globalClock = 0;
const HORIZON = 22 * 60;

while (
  fvIdx < firstVisitArrivals.length ||
  bayQueue.length > 0 ||
  diagnosticQueue.length > 0 ||
  diagnosticArrivalsQueue.length > 0 ||
  revisitArrivalsQueue.length > 0
) {
  admitBay(globalClock);
  admitDiagnostic(globalClock);
  let progressed = false;

  // --- diagnostic station ---
  if (diagnosticQueue.length > 0) {
    const startAt = Math.max(diagnosticFreeAt, globalClock);
    admitDiagnostic(startAt);
    const entityId = diagnosticQueue.shift();
    const duration = Math.max(1, Math.round(sampleDuration(15, 25)));
    emit("called", startAt, { entity_id: entityId, station_id: "st_diagnostic", resource_id: "res_diagnostic_1" });
    emit("service_started", startAt, { entity_id: entityId, station_id: "st_diagnostic", resource_id: "res_diagnostic_1" });
    const completeAt = startAt + duration;
    emit("service_completed", completeAt, {
      entity_id: entityId,
      station_id: "st_diagnostic",
      resource_id: "res_diagnostic_1",
      duration_min: duration
    });
    diagnosticFreeAt = completeAt;
    emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_bay", step_index: 3 });
    revisitArrivalsQueue.push({ entityId, atMin: completeAt });
    revisitArrivalsQueue.sort((a, b) => a.atMin - b.atMin);
    progressed = true;
  }

  // --- bay station ---
  admitBay(globalClock);
  if (bayQueue.length > 0) {
    const resourceId = bayFreeAt.res_bay_1 <= bayFreeAt.res_bay_2 ? "res_bay_1" : "res_bay_2";
    const resource = bayResources.find((r) => r.id === resourceId);
    const startCandidate = nextFreeTime(Math.max(bayFreeAt[resourceId], globalClock), resource.pauses);
    admitBay(startCandidate);
    const idx = pickBayIndex();
    const { entityId, visit } = bayQueue[idx];
    const flags = bayFlags.get(entityId);

    if (flags.isPriority && !bayPriorityApplied.has(entityId) && idx !== 0) {
      emit("priority_insert", startCandidate - 1, {
        entity_id: entityId,
        station_id: "st_bay",
        reason: PRIORITY_REASONS[priorityCursor++ % PRIORITY_REASONS.length]
      });
    }
    bayPriorityApplied.add(entityId);
    bayQueue.splice(idx, 1);

    if (flags.isNoShowCandidate && !bayNoShowResolved.has(entityId) && visit === "first") {
      const grace = 4;
      // A real story for *why* they no-show: stepped out while waiting and
      // genuinely never came back — also gives noShowRisk.js's "stepped
      // out and overdue" signal something true to catch beforehand.
      const stepOutLeadMin = 20;
      const joinedAt = advisorCompletions[entityId].completeMin;
      const stepOutAt = Math.max(joinedAt, startCandidate - stepOutLeadMin);
      emit("stepped_out", stepOutAt, { entity_id: entityId, station_id: "st_bay" });
      emit("called", startCandidate, { entity_id: entityId, station_id: "st_bay", resource_id: resourceId });
      emit("no_show", startCandidate + grace, { entity_id: entityId, station_id: "st_bay" });
      bayNoShowResolved.add(entityId);
      bayFreeAt[resourceId] = startCandidate + grace;
      emit("resequence_suggested", startCandidate + grace, {
        suggestion: "pull_forward",
        reason_key: "no_show_gap",
        station_id: "st_bay",
        related_entity_id: entityId,
        accepted: true
      });
      admitBay(bayFreeAt[resourceId]);
      if (bayQueue.length > 0) {
        const pullIdx = Math.min(2, bayQueue.length - 1);
        const [pulled] = bayQueue.splice(pullIdx, 1);
        bayQueue.unshift(pulled);
        emit("pull_forward", startCandidate + grace + 1, {
          entity_id: pulled.entityId,
          station_id: "st_bay",
          reason: "Recovering slot freed by no-show"
        });
      }
      // note: no globalClock advance here — the *other* bay resource may
      // still have earlier work available and must get its own turn next
      // iteration rather than being fast-forwarded past.
      progressed = true;
    } else {
      const isMajorRepair = entityId === entities[MAJOR_REPAIR_IDX].id;
      const svc =
        visit === "first"
          ? isMajorRepair
            ? { median: 140, p80: 180 } // turns out to be a much bigger job than a routine service
            : { median: 40, p80: 65 }
          : { median: 20, p80: 35 };
      const duration = Math.max(1, Math.round(sampleDuration(svc.median, svc.p80)));
      emit("called", startCandidate, { entity_id: entityId, station_id: "st_bay", resource_id: resourceId });
      emit("service_started", startCandidate, { entity_id: entityId, station_id: "st_bay", resource_id: resourceId });
      const completeAt = startCandidate + duration;
      emit("service_completed", completeAt, {
        entity_id: entityId,
        station_id: "st_bay",
        resource_id: resourceId,
        duration_min: duration
      });
      bayFreeAt[resourceId] = completeAt;
      // note: no globalClock advance here — see comment above; the two bay
      // resources must be free to progress independently in parallel.
      progressed = true;

      // dynamic mid-day partial pause: only res_bay_1, only once, only after
      // it has done a handful of jobs today (so a queue backlog exists by then)
      if (resourceId === "res_bay_1") {
        bay1CompletionCount += 1;
        if (!midPauseInjected && bay1CompletionCount >= 4) {
          midPauseInjected = true;
          const pauseStart = completeAt;
          const pauseEnd = pauseStart + 30;
          resource.pauses.push({
            start: pauseStart,
            end: pauseEnd,
            reasonKey: "part_delivery_wait",
            reasonText: "Waiting on a delivered part for an in-progress repair"
          });
          emit("resource_paused", pauseStart, {
            resource_id: "res_bay_1",
            station_id: "st_bay",
            reason_key: "part_delivery_wait",
            reason_text: "Waiting on a delivered part for an in-progress repair",
            expected_resume_at: toISO(pauseStart + 15)
          });
          emit("resource_resumed", pauseEnd, {
            resource_id: "res_bay_1",
            station_id: "st_bay",
            actual_duration_min: 30
          });
          bayFreeAt.res_bay_1 = pauseEnd;
        }
      }

      const meta = entities.find((e) => e.id === entityId);
      if (visit === "first") {
        if (meta.diagnostic_needed) {
          emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_diagnostic", step_index: 2 });
          diagnosticArrivalsQueue.push({ entityId, atMin: completeAt });
          diagnosticArrivalsQueue.sort((a, b) => a.atMin - b.atMin);
        } else if (meta.wash_requested) {
          emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_wash", step_index: 4 });
          washArrivals.push({ entityId, atMin: completeAt });
        } else {
          emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_billing", step_index: 5 });
          billingArrivals.push({ entityId, atMin: completeAt });
        }
      } else {
        if (meta.wash_requested) {
          emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_wash", step_index: 4 });
          washArrivals.push({ entityId, atMin: completeAt });
        } else {
          emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_billing", step_index: 5 });
          billingArrivals.push({ entityId, atMin: completeAt });
        }
      }
    }
  }

  if (!progressed) {
    const candidates = [];
    if (fvIdx < firstVisitArrivals.length) candidates.push(firstVisitArrivals[fvIdx].atMin);
    if (diagnosticArrivalsQueue.length) candidates.push(diagnosticArrivalsQueue[0].atMin);
    if (revisitArrivalsQueue.length) candidates.push(revisitArrivalsQueue[0].atMin);
    if (candidates.length === 0) break;
    globalClock = Math.min(...candidates);
  }
  if (globalClock > HORIZON) break;
}

// --- 4. Wash ---
const washCompletions = simulateStation({
  stationId: "st_wash",
  resources: [{ id: "res_wash_1", pauses: [] }],
  arrivals: washArrivals,
  serviceTimeFor: () => ({ median: 12, p80: 18 }),
  emit,
  sampleDuration
});
for (const [entityId, c] of Object.entries(washCompletions)) {
  emit("queue_joined", c.completeMin, { entity_id: entityId, station_id: "st_billing", step_index: 5 });
  billingArrivals.push({ entityId, atMin: c.completeMin });
}

// --- 5. Billing ---
const billingCompletions = simulateStation({
  stationId: "st_billing",
  resources: [{ id: "res_billing_1", pauses: [] }],
  arrivals: billingArrivals,
  serviceTimeFor: () => ({ median: 6, p80: 10 }),
  emit,
  sampleDuration
});
for (const [entityId, c] of Object.entries(billingCompletions)) {
  emit("journey_completed", c.completeMin, { entity_id: entityId });
}

// --- demonstrate "step out & get notified" for long waits ---
// (parallel bays keep station waits short here relative to OPD's single
// resource, so use a lower bar than the default)
const stepOutCount = injectStepOutDemo(events, emit, { leadMin: 3, returnLeadMin: 4, minWaitMin: 15, maxCount: 4 });

// --- tags + finalize ---
events.sort((a, b) => a.ts_min - b.ts_min || a.id.localeCompare(b.id));
const journeyStats = entities.map((e) => {
  const jc = events.find((ev) => ev.type === "journey_completed" && ev.entity_id === e.id);
  return { id: e.id, journeyMin: jc ? jc.ts_min - e.actual_arrival_min : null };
});
const longest = journeyStats.filter((j) => j.journeyMin != null).sort((a, b) => b.journeyMin - a.journeyMin)[0];
if (longest) {
  const tag = longest.journeyMin > 180 ? "long_journey_gt_3h" : "long_journey_today";
  entities.find((e) => e.id === longest.id).scenario_tags.push(tag);
}
for (const idx of NO_SHOW_IDX) entities[idx].scenario_tags.push("no_show");
for (const idx of PRIORITY_IDX) entities[idx].scenario_tags.push("priority_insert");
entities[LATE_ARRIVAL_IDX].scenario_tags.push("late_arrival");
for (const idx of DIAGNOSTIC_IDX) entities[idx].scenario_tags.push("diagnostic_and_return");

const cleanEvents = events.map(({ ts_min, ...rest }) => rest);
writeFileSync(path.join(OUT_DIR, "entities.json"), JSON.stringify(entities, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "events.json"), JSON.stringify(cleanEvents, null, 2) + "\n");

console.log("car_service: total events", cleanEvents.length);
console.log("Step-out demo entities:", stepOutCount);
console.log(
  "longest journeys:",
  journeyStats
    .filter((j) => j.journeyMin != null)
    .sort((a, b) => b.journeyMin - a.journeyMin)
    .slice(0, 6)
);
console.log(
  "no journey_completed (no-shows expected):",
  journeyStats.filter((j) => j.journeyMin == null).map((j) => j.id)
);
