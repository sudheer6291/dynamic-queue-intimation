import { nameOf } from "../i18n.js";

export function renderBoardView(root, ctx) {
  const { state, data, config, t, locale } = ctx;
  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "board";

  const h2 = document.createElement("h2");
  h2.textContent = t("board.title");
  h2.style.color = "#fff";
  wrap.appendChild(h2);

  const table = document.createElement("table");
  const thead = document.createElement("tr");
  ["Station", "Now serving", "Next up", "Waiting"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    thead.appendChild(th);
  });
  table.appendChild(thead);

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

    const tr = document.createElement("tr");
    const cells = [
      nameOf(config, locale, station.name_key),
      paused ? "Delayed" : serving.length ? serving.join(", ") : "—",
      next,
      String(queue.length)
    ];
    cells.forEach((c) => {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    });
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  root.appendChild(wrap);
}
