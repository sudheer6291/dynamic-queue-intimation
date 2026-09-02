import { nameOf } from "../i18n.js";
import { parseISOToMin, el } from "../util.js";
import { actionStationDone } from "../actions.js";

export function renderDoctorView(root, ctx) {
  const { state, data, config, t, locale } = ctx;
  root.innerHTML = "";

  const stationId = config.doctor_view_station_id || data.stations[0].id;
  const station = data.stations.find((s) => s.id === stationId);
  const resources = data.resources.filter((r) => r.station_id === stationId);

  const card = el("div", { class: "card border-0 shadow-lg text-center mx-auto", style: "max-width:520px" });
  const body = el("div", { class: "card-body p-4 p-md-5" });

  body.appendChild(el("h2", { class: "h4 fw-bold text-muted mb-3" }, nameOf(config, locale, station.name_key)));

  const pausedResource = resources.map((r) => state.resources[r.id]).find((r) => r.status === "paused");
  if (pausedResource) {
    body.appendChild(
      el("div", { class: "alert alert-danger" }, [
        el("i", { class: "bi bi-exclamation-triangle-fill me-2" }),
        `Unavailable — ${pausedResource.pausedReasonText}`
      ])
    );
  }

  const serving = resources.map((r) => state.resources[r.id]).find((r) => r.status === "serving");
  let currentText, elapsedText;

  if (serving) {
    const meta = data.entities.find((e) => e.id === serving.currentEntityId);
    currentText = `${t("doctor.next_up")}: ${meta.display_token}`;
    const startMin = parseISOToMin(state.entities[serving.currentEntityId].serviceStartedAt);
    elapsedText = `In progress — ${Math.max(0, Math.round(ctx.nowMin - startMin))} min so far`;
  } else {
    const queue = state.stations[stationId].queue;
    if (queue.length > 0) {
      const meta = data.entities.find((e) => e.id === queue[0]);
      currentText = `${t("doctor.next_up")}: ${meta.display_token}`;
      elapsedText = `${queue.length - 1} more waiting after`;
    } else {
      currentText = t("doctor.no_patient");
      elapsedText = "";
    }
  }

  body.appendChild(el("div", { class: "display-5 fw-bold my-2" }, currentText));
  body.appendChild(el("div", { class: "text-muted mb-4" }, elapsedText || " "));

  const btn = el("button", { class: "btn btn-primary done-button w-100" }, [
    el("i", { class: "bi bi-check2-circle me-2" }),
    t("doctor.done_button")
  ]);
  const queueEmpty = state.stations[stationId].queue.length === 0;
  btn.disabled = !serving && queueEmpty;
  btn.addEventListener("click", () => ctx.dispatch(actionStationDone, stationId));
  body.appendChild(btn);

  card.appendChild(body);
  root.appendChild(el("div", { class: "row justify-content-center mt-4" }, [el("div", { class: "col-12" }, [card])]));
}
