// The runtime shell shared by every role's page (patient.html,
// frontdesk.html, doctor.html, admin.html, board.html). Each of those is
// its own separate page load with its own <script type="module"> entry
// (src/entries/*.js) that imports mountApp() and hands it exactly one
// view — there is no shared tab bar anywhere in this file, deliberately:
// a real deployment would never let a Front Desk terminal jump straight
// into the Admin dashboard, and neither does this. What *is* shared
// across those separate page loads is the underlying simulation itself —
// vertical, locale, and the clock's current position persist via
// localStorage (per-browser, not a security boundary — this still has no
// login), and the actual queue/entity state persists via the existing
// runtime-events API (src/apiSync.js) exactly as it already did — so
// walking from frontdesk.html to doctor.html mid-demo feels like looking
// at a different terminal on the same shared system, not starting over.

import { loadVertical, listVerticals } from "./dataLoader.js";
import { VirtualClock } from "./clock.js";
import { deriveState } from "./engine/deriveState.js";
import { makeTranslator } from "./i18n.js";
import { minOfDayToISO, minToHHMM, parseISOToMin } from "./util.js";
import { actionPredictionShown, actionNudgeShown, actionRegisterEntity } from "./actions.js";
import { fetchPersistedEvents, syncEventsToServer, resetPersistedEvents } from "./apiSync.js";

const LS_VERTICAL = "dqi:vertical";
const LS_LOCALE = "dqi:locale";
const LS_CLOCK_MIN = "dqi:clockMin";

function readLocalStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // private browsing / storage blocked — fall back to defaults
  }
}
function writeLocalStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore — per-viewer convenience only, never required for correctness
  }
}

