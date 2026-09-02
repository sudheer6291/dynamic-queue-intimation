import { nameOf } from "../i18n.js";
import { parseISOToMin } from "../util.js";
import { actionStationDone } from "../actions.js";

export function renderDoctorView(root, ctx) {
  const { state, data, config, t, locale } = ctx;
  root.innerHTML = "";

  const stationId = config.doctor_view_station_id || data.stations[0].id;
  const station = data.stations.find((s) => s.id === stationId);
  const resources = data.resources.filter((r) => r.station_id === stationId);

  const wrap = document.createElement("div");
  wrap.className = "panel doctor-wrap";

  const title = document.createElement("h2");
  title.textContent = nameOf(config, locale, station.name_key);
  wrap.appendChild(title);

  const pausedResource = resources.map((r) => state.resources[r.id]).find((r) => r.status === "paused");
  if (pausedResource) {
    const chip = document.createElement("div");
    chip.className = "chip chip-bad";
    chip.style.marginBottom = "10px";
    chip.textContent = `Unavailable — ${pausedResource.pausedReasonText}`;
    wrap.appendChild(chip);
  }

  const serving = resources.map((r) => state.resources[r.id]).find((r) => r.status === "serving");
  const current = document.createElement("div");
  current.className = "doctor-current";
  const elapsed = document.createElement("div");
  elapsed.className = "doctor-elapsed";

  if (serving) {
    const meta = data.entities.find((e) => e.id === serving.currentEntityId);
    current.textContent = `${t("doctor.next_up")}: ${meta.display_token}`;
    const startMin = parseISOToMin(state.entities[serving.currentEntityId].serviceStartedAt);
    elapsed.textContent = `In progress — ${Math.max(0, Math.round(ctx.nowMin - startMin))} min so far`;
  } else {
    const queue = state.stations[stationId].queue;
    if (queue.length > 0) {
      const meta = data.entities.find((e) => e.id === queue[0]);
      current.textContent = `${t("doctor.next_up")}: ${meta.display_token}`;
      elapsed.textContent = `${queue.length - 1} more waiting after`;
    } else {
      current.textContent = t("doctor.no_patient");
      elapsed.textContent = "";
    }
  }
  wrap.appendChild(current);
  wrap.appendChild(elapsed);

  const btn = document.createElement("button");
  btn.className = "btn btn-primary done-button";
  btn.textContent = t("doctor.done_button");
  const queueEmpty = state.stations[stationId].queue.length === 0;
  btn.disabled = !serving && queueEmpty;
  btn.addEventListener("click", () => ctx.dispatch(actionStationDone, stationId));
  wrap.appendChild(btn);

  root.appendChild(wrap);
}
