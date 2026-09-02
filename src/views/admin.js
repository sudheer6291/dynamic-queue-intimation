import { nameOf } from "../i18n.js";
import { fmtDuration, parseISOToMin } from "../util.js";
import { getEstimate } from "../engine/estimator.js";
import { recoveredSlotsCount, computeLiveSuggestions } from "../engine/suggestions.js";

function statTile(num, label) {
  const d = document.createElement("div");
  d.className = "stat-tile";
  const n = document.createElement("div");
  n.className = "stat-num";
  n.textContent = num;
  const l = document.createElement("div");
  l.className = "stat-label";
  l.textContent = label;
  d.appendChild(n);
  d.appendChild(l);
  return d;
}

export function renderAdminView(root, ctx) {
  const { state, data, config, t, locale } = ctx;
  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "grid";

  const header = document.createElement("h2");
  header.textContent = t("admin.title");
  wrap.appendChild(header);

  // --- top stats ---
  const noShows = Object.values(state.entities).filter((e) => e.status === "no_show").length;
  const recovered = recoveredSlotsCount(state);
  const completed = Object.values(state.entities).filter((e) => e.status === "journey_complete");
  const meanWaitToday = completed.length
    ? completed.reduce((sum, e) => {
        const meta = data.entities.find((x) => x.id === e.id);
        return sum + (parseISOToMin(e.journeyCompletedAt) - meta.actual_arrival_min);
      }, 0) / completed.length
    : null;
  const yesterday = config.comparison ? config.comparison.yesterday_mean_wait_min : null;

  const statsGrid = document.createElement("div");
  statsGrid.className = "grid grid-4";
  statsGrid.appendChild(statTile(String(recovered), "Slots recovered today"));
  statsGrid.appendChild(statTile(String(noShows), "No-shows"));
  statsGrid.appendChild(
    statTile(meanWaitToday != null ? fmtDuration(meanWaitToday) : "--", "Mean journey time today")
  );
  statsGrid.appendChild(
    statTile(
      yesterday != null ? `${meanWaitToday != null ? Math.round(meanWaitToday - yesterday) : "--"} min` : "--",
      `vs ${t("comparison.yesterday")} (${yesterday ?? "--"} min)`
    )
  );
  wrap.appendChild(statsGrid);

  // --- live suggestions across all stations ---
  const allSuggestions = computeLiveSuggestions(state, data, config, ctx.nowMin);
  if (allSuggestions.length) {
    const sugPanel = document.createElement("div");
    sugPanel.className = "panel";
    const h3 = document.createElement("h3");
    h3.textContent = "Active suggestions";
    sugPanel.appendChild(h3);
    allSuggestions.forEach((s) => {
      const row = document.createElement("div");
      row.className = "muted";
      row.textContent = `${s.stationId} — ${s.kind === "pull_forward" ? t("suggestion.pull_forward") : t("suggestion.lab_first")}`;
      sugPanel.appendChild(row);
    });
    wrap.appendChild(sugPanel);
  }

  // --- station load: current vs predicted ---
  const loadPanel = document.createElement("div");
  loadPanel.className = "panel";
  const h3b = document.createElement("h3");
  h3b.textContent = "Station load — current vs predicted";
  loadPanel.appendChild(h3b);

  const table = document.createElement("table");
  table.style.width = "100%";
  table.style.borderCollapse = "collapse";
  const thead = document.createElement("tr");
  ["Station", "Queue", "Resources", "Avg baseline (min)", "Avg proposed p50–p80 (min)"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    th.style.textAlign = "left";
    th.style.padding = "6px 8px";
    th.style.borderBottom = "1px solid var(--border)";
    thead.appendChild(th);
  });
  table.appendChild(thead);

  for (const station of data.stations) {
    const queue = state.stations[station.id].queue;
    const resources = data.resources.filter((r) => r.station_id === station.id);
    const busy = resources.filter((r) => state.resources[r.id].status === "serving").length;
    const paused = resources.filter((r) => state.resources[r.id].status === "paused").length;

    const baselineVals = queue
      .map((id) => getEstimate("baseline", id, state, data, config, ctx.nowMin))
      .filter((r) => r.available)
      .map((r) => r.headlineMin);
    const proposedVals = queue
      .map((id) => getEstimate("proposed", id, state, data, config, ctx.nowMin))
      .filter((r) => r.available);

    const avgBaseline = baselineVals.length ? baselineVals.reduce((a, b) => a + b, 0) / baselineVals.length : null;
    const avgP50 = proposedVals.length ? proposedVals.reduce((a, b) => a + b.p50Min, 0) / proposedVals.length : null;
    const avgP80 = proposedVals.length ? proposedVals.reduce((a, b) => a + b.p80Min, 0) / proposedVals.length : null;

    const tr = document.createElement("tr");
    const cells = [
      nameOf(config, locale, station.name_key),
      `${queue.length} waiting`,
      `${busy} serving / ${paused} paused / ${resources.length} total`,
      avgBaseline != null ? Math.round(avgBaseline) : "--",
      avgP50 != null ? `${Math.round(avgP50)}–${Math.round(avgP80)}` : "--"
    ];
    cells.forEach((c) => {
      const td = document.createElement("td");
      td.textContent = c;
      td.style.padding = "6px 8px";
      td.style.borderBottom = "1px solid var(--border)";
      tr.appendChild(td);
    });
    table.appendChild(tr);
  }
  loadPanel.appendChild(table);
  wrap.appendChild(loadPanel);

  // --- resource pause log ---
  const pausePanel = document.createElement("div");
  pausePanel.className = "panel";
  const h3c = document.createElement("h3");
  h3c.textContent = "Delays today";
  pausePanel.appendChild(h3c);
  let any = false;
  for (const r of data.resources) {
    const rs = state.resources[r.id];
    const logs = rs.pauseLog.concat(
      rs.status === "paused"
        ? [{ start: rs.pausedAt, end: null, reasonText: rs.pausedReasonText, expectedResumeAt: rs.expectedResumeAt }]
        : []
    );
    for (const log of logs) {
      any = true;
      const row = document.createElement("div");
      row.className = "muted";
      const dur = log.end
        ? `${Math.round(parseISOToMin(log.end) - parseISOToMin(log.start))} min`
        : `ongoing, ~${Math.round(ctx.nowMin - parseISOToMin(log.start))} min so far`;
      row.textContent = `${nameOf(config, locale, r.name_key)} — ${log.reasonText} (${dur})`;
      pausePanel.appendChild(row);
    }
  }
  if (!any) {
    const row = document.createElement("div");
    row.className = "muted";
    row.textContent = "No delays recorded.";
    pausePanel.appendChild(row);
  }
  wrap.appendChild(pausePanel);

  root.appendChild(wrap);
}
