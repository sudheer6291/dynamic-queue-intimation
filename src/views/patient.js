import { getEstimate, currentStationWaitEstimate } from "../engine/estimator.js";
import { fmtDuration, el } from "../util.js";
import { nameOf } from "../i18n.js";
import { actionStepOut, actionReturn } from "../actions.js";
import { renderJourneyTracker } from "./journeyTracker.js";

function stationName(config, locale, stationId, data) {
  const s = data.stations.find((x) => x.id === stationId);
  return s ? nameOf(config, locale, s.name_key) : stationId;
}

function computeLabFirstAlert(entityId, ctx) {
  const { state, data, config, nowMin } = ctx;
  const cfg = config.resequencing && config.resequencing.pause_alt_route;
  if (!cfg) return null;
  const entity = state.entities[entityId];
  const meta = data.entities.find((x) => x.id === entityId);
  if (!entity || entity.status !== "waiting") return null;
  if (entity.currentStationId !== cfg.trigger_station_id) return null;
  if (!meta || !meta[cfg.flag_field]) return null;

  const resources = data.resources.filter((r) => r.station_id === cfg.trigger_station_id);
  const pausedResources = resources.map((r) => state.resources[r.id]).filter((r) => r.status === "paused");
  if (pausedResources.length < resources.length) return null;

  const proposed = getEstimate("proposed", entityId, state, data, config, nowMin);
  if (!proposed.available || !proposed.pausedInfo) return null;

  const altStation = data.stations.find((s) => s.id === cfg.alt_station_id);
  const altMedian = altStation.service_time.median_min;
  const minLead = (config.display && config.display.min_lead_time_min) || 5;
  const pauseRemaining = proposed.p50Min; // rough — dominated by pause remaining at this point in the journey
  if (pauseRemaining - altMedian < minLead) return null;

  return {
    message: `Please head to ${nameOf(config, ctx.locale, altStation.name_key)} now`,
    reasonText: proposed.reasonText
  };
}

// Small chip in the hero header giving a one-glance status word beyond the
// station name — "waiting", "up now", "away"... a modern tracking-app
// habit (delivery/ride apps always show a status word, not just a number).
function heroStatusChip(entity, awayNudging) {
  if (!entity) return null;
  if (awayNudging) return { icon: "bi-bell-fill", label: "Head back now" };
  if (entity.away) return { icon: "bi-geo-alt-fill", label: "Stepped out" };
  if (entity.status === "called") return { icon: "bi-megaphone-fill", label: "You're being called" };
  if (entity.status === "in_service") return { icon: "bi-play-circle-fill", label: "In progress" };
  if (entity.status === "waiting") return { icon: "bi-hourglass-split", label: "Waiting" };
  return null;
}

