// Shared helpers for the seed-data generator scripts (tools/generate-*.mjs).
// One-time authoring tools, not part of the running app.

export function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSampler(rand) {
  return function sampleDuration(median, p80) {
    const r = rand();
    if (r < 0.55) return median * (0.55 + 0.45 * rand());
    if (r < 0.88) return median + (p80 - median) * rand();
    return p80 + (p80 - median) * rand() * 1.4;
  };
}

export function makeIsoFormatter(dateStr, tz) {
  return function toISO(min) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return `${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${tz}`;
  };
}

export function nextFreeTime(fromMin, pauses) {
  let t = fromMin;
  let moved = true;
  while (moved) {
    moved = false;
    for (const p of pauses) {
      if (t >= p.start && t < p.end) {
        t = p.end;
        moved = true;
      }
    }
  }
  return t;
}

export function makeEmitter(toISO) {
  const events = [];
  let seq = 0;
  function emit(type, ts_min, fields) {
    seq += 1;
    events.push({ id: `ev${String(seq).padStart(4, "0")}`, type, ts: toISO(ts_min), ts_min, ...fields });
  }
  return { emit, events };
}

// Generalized FIFO station simulator: N resources (each with its own pause
// windows), optional priority-reorder and no-show handling. Mirrors the
// logic in tools/generate-opd-seed.mjs but generalized to multiple
// resources sharing one queue (a station with capacity > 1).
export function simulateStation({
  stationId,
  resources, // [{ id, pauses: [{start,end,reasonKey,reasonText,expectedResumeStatedMin}] }]
  arrivals, // [{entityId, atMin}]
  serviceTimeFor, // (entityId) => {median, p80}
  entityFlags = new Map(), // entityId -> {isPriority, isNoShowCandidate}
  priorityApplied = new Set(),
  noShowResolved = new Set(),
  priorityReasonFor = () => "Priority requested",
  emit,
  sampleDuration,
  // (resourceId, completionCount, freeAtMin) => pause spec | null. Called
  // right after a resource frees up (never mid-service), letting a
  // narrative pause (e.g. "waiting on a delivered part") land at a
  // realistic, always-valid moment instead of a hand-picked clock time.
  dynamicPause = () => null
}) {
  const queue = [];
  const pending = arrivals.slice().sort((a, b) => a.atMin - b.atMin);
  const arrivalOf = new Map(pending.map((a) => [a.entityId, a.atMin]));
  const freeAt = {};
  const completionCount = {};
  for (const r of resources) {
    freeAt[r.id] = nextFreeTime(0, r.pauses || []);
    completionCount[r.id] = 0;
  }
  let pendingIdx = 0;
  const completions = {};

  function admit(t) {
    while (pendingIdx < pending.length && pending[pendingIdx].atMin <= t) {
      queue.push(pending[pendingIdx].entityId);
      pendingIdx += 1;
    }
  }
  function pickIndex() {
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      const flags = entityFlags.get(id);
      if (flags && flags.isPriority && !priorityApplied.has(id)) return i;
    }
    return 0;
  }

  while (pendingIdx < pending.length || queue.length > 0) {
    if (queue.length === 0) {
      admit(pending[pendingIdx].atMin);
      continue;
    }
    // pick the resource that becomes free earliest (respecting its own pauses)
    const resourceId = resources.reduce(
      (best, r) => (freeAt[r.id] < freeAt[best] ? r.id : best),
      resources[0].id
    );
    const resource = resources.find((r) => r.id === resourceId);
    const arrivalFloor = arrivalOf.get(queue[pickIndex()]) || 0;
    const startAt = nextFreeTime(Math.max(freeAt[resourceId], arrivalFloor), resource.pauses || []);
    admit(startAt);

    const idx = pickIndex();
    const entityId = queue[idx];
    const flags = entityFlags.get(entityId) || {};

    if (flags.isPriority && !priorityApplied.has(entityId) && idx !== 0) {
      emit("priority_insert", startAt - 1, { entity_id: entityId, station_id: stationId, reason: priorityReasonFor() });
    }
    priorityApplied.add(entityId);
    queue.splice(idx, 1);

    if (flags.isNoShowCandidate && !noShowResolved.has(entityId)) {
      const grace = 4;
      // A real story for *why* they no-show, not a random dropout: they
      // stepped out while waiting and genuinely never came back. Also
      // gives noShowRisk.js's "stepped out and overdue" signal something
      // true to catch before the no-show itself actually fires.
      const stepOutLeadMin = 20;
      const stepOutAt = Math.max(arrivalOf.get(entityId) || 0, startAt - stepOutLeadMin);
      emit("stepped_out", stepOutAt, { entity_id: entityId, station_id: stationId });
      emit("called", startAt, { entity_id: entityId, station_id: stationId, resource_id: resourceId });
      emit("no_show", startAt + grace, { entity_id: entityId, station_id: stationId });
      noShowResolved.add(entityId);
      freeAt[resourceId] = startAt + grace;
      emit("resequence_suggested", startAt + grace, {
        suggestion: "pull_forward",
        reason_key: "no_show_gap",
        station_id: stationId,
        related_entity_id: entityId,
        accepted: true
      });
      admit(freeAt[resourceId]);
      if (queue.length > 0) {
        const pullIdx = Math.min(2, queue.length - 1);
        const [pulled] = queue.splice(pullIdx, 1);
        queue.unshift(pulled);
        emit("pull_forward", startAt + grace + 1, {
          entity_id: pulled,
          station_id: stationId,
          reason: "Recovering slot freed by no-show"
        });
      }
      continue;
    }

    const { median, p80 } = serviceTimeFor(entityId);
    const duration = Math.max(1, Math.round(sampleDuration(median, p80)));
    emit("called", startAt, { entity_id: entityId, station_id: stationId, resource_id: resourceId });
    emit("service_started", startAt, { entity_id: entityId, station_id: stationId, resource_id: resourceId });
    const completeAt = startAt + duration;
    emit("service_completed", completeAt, {
      entity_id: entityId,
      station_id: stationId,
      resource_id: resourceId,
      duration_min: duration
    });
    freeAt[resourceId] = completeAt;
    completionCount[resourceId] += 1;
    completions[entityId] = { completeMin: completeAt, durationMin: duration };

    const pause = dynamicPause(resourceId, completionCount[resourceId], completeAt);
    if (pause) {
      resource.pauses = (resource.pauses || []).concat([pause]);
      emit("resource_paused", pause.start, {
        resource_id: resourceId,
        station_id: stationId,
        reason_key: pause.reasonKey,
        reason_text: pause.reasonText,
        expected_resume_at: pause.expectedResumeAtISO
      });
      emit("resource_resumed", pause.end, {
        resource_id: resourceId,
        station_id: stationId,
        actual_duration_min: pause.end - pause.start
      });
      freeAt[resourceId] = pause.end;
    }
  }
  return completions;
}

