import { loadVertical, listVerticals } from "./dataLoader.js";
import { VirtualClock } from "./clock.js";
import { deriveState } from "./engine/deriveState.js";
import { makeTranslator } from "./i18n.js";
import { minOfDayToISO, minToHHMM, parseISOToMin } from "./util.js";

import { renderPatientView } from "./views/patient.js";
import { renderFrontDeskView } from "./views/frontdesk.js";
import { renderDoctorView } from "./views/doctor.js";
import { renderAdminView } from "./views/admin.js";
import { renderBoardView } from "./views/board.js";
import { actionPredictionShown } from "./actions.js";

const VIEWS = [
  { id: "patient", labelKey: "screen.patient", render: renderPatientView },
  { id: "frontdesk", labelKey: "screen.frontdesk", render: renderFrontDeskView },
  { id: "doctor", labelKey: "screen.doctor", render: renderDoctorView },
  { id: "admin", labelKey: "screen.admin", render: renderAdminView },
  { id: "board", labelKey: "screen.board", render: renderBoardView }
];

const app = {
  verticals: [],
  data: null,
  clock: null,
  runtimeEvents: [],
  currentView: "patient",
  locale: "en",
  estimatorMode: "proposed",
  selectedStation: null,
  selectedEntityId: null,
  loggedPredictionBuckets: new Set()
};

const viewRoot = document.getElementById("view-root");
const clockTimeEl = document.getElementById("clock-time");
const clockScrub = document.getElementById("clock-scrub");
const playPauseBtn = document.getElementById("clock-playpause");
const toastEl = document.getElementById("toast");

let lastRenderReal = 0;

function toast(message) {
  if (!message) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (toastEl.hidden = true), 2400);
}

function nowISO() {
  return minOfDayToISO(app.data.config.date, app.clock.nowMin, app.data.config.day_start.slice(-6));
}

function ctx() {
  const allEvents = app.data.seedEvents.concat(app.runtimeEvents);
  const iso = nowISO();
  const state = deriveState(app.data, allEvents, iso);
  return {
    state,
    data: app.data,
    config: app.data.config,
    t: makeTranslator(app.data.config, app.locale),
    locale: app.locale,
    nowISO: iso,
    nowMin: app.clock.nowMin,
    clock: app.clock,
    estimatorMode: app.estimatorMode,
    app,
    dispatch,
    toast,
    setSelectedStation: (id) => {
      app.selectedStation = id;
      scheduleRender(true);
    },
    setSelectedEntity: (id) => {
      app.selectedEntityId = id;
      scheduleRender(true);
    },
    logPredictionShown: (entityId, stationId, estimatorId, result) => {
      if (!result || !result.available) return;
      const bucket = `${entityId}|${estimatorId}|${Math.floor(app.clock.nowMin / 5)}`;
      if (app.loggedPredictionBuckets.has(bucket)) return;
      app.loggedPredictionBuckets.add(bucket);
      const { events } = actionPredictionShown(entityId, stationId, estimatorId, result, {
        config: app.data.config,
        nowISO: iso
      });
      app.runtimeEvents.push(...events);
    }
  };
}

function dispatch(actionFn, ...args) {
  app.clock.pause();
  const result = actionFn(...args, ctx());
  if (result && result.events && result.events.length) {
    app.runtimeEvents.push(...result.events);
  }
  if (result && result.message) toast(result.message);
  render(true);
}

function render(force) {
  const c = ctx();
  clockTimeEl.textContent = minToHHMM(app.clock.nowMin);
  clockScrub.value = String(Math.round(app.clock.nowMin));
  playPauseBtn.innerHTML = app.clock.playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
  document.getElementById("vertical-name").textContent = c.t("vertical.name");

  const estimatorWrap = document.getElementById("estimator-toggle-wrap");
  estimatorWrap.style.display = app.currentView === "patient" ? "flex" : "none";

  const view = VIEWS.find((v) => v.id === app.currentView);
  view.render(viewRoot, c);
  lastRenderReal = performance.now();
}

function scheduleRender(force) {
  const t = performance.now();
  if (force || t - lastRenderReal > 180) render(force);
}

