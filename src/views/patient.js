import { getEstimate } from "../engine/estimator.js";
import { fmtDuration } from "../util.js";
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

  const wrap = document.createElement("div");
  wrap.className = "grid";
  wrap.style.maxWidth = "480px";
  wrap.style.margin = "0 auto";

  const picker = document.createElement("div");
  picker.className = "entity-picker";
  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = `${t("entity.label")}:`;
  const select = document.createElement("select");
  for (const e of data.entities) {
    const opt = document.createElement("option");
    opt.value = e.id;
    const st = state.entities[e.id];
    const statusTag = st && st.status === "no_show" ? " (no-show)" : st && st.status === "journey_complete" ? " (done)" : "";
    opt.textContent = `${e.display_token}${statusTag}`;
    if (e.id === ctx.app.selectedEntityId) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", (e) => ctx.setSelectedEntity(e.target.value));
  picker.appendChild(label);
  picker.appendChild(select);
  wrap.appendChild(picker);

  const entityId = ctx.app.selectedEntityId;
  const meta = data.entities.find((e) => e.id === entityId);
  const entity = state.entities[entityId];

  const phone = document.createElement("div");
  phone.className = "phone-frame";
  const screen = document.createElement("div");
  screen.className = "phone-screen";
  const card = document.createElement("div");
  card.className = "patient-card";

  const tokenEl = document.createElement("div");
  tokenEl.className = "patient-token";
  tokenEl.textContent = `${t("entity.id_prefix")} ${meta.display_token}`;
  card.appendChild(tokenEl);

  if (!entity || entity.status === "not_registered") {
    card.appendChild(makeLine("patient-station", t("action.not_arrived")));
  } else if (entity.status === "no_show") {
    card.appendChild(makeLine("patient-station", t("action.no_show")));
  } else if (entity.status === "journey_complete") {
    card.appendChild(makeLine("patient-station", t("action.done")));
    const total = document.createElement("div");
    total.className = "estimate-caption";
    total.textContent = "Total visit time: " + fmtDuration(minutesBetween(meta.actual_arrival_min, entity.journeyCompletedAt, config));
    card.appendChild(total);
  } else {
    const stName = stationName(config, locale, entity.currentStationId, data);
    card.appendChild(makeLine("patient-station", stName));

    const result = getEstimate(ctx.estimatorMode, entityId, state, data, config, ctx.nowMin);
    ctx.logPredictionShown(entityId, entity.currentStationId, ctx.estimatorMode, result);

    if (!result.available) {
      const na = document.createElement("div");
      na.className = "estimate-caption";
      na.textContent = t("estimate.not_available");
      card.appendChild(na);
    } else if (result.isRange) {
      const range = document.createElement("div");
      range.className = "estimate-range";
      range.textContent = `${Math.max(0, Math.round(result.lowerBoundMin))}–${Math.max(
        0,
        Math.round(result.headlineMin)
      )}`;
      card.appendChild(range);
      const unit = document.createElement("div");
      unit.className = "estimate-unit";
      unit.textContent = `min, ${t("estimate.updating")}`;
      card.appendChild(unit);
      const scope = document.createElement("div");
      scope.className = "estimate-caption";
      scope.textContent = "until your visit is fully complete";
      card.appendChild(scope);
    } else {
      const range = document.createElement("div");
      range.className = "estimate-range";
      range.textContent = `~${Math.max(0, Math.round(result.headlineMin))}`;
      card.appendChild(range);
      const unit = document.createElement("div");
      unit.className = "estimate-unit";
      unit.textContent = "min";
      card.appendChild(unit);
      const scope = document.createElement("div");
      scope.className = "estimate-caption";
      scope.textContent = "for this station's queue only — doesn't account for delays";
      card.appendChild(scope);
    }

    const heur = document.createElement("div");
    heur.className = "estimate-heuristic-note";
    heur.textContent = ctx.estimatorMode === "proposed" ? t("estimate.heuristic_label") : "Baseline: people ahead × median time";
    card.appendChild(heur);

    if (result.available && result.reasonText) {
      const why = document.createElement("div");
      why.className = "why-box";
      why.innerHTML = `<strong>Why:</strong> ${result.reasonText}`;
      card.appendChild(why);
    }

    const alert = computeLabFirstAlert(entityId, ctx);
    if (alert) {
      const box = document.createElement("div");
      box.className = "alert-box";
      box.textContent = alert.message;
      card.appendChild(box);
    } else if (entity.status === "waiting" || entity.status === "called") {
      const box = document.createElement("div");
      box.className = "alert-box";
      box.style.background = "#f3f5f8";
      box.style.color = "var(--ink-soft)";
      box.style.fontWeight = "400";
      box.textContent = t("action.wait");
      card.appendChild(box);
    }
  }

  screen.appendChild(card);
  phone.appendChild(screen);
  wrap.appendChild(phone);

  const debugPanel = document.createElement("div");
  debugPanel.className = "panel";
  debugPanel.style.marginTop = "8px";
  const h3 = document.createElement("h3");
  h3.textContent = "Prediction log (for this patient)";
  debugPanel.appendChild(h3);
  const tl = document.createElement("div");
  tl.className = "timeline";
  if (entity && entity.predictions.length) {
    entity.predictions
      .slice(-8)
      .reverse()
      .forEach((p) => {
        const row = document.createElement("div");
        row.textContent = `${p.ts.slice(11, 16)} — ${p.estimator}: ${p.p50Min}–${p.p80Min} min${
          p.reasonKey ? " (" + p.reasonKey + ")" : ""
        }`;
        tl.appendChild(row);
      });
  } else {
    tl.innerHTML = '<div class="muted">No predictions logged yet.</div>';
  }
  debugPanel.appendChild(tl);
  wrap.appendChild(debugPanel);

  root.appendChild(wrap);
}

function makeLine(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}

function minutesBetween(startMin, endISO, config) {
  const t = endISO.split("T")[1];
  const [hh, mm] = t.split(":").map(Number);
  return hh * 60 + mm - startMin;
}
