// Persistence for runtime (front-desk/patient) actions, one JSON blob per
// vertical, backed by Vercel Blob — the closest thing to "a JSON file" that
// actually survives on Vercel's serverless runtime, whose own filesystem is
// read-only in production. Falls back to an in-memory store (per warm
// lambda instance only — NOT durable, just enough that local `vercel dev`
// and a store-less deploy don't hard-crash) when no Blob store is
// configured, so the app degrades instead of erroring.
//
// Read-modify-write, not compare-and-swap — fine for a prototype's
// request volume, not meant to survive heavy concurrent writers.

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
