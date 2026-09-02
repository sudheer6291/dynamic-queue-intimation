import { nameOf } from "../i18n.js";
import { el } from "../util.js";

export function renderBoardView(root, ctx) {
  const { state, data, config, t, locale } = ctx;
  root.innerHTML = "";

  const rows = [];
  for (const station of data.stations) {
    const resources = data.resources.filter((r) => r.station_id === station.id);
    const serving = resources
      .map((r) => state.resources[r.id])
      .filter((r) => r.status === "serving")
      .map((r) => {
        const meta = data.entities.find((e) => e.id === r.currentEntityId);
        return meta ? meta.display_token : "";
      });
    const paused = resources.some((r) => state.resources[r.id].status === "paused");
    const queue = state.stations[station.id].queue;
    const next = queue[0] ? data.entities.find((e) => e.id === queue[0]).display_token : "—";

    rows.push(
      el("tr", {}, [
        el("td", { class: "fw-semibold" }, nameOf(config, locale, station.name_key)),
        el(
          "td",
          {},
          paused
            ? el("span", { class: "badge bg-danger" }, "Delayed")
            : serving.length
              ? el("span", { class: "badge bg-warning text-dark" }, serving.join(", "))
              : "—"
        ),
        el("td", {}, next),
        el("td", {}, el("span", { class: "badge bg-primary rounded-pill" }, String(queue.length)))
      ])
    );
  }

  root.appendChild(
    el("div", { class: "board-wrap p-4 shadow" }, [
      el("h2", { class: "h4 fw-bold mb-3 text-white" }, [el("i", { class: "bi bi-tv me-2" }), t("board.title")]),
      el("div", { class: "table-responsive" }, [
        el("table", { class: "table table-borderless mb-0" }, [
          el("thead", {}, [el("tr", {}, ["Station", "Now serving", "Next up", "Waiting"].map((h) => el("th", {}, h)))]),
          el("tbody", {}, rows)
        ])
      ])
    ])
  );
}
