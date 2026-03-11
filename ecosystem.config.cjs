/**
 * PM2 Ecosystem Config for OpenClaude
 *
 * Must be .cjs (not .js) — OpenClaude has "type":"module" in package.json
 * and PM2 loads this via require() which needs CommonJS.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup   (run the printed command as Administrator once)
 */

module.exports = {
  apps: [
    // ─── Main Gateway ──────────────────────────────────────────
    {
      name: 'openclaude',

      // Run tsx's JS entry directly via node — avoids Windows .bin shebang issue
      // (same pattern as mobile-cc-setup: "node server/index.js" not npm.cmd)
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/cli/index.ts start',
      cwd: 'E:/1.Claude Code/OpenClaude',

      env: {
        NODE_ENV: 'production',
        GATEWAY_HOST: '0.0.0.0',      // Required: allows Tailscale phone access
        GATEWAY_PORT: '18789',
        PROJECTS_ROOT: 'E:/1.Claude Code',
        CLAUDE_MODEL: 'claude-sonnet-4-6',
        SANDBOX_MODE: 'true',
        HEARTBEAT_CRON: '0 * * * *',  // Agents heartbeat once per hour (not every 15 min)
        PUPPETEER_SKIP_DOWNLOAD: '1',
        // Prevent "nested session" false positive — see mobile-cc-setup MEMORY.md
        CLAUDECODE: '',
      },

      // Memory guard — 10 agents + workers can eat RAM
      max_memory_restart: '700M',

      // Restart policy
      autorestart: true,
      restart_delay: 5000,   // 5s between restarts
      max_restarts: 15,      // give up after 15 rapid crashes

      // Logging
      merge_logs: true,
      out_file: 'logs/openclaude-out.log',
      error_file: 'logs/openclaude-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      log_type: 'json',

      watch: false,
      kill_timeout: 10000,   // 10s to shut down gracefully
    },

    // ─── Watchdog ──────────────────────────────────────────────
    {
      name: 'openclaude-watchdog',
      script: 'watchdog.js',
      cwd: 'E:/1.Claude Code/OpenClaude',

      max_memory_restart: '50M',
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 20,

      merge_logs: true,
      out_file: 'logs/watchdog-out.log',
      error_file: 'logs/watchdog-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      watch: false,
    },
  ],
};
