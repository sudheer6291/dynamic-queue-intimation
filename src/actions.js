// Front-desk / single-button-operator-view handlers. Every action appends
// one or more events to the log at the current clock time — nothing here
// mutates state directly.

import { parseISOToMin } from "./util.js";

let seq = 1000;
function nextId() {
  seq += 1;
  return `rt${seq}`;
}

function makeEvent(config, nowISO, type, fields) {
  return { id: nextId(), type, ts: nowISO, ...fields };
}

// Call Next only summons — it does not start service. That leaves a real
// window (as in the seed) where the entity might not show up, so the
// no-show button has something to act on. Confirm Arrival starts service.
export function actionCallNext(stationId, ctx) {
  const { state, data, config, nowISO } = ctx;
  const queue = state.stations[stationId].queue;
  if (queue.length === 0) return { events: [], message: "Queue is empty." };
  const alreadyCalled = Object.values(state.entities).some(
    (e) => e.currentStationId === stationId && e.status === "called"
  );
  if (alreadyCalled) return { events: [], message: "Resolve the current call (confirm or no-show) first." };
  const resources = data.resources.filter((r) => r.station_id === stationId);
  const idle = resources.find((r) => state.resources[r.id].status === "idle");
  if (!idle) return { events: [], message: "No free resource at this station." };
  const entityId = queue[0];
  const called = makeEvent(config, nowISO, "called", { entity_id: entityId, station_id: stationId, resource_id: idle.id });
  return { events: [called], message: null };
}

export function actionConfirmArrival(stationId, ctx) {
  const { state, config, nowISO } = ctx;
  const candidate = Object.values(state.entities).find(
    (e) => e.currentStationId === stationId && e.status === "called"
  );
  if (!candidate) return { events: [], message: "No one is currently being called at this station." };
  const started = makeEvent(config, nowISO, "service_started", {
    entity_id: candidate.id,
    station_id: stationId,
    resource_id: candidate.currentResourceId || calledResourceId(state, candidate.id)
  });
  return { events: [started], message: null };
}

function calledResourceId(state, entityId) {
  const hist = state.entities[entityId].history;
  const last = [...hist].reverse().find((h) => h.type === "called");
  return last ? last.resource_id : null;
}

export function actionMarkNoShow(stationId, ctx) {
  const { state, config, nowISO } = ctx;
  // "called" state entities have already left the queue array; find one
  // whose current station matches and status is 'called'.
  const candidate = Object.values(state.entities).find(
    (e) => e.currentStationId === stationId && e.status === "called"
  );
  if (!candidate) return { events: [], message: "No one is currently being called at this station." };
  const noShow = makeEvent(config, nowISO, "no_show", { entity_id: candidate.id, station_id: stationId });
  const suggested = makeEvent(config, nowISO, "resequence_suggested", {
    suggestion: "pull_forward",
    reason_key: "no_show_gap",
    station_id: stationId,
    related_entity_id: candidate.id,
    accepted: false
  });
  return { events: [noShow, suggested], message: null };
}

