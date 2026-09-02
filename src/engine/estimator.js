// Two estimators, switchable in the UI — the comparison is the demo.
//
// baselineEstimate(): what the market ships. people_ahead * median service
// time at the current station. A single number. Never looks at pauses.
//
// proposedEstimate(): p50/p80 across the entity's remaining route, adjusted
// for resource pause state, a rolling mean of recent completions, and
// probabilistic expansion of conditional route steps. No machine learning —
// just the distributions in stations.json plus today's observed drift.
//
// No domain words in this file (checkpoint 8).

import { parseISOToMin } from "../util.js";
import { resourcesForStation } from "./deriveState.js";

function getStationServiceStats(stationId, state, data, config) {
  const station = data.stations.find((s) => s.id === stationId);
  const prior = station.service_time;
  const resources = resourcesForStation(data, stationId);
  const samples = [];
  for (const r of resources) {
    const rs = state.resources[r.id];
    if (!rs) continue;
    for (const log of rs.serviceLog) samples.push(log);
  }
  samples.sort((a, b) => (a.end < b.end ? 1 : -1)); // most recent first
  const window = config.estimator.rolling_window || 5;
  const recent = samples.slice(0, window);
  const count = recent.length;
  const observedMean = count ? recent.reduce((s, x) => s + x.durationMin, 0) / count : null;

  const minSamples = config.estimator.min_samples_for_observed_mean || 3;
  let median;
  if (count === 0) {
    median = prior.median_min;
  } else if (count >= minSamples) {
    median = observedMean;
  } else {
    median = (observedMean * count + prior.median_min * (minSamples - count)) / minSamples;
  }
  const tailRatio = prior.p80_min / prior.median_min;
  const p80 = median * tailRatio;
  return { median, p80, sampleCount: count, prior };
}

function pauseInfoForStation(stationId, state, data) {
  const resources = resourcesForStation(data, stationId);
  const capacity = resources.length;
  const paused = resources
    .map((r) => state.resources[r.id])
    .filter((rs) => rs && rs.status === "paused");
  const serving = resources.filter((r) => state.resources[r.id] && state.resources[r.id].status === "serving").length;
  return { capacity, paused, serving, allPaused: paused.length >= capacity && capacity > 0 };
}

function currentStationWait(entityId, state, data, config, nowMin) {
  const entity = state.entities[entityId];
  const stationId = entity.currentStationId;
  const queue = state.stations[stationId].queue;
  const position = queue.indexOf(entityId);
  const { capacity, paused, serving, allPaused } = pauseInfoForStation(stationId, state, data);
  const stats = getStationServiceStats(stationId, state, data, config);

  if (entity.status === "called" || entity.status === "in_service") {
    return { p50: 0, p80: entity.status === "called" ? 1 : Math.max(1, stats.median * 0.3), pausedInfo: null };
  }

  if (allPaused) {
    const earliest = paused.reduce((best, r) => (!best || r.pausedAt < best.pausedAt ? r : best), null);
    const pausedAtMin = parseISOToMin(earliest.pausedAt);
    const expectedResumeMin = parseISOToMin(earliest.expectedResumeAt);
    const elapsedSincePause = Math.max(0, nowMin - pausedAtMin);
    const statedRemaining = expectedResumeMin - nowMin;
    // Trust the stated resume time only loosely: a pause that has already
    // run for N minutes is, at minimum, assumed to need about that much
    // longer again (classic "it's taken this long, expect as much more"
    // rule for events with an unknown remaining duration) — so the estimate
    // never quietly drifts back toward "business as usual" while the
    // resource is still genuinely paused.
    const p50PauseRemaining = Math.max(statedRemaining, elapsedSincePause * 0.5, 3);
    const p80PauseRemaining = Math.max(statedRemaining, elapsedSincePause, 5);

    const ahead = Math.max(0, position);
    const queueP50 = (ahead * stats.median) / capacity;
    const queueP80 = ((ahead * stats.p80) / capacity) * (config.estimator.queue_wait_inflation_p80 || 1.3);

    return {
      p50: p50PauseRemaining + queueP50,
      p80: p80PauseRemaining + queueP80,
      pausedInfo: {
        resourceId: earliest.id,
        reasonKey: earliest.pausedReasonKey,
        reasonText: earliest.pausedReasonText,
        expectedResumeAt: earliest.expectedResumeAt,
        elapsedMin: elapsedSincePause
      }
    };
  }

  const effectiveCapacity = Math.max(1, capacity - paused.length);
  const ahead = Math.max(0, position);
  const inProgressRemainder = serving > 0 ? stats.median / 2 : 0;
  const queueP50 = (ahead * stats.median) / effectiveCapacity + inProgressRemainder;
  const queueP80 =
    (ahead * stats.p80 * (config.estimator.queue_wait_inflation_p80 || 1.3)) / effectiveCapacity +
    inProgressRemainder * 1.3;

  return { p50: queueP50, p80: queueP80, pausedInfo: null };
}

