// Retrospective accuracy check — the only honest way to answer the brief's
// own #1 evaluation question ("does the range feel more trustworthy?")
// with evidence instead of vibes.
//
// This grades the system the way it's actually used: the estimate updates
// continuously as an entity moves through their visit, so accuracy is
// checked at *every* point it would realistically have been shown (each
// station the entity actually joined a queue at) — not just a single
// guess made the moment they walked in, which is an unrealistically hard
// bar even for a human (predicting an emergency that hasn't happened yet).
//
// Each estimator is graded on its own claim, not the other's scope:
// proposed claims "time to fully finish" from wherever the entity
// currently is, so it's checked against the real remaining time from
// each checkpoint; baseline only ever claims a next-station wait, so
// it's checked against the real wait for that specific station call.
// Grading baseline against the full remaining visit would be a scope
// mismatch dressed up as an accuracy score.
//
// No domain words here — pure event-log arithmetic.

import { deriveState } from "./deriveState.js";
import { getEstimate } from "./estimator.js";
import { parseISOToMin } from "../util.js";

export function computeCalibration(data, allEvents, currentState) {
  const proposed = { early: 0, hit: 0, late: 0, total: 0 };
  const baseline = { onTime: 0, late: 0, total: 0 };

  for (const entity of Object.values(currentState.entities)) {
    if (entity.status !== "journey_complete") continue;
    const completedMin = parseISOToMin(entity.journeyCompletedAt);

    const checkpoints = entity.history.filter((h) => h.type === "queue_joined");
    for (const checkpoint of checkpoints) {
      const checkpointMin = parseISOToMin(checkpoint.ts);
      const actualRemainingMin = completedMin - checkpointMin;
      if (actualRemainingMin <= 0) continue;

      // recompute state as it stood at this checkpoint — deriveState is a
      // pure function, so this is a genuine "what would we have shown
      // right then," not a lookup of what was actually rendered
      const stateAtCheckpoint = deriveState(data, allEvents, checkpoint.ts);

      const proposedHere = getEstimate("proposed", entity.id, stateAtCheckpoint, data, data.config, checkpointMin);
      if (proposedHere.available) {
        proposed.total += 1;
        if (actualRemainingMin < proposedHere.p50Min) proposed.early += 1;
        else if (actualRemainingMin <= proposedHere.p80Min) proposed.hit += 1;
        else proposed.late += 1;
      }

      const calledHere = entity.history.find(
        (h) => h.type === "called" && h.station_id === checkpoint.station_id && h.ts >= checkpoint.ts
      );
      if (calledHere) {
        const actualStationWaitMin = parseISOToMin(calledHere.ts) - checkpointMin;
        const baselineHere = getEstimate("baseline", entity.id, stateAtCheckpoint, data, data.config, checkpointMin);
        if (baselineHere.available && actualStationWaitMin > 0) {
          baseline.total += 1;
          // baseline's own claim, graded generously (+15% grace, +2min floor) on its own terms
          if (actualStationWaitMin <= baselineHere.headlineMin * 1.15 + 2) baseline.onTime += 1;
          else baseline.late += 1;
        }
      }
    }
  }

  return { proposed, baseline };
}
