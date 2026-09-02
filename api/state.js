// GET /api/state?vertical=opd&now=2026-09-02T11:30:00+05:30
//   -> { vertical, now, runtimeEventCount, state }
//
// Runs the exact same deriveState() the browser uses, server-side, against
// the static seed plus whatever's been persisted via /api/events — so an
// automation suite can assert on queue state directly ("at 11:30, 5 people
// are waiting at st_opd_gen and the doctor is paused") without driving a
// browser at all. Omit `now` to evaluate at the vertical's configured
// day_end (i.e. the fully-replayed end-of-day state).

import { readFile } from "fs/promises";
import path from "path";
import { deriveState } from "../src/engine/deriveState.js";
import { readEvents, storageMode } from "./_lib/blobStore.js";

const VERTICAL_RE = /^[a-z][a-z0-9_]*$/;

async function loadVerticalData(vertical) {
  const base = path.join(process.cwd(), "data", vertical);
  const files = ["config", "stations", "resources", "routes", "entities", "events"];
  const [config, stations, resources, routes, entities, seedEvents] = await Promise.all(
    files.map((f) => readFile(path.join(base, `${f}.json`), "utf8").then(JSON.parse))
  );
  return { config, stations, resources, routes, entities, seedEvents };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET,OPTIONS");
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const vertical = String(req.query.vertical || "opd");
  if (!VERTICAL_RE.test(vertical)) {
    res.status(400).json({ error: "invalid 'vertical' query param" });
    return;
  }

  try {
    const data = await loadVerticalData(vertical);
    const runtimeEvents = await readEvents(vertical);
    const allEvents = data.seedEvents.concat(runtimeEvents);
    const nowISO = req.query.now ? String(req.query.now) : data.config.day_end;
    const state = deriveState(data, allEvents, nowISO);
    res.status(200).json({
      vertical,
      now: nowISO,
      runtimeEventCount: runtimeEvents.length,
      storage: storageMode(),
      state
    });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      res.status(404).json({ error: `unknown vertical '${vertical}'` });
      return;
    }
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