function setupTabs() {
  const tabsEl = document.getElementById("tabs");
  tabsEl.innerHTML = "";
  const t = app.data ? makeTranslator(app.data.config, app.locale) : (k) => k;
  const icons = { patient: "bi-person-badge", frontdesk: "bi-clipboard2-pulse", doctor: "bi-check2-circle", admin: "bi-speedometer2", board: "bi-tv" };
  for (const v of VIEWS) {
    const li = document.createElement("li");
    li.className = "nav-item";
    const btn = document.createElement("button");
    btn.className = "nav-link" + (v.id === app.currentView ? " active" : "");
    btn.innerHTML = `<i class="bi ${icons[v.id] || "bi-circle"} me-1"></i>${t(v.labelKey)}`;
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => {
      app.currentView = v.id;
      setupTabs();
      render(true);
    });
    li.appendChild(btn);
    tabsEl.appendChild(li);
  }
}

function setupClockControls() {
  playPauseBtn.addEventListener("click", () => {
    app.clock.togglePlay();
    render(true);
  });
  document.getElementById("clock-back").addEventListener("click", () => {
    app.clock.step(-5);
    render(true);
  });
  document.getElementById("clock-fwd").addEventListener("click", () => {
    app.clock.step(5);
    render(true);
  });
  clockScrub.addEventListener("input", (e) => {
    app.clock.jumpTo(Number(e.target.value));
    render(true);
  });
  document.querySelectorAll(".speed-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      app.clock.setSpeed(Number(btn.dataset.speed));
      document.querySelectorAll(".speed-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
  document.querySelector('.speed-btn[data-speed="10"]').classList.add("active");

  document.getElementById("estimator-select").addEventListener("change", (e) => {
    app.estimatorMode = e.target.value;
    render(true);
  });
}

async function setupVerticalAndLocaleSelectors() {
  app.verticals = await listVerticals();
  const vSel = document.getElementById("vertical-select");
  vSel.innerHTML = "";
  for (const v of app.verticals) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.id;
    vSel.appendChild(opt);
  }
  vSel.addEventListener("change", async (e) => {
    await loadAndStart(app.verticals.find((v) => v.id === e.target.value));
  });

  document.getElementById("locale-select").addEventListener("change", (e) => {
    app.locale = e.target.value;
    setupTabs();
    render(true);
  });
}

function refreshLocaleOptions() {
  const lSel = document.getElementById("locale-select");
  lSel.innerHTML = "";
  const available = app.data.config.locale.available || ["en"];
  for (const loc of available) {
    const opt = document.createElement("option");
    opt.value = loc;
    opt.textContent = loc.toUpperCase();
    lSel.appendChild(opt);
  }
  app.locale = app.data.config.locale.default || "en";
  lSel.value = app.locale;
}

async function loadAndStart(verticalMeta) {
  app.data = await loadVertical(verticalMeta.path);
  app.runtimeEvents = [];
  app.loggedPredictionBuckets = new Set();
  app.selectedStation = app.data.stations[0].id;
  app.selectedEntityId = app.data.entities[0].id;

  const dayStartMin = parseISOToMin(app.data.config.day_start);
  const dayEndMin = parseISOToMin(app.data.config.day_end);

  if (app.clock) app.clock.pause();
  app.clock = new VirtualClock({
    dayStartMin,
    dayEndMin,
    onTick: () => scheduleRender(false)
  });
  clockScrub.min = String(dayStartMin);
  clockScrub.max = String(dayEndMin);
  clockScrub.value = String(dayStartMin);
  app.clock.setSpeed(10);

  refreshLocaleOptions();
  document.getElementById("vertical-select").value = verticalMeta.id;
  setupTabs();
  render(true);
}

async function main() {
  setupTabs();
  setupClockControls();
  await setupVerticalAndLocaleSelectors();
  await loadAndStart(app.verticals[0]);
}

main().catch((err) => {
  console.error(err);
  viewRoot.innerHTML = `<div class="panel"><h2>Failed to load</h2><pre>${String(err && err.stack || err)}</pre></div>`;
});
