// Heuristic no-show risk — deliberately not a trained model (this
// prototype's own "no ML" line, see the brief's out-of-scope §9): a
// transparent, explainable score built only from signals actually
// observable in the live event log, recomputed fresh every render exactly
// like every other estimate here. The point isn't forecasting the future
// perfectly — it's giving Front Desk a reason to look twice at someone
// *before* their slot is wasted, instead of only finding out once a call
// goes unanswered (the existing called -> grace period -> no_show flow,
// which by definition can't fire until it's already too late to recover
// gracefully).
//
// Three independent signals, each carrying its own plain-language reason
// — "every delay has a reason string" applies here too, not just to
// resource pauses:
//   1. Stepped out and overdue to return — the strongest signal available,
//      and the literal, honest story behind most real no-shows.
//   2. Already waiting well past the range they were personally shown for
//      *this* station (not the whole remaining visit — a lab-and-return
//      patient's full-journey estimate includes steps they haven't
//      reached yet, which isn't what "have they been kept waiting" means).
//   3. Arrived late against their own scheduled slot — a real,
//      known-at-arrival fact already carried in every seed entity's own
//      metadata, not a peek at ground truth the seed authored for demo
//      purposes (that would be is_no_show_candidate, which this
//      deliberately never reads).
//
// No domain words here — pure event-log arithmetic, same spirit as
// calibration.js.

import { parseISOToMin } from "../util.js";
import { currentStationWaitEstimate } from "./estimator.js";

export function computeNoShowRisk(entityId, state, data, config, nowMin) {
  const entity = state.entities[entityId];
  if (!entity || entity.status !== "waiting") {
    return { level: "none", score: 0, reasons: [] };
  }

  const cfg = config.no_show_risk || {};
  const awayOverdueMin = cfg.away_overdue_min ?? 12;
  const overwaitMultiplier = cfg.overwait_multiplier ?? 1.5;
  const lateArrivalThresholdMin = cfg.late_arrival_threshold_min ?? 15;

  let score = 0;
  const reasons = [];

  // 1. Stepped out and overdue to return
  if (entity.away && entity.awaySince) {
    const awayMin = nowMin - parseISOToMin(entity.awaySince);
    if (awayMin >= awayOverdueMin) {
      score += 3;
      reasons.push(`Stepped out ${Math.round(awayMin)} min ago, hasn't returned`);
    }
  }

  // 2. Already waiting well past the range shown for this station
  if (!entity.away && entity.queueEnteredAt) {
    const waitedMin = nowMin - parseISOToMin(entity.queueEnteredAt);
    const est = currentStationWaitEstimate(entityId, state, data, config, nowMin);
    if (est.available && est.p80Min > 0 && waitedMin > est.p80Min * overwaitMultiplier) {
      score += 2;
      reasons.push(`Already waited ${Math.round(waitedMin)} min here — well past the range shown`);
    }
  }

  // 3. Arrived late against their own scheduled slot
  const meta = data.entities.find((e) => e.id === entityId);
  if (meta && meta.scheduled_arrival_min != null && meta.actual_arrival_min != null) {
    const lateBy = meta.actual_arrival_min - meta.scheduled_arrival_min;
    if (lateBy >= lateArrivalThresholdMin) {
      score += 1;
      reasons.push(`Arrived ${lateBy} min after their scheduled slot`);
    }
  }

  const level = score >= 3 ? "high" : score >= 2 ? "medium" : score >= 1 ? "low" : "none";
  return { level, score, reasons };
}

// Live count for the Admin dashboard — everyone currently waiting whose
// risk clears the "worth a badge" bar (medium+; "low" alone is too weak a
// signal to surface as an actionable count without inviting alert fatigue).
export function countAtRisk(state, data, config, nowMin) {
  let count = 0;
  for (const entity of Object.values(state.entities)) {
    if (entity.status !== "waiting") continue;
    const risk = computeNoShowRisk(entity.id, state, data, config, nowMin);
    if (risk.level === "medium" || risk.level === "high") count += 1;
  }
  return count;
}
