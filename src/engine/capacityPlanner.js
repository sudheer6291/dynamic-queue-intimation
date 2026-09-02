// "What if?" capacity planning — the differentiator a live-token-number
// competitor cannot offer, because it requires having modeled the queue
// as a system in the first place, not just displayed its current length.
//
// This reuses exactly the same rolling-mean service-time stats the
// estimator already trusts (today's observed drift, blended with the
// station's prior distribution) — the only thing that changes is the
// resource count, so the answer is a straight extension of the same
// honest, explainable math, not a separate model.
//
// No domain words here.

import { getStationServiceStats } from "./estimator.js";
import { resourcesForStation } from "./deriveState.js";

// Projects how long it would take to clear everyone currently queued at a
// station, under a hypothetical resource count. Deliberately scoped to
// "clear the queue that exists right now" rather than projecting future
// arrivals — arrivals are genuinely unknown ahead of time in a live
// system, so this stays honest about what it can and can't claim.
export function whatIfStationLoad(stationId, state, data, config, capacityDelta) {
  const resources = resourcesForStation(data, stationId);
  const actualCapacity = resources.length;
  const hypotheticalCapacity = Math.max(1, actualCapacity + capacityDelta);
  const queueLen = state.stations[stationId].queue.length;
  const stats = getStationServiceStats(stationId, state, data, config);
  const inflation = (config.estimator && config.estimator.queue_wait_inflation_p80) || 1.3;

  const clearP50 = (queueLen * stats.median) / hypotheticalCapacity;
  const clearP80 = ((queueLen * stats.p80) / hypotheticalCapacity) * inflation;

  return {
    stationId,
    actualCapacity,
    hypotheticalCapacity,
    capacityDelta,
    queueLen,
    clearP50,
    clearP80
  };
}

// Convenience: the station currently carrying the longest queue — a
// sensible default for "which station should I even be asking about."
export function busiestStationId(state, data) {
  let best = null;
  let bestLen = -1;
  for (const station of data.stations) {
    const len = state.stations[station.id].queue.length;
    if (len > bestLen) {
      best = station.id;
      bestLen = len;
    }
  }
  return best || (data.stations[0] && data.stations[0].id);
}