function resolvedConditionKeys(entity, route) {
  const set = new Set();
  for (const h of entity.history) {
    if (h.type === "queue_joined") {
      const step = route.steps.find((s) => s.step_index === h.step_index);
      if (step && step.condition_key) set.add(step.condition_key);
    }
  }
  return set;
}

function futureRemaining(entityId, state, data) {
  const entity = state.entities[entityId];
  const route = data.routes.find((r) => r.id === entity.routeId);
  if (!route) return { p50: 0, p80: 0, items: [] };
  const resolved = resolvedConditionKeys(entity, route);
  let p50 = 0;
  let p80 = 0;
  const items = [];
  for (const step of route.steps) {
    if (step.step_index <= entity.stepIndex) continue;
    const probability = !step.conditional ? 1 : resolved.has(step.condition_key) ? 1 : step.probability;
    if (probability <= 0) continue;
    const station = data.stations.find((s) => s.id === step.station_id);
    const svc = step.service_time_override || station.service_time;
    const stepP50 = probability * svc.median_min;
    const stepP80 = probability * svc.p80_min;
    p50 += stepP50;
    p80 += stepP80;
    items.push({ stationId: step.station_id, p50: stepP50, p80: stepP80, probability });
  }
  return { p50, p80, items };
}

export function baselineEstimate(entityId, state, data, config, nowMin) {
  const entity = state.entities[entityId];
  if (!entity || entity.status === "not_registered") return { available: false, reasonKey: "not_registered" };
  if (["journey_complete", "no_show"].includes(entity.status)) return { available: false, reasonKey: entity.status };

  const stationId = entity.currentStationId;
  const station = data.stations.find((s) => s.id === stationId);
  const queue = state.stations[stationId].queue;
  const position = queue.indexOf(entityId);
  const ahead = entity.status === "called" || entity.status === "in_service" ? 0 : Math.max(0, position);
  const resources = resourcesForStation(data, stationId);
  const capacity = resources.length;
  const min = (ahead * station.service_time.median_min) / capacity;

  return {
    available: true,
    estimator: "baseline",
    p50Min: min,
    p80Min: min,
    headlineMin: min,
    lowerBoundMin: min,
    reasonKey: null,
    reasonText: null,
    degraded: false,
    isRange: false
  };
}

export function proposedEstimate(entityId, state, data, config, nowMin) {
  const entity = state.entities[entityId];
  if (!entity || entity.status === "not_registered") return { available: false, reasonKey: "not_registered" };
  if (["journey_complete", "no_show"].includes(entity.status)) return { available: false, reasonKey: entity.status };

  const current = currentStationWait(entityId, state, data, config, nowMin);
  const future = futureRemaining(entityId, state, data);

  const p50 = current.p50 + future.p50;
  const p80 = current.p80 + future.p80;
  const headlinePct = (config.display && config.display.headline_percentile) || "p80";
  const lowerPct = (config.display && config.display.lower_bound_percentile) || "p50";
  const values = { p50, p80 };

  let reasonKey = current.pausedInfo ? current.pausedInfo.reasonKey : null;
  let reasonText = current.pausedInfo ? current.pausedInfo.reasonText : null;

  // bound the update swing: never let the headline jump silently
  const priorPredictions = entity.predictions.filter((p) => p.estimator === "proposed");
  let bigSwing = false;
  if (priorPredictions.length) {
    const last = priorPredictions[priorPredictions.length - 1];
    const delta = values[headlinePct] - last.headlineMin;
    const maxSwing = (config.display && config.display.max_swing_per_update_min) || 15;
    if (Math.abs(delta) > maxSwing) {
      bigSwing = true;
      if (!reasonText) {
        reasonText = delta > 0 ? "Running behind schedule — queue is longer than expected" : "Queue moving faster than expected";
        reasonKey = reasonKey || (delta > 0 ? "running_behind" : "moving_faster");
      }
    }
  }

  return {
    available: true,
    estimator: "proposed",
    p50Min: p50,
    p80Min: p80,
    headlineMin: values[headlinePct],
    lowerBoundMin: values[lowerPct],
    reasonKey,
    reasonText,
    degraded: false,
    isRange: true,
    bigSwing,
    pausedInfo: current.pausedInfo,
    breakdown: future.items
  };
}

export function getEstimate(estimatorId, entityId, state, data, config, nowMin) {
  return estimatorId === "baseline"
    ? baselineEstimate(entityId, state, data, config, nowMin)
    : proposedEstimate(entityId, state, data, config, nowMin);
}