function renderHero(entityId, ctx) {
  const { state, data, config, locale, t } = ctx;
  const meta = data.entities.find((e) => e.id === entityId);
  const entity = state.entities[entityId];

  const hero = el("div", { class: "hero-card" });
  hero.appendChild(el("div", { class: "hero-token" }, `${t("entity.id_prefix")} ${meta.display_token}`));

  if (!entity || entity.status === "not_registered") {
    hero.appendChild(
      el("div", { class: "text-center py-3" }, [
        el("i", { class: "bi bi-clock-history hero-terminal-icon" }),
        el("div", { class: "hero-station mt-2" }, t("action.not_arrived"))
      ])
    );
    return { hero, result: null, entity };
  }
  if (entity.status === "no_show") {
    hero.appendChild(
      el("div", { class: "text-center py-3" }, [
        el("i", { class: "bi bi-exclamation-octagon-fill hero-terminal-icon" }),
        el("div", { class: "hero-station mt-2" }, t("action.no_show"))
      ])
    );
    return { hero, result: null, entity };
  }
  if (entity.status === "journey_complete") {
    hero.appendChild(
      el("div", { class: "text-center py-3" }, [
        el("i", { class: "bi bi-check-circle-fill hero-terminal-icon" }),
        el("div", { class: "hero-station mt-2" }, t("action.done")),
        el(
          "div",
          { class: "hero-eta-unit mt-2" },
          "Total visit time: " + fmtDuration(minutesBetween(meta.actual_arrival_min, entity.journeyCompletedAt))
        )
      ])
    );
    return { hero, result: null, entity };
  }

  const stName = stationName(config, locale, entity.currentStationId, data);
  hero.appendChild(el("div", { class: "hero-station" }, stName));

  const result = getEstimate(ctx.estimatorMode, entityId, state, data, config, ctx.nowMin);
  ctx.logPredictionShown(entityId, entity.currentStationId, ctx.estimatorMode, result);

  if (!result.available) {
    hero.appendChild(el("div", { class: "hero-eta-unit mt-3" }, [el("i", { class: "bi bi-hourglass-split me-2" }), t("estimate.not_available")]));
  } else if (result.isRange) {
    hero.appendChild(
      el("div", { class: "hero-eta" }, `${Math.max(0, Math.round(result.lowerBoundMin))}–${Math.max(0, Math.round(result.headlineMin))}`)
    );
    hero.appendChild(el("div", { class: "hero-eta-unit" }, `min, ${t("estimate.updating")} · until your visit is fully complete`));
  } else {
    hero.appendChild(el("div", { class: "hero-eta" }, `~${Math.max(0, Math.round(result.headlineMin))}`));
    hero.appendChild(el("div", { class: "hero-eta-unit" }, "min for this station's queue only"));
  }

  const stepOutThreshold = (config.display && config.display.step_out_min_wait_min) || 20;
  const nudgeThreshold = (config.display && config.display.return_nudge_lead_time_min) || 15;
  let awayNudging = false;
  if (entity.away) {
    const stationWait = currentStationWaitEstimate(entityId, state, data, config, ctx.nowMin);
    awayNudging = stationWait.available && stationWait.p80Min <= nudgeThreshold;
  }
  const chip = heroStatusChip(entity, awayNudging);
  if (chip) {
    hero.appendChild(el("div", { class: "hero-status-chip" }, [el("i", { class: `bi ${chip.icon}` }), chip.label]));
  }

  return { hero, result, entity, stepOutThreshold, nudgeThreshold, awayNudging };
}

