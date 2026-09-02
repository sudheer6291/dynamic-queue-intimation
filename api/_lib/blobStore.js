// Persistence for runtime (front-desk/patient) actions.
//
// The *seed* — every static data/<vertical>/*.json file — ships inside the
// deployment itself and is what api/state.js reads directly off disk on
// every request; no external store is involved in that at all, and none is
// required for initial testing. What needs somewhere to live is only the
// *incremental* log a live demo appends on top of that seed (front-desk
// calls, walk-in registrations, ...), and by default that lives in a
// plain in-memory Map, scoped to one warm serverless instance — good
// enough to drive a same-session demo or a single automated test run
// without any setup step at all.
//
// That in-memory store is NOT durable across a redeploy or a cold/second
// instance, so if a deployment later needs runtime actions to survive
// that, set BLOB_READ_WRITE_TOKEN (Vercel dashboard -> Storage -> Create
// Database -> Blob) and this switches to writing one JSON blob per
// vertical instead — same read/append/reset API either way, callers don't
// need to know which mode is active. Read-modify-write, not
// compare-and-swap, in the Blob path — fine for a prototype's request
// volume, not meant to survive heavy concurrent writers.

import { put, get, del } from "@vercel/blob";

const PATH_PREFIX = "queue-intimation/runtime-events";
const memoryFallback = new Map(); // used only when no Blob store is configured

function blobPath(vertical) {
  return `${PATH_PREFIX}/${vertical}.json`;
}

function hasBlobStore() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function readEvents(vertical) {
  if (!hasBlobStore()) {
    return memoryFallback.get(vertical) || [];
  }
  try {
    const result = await get(blobPath(vertical), { access: "public", useCache: false });
    if (!result || !result.stream) return [];
    const data = await new Response(result.stream).json();
    return Array.isArray(data.events) ? data.events : [];
  } catch (err) {
    // no blob yet for this vertical, or a transient read error — treat as empty
    return [];
  }
}

async function writeEvents(vertical, events) {
  if (!hasBlobStore()) {
    memoryFallback.set(vertical, events);
    return events;
  }
  await put(blobPath(vertical), JSON.stringify({ events, updatedAt: new Date().toISOString() }), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true
  });
  return events;
}

export async function appendEvents(vertical, newEvents) {
  const existing = await readEvents(vertical);
  const merged = existing.concat(newEvents);
  return writeEvents(vertical, merged);
}

export async function resetEvents(vertical) {
  if (!hasBlobStore()) {
    memoryFallback.delete(vertical);
    return [];
  }
  try {
    await del(blobPath(vertical));
  } catch (err) {
    // already gone — fine
  }
  return [];
}

export function storageMode() {
  return hasBlobStore() ? "blob" : "memory-fallback";
}
