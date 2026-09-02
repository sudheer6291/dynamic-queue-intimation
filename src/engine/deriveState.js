// The engine. No vertical-specific vocabulary lives here — see the "no
// domain words in the engine" checkpoint in the spec.
//
// deriveState is a pure function of (event log up to `nowISO`, config/data).
// It never mutates events, and it is recomputed from scratch every call —
// cheap at prototype scale, and it guarantees "scrub to any time, get the
// correct state at that instant" (M0's exit criterion) for free.

export function deriveState(data, allEvents, nowISO) {
  const { stations, resources } = data;

  const entities = {};
  const stationState = {};
  for (const s of stations) stationState[s.id] = { id: s.id, queue: [] };

  const resourceState = {};
  for (const r of resources) {
    resourceState[r.id] = {
      id: r.id,
      stationId: r.station_id,
      status: "idle", // idle | serving | paused
      currentEntityId: null,
      pausedReasonKey: null,
      pausedReasonText: null,
      pausedAt: null,
      expectedResumeAt: null,
      serviceLog: [], // {entityId, start, end, durationMin}
      pauseLog: [] // {start, end, reasonKey, reasonText, expectedResumeAt}
    };
  }

  const suggestions = []; // {ts, suggestion, reasonKey, stationId, relatedEntityId, accepted}
  const predictionsLog = []; // flat log of every prediction_shown, for later "did it change behaviour" analysis
  const nudgesLog = []; // flat log of every "please head back" nudge actually shown
  const noShowRiskLog = []; // flat log of every no-show risk flag actually shown to front desk

  function getEntity(id) {
    if (!entities[id]) {
      entities[id] = {
        id,
        displayToken: id,
        routeId: null,
        priority: false,
        status: "not_registered",
        currentStationId: null,
        stepIndex: -1,
        queueEnteredAt: null,
        calledAt: null,
        serviceStartedAt: null,
        serviceCompletedAt: null,
        noShowAt: null,
        journeyCompletedAt: null,
        lastCompletedStationId: null,
        away: false, // stepped out of the physical waiting area, still queued
        awaySince: null,
        history: [],
        predictions: []
      };
    }
    return entities[id];
  }

  function removeFromQueue(stationId, entityId) {
    // stationId is trusted static data everywhere this ran before the
    // runtime event log became externally writable (via /api/events, with
    // no auth). A malformed or malicious event referencing an unknown
    // station must not crash derivation for the whole vertical — so this
    // (and every other stationState[...] lookup below) treats "unknown
    // station" as a no-op rather than assuming it always exists.
    const s = stationState[stationId];
    if (!s) return -1;
    const idx = s.queue.indexOf(entityId);
    if (idx !== -1) s.queue.splice(idx, 1);
    return idx;
  }

  const relevant = allEvents.filter((e) => e.ts <= nowISO);
  relevant.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id.localeCompare(b.id)));

  for (const ev of relevant) {
    switch (ev.type) {
      case "entity_registered": {
        const e = getEntity(ev.entity_id);
        e.displayToken = ev.display_token || ev.entity_id;
        e.routeId = ev.route_id || null;
        e.priority = !!ev.priority;
        e.status = "registered";
        e.history.push(ev);
        break;
      }
      case "queue_joined": {
        const e = getEntity(ev.entity_id);
        const s = stationState[ev.station_id];
        if (s && !s.queue.includes(ev.entity_id)) {
          s.queue.push(ev.entity_id);
        }
        e.currentStationId = ev.station_id;
        e.stepIndex = ev.step_index != null ? ev.step_index : e.stepIndex + 1;
        e.status = "waiting";
        e.queueEnteredAt = ev.ts;
        e.calledAt = null;
        e.serviceStartedAt = null;
        e.history.push(ev);
        break;
      }
      case "priority_insert": {
        const s = stationState[ev.station_id];
        if (s) {
          const idx = s.queue.indexOf(ev.entity_id);
          if (idx > 0) {
            s.queue.splice(idx, 1);
            s.queue.unshift(ev.entity_id);
          }
        }
        const e = getEntity(ev.entity_id);
        e.priority = true;
        e.history.push(ev);
        break;
      }
      case "pull_forward": {
        const s = stationState[ev.station_id];
        if (s) {
          const idx = s.queue.indexOf(ev.entity_id);
          if (idx > 0) {
            s.queue.splice(idx, 1);
            s.queue.unshift(ev.entity_id);
          }
        }
        getEntity(ev.entity_id).history.push(ev);
        break;
      }
      case "stepped_out": {
        const e = getEntity(ev.entity_id);
        e.away = true;
        e.awaySince = ev.ts;
        e.history.push(ev);
        break;
      }
      case "returned": {
        const e = getEntity(ev.entity_id);
        e.away = false;
        e.awaySince = null;
        e.history.push(ev);
        break;
      }
      case "return_nudge_shown": {
        nudgesLog.push({ entityId: ev.entity_id, stationId: ev.station_id, ts: ev.ts });
        getEntity(ev.entity_id).history.push(ev);
        break;
      }
      case "noshow_risk_flagged": {
        noShowRiskLog.push({ entityId: ev.entity_id, stationId: ev.station_id, level: ev.level, reasons: ev.reasons, ts: ev.ts });
        getEntity(ev.entity_id).history.push(ev);
        break;
      }
      case "reroute": {
        removeFromQueue(ev.from_station_id, ev.entity_id);
        const toStation = stationState[ev.to_station_id];
        if (toStation && !toStation.queue.includes(ev.entity_id)) {
          toStation.queue.push(ev.entity_id);
        }
        const e = getEntity(ev.entity_id);
        e.currentStationId = ev.to_station_id;
        e.status = "waiting";
        e.queueEnteredAt = ev.ts;
        e.history.push(ev);
        break;
      }
      case "called": {
        removeFromQueue(ev.station_id, ev.entity_id);
        const e = getEntity(ev.entity_id);
        e.status = "called";
        e.calledAt = ev.ts;
        e.history.push(ev);
        break;
      }
      case "service_started": {
        const r = resourceState[ev.resource_id];
        if (r) {
          r.status = "serving";
          r.currentEntityId = ev.entity_id;
        }
        const e = getEntity(ev.entity_id);
        e.status = "in_service";
        e.away = false;
        e.awaySince = null;
        e.serviceStartedAt = ev.ts;
        e.history.push(ev);
        break;
      }
      case "service_completed": {
        const r = resourceState[ev.resource_id];
        if (r) {
          // A resource_paused announced mid-service (e.g. an emergency called
          // while already serving someone) still holds until an explicit
          // resource_resumed — completing that one service must not clear it.
          if (r.status !== "paused") r.status = "idle";
          r.currentEntityId = null;
          r.serviceLog.push({
            entityId: ev.entity_id,
            start: ev.service_started_at || null,
            end: ev.ts,
            durationMin: ev.duration_min
          });
        }
        const e = getEntity(ev.entity_id);
        e.status = "completed_step";
        e.serviceCompletedAt = ev.ts;
        e.lastCompletedStationId = ev.station_id;
        e.history.push(ev);
        break;
      }
      case "no_show": {
        removeFromQueue(ev.station_id, ev.entity_id);
        const e = getEntity(ev.entity_id);
        e.status = "no_show";
        e.noShowAt = ev.ts;
        e.history.push(ev);
        break;
      }
      case "resource_paused": {
        const r = resourceState[ev.resource_id];
        if (r) {
          r.status = "paused";
          r.pausedReasonKey = ev.reason_key;
          r.pausedReasonText = ev.reason_text;
          r.pausedAt = ev.ts;
          r.expectedResumeAt = ev.expected_resume_at;
        }
        break;
      }
      case "resource_resumed": {
        const r = resourceState[ev.resource_id];
        if (r) {
          if (r.pausedAt) {
            r.pauseLog.push({
              start: r.pausedAt,
              end: ev.ts,
              reasonKey: r.pausedReasonKey,
              reasonText: r.pausedReasonText,
              expectedResumeAt: r.expectedResumeAt
            });
          }
          r.status = "idle";
          r.pausedReasonKey = null;
          r.pausedReasonText = null;
          r.pausedAt = null;
          r.expectedResumeAt = null;
        }
        break;
      }
      case "resequence_suggested": {
        suggestions.push({
          ts: ev.ts,
          suggestion: ev.suggestion,
          reasonKey: ev.reason_key,
          stationId: ev.station_id,
          relatedEntityId: ev.related_entity_id,
          accepted: !!ev.accepted
        });
        break;
      }
      case "journey_completed": {
        const e = getEntity(ev.entity_id);
        e.status = "journey_complete";
        e.journeyCompletedAt = ev.ts;
        e.history.push(ev);
        break;
      }
      case "prediction_shown": {
        const e = getEntity(ev.entity_id);
        const rec = {
          ts: ev.ts,
          estimator: ev.estimator,
          p50Min: ev.p50_min,
          p80Min: ev.p80_min,
          headlineMin: ev.headline_min,
          reasonKey: ev.reason_key,
          stationId: ev.station_id
        };
        e.predictions.push(rec);
        predictionsLog.push({ entityId: ev.entity_id, ...rec });
        break;
      }
      default:
        break;
    }
  }

  return {
    now: nowISO,
    entities,
    stations: stationState,
    resources: resourceState,
    suggestions,
    predictionsLog,
    nudgesLog,
    noShowRiskLog
  };
}

export function stationQueuePosition(state, stationId, entityId) {
  return state.stations[stationId].queue.indexOf(entityId);
}

export function resourcesForStation(data, stationId) {
  return data.resources.filter((r) => r.station_id === stationId);
}
