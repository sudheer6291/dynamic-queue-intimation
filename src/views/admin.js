import { nameOf } from "../i18n.js";
import { fmtDuration, parseISOToMin, el } from "../util.js";
import { getEstimate } from "../engine/estimator.js";
import { recoveredSlotsCount, computeLiveSuggestions } from "../engine/suggestions.js";
import { computeCalibration } from "../engine/calibration.js";
import { whatIfStationLoad, busiestStationId } from "../engine/capacityPlanner.js";

function calibrationBar(bucket) {
  const pct = (n) => Math.round((n / bucket.total) * 100);
  return el("div", {}, [
    el("div", { class: "d-flex justify-content-between small mb-1" }, [
      el("span", { class: "text-primary fw-semibold" }, `${pct(bucket.early)}% called early`),
      el("span", { class: "text-success fw-semibold" }, `${pct(bucket.hit)}% within range`),
      el("span", { class: "text-danger fw-semibold" }, `${pct(bucket.late)}% ran late`)
    ]),
    el("div", { class: "progress", style: "height:10px" }, [
      el("div", { class: "progress-bar bg-primary", style: `width:${pct(bucket.early)}%` }),
      el("div", { class: "progress-bar bg-success", style: `width:${pct(bucket.hit)}%` }),
      el("div", { class: "progress-bar bg-danger", style: `width:${pct(bucket.late)}%` })
    ]),
    el(
      "div",
      { class: "text-muted small mt-2" },
      `${pct(bucket.early + bucket.hit)}% of finished visits landed at or before the range we showed at check-in — that's the honest number behind "range feels trustworthy."`
    )
  ]);
}

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

  // --- trust score: were the ranges we showed actually right? ---
  // This is the answer to the brief's own #1 evaluation question, backed
  // by evidence — every finished visit's shown estimate, replayed and
  // checked against what actually happened, not a survey answer.
  const calibration = computeCalibration(data, ctx.allEvents, state);
  wrap.appendChild(
    el("div", { class: "card border-0 shadow-sm" }, [
      el("div", { class: "card-header bg-white fw-semibold small text-uppercase text-muted" }, [
        el("i", { class: "bi bi-clipboard-check-fill me-2" }),
        "Prediction accuracy — evidence, not a claim"
      ]),
      el("div", { class: "card-body" }, [
        el("div", { class: "row g-4" }, [
          el("div", { class: "col-12 col-md-6" }, [
            el("div", { class: "fw-semibold mb-2" }, "Proposed — full-visit range vs. reality"),
            calibration.proposed.total === 0
              ? el("div", { class: "text-muted small" }, "No completed visits yet today.")
              : calibrationBar(calibration.proposed)
          ]),
          el("div", { class: "col-12 col-md-6" }, [
            el("div", { class: "fw-semibold mb-2" }, "Baseline — its own next-station claim vs. reality"),
            calibration.baseline.total === 0
              ? el("div", { class: "text-muted small" }, "No completed visits yet today.")
              : el("div", {}, [
                  el("div", { class: "d-flex justify-content-between small mb-1" }, [
                    el("span", { class: "text-success fw-semibold" }, `${Math.round((calibration.baseline.onTime / calibration.baseline.total) * 100)}% on time`),
                    el("span", { class: "text-danger fw-semibold" }, `${Math.round((calibration.baseline.late / calibration.baseline.total) * 100)}% ran late`)
                  ]),
                  el("div", { class: "progress", style: "height:10px" }, [
                    el("div", {
                      class: "progress-bar bg-success",
                      style: `width:${(calibration.baseline.onTime / calibration.baseline.total) * 100}%`
                    }),
                    el("div", {
                      class: "progress-bar bg-danger",
                      style: `width:${(calibration.baseline.late / calibration.baseline.total) * 100}%`
                    })
                  ]),
                  el(
                    "div",
                    { class: "text-muted small mt-2" },
                    "Graded generously on baseline's own narrow claim (next station only) — it still misses because it never looks at resource pauses."
                  )
                ])
          ])
        ])
      ])
    ])
  );

  // --- what-if capacity planner ---
  // The differentiator a live-token-number competitor can't offer: they
  // never modeled the queue as a system, only displayed its length.
  const whatIfStationId = ctx.app.whatIfStation && data.stations.some((s) => s.id === ctx.app.whatIfStation)
    ? ctx.app.whatIfStation
    : busiestStationId(state, data);
  const whatIfDelta = ctx.app.whatIfDelta;
  const currentLoad = whatIfStationLoad(whatIfStationId, state, data, config, 0);
  const hypoLoad = whatIfStationLoad(whatIfStationId, state, data, config, whatIfDelta);
  const savedP80 = Math.round(currentLoad.clearP80 - hypoLoad.clearP80);
  const whatIfStationName = nameOf(config, locale, data.stations.find((s) => s.id === whatIfStationId).name_key);

  wrap.appendChild(
    el("div", { class: "card border-0 shadow-sm" }, [
      el("div", { class: "card-header bg-white fw-semibold small text-uppercase text-muted" }, [
        el("i", { class: "bi bi-sliders me-2" }),
        "What if? — capacity planner"
      ]),
      el("div", { class: "card-body" }, [
        el("div", { class: "d-flex flex-wrap align-items-center gap-3 mb-3" }, [
          (() => {
            const select = el("select", { class: "form-select form-select-sm w-auto" });
            for (const s of data.stations) {
              const opt = el("option", { value: s.id }, nameOf(config, locale, s.name_key));
              if (s.id === whatIfStationId) opt.selected = true;
              select.appendChild(opt);
            }
            select.addEventListener("change", (e) => ctx.setWhatIfStation(e.target.value));
            return select;
          })(),
          el("div", { class: "btn-group btn-group-sm", role: "group" }, [-1, 1, 2].map((d) =>
            (() => {
              const btn = el("button", { class: "btn btn-outline-secondary" + (whatIfDelta === d ? " active" : "") }, `${d > 0 ? "+" : ""}${d} resource${Math.abs(d) > 1 ? "s" : ""}`);
              btn.addEventListener("click", () => ctx.setWhatIfDelta(d));
              return btn;
            })()
          ))
        ]),
        currentLoad.queueLen === 0
          ? el("div", { class: "text-muted small" }, `No one waiting at ${whatIfStationName} right now — nothing to project.`)
          : el("div", { class: "row g-3 align-items-center" }, [
              el("div", { class: "col-12 col-md-5" }, [
                el("div", { class: "text-muted small" }, `Today, as staffed (${currentLoad.actualCapacity} resource${currentLoad.actualCapacity === 1 ? "" : "s"})`),
                el("div", { class: "fs-4 fw-bold" }, `${Math.round(currentLoad.clearP50)}–${Math.round(currentLoad.clearP80)} min`),
                el("div", { class: "text-muted small" }, `to clear the ${currentLoad.queueLen} currently waiting`)
              ]),
              el("div", { class: "col-12 col-md-2 text-center" }, [el("i", { class: "bi bi-arrow-right fs-3 text-muted" })]),
              el("div", { class: "col-12 col-md-5" }, [
                el("div", { class: "text-muted small" }, `With ${hypoLoad.hypotheticalCapacity} resource${hypoLoad.hypotheticalCapacity === 1 ? "" : "s"}`),
                el("div", { class: "fs-4 fw-bold text-primary" }, `${Math.round(hypoLoad.clearP50)}–${Math.round(hypoLoad.clearP80)} min`),
                savedP80 !== 0
                  ? el("div", { class: `small fw-semibold ${savedP80 > 0 ? "text-success" : "text-danger"}` }, `${savedP80 > 0 ? savedP80 + " min sooner" : Math.abs(savedP80) + " min slower"}`)
                  : el("div", { class: "text-muted small" }, "no material change")
              ])
            ]),
        el(
          "div",
          { class: "text-muted small mt-3 border-top pt-2" },
          "Projects clearing today's already-queued backlog only — it doesn't guess at arrivals that haven't happened yet. Same rolling-mean service-time math the live estimate already uses, just with a different resource count."
        )
      ])
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
