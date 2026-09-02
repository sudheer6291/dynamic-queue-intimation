// Seed generator for the second vertical (M6 — vertical swap test).
// Deliberately reuses no application code, only this standalone script —
// the point is that the *app* needs zero changes, not that the generator is shared.
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data", "vehicle_service");

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
const rand = mulberry32(20260903);

const DATE = "2026-09-02";
const TZ = "+05:30";
const DAY_START_MIN = 8 * 60;

function toISO(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${DATE}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${TZ}`;
}
function sampleDuration(median, p80) {
  const r = rand();
  if (r < 0.6) return median * (0.6 + 0.4 * rand());
  if (r < 0.9) return median + (p80 - median) * rand();
  return p80 + (p80 - median) * rand();
}

const N = 20;
const entities = [];
for (let i = 0; i < N; i++) {
  const arrival = DAY_START_MIN + i * 16 + Math.round((rand() - 0.5) * 5);
  entities.push({
    id: `v${String(i + 1).padStart(2, "0")}`,
    display_token: `V-${String(i + 1).padStart(2, "0")}`,
    route_id: "route_standard",
    scheduled_arrival_min: arrival,
    actual_arrival_min: arrival,
    is_late_arrival: false,
    is_priority: false,
    is_no_show_candidate: false,
    lab_ordered: false,
    pre_flagged_lab: false,
    wash_requested: rand() < 0.5,
    medicine_prescribed: false,
    scenario_tags: []
  });
}

const events = [];
let seq = 0;
function emit(type, ts_min, fields) {
  seq += 1;
  events.push({ id: `ev${String(seq).padStart(4, "0")}`, type, ts: toISO(ts_min), ts_min, ...fields });
}

for (const e of entities) {
  emit("entity_registered", e.actual_arrival_min, {
    entity_id: e.id,
    display_token: e.display_token,
    route_id: e.route_id,
    priority: false
  });
  emit("queue_joined", e.actual_arrival_min, { entity_id: e.id, station_id: "st_checkin", step_index: 0 });
}

// generic multi-resource FIFO simulator (no pauses/priority/no-show — this
// vertical only needs to prove the config swap renders correctly)
function simulate(stationId, resourceIds, arrivals, serviceTime, nextStationFor) {
  const queue = [];
  const pending = arrivals.slice().sort((a, b) => a.atMin - b.atMin);
  const arrivalOf = new Map(pending.map((a) => [a.entityId, a.atMin]));
  const freeAt = {};
  for (const r of resourceIds) freeAt[r] = 0;
  let pendingIdx = 0;

  function admit(t) {
    while (pendingIdx < pending.length && pending[pendingIdx].atMin <= t) {
      queue.push(pending[pendingIdx].entityId);
      pendingIdx += 1;
    }
  }

  const out = [];
  while (pendingIdx < pending.length || queue.length > 0) {
    if (queue.length === 0) {
      admit(pending[pendingIdx].atMin);
      continue;
    }
    const resourceId = resourceIds.reduce((best, r) => (freeAt[r] < freeAt[best] ? r : best), resourceIds[0]);
    // a resource sitting idle since earlier can't start before this entity actually arrived
    const startAt = Math.max(freeAt[resourceId], arrivalOf.get(queue[0]));
    admit(startAt); // let anyone who arrived by the time the resource frees up join the queue first too
    const entityId = queue.shift();
    const duration = Math.max(1, Math.round(sampleDuration(serviceTime.median_min, serviceTime.p80_min)));
    emit("called", startAt, { entity_id: entityId, station_id: stationId, resource_id: resourceId });
    emit("service_started", startAt, { entity_id: entityId, station_id: stationId, resource_id: resourceId });
    const completeAt = startAt + duration;
    emit("service_completed", completeAt, {
      entity_id: entityId,
      station_id: stationId,
      resource_id: resourceId,
      duration_min: duration
    });
    freeAt[resourceId] = completeAt;
    out.push({ entityId, completeMin: completeAt });
    nextStationFor(entityId, completeAt);
  }
  return out;
}

const bayArrivals = [];
const washArrivals = [];
const billingArrivals = [];

simulate(
  "st_checkin",
  ["res_advisor_1"],
  entities.map((e) => ({ entityId: e.id, atMin: e.actual_arrival_min })),
  { median_min: 4, p80_min: 7 },
  (entityId, completeAt) => {
    emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_bay", step_index: 1 });
    bayArrivals.push({ entityId, atMin: completeAt });
  }
);

simulate("st_bay", ["res_bay_1", "res_bay_2"], bayArrivals, { median_min: 35, p80_min: 55 }, (entityId, completeAt) => {
  const meta = entities.find((e) => e.id === entityId);
  if (meta.wash_requested) {
    emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_wash", step_index: 2 });
    washArrivals.push({ entityId, atMin: completeAt });
  } else {
    emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_billing", step_index: 3 });
    billingArrivals.push({ entityId, atMin: completeAt });
  }
});

simulate("st_wash", ["res_wash_1"], washArrivals, { median_min: 12, p80_min: 18 }, (entityId, completeAt) => {
  emit("queue_joined", completeAt, { entity_id: entityId, station_id: "st_billing", step_index: 3 });
  billingArrivals.push({ entityId, atMin: completeAt });
});

simulate("st_billing", ["res_billing_1"], billingArrivals, { median_min: 5, p80_min: 8 }, (entityId, completeAt) => {
  emit("journey_completed", completeAt, { entity_id: entityId });
});

events.sort((a, b) => a.ts_min - b.ts_min || a.id.localeCompare(b.id));
const cleanEvents = events.map(({ ts_min, ...rest }) => rest);

writeFileSync(path.join(OUT_DIR, "entities.json"), JSON.stringify(entities, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "events.json"), JSON.stringify(cleanEvents, null, 2) + "\n");
console.log("Total events:", cleanEvents.length);
const lastJourney = events.filter((e) => e.type === "journey_completed").slice(-1)[0];
console.log("Last journey completed at:", lastJourney && lastJourney.ts);
