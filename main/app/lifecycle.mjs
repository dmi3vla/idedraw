// App lifecycle side effects, moved out of the bootstrap.
import { cleanupExpired, cleanupStaleRunDirs } from '../archify-runs.mjs';

const HOUR_MS = 60 * 60 * 1000;

export function registerLifecycle({ app }) {
  app.on('window-all-closed', () => app.quit());

  // S4.2 cleanup: run scratch dirs are ephemeral. Sweep expired + stale dirs at
  // startup (including dirs from a previous crashed session that are no longer in
  // the in-memory map), then on a rare interval, so a long-lived app cannot grow
  // an unbounded `userData/agent-runs` tree with candidate artifacts.
  const userDataDir = app.getPath('userData');
  cleanupExpired();
  cleanupStaleRunDirs(userDataDir);
  const timer = setInterval(() => {
    cleanupExpired();
    cleanupStaleRunDirs(userDataDir);
  }, HOUR_MS); // every hour (rare; runs are 24h TTL)
  timer.unref?.();
  return () => clearInterval(timer);
}
