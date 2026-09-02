import { nameOf } from "../i18n.js";
import { el } from "../util.js";
import { computeLiveSuggestions } from "../engine/suggestions.js";
import {
  actionCallNext,
  actionConfirmArrival,
  actionMarkNoShow,
  actionPriorityInsert,
  actionPullForward,
  actionApplyLabFirstSuggestion,
  actionCompleteService
} from "../actions.js";

const STATUS_BADGE = {
  paused: "bg-danger-subtle text-danger-emphasis",
  serving: "bg-warning-subtle text-warning-emphasis",
  idle: "bg-success-subtle text-success-emphasis"
};

export function renderFrontDeskView(root, ctx) {
  const { state, data, config, t, locale } = ctx;
  root.innerHTML = "";

  const wrap = el("div", { class: "row g-4" });
  const main = el("div", { class: "col-12" });

  main.appendChild(el("h2", { class: "h4 fw-bold mb-3" }, [el("i", { class: "bi bi-clipboard2-pulse me-2 text-primary" }), t("frontdesk.title")]));

  // station selector as pill nav
  const stationTabs = el("ul", { class: "nav nav-pills gap-2 mb-3" });
  for (const s of data.stations) {
    const queueLen = state.stations[s.id].queue.length;
    const li = el("li", { class: "nav-item" });
    const btn = el(
      "button",
      { class: "nav-link station-pill border" + (s.id === ctx.app.selectedStation ? " active" : "") },
      [`${nameOf(config, locale, s.name_key)} `, el("span", { class: "badge rounded-pill text-bg-light ms-1" }, String(queueLen))]
    );
    btn.addEventListener("click", () => ctx.setSelectedStation(s.id));
    li.appendChild(btn);
    stationTabs.appendChild(li);
  }
  main.appendChild(stationTabs);

  const stationId = ctx.app.selectedStation || data.stations[0].id;
  const station = data.stations.find((s) => s.id === stationId);
  const resources = data.resources.filter((r) => r.station_id === stationId);

  // live suggestions
  const live = computeLiveSuggestions(state, data, config, ctx.nowMin).filter((s) => s.stationId === stationId);
  for (const sug of live) {
    const applyBtn = el("button", { class: "btn btn-primary btn-sm" }, "Apply");
    applyBtn.addEventListener("click", () => {
      if (sug.kind === "pull_forward") {
        ctx.dispatch(actionPullForward, stationId, sug.relatedEntityId, "Recovering slot freed by no-show");
      } else {
        ctx.dispatch(actionApplyLabFirstSuggestion, sug.stationId, sug.altStationId, sug.entityIds);
      }
    });
    main.appendChild(
      el("div", { class: "alert alert-primary d-flex align-items-center justify-content-between shadow-sm" }, [
        el("span", {}, [el("i", { class: "bi bi-lightbulb-fill me-2" }), sug.kind === "pull_forward" ? t("suggestion.pull_forward") : t("suggestion.lab_first")]),
        applyBtn
      ])
    );
  }

  const row = el("div", { class: "row g-3" });

  // resources card
  const resCard = el("div", { class: "col-12" }, [
    el("div", { class: "card border-0 shadow-sm" }, [
      el("div", { class: "card-header bg-white fw-semibold small text-uppercase text-muted" }, "Resources"),
      el(
        "ul",
        { class: "list-group list-group-flush" },
        resources.map((r) => {
          const rs = state.resources[r.id];
          let label, badgeClass;
          if (rs.status === "paused") {
            label = `Paused — ${rs.pausedReasonText || "unavailable"}`;
            badgeClass = STATUS_BADGE.paused;
          } else if (rs.status === "serving") {
            const meta = data.entities.find((e) => e.id === rs.currentEntityId);
            label = `Serving ${meta ? meta.display_token : rs.currentEntityId}`;
            badgeClass = STATUS_BADGE.serving;
          } else {
            label = "Idle";
            badgeClass = STATUS_BADGE.idle;
          }
          return el("li", { class: "list-group-item d-flex justify-content-between align-items-center" }, [
            nameOf(config, locale, r.name_key),
            el("span", { class: `badge rounded-pill ${badgeClass}` }, label)
          ]);
        })
      )
    ])
  ]);
  row.appendChild(resCard);

  // action buttons
  const calledEntity = Object.values(state.entities).find((e) => e.currentStationId === stationId && e.status === "called");
  const actionRow = el("div", { class: "col-12 d-flex flex-wrap gap-2" });

  const callBtn = el("button", { class: "btn btn-primary" }, [el("i", { class: "bi bi-megaphone-fill me-1" }), t("frontdesk.call_next")]);
  callBtn.disabled = state.stations[stationId].queue.length === 0 || !!calledEntity;
  callBtn.addEventListener("click", () => ctx.dispatch(actionCallNext, stationId));
  actionRow.appendChild(callBtn);

  if (calledEntity) {
    const meta = data.entities.find((e) => e.id === calledEntity.id);
    const confirmBtn = el("button", { class: "btn btn-outline-primary" }, [
      el("i", { class: "bi bi-person-check-fill me-1" }),
      `Confirm arrival — ${meta.display_token}`
    ]);
    confirmBtn.addEventListener("click", () => ctx.dispatch(actionConfirmArrival, stationId));
    actionRow.appendChild(confirmBtn);
    if (calledEntity.away) {
      actionRow.appendChild(
        el("span", { class: "badge bg-info-subtle text-info-emphasis align-self-center" }, [
          el("i", { class: "bi bi-geo-alt-fill me-1" }),
          `${meta.display_token} stepped out — give them a minute before marking no-show`
        ])
      );
    }
  }

  const noShowBtn = el("button", { class: "btn btn-outline-danger" }, [el("i", { class: "bi bi-person-dash-fill me-1" }), t("frontdesk.no_show")]);
  noShowBtn.disabled = !calledEntity;
  noShowBtn.addEventListener("click", () => ctx.dispatch(actionMarkNoShow, stationId));
  actionRow.appendChild(noShowBtn);

  const servingEntity = Object.values(state.entities).find((e) => e.currentStationId === stationId && e.status === "in_service");
  if (servingEntity) {
    const meta = data.entities.find((e) => e.id === servingEntity.id);
    const completeBtn = el("button", { class: "btn btn-success" }, [
      el("i", { class: "bi bi-check2-circle me-1" }),
      `Complete — ${meta.display_token}`
    ]);
    completeBtn.addEventListener("click", () => ctx.dispatch(actionCompleteService, stationId));
    actionRow.appendChild(completeBtn);
  }
  row.appendChild(actionRow);

  // queue
  const queue = state.stations[stationId].queue;
  const queueCard = el("div", { class: "col-12" }, [
    el("div", { class: "card border-0 shadow-sm" }, [
      el("div", { class: "card-header bg-white fw-semibold small text-uppercase text-muted" }, `Queue — ${nameOf(config, locale, station.name_key)}`),
      queue.length === 0
        ? el("div", { class: "card-body text-muted" }, "No one waiting.")
        : el(
            "ul",
            { class: "list-group list-group-flush" },
            queue.map((entityId, idx) => {
              const meta = data.entities.find((e) => e.id === entityId);
              const entity = state.entities[entityId];
              const left = el("span", { class: "d-flex align-items-center gap-2" }, [
                el("span", { class: "text-muted fw-bold", style: "width:22px" }, String(idx + 1)),
                el("span", { class: "fw-semibold" }, meta.display_token),
                entity.priority ? el("span", { class: "badge bg-warning-subtle text-warning-emphasis" }, "priority") : null,
                entity.away
                  ? el("span", { class: "badge bg-info-subtle text-info-emphasis" }, [
                      el("i", { class: "bi bi-geo-alt-fill me-1" }),
                      t("frontdesk.away_badge")
                    ])
                  : null
              ]);
              const right = el("span", { class: "d-flex gap-2" });
              if (idx !== 0) {
                const pullBtn = el("button", { class: "btn btn-sm btn-outline-secondary" }, t("frontdesk.pull_forward"));
                pullBtn.addEventListener("click", () =>
                  ctx.dispatch(actionPullForward, stationId, entityId, "Manually pulled forward by front desk")
                );
                right.appendChild(pullBtn);
              }
              if (!entity.priority) {
                const prBtn = el("button", { class: "btn btn-sm btn-outline-secondary" }, t("frontdesk.priority_insert"));
                prBtn.addEventListener("click", () =>
                  ctx.dispatch(actionPriorityInsert, stationId, entityId, "Marked priority by front desk")
                );
                right.appendChild(prBtn);
              }
              return el(
                "li",
                { class: "list-group-item d-flex justify-content-between align-items-center" + (entity.priority ? " bg-warning-subtle" : "") },
                [left, right]
              );
            })
          )
    ])
  ]);
  row.appendChild(queueCard);

  main.appendChild(row);
  wrap.appendChild(main);
  root.appendChild(wrap);
}
