// Seed generator for the bike-service vertical — a fast, high-volume,
// no-revisit chain (deliberately simpler than car_service's diagnostic
// loop and OPD's lab-and-return), to make the transfer-test contrast
// meaningful rather than a re-skin. Run with: node tools/generate-bike-seed.mjs

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { mulberry32, makeSampler, makeIsoFormatter, makeEmitter, simulateStation, injectStepOutDemo } from "./seedkit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data", "bike_service");

const rand = mulberry32(20260904);
const sampleDuration = makeSampler(rand);
const DATE = "2026-09-02";
const TZ = "+05:30";
const DAY_START_MIN = 8 * 60;
const toISO = makeIsoFormatter(DATE, TZ);
const { emit, events } = makeEmitter(toISO);

const N = 35;
const LATE_ARRIVAL_IDX = 15;
const PRIORITY_IDX = new Set([4, 18, 30]);
const NO_SHOW_IDX = new Set([9, 25]);

const PRIORITY_REASONS = [
  "Delivery rider — time-critical, waiting on-site",
  "Commuter breakdown — towed in, needs same-day fix",
  "Loyalty programme member — priority slot"
];
let priorityCursor = 0;

const entities = [];
for (let i = 0; i < N; i++) {
  const base = DAY_START_MIN + i * 15 + Math.round((rand() - 0.5) * 6);
  const isLate = i === LATE_ARRIVAL_IDX;
  entities.push({
    id: `b${String(i + 1).padStart(2, "0")}`,
    display_token: `B-${String(i + 1).padStart(2, "0")}`,
    route_id: "route_standard",
    scheduled_arrival_min: base,
    actual_arrival_min: isLate ? base + 22 : base,
    is_late_arrival: isLate,
    is_priority: PRIORITY_IDX.has(i),
    is_no_show_candidate: NO_SHOW_IDX.has(i),
    wash_requested: rand() < 0.4,
    scenario_tags: []
  });
}

for (const e of entities) {
  emit("entity_registered", e.actual_arrival_min, {
    entity_id: e.id,
    display_token: e.display_token,
    route_id: e.route_id,
    priority: e.is_priority
  });
  emit("queue_joined", e.actual_arrival_min, { entity_id: e.id, station_id: "st_checkin", step_index: 0 });
}

const flagsFor = (idx) =>
  new Map(entities.map((e, i) => [e.id, { isPriority: PRIORITY_IDX.has(i), isNoShowCandidate: NO_SHOW_IDX.has(i) }]));

// --- 1. Check-in ---
const checkinCompletions = simulateStation({
  stationId: "st_checkin",
  resources: [{ id: "res_advisor_1", pauses: [] }],
  arrivals: entities.map((e) => ({ entityId: e.id, atMin: e.actual_arrival_min })),
  serviceTimeFor: () => ({ median: 3, p80: 5 }),
  emit,
  sampleDuration
});

// --- 2. Service bay: 3 mechanics, one late start, one dynamic mid-day pause ---
const bay1Pauses = [
  {
    start: DAY_START_MIN,
    end: DAY_START_MIN + 15,
    reasonKey: "mechanic_late_start",
    reasonText: "Mechanic arriving later than scheduled",
    expectedResumeAtISO: toISO(DAY_START_MIN + 10)
  }
];
// bay1Pauses above governs *scheduling* only (nextFreeTime respects it) —
// it still needs its own resource_paused/resumed events, same as any
// other pause, so the derived state and estimator see it too.
for (const p of bay1Pauses) {
  emit("resource_paused", p.start, {
    resource_id: "res_bay_1",
    station_id: "st_bay",
    reason_key: p.reasonKey,
    reason_text: p.reasonText,
    expected_resume_at: p.expectedResumeAtISO
  });
  emit("resource_resumed", p.end, { resource_id: "res_bay_1", station_id: "st_bay", actual_duration_min: p.end - p.start });
}
let bay2Paused = false;
const bayFlags = flagsFor();
const bayPriorityApplied = new Set();
const bayNoShowResolved = new Set();

const bayArrivals = Object.entries(checkinCompletions).map(([entityId, c]) => ({ entityId, atMin: c.completeMin }));
// the engine only ever learns about a queue via an explicit queue_joined
// event — simulateStation's `arrivals` list only drives its own internal
// scheduling, so the transition itself still needs to be logged here.
for (const a of bayArrivals) {
  emit("queue_joined", a.atMin, { entity_id: a.entityId, station_id: "st_bay", step_index: 1 });
}

