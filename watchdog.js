/**
 * OpenClaude Watchdog
 *
 * Polls /health every 60s. If it fails MAX_FAILURES times in a row,
 * restarts the openclaude PM2 process.
 *
 * Runs as a separate PM2 process (see ecosystem.config.cjs).
 * CommonJS — must NOT be ESM since package.json has "type":"module".
 */

const { execSync } = require('child_process');
const http = require('http');

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || '18789', 10);
const HEALTH_URL = `http://127.0.0.1:${GATEWAY_PORT}/health`;
const CHECK_INTERVAL_MS = 60_000;  // 60 seconds
const MAX_FAILURES = 3;            // 3 consecutive failures → restart

let failures = 0;
let lastRestartAt = null;
const MIN_RESTART_GAP_MS = 5 * 60_000; // don't restart more than once every 5 min

function log(msg) {
  console.log(`[${new Date().toISOString()}] [Watchdog] ${msg}`);
}

function checkHealth() {
  const req = http.get(HEALTH_URL, { timeout: 8000 }, (res) => {
    if (res.statusCode === 200) {
      if (failures > 0) log(`Health restored (was at ${failures} failures)`);
      failures = 0;
    } else {
      handleFailure(`HTTP ${res.statusCode}`);
    }
    res.resume();
  });

  req.on('error', (err) => handleFailure(err.message));
  req.on('timeout', () => {
    req.destroy();
    handleFailure('request timeout');
  });
}

function handleFailure(reason) {
  failures++;
  log(`Health check failed (${failures}/${MAX_FAILURES}): ${reason}`);

  if (failures < MAX_FAILURES) return;

  // Rate-limit restarts — don't hammer if something is seriously wrong
  const now = Date.now();
  if (lastRestartAt && (now - lastRestartAt) < MIN_RESTART_GAP_MS) {
    log(`Skipping restart — last restart was ${Math.round((now - lastRestartAt) / 1000)}s ago (min gap: ${MIN_RESTART_GAP_MS / 1000}s)`);
    return;
  }

  log('Triggering pm2 restart openclaude...');
  try {
    execSync('pm2 restart openclaude', { stdio: 'pipe' });
    lastRestartAt = now;
    failures = 0;
    log('Restart command sent successfully');
  } catch (err) {
    log(`pm2 restart failed: ${err.message}`);
  }
}

log(`Starting health checks → ${HEALTH_URL} every ${CHECK_INTERVAL_MS / 1000}s`);
log(`Will restart after ${MAX_FAILURES} consecutive failures (min gap: ${MIN_RESTART_GAP_MS / 60000}m)`);

// Initial check on startup
setTimeout(checkHealth, 15_000); // wait 15s for gateway to boot first

// Then poll every 60s
setInterval(checkHealth, CHECK_INTERVAL_MS);
