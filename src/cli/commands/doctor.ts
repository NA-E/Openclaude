/**
 * Doctor command — standalone entry point.
 * Can be run directly via: tsx src/cli/commands/doctor.ts
 */

import { loadConfig } from '../../config/index.js';

const config = loadConfig();

console.log('OpenClaude Configuration Diagnosis');
console.log('──────────────────────────────────');
console.log(`Gateway: ${config.gateway.host}:${config.gateway.port}`);
console.log(`Model: ${config.agent.defaultModel}`);
console.log(`DM Policy: ${config.security.dmPolicy}`);
console.log(`Sandbox: ${config.security.sandboxMode}`);
console.log(`Workspace: ${config.workspace}`);
console.log(`Memory Dir: ${config.memory.dir}`);
console.log(`Heartbeat: ${config.scheduler.heartbeatCron}`);

const channels = [];
if (config.channels.discord) channels.push('Discord');
if (config.channels.telegram) channels.push('Telegram');
if (config.channels.slack) channels.push('Slack');
if (config.channels.webchat?.enabled) channels.push('WebChat');
console.log(`Channels: ${channels.join(', ') || 'none configured'}`);
