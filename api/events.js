// GET  /api/events?vertical=opd            -> { events: [...] }
// POST /api/events?vertical=opd  {events:[...]} -> { ok, count }
// DELETE /api/events?vertical=opd           -> { ok } — clears persisted state (used by "Reset simulation")
//
// This is what "save records to the JSON files" becomes once the app is
// deployed: Vercel's own filesystem is read-only in production, so the
// runtime event log — everything a Front Desk / Patient / Doctor action
// appends beyond the static seed — is persisted through Vercel Blob
// instead (see api/_lib/blobStore.js). The client (src/app.js) calls this
// on every dispatch and on load; if this endpoint isn't reachable at all
// (e.g. served via a plain static file server locally) the app falls back
// to purely local, in-memory state with no behavior change.

import { readEvents, appendEvents, resetEvents, storageMode } from "./_lib/blobStore.js";

const VERTICAL_RE = /^[a-z][a-z0-9_]*$/;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const vertical = String(req.query.vertical || "");
  if (!VERTICAL_RE.test(vertical)) {
    res.status(400).json({ error: "missing or invalid 'vertical' query param" });
    return;
  }

  try {
    if (req.method === "GET") {
      const events = await readEvents(vertical);
      res.status(200).json({ events, storage: storageMode() });
      return;
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const incoming = Array.isArray(body.events) ? body.events : [];
      if (incoming.length === 0) {
        res.status(200).json({ ok: true, count: 0 });
        return;
      }
      const merged = await appendEvents(vertical, incoming);
      res.status(200).json({ ok: true, count: merged.length, storage: storageMode() });
      return;
    }

    if (req.method === "DELETE") {
      await resetEvents(vertical);
      res.status(200).json({ ok: true, storage: storageMode() });
      return;
    }

    res.setHeader("Allow", "GET,POST,DELETE,OPTIONS");
    res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
