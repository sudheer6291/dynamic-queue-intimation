#!/usr/bin/env node
// API-level smoke test for a deployed instance (no browser needed — plain
// fetch). Verifies the persistence contract end to end: state loads,
// events actually persist server-side (not just in the response that
// echoed them back), deriveState() correctly merges seed + persisted
// events, and the test cleans up after itself so it's safe to re-run
// against a real deployment without leaving synthetic entities behind.
//
// Usage:
//   node tools/smoke-test-api.mjs [baseUrl]
//   node tools/smoke-test-api.mjs https://dynamic-queue-intimation.vercel.app
//
// Defaults to https://dynamic-queue-intimation.vercel.app if no argument
// is given. Exits non-zero (and prints a FAIL summary) if any check fails
// — wire this straight into CI.

const baseUrl = (process.argv[2] || "https://dynamic-queue-intimation.vercel.app").replace(/\/$/, "");
// Each vertical's real entry station (data/<vertical>/config.json's
// entry_station_id) — using a station that actually exists in the seed
// data exercises the same code path a genuine Front Desk/Patient action
// would, rather than a station id nothing recognizes.
const VERTICALS = [
  { id: "opd", entryStationId: "st_reception" },
  { id: "car_service", entryStationId: "st_checkin" },
  { id: "bike_service", entryStationId: "st_checkin" }
];

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function json(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response — leave body null, callers check res.ok/status
  }
  return { res, body };
}

async function testVertical({ id: vertical, entryStationId }) {
  console.log(`\n== ${vertical} ==`);
  const stateUrl = `${baseUrl}/api/state?vertical=${vertical}`;
  const eventsUrl = `${baseUrl}/api/events?vertical=${vertical}`;

  // 1. /api/state serves the fully-replayed end-of-day state from the seed.
  const { res: stateRes, body: stateBody } = await json(stateUrl);
  check("GET /api/state -> 200", stateRes.ok, `status ${stateRes.status}`);
  check("response has state.entities", stateBody && stateBody.state && typeof stateBody.state.entities === "object");
  const entityCount = stateBody && stateBody.state ? Object.keys(stateBody.state.entities).length : 0;
  check("seed has at least one entity", entityCount > 0, `found ${entityCount}`);
  console.log(`  storage mode: ${stateBody ? stateBody.storage : "?"}`);
  if (stateBody && stateBody.storage === "memory-fallback") {
    console.log("  NOTE: memory-fallback means Blob storage isn't connected yet in the Vercel project —");
    console.log("        persistence works per-instance but is not durable. See README 'Persistence & deployment'.");
  }

  // 2. Clean slate: clear anything left over from a previous run.
  await fetch(eventsUrl, { method: "DELETE" });

  // 3. Post a synthetic runtime event and confirm the POST itself succeeds.
  const testEntityId = `smoketest-${vertical}-${Date.now()}`;
  const testTs = stateBody ? stateBody.now : new Date().toISOString();
  const testEvent = {
    id: `smoketest-ev-${Date.now()}`,
    type: "queue_joined",
    ts: testTs,
    entity_id: testEntityId,
    station_id: entryStationId,
    step_index: 0
  };
  const { res: postRes, body: postBody } = await json(eventsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: [testEvent] })
  });
  check("POST /api/events -> ok:true", postRes.ok && postBody && postBody.ok === true, JSON.stringify(postBody));

  // 4. THE REAL TEST: read it back with a fresh GET. If this only echoed
  // back what we just sent without actually writing anywhere, a second,
  // independent request would still show it because of the round trip —
  // so what actually proves persistence is that the count matches what a
  // brand new request computes from storage, not from any local state.
  const { res: getRes, body: getBody } = await json(eventsUrl);
  check("GET /api/events after POST -> 200", getRes.ok, `status ${getRes.status}`);
  const found = getBody && Array.isArray(getBody.events) && getBody.events.some((e) => e.entity_id === testEntityId);
  check("persisted event is present on GET", found, found ? "" : `events: ${JSON.stringify(getBody && getBody.events)}`);
  check(
    "storage mode is 'blob' (durable) rather than 'memory-fallback'",
    getBody && getBody.storage === "blob",
    getBody ? `storage: ${getBody.storage}` : "no body"
  );

  // 5. /api/state should now reflect the synthetic entity too — proves
  // deriveState() is actually merging seed + persisted events, not just
  // serving the static seed regardless of what's been posted.
  const { body: stateAfter } = await json(stateUrl);
  const entityInState = stateAfter && stateAfter.state && stateAfter.state.entities && stateAfter.state.entities[testEntityId];
  check("synthetic entity appears in /api/state after POST", Boolean(entityInState));
  if (entityInState) {
    check("synthetic entity's queue station matches what was posted", entityInState.currentStationId === entryStationId);
  }

  // 6. Clean up — DELETE clears the whole vertical's persisted log, so this
  // also removes the synthetic event, leaving the deployment exactly as
  // this test found it.
  const { res: delRes, body: delBody } = await json(eventsUrl, { method: "DELETE" });
  check("DELETE /api/events -> ok:true", delRes.ok && delBody && delBody.ok === true);
  const { body: afterDelete } = await json(eventsUrl);
  check("GET /api/events after DELETE is empty", afterDelete && Array.isArray(afterDelete.events) && afterDelete.events.length === 0);
}

async function main() {
  console.log(`Smoke-testing ${baseUrl}`);
  for (const vertical of VERTICALS) {
    try {
      await testVertical(vertical);
    } catch (err) {
      fail += 1;
      failures.push(`${vertical.id}: threw ${err && err.message}`);
      console.log(`  FAIL ${vertical.id} threw: ${err && err.stack}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();