const bayCompletions = simulateStation({
  stationId: "st_bay",
  resources: [
    { id: "res_bay_1", pauses: bay1Pauses },
    { id: "res_bay_2", pauses: [] },
    { id: "res_bay_3", pauses: [] }
  ],
  arrivals: bayArrivals,
  serviceTimeFor: () => ({ median: 20, p80: 32 }),
  entityFlags: bayFlags,
  priorityApplied: bayPriorityApplied,
  noShowResolved: bayNoShowResolved,
  priorityReasonFor: () => PRIORITY_REASONS[priorityCursor++ % PRIORITY_REASONS.length],
  emit,
  sampleDuration,
  dynamicPause: (resourceId, count, freeAtMin) => {
    if (resourceId !== "res_bay_2" || bay2Paused || count < 5) return null;
    bay2Paused = true;
    return {
      start: freeAtMin,
      end: freeAtMin + 20,
      reasonKey: "spare_part_pickup",
      reasonText: "Mechanic sent to collect a delivered spare part",
      expectedResumeAtISO: toISO(freeAtMin + 10)
    };
  }
});

const washArrivals = [];
const billingArrivals = [];
for (const [entityId, c] of Object.entries(bayCompletions)) {
  const meta = entities.find((e) => e.id === entityId);
  emit("queue_joined", c.completeMin, {
    entity_id: entityId,
    station_id: meta.wash_requested ? "st_wash" : "st_billing",
    step_index: meta.wash_requested ? 2 : 3
  });
  (meta.wash_requested ? washArrivals : billingArrivals).push({ entityId, atMin: c.completeMin });
}

// --- 3. Wash ---
const washCompletions = simulateStation({
  stationId: "st_wash",
  resources: [{ id: "res_wash_1", pauses: [] }],
  arrivals: washArrivals,
  serviceTimeFor: () => ({ median: 8, p80: 12 }),
  emit,
  sampleDuration
});
for (const [entityId, c] of Object.entries(washCompletions)) {
  emit("queue_joined", c.completeMin, { entity_id: entityId, station_id: "st_billing", step_index: 3 });
  billingArrivals.push({ entityId, atMin: c.completeMin });
}

// --- 4. Billing ---
const billingCompletions = simulateStation({
  stationId: "st_billing",
  resources: [{ id: "res_billing_1", pauses: [] }],
  arrivals: billingArrivals,
  serviceTimeFor: () => ({ median: 4, p80: 7 }),
  emit,
  sampleDuration
});
for (const [entityId, c] of Object.entries(billingCompletions)) {
  emit("journey_completed", c.completeMin, { entity_id: entityId });
}

// --- demonstrate "step out & get notified" for long waits ---
// lower threshold than car/OPD — bike servicing is fast by design, so even
// a 15+ minute station wait is worth stepping out for.
const stepOutCount = injectStepOutDemo(events, emit, { leadMin: 2, returnLeadMin: 3, minWaitMin: 8, maxCount: 4 });

// --- tags + finalize ---
events.sort((a, b) => a.ts_min - b.ts_min || a.id.localeCompare(b.id));
const journeyStats = entities.map((e) => {
  const jc = events.find((ev) => ev.type === "journey_completed" && ev.entity_id === e.id);
  return { id: e.id, journeyMin: jc ? jc.ts_min - e.actual_arrival_min : null };
});
const longest = journeyStats.filter((j) => j.journeyMin != null).sort((a, b) => b.journeyMin - a.journeyMin)[0];
if (longest) entities.find((e) => e.id === longest.id).scenario_tags.push("long_journey_from_backlog");
for (const idx of NO_SHOW_IDX) entities[idx].scenario_tags.push("no_show");
for (const idx of PRIORITY_IDX) entities[idx].scenario_tags.push("priority_insert");
entities[LATE_ARRIVAL_IDX].scenario_tags.push("late_arrival");

const cleanEvents = events.map(({ ts_min, ...rest }) => rest);
writeFileSync(path.join(OUT_DIR, "entities.json"), JSON.stringify(entities, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "events.json"), JSON.stringify(cleanEvents, null, 2) + "\n");

console.log("bike_service: total events", cleanEvents.length);
console.log("Step-out demo entities:", stepOutCount);
console.log(
  "longest journeys:",
  journeyStats
    .filter((j) => j.journeyMin != null)
    .sort((a, b) => b.journeyMin - a.journeyMin)
    .slice(0, 5)
);
console.log(
  "no journey_completed (no-shows expected):",
  journeyStats.filter((j) => j.journeyMin == null).map((j) => j.id)
);
