// A vertical, delivery-tracking-style timeline of an entity's whole route —
// done / current / upcoming / didn't-apply-this-visit — built purely from
// route.steps + entity.history + entity.stepIndex. This is the direct
// answer to "be very clear on the patient/customer workflow": every
// checkpoint the visit could touch, in order, with exactly where the
// entity actually is right now, not just the current station's name.
//
// No domain words here beyond formatting a condition_key into a caption —
// station/step vocabulary all comes from config/data, same as every other
// view.

import { nameOf } from "../i18n.js";
import { el } from "../util.js";

function humanizeCondition(conditionKey) {
  if (!conditionKey) return null;
  return `if ${conditionKey.replace(/_/g, " ")}`;
}

// Returns one entry per route step, each tagged with a status the caller
// renders — this is the single source of truth both journeyTracker.js and
// (if useful elsewhere later) anything else can build on.
export function computeJourneySteps(entityId, ctx) {
  const { state, data } = ctx;
  const entity = state.entities[entityId];
  if (!entity || !entity.routeId) return [];
  const route = data.routes.find((r) => r.id === entity.routeId);
  if (!route) return [];

  const joinedAt = new Map(); // step_index -> queue_joined event
  const completedAt = new Map(); // step_index -> service_completed event (matched by station, nearest after the join)
  for (const h of entity.history) {
    if (h.type === "queue_joined") joinedAt.set(h.step_index, h);
  }
  // service_completed events don't carry step_index, only station_id — match
  // each one to the join for that station closest before it in time.
  const joins = [...joinedAt.entries()].sort((a, b) => a[1].ts.localeCompare(b[1].ts));
  for (const h of entity.history) {
    if (h.type !== "service_completed") continue;
    const candidate = joins
      .filter(([, j]) => j.station_id === h.station_id && j.ts <= h.ts)
      .sort((a, b) => b[1].ts.localeCompare(a[1].ts))[0];
    if (candidate) completedAt.set(candidate[0], h);
  }

  const finished = entity.status === "journey_complete" || entity.status === "no_show";
  const steps = route.steps.slice().sort((a, b) => a.step_index - b.step_index);

  return steps.map((step) => {
    const station = data.stations.find((s) => s.id === step.station_id);
    const joined = joinedAt.get(step.step_index);
    const completed = completedAt.get(step.step_index);
    let status;
    if (joined && step.step_index === entity.stepIndex && !finished) {
      status = entity.status === "no_show" ? "skipped" : "current";
    } else if (joined) {
      status = "done";
    } else if (step.step_index < entity.stepIndex || finished) {
      status = "skipped"; // a conditional step whose condition didn't apply this visit
    } else {
      status = "upcoming";
    }
    return {
      stepIndex: step.step_index,
      stationId: step.station_id,
      stationName: station ? undefined : step.station_id, // resolved by caller (needs t/locale)
      station,
      conditional: !!step.conditional,
      conditionKey: step.condition_key || null,
      revisit: !!step.revisit,
      status,
      joinedAt: joined ? joined.ts : null,
      completedAt: completed ? completed.ts : null
    };
  });
}

function statusIcon(status) {
  if (status === "done") return "bi-check-lg";
  if (status === "current") return "bi-record-fill";
  if (status === "skipped") return "bi-dash-lg";
  return "";
}

export function renderJourneyTracker(entityId, ctx) {
  const { config, locale, t } = ctx;
  const steps = computeJourneySteps(entityId, ctx);
  if (!steps.length) return el("div", {});

  const list = el("div", { class: "journey" });
  steps.forEach((step, idx) => {
    const isLast = idx === steps.length - 1;
    const stationLabel = step.station ? nameOf(config, locale, step.station.name_key) : step.stationId;
    const label = step.revisit ? `${stationLabel} — follow-up` : stationLabel;

    let caption = null;
    if (step.status === "done" && step.completedAt) {
      caption = `Completed ${step.completedAt.slice(11, 16)}`;
    } else if (step.status === "current") {
      caption = "You're here now";
    } else if (step.status === "skipped" && step.conditional) {
      caption = "Not needed this visit";
    } else if (step.status === "upcoming" && step.conditional) {
      caption = humanizeCondition(step.conditionKey);
    }

    const node = el("div", { class: `journey-node journey-node-${step.status}` }, [
      el("i", { class: `bi ${statusIcon(step.status)}` })
    ]);
    const textCol = el("div", { class: "journey-text" }, [
      el("div", { class: `journey-label journey-label-${step.status}` }, label),
      caption ? el("div", { class: "journey-caption" }, caption) : null
    ]);
    const row = el("div", { class: `journey-step${isLast ? " journey-step-last" : ""}` }, [
      el("div", { class: "journey-rail" }, [node, isLast ? null : el("div", { class: `journey-connector journey-connector-${step.status === "upcoming" ? "upcoming" : "filled"}` })]),
      textCol
    ]);
    list.appendChild(row);
  });

  return el("div", { class: "journey-card" }, [
    el("div", { class: "journey-card-title" }, [el("i", { class: "bi bi-signpost-split-fill me-2" }), t("journey.title") || "Your journey today"]),
    list
  ]);
}