// Post-process the finished event log to demonstrate "step out & get
// notified" for a handful of entities who genuinely waited long enough to
// benefit — so the feature is visible by default in replay, not only when
// a viewer clicks it themselves. Purely additive: only reads `called` and
// `queue_joined` events already emitted, adds `stepped_out`/`returned`
// for entities with a long-enough wait, spread across the day.
export function injectStepOutDemo(events, emit, { leadMin = 5, returnLeadMin = 6, minWaitMin = 35, maxCount = 4 } = {}) {
  const joinsByEntity = new Map();
  for (const e of events) {
    if (e.type !== "queue_joined") continue;
    if (!joinsByEntity.has(e.entity_id)) joinsByEntity.set(e.entity_id, []);
    joinsByEntity.get(e.entity_id).push(e);
  }
  const calledEvents = events.filter((e) => e.type === "called").sort((a, b) => a.ts_min - b.ts_min);
  const usedEntities = new Set();
  let count = 0;
  for (const ev of calledEvents) {
    if (count >= maxCount) break;
    if (usedEntities.has(ev.entity_id)) continue;
    const joins = (joinsByEntity.get(ev.entity_id) || []).filter((j) => j.ts_min <= ev.ts_min);
    if (!joins.length) continue;
    const lastJoin = joins.sort((a, b) => a.ts_min - b.ts_min)[joins.length - 1];
    const wait = ev.ts_min - lastJoin.ts_min;
    if (wait < minWaitMin) continue;
    usedEntities.add(ev.entity_id);
    count += 1;
    emit("stepped_out", lastJoin.ts_min + leadMin, { entity_id: ev.entity_id, station_id: ev.station_id });
    emit("returned", Math.max(lastJoin.ts_min + leadMin + 1, ev.ts_min - returnLeadMin), {
      entity_id: ev.entity_id,
      station_id: ev.station_id
    });
  }
  return count;
}
