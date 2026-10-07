export function createSyncCoordinator({ run, enabled, intervalMs = 300_000, onError = console.error }) {
  let active = null;
  let timer = null;
  let stopped = false;
  const state = { enabled, intervalMs, running: false, lastStartedAt: null, lastSuccessAt: null, lastError: null, lastResult: null };
  function execute() {
    if (active) return active;
    state.running = true;
    state.lastStartedAt = new Date().toISOString();
    active = Promise.resolve().then(run).then(result => {
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
      state.lastResult = { pushed: result.pushed, pulled: result.pulled, rejected: result.rejected?.length ?? 0 };
      return result;
    }).catch(error => {
      state.lastError = { at: new Date().toISOString(), message: error.message };
      throw error;
    }).finally(() => {
      state.running = false;
      active = null;
    });
    return active;
  }
  function schedule(delay) {
    if (!enabled || stopped) return;
    timer = setTimeout(async () => {
      try { await execute(); } catch (error) { onError(`[taskboard-sync] ${error.message}`); }
      schedule(intervalMs);
    }, delay);
    timer.unref?.();
  }
  schedule(3_000);
  return {
    run: execute,
    status: () => ({ ...state }),
    async stop() { stopped = true; clearTimeout(timer); if (active) await active.catch(() => {}); },
  };
}