export function renderPatientView(root, ctx) {
  const { state, data, config, t, locale } = ctx;
  root.innerHTML = "";

  const outer = el("div", { class: "row justify-content-center g-4" });
  const col = el("div", { class: "col-12 col-md-8 col-lg-5" });

  // entity picker
  const pickerCard = el("div", { class: "d-flex align-items-center justify-content-center gap-2 mb-3" }, [
    el("span", { class: "text-muted small text-uppercase fw-semibold" }, `${t("entity.label")}`),
    (() => {
      const select = el("select", { id: "entity-select", class: "form-select form-select-sm w-auto" });
      for (const e of data.entities) {
        const st = state.entities[e.id];
        const statusTag =
          st && st.status === "no_show"
            ? " (no-show)"
            : st && st.status === "journey_complete"
              ? " (done)"
              : st && st.away
                ? " (away)"
                : "";
        const opt = el("option", { value: e.id }, `${e.display_token}${statusTag}`);
        if (e.id === ctx.app.selectedEntityId) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener("change", (e) => ctx.setSelectedEntity(e.target.value));
      return select;
    })()
  ]);
  col.appendChild(pickerCard);

  const entityId = ctx.app.selectedEntityId;
  const meta = data.entities.find((e) => e.id === entityId);
  const { hero, result, entity, stepOutThreshold, nudgeThreshold, awayNudging } = renderHero(entityId, ctx);

  const body = el("div", { class: "patient-body" });

  if (entity && !["not_registered", "no_show", "journey_complete"].includes(entity.status)) {
    body.appendChild(
      el(
        "span",
        { class: "badge rounded-pill text-bg-light border px-3 py-2" },
        ctx.estimatorMode === "proposed" ? t("estimate.heuristic_label") : "Baseline: people ahead × median time"
      )
    );

    if (result && result.available && result.reasonText) {
      body.appendChild(el("div", { class: "info-chip info-chip-why mt-3" }, [el("i", { class: "bi bi-info-circle-fill mt-1" }), el("span", {}, [el("strong", {}, "Why: "), result.reasonText])]));
    }

    const alert = computeLabFirstAlert(entityId, ctx);
    if (alert) {
      body.appendChild(el("div", { class: "info-chip info-chip-alert mt-3" }, [el("i", { class: "bi bi-signpost-2-fill mt-1" }), alert.message]));
    } else if (entity.away) {
      if (awayNudging) {
        ctx.logNudgeShown(entityId, entity.currentStationId);
        body.appendChild(el("div", { class: "info-chip info-chip-nudge mt-3" }, [el("i", { class: "bi bi-bell-fill mt-1" }), t("action.return_now")]));
      } else {
        body.appendChild(el("div", { class: "info-chip info-chip-away mt-3" }, [el("i", { class: "bi bi-geo-alt-fill mt-1" }), t("action.stepped_out")]));
      }
      const backBtn = el("button", { class: "btn btn-outline-primary pill-btn w-100 mt-3" }, [el("i", { class: "bi bi-arrow-return-left me-2" }), t("action.im_back")]);
      backBtn.addEventListener("click", () => ctx.dispatch(actionReturn, entityId, entity.currentStationId));
      body.appendChild(backBtn);
    } else if (entity.status === "waiting" || entity.status === "called") {
      body.appendChild(el("div", { class: "info-chip info-chip-wait mt-3" }, [el("i", { class: "bi bi-hourglass-split mt-1" }), t("action.wait")]));
      if (entity.status === "waiting" && result && result.available && result.headlineMin >= stepOutThreshold) {
        const stepBtn = el("button", { class: "btn btn-outline-secondary pill-btn w-100 mt-2" }, [el("i", { class: "bi bi-box-arrow-right me-2" }), t("action.step_out")]);
        stepBtn.addEventListener("click", () => ctx.dispatch(actionStepOut, entityId, entity.currentStationId));
        body.appendChild(stepBtn);
      }
    }
  }

  const phone = el("div", { class: "phone-frame" }, [el("div", { class: "phone-screen" }, [hero, body])]);
  col.appendChild(phone);

  // the journey tracker — every checkpoint this visit could touch, in
  // order, with exactly where the entity is right now
  if (entity && entity.status !== "not_registered") {
    col.appendChild(el("div", { class: "mt-3" }, [renderJourneyTracker(entityId, ctx)]));
  }

  // prediction log
  const logCard = el("div", { class: "card mt-3 shadow-sm border-0" }, [
    el("div", { class: "card-header bg-white fw-semibold small text-uppercase text-muted" }, [
      el("i", { class: "bi bi-journal-text me-2" }),
      "Prediction log (for this patient)"
    ]),
    (() => {
      const listGroup = el("ul", { class: "list-group list-group-flush timeline" });
      if (entity && entity.predictions.length) {
        entity.predictions
          .slice(-8)
          .reverse()
          .forEach((p) => {
            listGroup.appendChild(
              el("li", { class: "list-group-item small d-flex justify-content-between" }, [
                el("span", {}, `${p.ts.slice(11, 16)} — ${p.estimator}`),
                el("span", { class: "text-muted" }, `${p.p50Min}–${p.p80Min} min${p.reasonKey ? " (" + p.reasonKey + ")" : ""}`)
              ])
            );
          });
      } else {
        listGroup.appendChild(el("li", { class: "list-group-item text-muted small" }, "No predictions logged yet."));
      }
      return listGroup;
    })()
  ]);
  col.appendChild(logCard);

  outer.appendChild(col);
  root.appendChild(outer);
}

function minutesBetween(startMin, endISO) {
  const t = endISO.split("T")[1];
  const [hh, mm] = t.split(":").map(Number);
  return hh * 60 + mm - startMin;
}
