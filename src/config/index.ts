import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { homedir } from 'os';
import type { OpenClaudeConfig } from '../types/index.js';

dotenvConfig({ override: true }); // .env is the source of truth; overrides any stale PM2-cached env

const home = homedir();

export function loadConfig(overrides?: Partial<OpenClaudeConfig>): OpenClaudeConfig {
  const defaults: OpenClaudeConfig = {
    gateway: {
      host: process.env.GATEWAY_HOST || '0.0.0.0',
      port: parseInt(process.env.GATEWAY_PORT || '18789', 10),
      secret: process.env.GATEWAY_SECRET || 'change-me',
    },
    agent: {
      defaultModel: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
      maxTokens: parseInt(process.env.CLAUDE_MAX_TOKENS || '8192', 10),
      temperature: parseFloat(process.env.CLAUDE_TEMPERATURE || '0.7'),
    },
    channels: {
      discord: process.env.DISCORD_BOT_TOKEN
        ? {
            token: process.env.DISCORD_BOT_TOKEN,
            allowedUsers: (process.env.DISCORD_ALLOWED_USERS || '').split(',').filter(Boolean),
          }
        : undefined,
      telegram: process.env.TELEGRAM_BOT_TOKEN
        ? {
            token: process.env.TELEGRAM_BOT_TOKEN,
            allowedUsers: (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').filter(Boolean),
          }
        : undefined,
      slack:
        process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN
          ? {
              botToken: process.env.SLACK_BOT_TOKEN,
              appToken: process.env.SLACK_APP_TOKEN,
              signingSecret: process.env.SLACK_SIGNING_SECRET || '',
            }
          : undefined,
      webchat: { enabled: true },
    },
    memory: {
      dir: process.env.MEMORY_DIR || resolve(home, '.openclaude', 'memory'),
      maxEntries: 10000,
    },
    scheduler: {
      heartbeatCron: process.env.HEARTBEAT_CRON || '*/15 * * * *',
    },
    security: {
      dmPolicy: (process.env.DM_POLICY as 'pairing' | 'open') || 'pairing',
      sandboxMode: process.env.SANDBOX_MODE !== 'false',
    },
    browser: {
      headless: process.env.BROWSER_HEADLESS !== 'false',
      executablePath: process.env.BROWSER_PATH || undefined,
    },
    workspace: resolve(home, '.openclaude', 'workspace'),
  };

  return deepMerge(defaults, overrides || {}) as OpenClaudeConfig;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(
        (result[key] as Record<string, unknown>) || {},
        source[key] as Record<string, unknown>,
      );
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

export const CONFIG_DIR = resolve(home, '.openclaude');
export const DEFAULT_CONFIG_PATH = resolve(CONFIG_DIR, 'openclaude.json');
