import { nameOf } from "../i18n.js";
import { computeLiveSuggestions } from "../engine/suggestions.js";
import {
  actionCallNext,
  actionConfirmArrival,
  actionMarkNoShow,
  actionPriorityInsert,
  actionPullForward,
  actionApplyLabFirstSuggestion
} from "../actions.js";

export function renderFrontDeskView(root, ctx) {
  const { state, data, config, t, locale } = ctx;
  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "panel";

  const h1 = document.createElement("h2");
  h1.textContent = t("frontdesk.title");
  wrap.appendChild(h1);

  const stationTabs = document.createElement("div");
  stationTabs.className = "station-tabs";
  for (const s of data.stations) {
    const b = document.createElement("button");
    b.className = "station-tab" + (s.id === ctx.app.selectedStation ? " active" : "");
    const queueLen = state.stations[s.id].queue.length;
    b.textContent = `${nameOf(config, locale, s.name_key)} (${queueLen})`;
    b.addEventListener("click", () => ctx.setSelectedStation(s.id));
    stationTabs.appendChild(b);
  }
  wrap.appendChild(stationTabs);

  const stationId = ctx.app.selectedStation || data.stations[0].id;
  const station = data.stations.find((s) => s.id === stationId);
  const resources = data.resources.filter((r) => r.station_id === stationId);

  // suggestions relevant to this station
  const live = computeLiveSuggestions(state, data, config, ctx.nowMin).filter(
    (s) => s.stationId === stationId
  );
  for (const sug of live) {
    const banner = document.createElement("div");
    banner.className = "suggestion-banner";
    const msg = document.createElement("span");
    msg.textContent =
      sug.kind === "pull_forward" ? t("suggestion.pull_forward") : t("suggestion.lab_first");
    banner.appendChild(msg);
    const applyBtn = document.createElement("button");
    applyBtn.className = "btn btn-primary";
    applyBtn.textContent = "Apply";
    applyBtn.addEventListener("click", () => {
      if (sug.kind === "pull_forward") {
        ctx.dispatch(actionPullForward, stationId, sug.relatedEntityId, "Recovering slot freed by no-show");
      } else {
        ctx.dispatch(actionApplyLabFirstSuggestion, sug.stationId, sug.altStationId, sug.entityIds);
      }
    });
    banner.appendChild(applyBtn);
    wrap.appendChild(banner);
  }

  // resources
  const resPanel = document.createElement("div");
  resPanel.className = "panel";
  resPanel.style.marginTop = "10px";
  const rh = document.createElement("h3");
  rh.textContent = "Resources";
  resPanel.appendChild(rh);
  for (const r of resources) {
    const rs = state.resources[r.id];
    const row = document.createElement("div");
    row.className = "resource-row";
    const name = document.createElement("span");
    name.textContent = nameOf(config, locale, r.name_key);
    row.appendChild(name);
    const status = document.createElement("span");
    if (rs.status === "paused") {
      status.className = "chip chip-bad";
      status.textContent = `Paused — ${rs.pausedReasonText || "unavailable"}`;
    } else if (rs.status === "serving") {
      status.className = "chip chip-warn";
      const meta = data.entities.find((e) => e.id === rs.currentEntityId);
      status.textContent = `Serving ${meta ? meta.display_token : rs.currentEntityId}`;
    } else {
      status.className = "chip chip-good";
      status.textContent = "Idle";
    }
    row.appendChild(status);
    resPanel.appendChild(row);
  }
  wrap.appendChild(resPanel);

  // actions
  const actionRow = document.createElement("div");
  actionRow.className = "action-row";
  const calledEntity = Object.values(state.entities).find(
    (e) => e.currentStationId === stationId && e.status === "called"
  );

  const callBtn = document.createElement("button");
  callBtn.className = "btn btn-primary";
  callBtn.textContent = t("frontdesk.call_next");
  callBtn.disabled = state.stations[stationId].queue.length === 0 || !!calledEntity;
  callBtn.addEventListener("click", () => ctx.dispatch(actionCallNext, stationId));
  actionRow.appendChild(callBtn);

  if (calledEntity) {
    const meta = data.entities.find((e) => e.id === calledEntity.id);
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn";
    confirmBtn.textContent = `Confirm arrival — ${meta.display_token}`;
    confirmBtn.addEventListener("click", () => ctx.dispatch(actionConfirmArrival, stationId));
    actionRow.appendChild(confirmBtn);
  }

  const noShowBtn = document.createElement("button");
  noShowBtn.className = "btn btn-danger";
  noShowBtn.textContent = t("frontdesk.no_show");
  noShowBtn.disabled = !calledEntity;
  noShowBtn.addEventListener("click", () => ctx.dispatch(actionMarkNoShow, stationId));
  actionRow.appendChild(noShowBtn);
  wrap.appendChild(actionRow);

  // queue
  const queuePanel = document.createElement("div");
  queuePanel.className = "panel";
  queuePanel.style.marginTop = "10px";
  const qh = document.createElement("h3");
  qh.textContent = `Queue — ${nameOf(config, locale, station.name_key)}`;
  queuePanel.appendChild(qh);

  const list = document.createElement("ul");
  list.className = "queue-list";
  const queue = state.stations[stationId].queue;
  if (queue.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No one waiting.";
    queuePanel.appendChild(empty);
  }
  queue.forEach((entityId, idx) => {
    const meta = data.entities.find((e) => e.id === entityId);
    const entity = state.entities[entityId];
    const li = document.createElement("li");
    li.className = "queue-item" + (entity.priority ? " priority" : "");

    const left = document.createElement("span");
    left.style.display = "flex";
    left.style.gap = "10px";
    left.style.alignItems = "center";
    const pos = document.createElement("span");
    pos.className = "queue-pos";
    pos.textContent = String(idx + 1);
    const token = document.createElement("span");
    token.className = "queue-token";
    token.textContent = meta.display_token;
    left.appendChild(pos);
    left.appendChild(token);
    if (entity.priority) {
      const chip = document.createElement("span");
      chip.className = "chip chip-warn";
      chip.textContent = "priority";
      left.appendChild(chip);
    }
    li.appendChild(left);

    const right = document.createElement("span");
    right.style.display = "flex";
    right.style.gap = "6px";

    if (idx !== 0) {
      const pullBtn = document.createElement("button");
      pullBtn.className = "btn btn-ghost";
      pullBtn.textContent = t("frontdesk.pull_forward");
      pullBtn.addEventListener("click", () =>
        ctx.dispatch(actionPullForward, stationId, entityId, "Manually pulled forward by front desk")
      );
      right.appendChild(pullBtn);
    }
    if (!entity.priority) {
      const prBtn = document.createElement("button");
      prBtn.className = "btn btn-ghost";
      prBtn.textContent = t("frontdesk.priority_insert");
      prBtn.addEventListener("click", () =>
        ctx.dispatch(actionPriorityInsert, stationId, entityId, "Marked priority by front desk")
      );
      right.appendChild(prBtn);
    }
    li.appendChild(right);
    list.appendChild(li);
  });
  queuePanel.appendChild(list);
  wrap.appendChild(queuePanel);

  root.appendChild(wrap);
}
