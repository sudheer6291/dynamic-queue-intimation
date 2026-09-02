// M5 — active re-sequencing. Two interventions only, per the spec:
//   - on no_show: suggest pulling a waitlisted entity forward
//   - on resource_paused: suggest sending entities flagged for an alternate
//     station (e.g. a standing lab order) there first, instead of idling
//
// No domain words here — the alternate-station wiring comes from config.

export function computeLiveSuggestions(state, data, config, nowMin) {
  const live = [];
  const seenPullForward = new Set(
    state.suggestions.filter((s) => s.suggestion === "pull_forward").map((s) => s.relatedEntityId)
  );

  // no-show gaps without a recorded recovery
  for (const e of Object.values(state.entities)) {
    if (e.status !== "no_show" || !e.noShowAt) continue;
    if (seenPullForward.has(e.id)) continue;
    live.push({
      kind: "pull_forward",
      stationId: findStationForNoShow(e),
      relatedEntityId: e.id,
      reasonKey: "no_show_gap"
    });
  }

  const cfg = config.resequencing && config.resequencing.pause_alt_route;
  if (cfg) {
    const resources = data.resources.filter((r) => r.station_id === cfg.trigger_station_id);
    const allPaused = resources.length > 0 && resources.every((r) => state.resources[r.id].status === "paused");
    if (allPaused) {
      const queue = state.stations[cfg.trigger_station_id].queue;
      const flagged = queue.filter((id) => {
        const meta = data.entities.find((x) => x.id === id);
        return meta && meta[cfg.flag_field];
      });
      if (flagged.length > 0) {
        live.push({
          kind: "lab_first",
          stationId: cfg.trigger_station_id,
          altStationId: cfg.alt_station_id,
          entityIds: flagged,
          reasonKey: "resource_paused_alt_route"
        });
      }
    }
  }
  return live;
}

function findStationForNoShow(entity) {
  const last = entity.history[entity.history.length - 1];
  return (last && last.station_id) || entity.currentStationId;
}

export function recoveredSlotsCount(state) {
  return state.suggestions.filter((s) => s.suggestion === "pull_forward" && s.accepted).length;
}
