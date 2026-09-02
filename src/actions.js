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
  const { state, data, config, nowISO, nowMin } = ctx;
  const events = [];
  const resources = data.resources.filter((r) => r.station_id === stationId);
  const serving = resources.find((r) => state.resources[r.id].status === "serving");

  if (serving) {
    const rs = state.resources[serving.id];
    const entityId = rs.currentEntityId;
    const entity = state.entities[entityId];
    const startMin = parseISOToMin(entity.serviceStartedAt);
    const duration = Math.max(1, Math.round(nowMin - startMin));
    events.push(
      makeEvent(config, nowISO, "service_completed", {
        entity_id: entityId,
        station_id: stationId,
        resource_id: serving.id,
        duration_min: duration
      })
    );

    const meta = data.entities.find((x) => x.id === entityId);
    const route = data.routes.find((r) => r.id === entity.routeId);
    const nextStep = route.steps.find((s) => {
      if (s.step_index <= entity.stepIndex) return false;
      if (!s.conditional) return true;
      if (s.condition_key === "lab_ordered") return !!(meta && meta.lab_ordered) && s.station_id !== stationId;
      if (s.condition_key === "medicine_prescribed") return !!(meta && meta.medicine_prescribed);
      return false;
    });
    // special-case: revisit after lab shares condition_key with the lab step
    // itself, so once lab_ordered is true both are "due" — pick the nearest one.
    let target = nextStep;
    if (!target) {
      const remaining = route.steps.filter((s) => s.step_index > entity.stepIndex);
      target = remaining.find((s) => !s.conditional) || null;
    }

    if (target) {
      events.push(
        makeEvent(config, nowISO, "queue_joined", {
          entity_id: entityId,
          station_id: target.station_id,
          step_index: target.step_index
        })
      );
    } else {
      events.push(makeEvent(config, nowISO, "journey_completed", { entity_id: entityId }));
    }
  }

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
