// Hybrid logical clocks are totally ordered labels for a write.
// Concurrency is decided by the parent pointer (prev), not by which clock is larger.

export function createClock(deviceId, now = () => Date.now()) {
  if (!deviceId || String(deviceId).includes(":")) {
    throw new Error("deviceId is required and cannot contain ':'");
  }
  let lastMs = -1;
  let counter = -1;
  return {
    deviceId,
    tick() {
      const ms = Number(now());
      if (!Number.isFinite(ms)) throw new Error("clock time must be a finite number");
      if (ms === lastMs) counter += 1;
      else {
        lastMs = ms;
        counter = 0;
      }
      return formatHlc(ms, counter, deviceId);
    },
  };
}

export function formatHlc(ms, counter, deviceId) {
  return `${String(Math.trunc(ms)).padStart(15, "0")}:${String(counter).padStart(6, "0")}:${deviceId}`;
}

export function encodeValue(value) {
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

export function decodeValue(json) {
  if (json === undefined || json === null) return null;
  return JSON.parse(json);
}

/**
 * Decide what to do with one incoming field write.
 * localClock: { hlc, prev_hlc, supersedes_json } or null
 * incoming: { hlc, prev, supersedes }
 */
export function mergeFieldState(localClock, incoming) {
  if (!incoming?.hlc) return { action: "invalid" };
  if (!localClock) return { action: "apply" };
  if (localClock.hlc === incoming.hlc) return { action: "noop" };
  const incomingSupersedes = incoming.supersedes ?? [];
  if (incomingSupersedes.includes(localClock.hlc)) return { action: "apply" };
  let localSupersedes = [];
  try {
    localSupersedes = JSON.parse(localClock.supersedes_json || "[]");
  } catch {
    localSupersedes = [];
  }
  if (localSupersedes.includes(incoming.hlc)) return { action: "noop" };
  if (incoming.prev && incoming.prev === localClock.hlc) return { action: "apply" };
  if (localClock.prev_hlc && localClock.prev_hlc === incoming.hlc) return { action: "noop" };
  return { action: "conflict" };
}