// Creates a brand-new walk-in appointment at the vertical's entry station —
// the missing "how does a front desk actually create an appointment" step:
// every entity before this only ever came from the pre-seeded day. Each
// conditional route step's real-world outcome (does this patient end up
// needing a lab test, does this vehicle need a wash...) isn't actually
// known until later in the visit; this prototype has no separate "doctor
// orders a test" decision event yet, so — exactly like the seed
// generators already do for every pre-seeded entity — it's decided now,
// once, using that step's own declared probability from routes.json.
// Returns `meta` in addition to the usual `events`: the caller (app.js)
// must push it into app.data.entities itself, the same static-lookup
// array every view already reads display_token/condition flags from — see
// nextStepFor below and the data.entities.find(...) call sites across
// views. That lookup is intentionally null-safe (a live-created entity
// that outlives a page reload without its meta just skips any conditional
// step it hasn't reached yet, rather than crashing — see nextStepFor).
let walkinSeq = 0;
export function actionRegisterEntity(priority, ctx) {
  const { data, config, nowISO } = ctx;
  walkinSeq += 1;
  const entityId = `walkin-${Date.now()}-${walkinSeq}`;

  const tokenPrefix = (data.entities[0] && String(data.entities[0].display_token).replace(/\d+$/, "")) || "W-";
  const maxNum = data.entities.reduce((max, e) => {
    const n = parseInt(String(e.display_token).replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
  const displayToken = `${tokenPrefix}${String(maxNum + 1).padStart(2, "0")}`;

  const routeId = config.default_route_id;
  const route = data.routes.find((r) => r.id === routeId);
  const meta = { id: entityId, display_token: displayToken, route_id: routeId, scenario_tags: ["walk_in"] };
  if (route) {
    for (const step of route.steps) {
      if (step.conditional && step.condition_key && !(step.condition_key in meta)) {
        meta[step.condition_key] = Math.random() < step.probability;
      }
    }
  }

  const events = [
    makeEvent(config, nowISO, "entity_registered", {
      entity_id: entityId,
      display_token: displayToken,
      route_id: routeId,
      priority: !!priority
    }),
    makeEvent(config, nowISO, "queue_joined", {
      entity_id: entityId,
      station_id: config.entry_station_id,
      step_index: 0
    })
  ];
  return { events, meta, message: `Registered ${displayToken}${priority ? " (priority)" : ""}` };
}

export function actionPriorityInsert(stationId, entityId, reasonText, ctx) {
  const { config, nowISO } = ctx;
  const ev = makeEvent(config, nowISO, "priority_insert", {
    entity_id: entityId,
    station_id: stationId,
    reason: reasonText || "Priority requested by front desk"
  });
  return { events: [ev], message: null };
}

export function actionPullForward(stationId, entityId, reasonText, ctx) {
  const { config, nowISO } = ctx;
  const ev = makeEvent(config, nowISO, "pull_forward", {
    entity_id: entityId,
    station_id: stationId,
    reason: reasonText || "Pulled forward by front desk"
  });
  const accept = makeEvent(config, nowISO, "resequence_suggested", {
    suggestion: "pull_forward",
    reason_key: "manual_pull_forward",
    station_id: stationId,
    related_entity_id: entityId,
    accepted: true
  });
  return { events: [ev, accept], message: null };
}

// Generic next-step resolution — no vertical-specific condition_key names.
// A conditional route step is due once the entity's own flag (looked up by
// exactly the step's condition_key, whatever that vertical calls it) is
// true; the first due step after the entity's current one wins. Returns
// null once no further step is due (the journey is complete).
function nextStepFor(entity, meta, route) {
  for (const step of route.steps) {
    if (step.step_index <= entity.stepIndex) continue;
    const due = !step.conditional || !!(meta && meta[step.condition_key]);
    if (due) return step;
  }
  return null;
}

// Completes whoever is currently in service at `resourceId` (if anyone) and
// routes them to their next step. Shared by the doctor-style single-button
// view and the front desk's own "Complete" action. Returns the events to
// append plus the resource that's now free (or null).
function completeCurrentService(stationId, resourceId, ctx) {
  const { state, data, config, nowISO, nowMin } = ctx;
  const rs = state.resources[resourceId];
  if (!rs || rs.status !== "serving") return { events: [] };
  const entityId = rs.currentEntityId;
  const entity = state.entities[entityId];
  const startMin = parseISOToMin(entity.serviceStartedAt);
  const duration = Math.max(1, Math.round(nowMin - startMin));
  const events = [
    makeEvent(config, nowISO, "service_completed", {
      entity_id: entityId,
      station_id: stationId,
      resource_id: resourceId,
      duration_min: duration
    })
  ];

  const meta = data.entities.find((x) => x.id === entityId);
  const route = data.routes.find((r) => r.id === entity.routeId);
  const target = nextStepFor(entity, meta, route);

  if (target) {
    events.push(
      makeEvent(config, nowISO, "queue_joined", { entity_id: entityId, station_id: target.station_id, step_index: target.step_index })
    );
  } else {
    events.push(makeEvent(config, nowISO, "journey_completed", { entity_id: entityId }));
  }
  return { events };
}

// Front desk: complete whoever is being served at this station right now.
// Deliberately does not auto-call the next person — front desk operates
// one deliberate tap per action.
export function actionCompleteService(stationId, ctx) {
  const { state, data } = ctx;
  const resources = data.resources.filter((r) => r.station_id === stationId);
  const serving = resources.find((r) => state.resources[r.id].status === "serving");
  if (!serving) return { events: [], message: "No one is currently in service at this station." };
  const { events } = completeCurrentService(stationId, serving.id, ctx);
  return { events, message: null };
}

export function actionApplyLabFirstSuggestion(stationId, altStationId, entityIds, ctx) {
  const { config, nowISO } = ctx;
  const events = [];
  for (const entityId of entityIds) {
    events.push(
      makeEvent(config, nowISO, "reroute", {
        entity_id: entityId,
        from_station_id: stationId,
        to_station_id: altStationId,
        reason: "Sent ahead while resource is unavailable"
      })
    );
  }
  if (events.length) {
    events.push(
      makeEvent(config, nowISO, "resequence_suggested", {
        suggestion: "lab_first",
        reason_key: "resource_paused_alt_route",
        station_id: stationId,
        related_entity_id: entityIds[0],
        accepted: true
      })
    );
  }
  return { events, message: null };
}

// The single-button operator view: one button. Completes whoever is
// currently in service (if anyone), routes them to their next step, and
// immediately calls the next entity in the queue. This button is the
// entire data-collection layer for that station.
export function actionStationDone(stationId, ctx) {
  const { state, data, config, nowISO } = ctx;
  const resources = data.resources.filter((r) => r.station_id === stationId);
  const serving = resources.find((r) => state.resources[r.id].status === "serving");
  const events = serving ? completeCurrentService(stationId, serving.id, ctx).events : [];

  // auto-advance: call the next person if the resource is now free
  const queue = state.stations[stationId].queue;
  if (queue.length > 0) {
    const idle = resources.find((r) => (serving ? r.id !== serving.id : true) && state.resources[r.id].status === "idle");
    const freeResource = serving ? resources.find((r) => r.id === serving.id) : idle || resources[0];
    if (freeResource) {
      const entityId = queue[0];
      events.push(
        makeEvent(config, nowISO, "called", { entity_id: entityId, station_id: stationId, resource_id: freeResource.id })
      );
      events.push(
        makeEvent(config, nowISO, "service_started", {
          entity_id: entityId,
          station_id: stationId,
          resource_id: freeResource.id
        })
      );
    }
  }

  return { events, message: events.length ? null : "Nothing to do — no one in service and no one waiting." };
}

// "Step out & get notified" — the single biggest real-world pain in an
// outpatient-style queue is being physically trapped in a waiting room.
// This lets a waiting entity leave (still holding their place in the
// queue) and get nudged back before their turn — it doesn't change the
// estimate, it changes what the entity is free to do while they wait.
export function actionStepOut(entityId, stationId, ctx) {
  const { state, config, nowISO } = ctx;
  const entity = state.entities[entityId];
  if (!entity || entity.status !== "waiting") return { events: [], message: "Only someone currently waiting can step out." };
  if (entity.away) return { events: [], message: "Already stepped out." };
  return { events: [makeEvent(config, nowISO, "stepped_out", { entity_id: entityId, station_id: stationId })], message: null };
}

export function actionReturn(entityId, stationId, ctx) {
  const { state, config, nowISO } = ctx;
  const entity = state.entities[entityId];
  if (!entity || !entity.away) return { events: [], message: "Not currently marked away." };
  return { events: [makeEvent(config, nowISO, "returned", { entity_id: entityId, station_id: stationId })], message: null };
}

// Logs that a "please head back" nudge was actually shown — same spirit as
// prediction_shown: only measurable if you log what you told someone.
export function actionNudgeShown(entityId, stationId, ctx) {
  const { state, config, nowISO } = ctx;
  const entity = state.entities[entityId];
  if (!entity || !entity.away) return { events: [] };
  return { events: [makeEvent(config, nowISO, "return_nudge_shown", { entity_id: entityId, station_id: stationId })] };
}

export function actionPredictionShown(entityId, stationId, estimatorId, result, ctx) {
  const { config, nowISO } = ctx;
  if (!result || !result.available) return { events: [] };
  return {
    events: [
      makeEvent(config, nowISO, "prediction_shown", {
        entity_id: entityId,
        station_id: stationId,
        estimator: estimatorId,
        p50_min: Math.round(result.p50Min),
        p80_min: Math.round(result.p80Min),
        headline_min: Math.round(result.headlineMin),
        reason_key: result.reasonKey || null
      })
    ]
  };
}
