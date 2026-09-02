// Best-effort sync with the optional serverless API (api/events.js). This
// is what "save records to the JSON files" becomes once deployed — see
// api/_lib/blobStore.js for why Vercel needs Blob storage rather than a
// literal writable file. If the API isn't reachable at all (e.g. the app
// is served via a plain static file server with no /api routes, as in
// local dev without `vercel dev`), every function here fails silently and
// the app continues working purely from local, in-memory state — exactly
// as it did before this existed. No behavior change, pure enhancement.

const API_BASE = "/api/events";

function isJsonResponse(res) {
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json");
}

export async function fetchPersistedEvents(verticalId) {
  try {
    const res = await fetch(`${API_BASE}?vertical=${encodeURIComponent(verticalId)}`, { cache: "no-store" });
    if (!res.ok || !isJsonResponse(res)) return [];
    const data = await res.json();
    return Array.isArray(data.events) ? data.events : [];
  } catch (err) {
    return [];
  }
}

export function syncEventsToServer(verticalId, events) {
  if (!events || events.length === 0) return;
  fetch(`${API_BASE}?vertical=${encodeURIComponent(verticalId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events })
  }).catch(() => {});
}

export async function resetPersistedEvents(verticalId) {
  try {
    await fetch(`${API_BASE}?vertical=${encodeURIComponent(verticalId)}`, { method: "DELETE" });
  } catch (err) {
    // ignore — the caller clears local state regardless
  }
}
