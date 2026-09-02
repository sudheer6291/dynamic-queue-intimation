import { getEstimate } from "../engine/estimator.js";
import { fmtDuration, el } from "../util.js";
import { nameOf } from "../i18n.js";

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
          st && st.status === "no_show" ? " (no-show)" : st && st.status === "journey_complete" ? " (done)" : "";
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
  const entity = state.entities[entityId];

  const cardBody = el("div", { class: "card-body text-center px-4 py-5" });
  cardBody.appendChild(
    el("div", { class: "text-uppercase text-muted small fw-bold mb-1" }, `${t("entity.id_prefix")} ${meta.display_token}`)
  );

  if (!entity || entity.status === "not_registered") {
    cardBody.appendChild(el("div", { class: "fs-4 fw-bold text-muted py-4" }, t("action.not_arrived")));
  } else if (entity.status === "no_show") {
    cardBody.appendChild(
      el("div", { class: "py-4" }, [
        el("i", { class: "bi bi-exclamation-octagon text-danger", style: "font-size:2.5rem" }),
        el("div", { class: "fs-5 fw-bold text-danger mt-2" }, t("action.no_show"))
      ])
    );
  } else if (entity.status === "journey_complete") {
    cardBody.appendChild(
      el("div", { class: "py-3" }, [
        el("i", { class: "bi bi-check-circle-fill text-success", style: "font-size:2.8rem" }),
        el("div", { class: "fs-4 fw-bold mt-2" }, t("action.done")),
        el(
          "div",
          { class: "text-muted mt-2" },
          "Total visit time: " + fmtDuration(minutesBetween(meta.actual_arrival_min, entity.journeyCompletedAt))
        )
      ])
    );
  } else {
    const stName = stationName(config, locale, entity.currentStationId, data);
    cardBody.appendChild(el("div", { class: "fs-3 fw-bold mb-3" }, stName));

    const result = getEstimate(ctx.estimatorMode, entityId, state, data, config, ctx.nowMin);
    ctx.logPredictionShown(entityId, entity.currentStationId, ctx.estimatorMode, result);

    if (!result.available) {
      cardBody.appendChild(
        el("div", { class: "alert alert-secondary d-inline-block" }, [
          el("i", { class: "bi bi-hourglass-split me-2" }),
          t("estimate.not_available")
        ])
      );
    } else if (result.isRange) {
      cardBody.appendChild(
        el("div", { class: "estimate-range" }, `${Math.max(0, Math.round(result.lowerBoundMin))}–${Math.max(0, Math.round(result.headlineMin))}`)
      );
      cardBody.appendChild(el("div", { class: "estimate-unit" }, `min, ${t("estimate.updating")}`));
      cardBody.appendChild(el("div", { class: "text-muted small mt-1" }, "until your visit is fully complete"));
    } else {
      cardBody.appendChild(el("div", { class: "estimate-range" }, `~${Math.max(0, Math.round(result.headlineMin))}`));
      cardBody.appendChild(el("div", { class: "estimate-unit" }, "min"));
      cardBody.appendChild(
        el("div", { class: "text-muted small mt-1" }, "for this station's queue only — doesn't account for delays")
      );
    }

    cardBody.appendChild(
      el(
        "span",
        { class: "badge rounded-pill text-bg-light border mt-3 px-3 py-2" },
        ctx.estimatorMode === "proposed" ? t("estimate.heuristic_label") : "Baseline: people ahead × median time"
      )
    );

    if (result.available && result.reasonText) {
      cardBody.appendChild(
        el("div", { class: "alert alert-warning text-start mt-3 mb-0" }, [
          el("i", { class: "bi bi-info-circle-fill me-2" }),
          el("strong", {}, "Why: "),
          result.reasonText
        ])
      );
    }

    const alert = computeLabFirstAlert(entityId, ctx);
    if (alert) {
      cardBody.appendChild(
        el("div", { class: "alert alert-primary text-start mt-3 mb-0 fw-semibold" }, [
          el("i", { class: "bi bi-signpost-2-fill me-2" }),
          alert.message
        ])
      );
    } else if (entity.status === "waiting" || entity.status === "called") {
      cardBody.appendChild(
        el("div", { class: "alert alert-light border text-start mt-3 mb-0" }, [
          el("i", { class: "bi bi-hourglass-split me-2 text-muted" }),
          t("action.wait")
        ])
      );
    }
  }

  const phone = el("div", { class: "phone-frame" }, [el("div", { class: "phone-screen" }, [cardBody])]);
  col.appendChild(phone);

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
              el(
                "li",
                { class: "list-group-item small d-flex justify-content-between" },
                [
                  el("span", {}, `${p.ts.slice(11, 16)} — ${p.estimator}`),
                  el("span", { class: "text-muted" }, `${p.p50Min}–${p.p80Min} min${p.reasonKey ? " (" + p.reasonKey + ")" : ""}`)
                ]
              )
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
