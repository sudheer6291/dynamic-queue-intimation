import { nameOf } from "../i18n.js";
import { fmtDuration, parseISOToMin, el } from "../util.js";
import { getEstimate } from "../engine/estimator.js";
import { recoveredSlotsCount, computeLiveSuggestions } from "../engine/suggestions.js";

function statCard(icon, num, label, tone) {
  return el("div", { class: "col-6 col-lg-3" }, [
    el("div", { class: "card border-0 shadow-sm h-100 card-stat" }, [
      el("div", { class: "card-body text-center" }, [
        el("i", { class: `bi ${icon} fs-3 mb-1 text-${tone}` }),
        el("div", { class: `display-num text-${tone}` }, num),
        el("div", { class: "text-muted small mt-1" }, label)
      ])
    ])
  ]);
}

export function renderAdminView(root, ctx) {
  const { state, data, config, t, locale } = ctx;
  root.innerHTML = "";

  const wrap = el("div", { class: "d-flex flex-column gap-4" });
  wrap.appendChild(el("h2", { class: "h4 fw-bold mb-0" }, [el("i", { class: "bi bi-speedometer2 me-2 text-primary" }), t("admin.title")]));

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
  const delta = yesterday != null && meanWaitToday != null ? Math.round(meanWaitToday - yesterday) : null;

  const statsGrid = el("div", { class: "row g-3" }, [
    statCard("bi-arrow-repeat", String(recovered), "Slots recovered today", "success"),
    statCard("bi-person-dash", String(noShows), "No-shows", "danger"),
    statCard("bi-hourglass-split", meanWaitToday != null ? fmtDuration(meanWaitToday) : "--", "Mean journey time today", "primary"),
    statCard(
      delta != null && delta <= 0 ? "bi-graph-down-arrow" : "bi-graph-up-arrow",
      delta != null ? `${delta > 0 ? "+" : ""}${delta} min` : "--",
      `vs ${t("comparison.yesterday")} (${yesterday ?? "--"} min)`,
      delta != null && delta <= 0 ? "success" : "warning"
    )
  ]);
  wrap.appendChild(statsGrid);

  // --- waiting-room load: the actual painkiller metric — how many people
  // are NOT physically trapped in the building right now ---
  const waitingEntities = Object.values(state.entities).filter((e) => e.status === "waiting");
  const physicallyWaiting = waitingEntities.filter((e) => !e.away).length;
  const currentlyAway = waitingEntities.filter((e) => e.away).length;
  const nudgesSent = state.nudgesLog.length;

  wrap.appendChild(
    el("div", { class: "row g-3" }, [
      statCard("bi-building", String(physicallyWaiting), t("admin.physically_waiting"), "primary"),
      statCard("bi-geo-alt-fill", String(currentlyAway), t("admin.currently_away"), "info"),
      statCard("bi-bell-fill", String(nudgesSent), "Return nudges sent today", "secondary")
    ])
  );

  // --- live suggestions across all stations ---
  const allSuggestions = computeLiveSuggestions(state, data, config, ctx.nowMin);
  if (allSuggestions.length) {
    wrap.appendChild(
      el("div", { class: "card border-0 shadow-sm" }, [
        el("div", { class: "card-header bg-white fw-semibold small text-uppercase text-muted" }, "Active suggestions"),
        el(
          "ul",
          { class: "list-group list-group-flush" },
          allSuggestions.map((s) =>
            el("li", { class: "list-group-item small" }, [
              el("i", { class: "bi bi-lightbulb-fill text-primary me-2" }),
              `${s.stationId} — ${s.kind === "pull_forward" ? t("suggestion.pull_forward") : t("suggestion.lab_first")}`
            ])
          )
        )
      ])
    );
  }

  // --- station load: current vs predicted ---
  const tbody = el("tbody");
  for (const station of data.stations) {
    const queue = state.stations[station.id].queue;
    const resources = data.resources.filter((r) => r.station_id === station.id);
    const busy = resources.filter((r) => state.resources[r.id].status === "serving").length;
    const paused = resources.filter((r) => state.resources[r.id].status === "paused").length;

    const baselineVals = queue
      .map((id) => getEstimate("baseline", id, state, data, config, ctx.nowMin))
      .filter((r) => r.available)
      .map((r) => r.headlineMin);
    const proposedVals = queue.map((id) => getEstimate("proposed", id, state, data, config, ctx.nowMin)).filter((r) => r.available);

    const avgBaseline = baselineVals.length ? baselineVals.reduce((a, b) => a + b, 0) / baselineVals.length : null;
    const avgP50 = proposedVals.length ? proposedVals.reduce((a, b) => a + b.p50Min, 0) / proposedVals.length : null;
    const avgP80 = proposedVals.length ? proposedVals.reduce((a, b) => a + b.p80Min, 0) / proposedVals.length : null;

    tbody.appendChild(
      el("tr", {}, [
        el("td", { class: "fw-semibold" }, nameOf(config, locale, station.name_key)),
        el("td", {}, `${queue.length} waiting`),
        el("td", {}, [
          el("span", { class: "badge bg-warning-subtle text-warning-emphasis me-1" }, `${busy} serving`),
          paused ? el("span", { class: "badge bg-danger-subtle text-danger-emphasis" }, `${paused} paused`) : null,
          el("span", { class: "text-muted small ms-1" }, `/ ${resources.length} total`)
        ]),
        el("td", {}, avgBaseline != null ? String(Math.round(avgBaseline)) : "--"),
        el("td", { class: "fw-semibold text-primary" }, avgP50 != null ? `${Math.round(avgP50)}–${Math.round(avgP80)}` : "--")
      ])
    );
  }

  wrap.appendChild(
    el("div", { class: "card border-0 shadow-sm" }, [
      el("div", { class: "card-header bg-white fw-semibold small text-uppercase text-muted" }, "Station load — current vs predicted"),
      el("div", { class: "table-responsive" }, [
        el("table", { class: "table table-hover align-middle mb-0" }, [
          el("thead", { class: "table-light" }, [
            el("tr", {}, ["Station", "Queue", "Resources", "Avg baseline (min)", "Avg proposed p50–p80 (min)"].map((h) => el("th", {}, h)))
          ]),
          tbody
        ])
      ])
    ])
  );

  // --- resource pause log ---
  const delayItems = [];
  for (const r of data.resources) {
    const rs = state.resources[r.id];
    const logs = rs.pauseLog.concat(
      rs.status === "paused" ? [{ start: rs.pausedAt, end: null, reasonText: rs.pausedReasonText }] : []
    );
    for (const log of logs) {
      const dur = log.end
        ? `${Math.round(parseISOToMin(log.end) - parseISOToMin(log.start))} min`
        : `ongoing, ~${Math.round(ctx.nowMin - parseISOToMin(log.start))} min so far`;
      delayItems.push(
        el("li", { class: "list-group-item d-flex justify-content-between align-items-center" }, [
          el("span", {}, [el("i", { class: "bi bi-exclamation-circle text-danger me-2" }), `${nameOf(config, locale, r.name_key)} — ${log.reasonText}`]),
          el("span", { class: "badge text-bg-light border" }, dur)
        ])
      );
    }
  }
  wrap.appendChild(
    el("div", { class: "card border-0 shadow-sm" }, [
      el("div", { class: "card-header bg-white fw-semibold small text-uppercase text-muted" }, "Delays today"),
      delayItems.length
        ? el("ul", { class: "list-group list-group-flush" }, delayItems)
        : el("div", { class: "card-body text-muted" }, "No delays recorded.")
    ])
  );

  root.appendChild(wrap);
}