export function mountApp(viewSpec) {
  const app = {
    verticals: [],
    data: null,
    clock: null,
    runtimeEvents: [],
    locale: "en",
    estimatorMode: "proposed",
    selectedStation: null,
    selectedEntityId: null,
    whatIfStation: null,
    whatIfDelta: 1,
    loggedPredictionBuckets: new Set(),
    loggedNudgeBuckets: new Set()
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
      allEvents,
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
      setWhatIfStation: (id) => {
        app.whatIfStation = id;
        scheduleRender(true);
      },
      setWhatIfDelta: (delta) => {
        app.whatIfDelta = delta;
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
        syncEventsToServer(app.data.config.vertical_id, events);
      },
      logNudgeShown: (entityId, stationId) => {
        const bucket = `${entityId}|${Math.floor(app.clock.nowMin / 5)}`;
        if (app.loggedNudgeBuckets.has(bucket)) return;
        app.loggedNudgeBuckets.add(bucket);
        const { events } = actionNudgeShown(entityId, stationId, { state, config: app.data.config, nowISO: iso });
        app.runtimeEvents.push(...events);
        syncEventsToServer(app.data.config.vertical_id, events);
      },
      resetSimulation: () => resetSimulation(),
      registerAppointment: (priority) => registerAppointment(priority)
    };
  }

  // Front Desk "New Appointment" — the live equivalent of what the seed
  // generators do once, offline, for every pre-seeded entity: creates a
  // brand-new entity, joins it to the vertical's entry-station queue right
  // now, and (unlike every other action here) also has to extend
  // app.data.entities itself, since that's the static-lookup array every
  // view reads display_token and condition flags from — see
  // actionRegisterEntity's own comment for why.
  function registerAppointment(priority) {
    app.clock.pause();
    const { events, meta, message } = actionRegisterEntity(priority, ctx());
    app.data.entities.push(meta);
    app.runtimeEvents.push(...events);
    syncEventsToServer(app.data.config.vertical_id, events);
    app.selectedEntityId = meta.id;
    toast(message);
    render(true);
  }

  function dispatch(actionFn, ...args) {
    app.clock.pause();
    const result = actionFn(...args, ctx());
    if (result && result.events && result.events.length) {
      app.runtimeEvents.push(...result.events);
      syncEventsToServer(app.data.config.vertical_id, result.events);
    }
    if (result && result.message) toast(result.message);
    render(true);
  }

  // Clears both local and server-persisted runtime events for the current
  // vertical — a clean slate for a fresh demo, or for an automation suite to
  // call before each run so tests don't inherit a prior run's state.
  async function resetSimulation() {
    app.clock.pause();
    const verticalId = app.data.config.vertical_id;
    app.runtimeEvents = [];
    app.loggedPredictionBuckets = new Set();
    app.loggedNudgeBuckets = new Set();
    render(true);
    await resetPersistedEvents(verticalId);
  }

  function render(force) {
    const c = ctx();
    clockTimeEl.textContent = minToHHMM(app.clock.nowMin);
    clockScrub.value = String(Math.round(app.clock.nowMin));
    playPauseBtn.innerHTML = app.clock.playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
    document.getElementById("vertical-name").textContent = c.t("vertical.name");
    // the role badge's HTML has a plain-English fallback (e.g. "Patient")
    // baked in for a no-JS/pre-load flash, but every vertical's own label
    // (config.locale.strings' screen.* keys — "Customer view", "Bay view"
    // for car/bike) takes over once the page actually renders, same as the
    // old shared tab bar's labels used to.
    if (viewSpec.labelKey) {
      const badgeText = document.getElementById("role-badge-text");
      if (badgeText) badgeText.textContent = c.t(viewSpec.labelKey);
    }
    writeLocalStorage(LS_CLOCK_MIN, String(app.clock.nowMin));

    viewSpec.render(viewRoot, c);
    lastRenderReal = performance.now();
  }

  function scheduleRender(force) {
    const t = performance.now();
    if (force || t - lastRenderReal > 180) render(force);
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

    // only present on patient.html — every other role page omits this markup
    const estimatorSelect = document.getElementById("estimator-select");
    if (estimatorSelect) {
      estimatorSelect.addEventListener("change", (e) => {
        app.estimatorMode = e.target.value;
        render(true);
      });
    }
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
      writeLocalStorage(LS_VERTICAL, e.target.value);
      await loadAndStart(app.verticals.find((v) => v.id === e.target.value));
    });

    document.getElementById("locale-select").addEventListener("change", (e) => {
      app.locale = e.target.value;
      writeLocalStorage(LS_LOCALE, e.target.value);
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
    const stored = readLocalStorage(LS_LOCALE);
    app.locale = available.includes(stored) ? stored : app.data.config.locale.default || "en";
    lSel.value = app.locale;
  }

  async function loadAndStart(verticalMeta) {
    app.data = await loadVertical(verticalMeta.path);
    app.runtimeEvents = await fetchPersistedEvents(verticalMeta.id);
    app.loggedPredictionBuckets = new Set();
    app.loggedNudgeBuckets = new Set();
    if (app.runtimeEvents.length) {
      toast(`Resumed ${app.runtimeEvents.length} action${app.runtimeEvents.length === 1 ? "" : "s"} from an earlier session`);
    }
    app.selectedStation = app.data.stations[0].id;
    app.selectedEntityId = app.data.entities[0].id;

    const dayStartMin = parseISOToMin(app.data.config.day_start);
    const dayEndMin = parseISOToMin(app.data.config.day_end);

    if (app.clock) app.clock.pause();
    // Resume wherever the last page (patient.html, frontdesk.html, ...) left
    // the shared clock — the simulation is one continuous thing even though
    // each role now lives on its own separate page. A stored value outside
    // today's valid range (e.g. leftover from a different vertical with a
    // shorter day) is ignored, not clamped, so a stale value never strands
    // the clock at a misleading edge.
    const storedClockMin = Number(readLocalStorage(LS_CLOCK_MIN));
    const startMin =
      Number.isFinite(storedClockMin) && storedClockMin >= dayStartMin && storedClockMin <= dayEndMin
        ? storedClockMin
        : dayStartMin;
    app.clock = new VirtualClock({
      dayStartMin,
      dayEndMin,
      onTick: () => scheduleRender(false)
    });
    app.clock.jumpTo(startMin);
    clockScrub.min = String(dayStartMin);
    clockScrub.max = String(dayEndMin);
    clockScrub.value = String(startMin);
    app.clock.setSpeed(10);

    refreshLocaleOptions();
    document.getElementById("vertical-select").value = verticalMeta.id;
    render(true);
  }

  async function main() {
    setupClockControls();
    await setupVerticalAndLocaleSelectors();
    const storedVertical = readLocalStorage(LS_VERTICAL);
    const startVertical = app.verticals.find((v) => v.id === storedVertical) || app.verticals[0];
    await loadAndStart(startVertical);
  }

  main().catch((err) => {
    console.error(err);
    viewRoot.innerHTML = `<div class="panel"><h2>Failed to load</h2><pre>${String((err && err.stack) || err)}</pre></div>`;
  });
}
