#!/usr/bin/env node

/**
 * OpenClaude CLI — Command-line interface for setup and management.
 *
 * OpenClaw uses a CLI wizard for setup and management.
 * OpenClaude provides the same with commander.
 *
 * Usage:
 *   openclaude start        - Start the Gateway and all services
 *   openclaude setup        - Interactive setup wizard
 *   openclaude doctor       - Diagnose configuration issues
 *   openclaude status       - Show system status
 *   openclaude agent list   - List registered agents
 *   openclaude agent add    - Add a new agent
 *   openclaude skill list   - List installed skills
 *   openclaude skill install - Install a skill
 *   openclaude message      - Send a message via CLI
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config/index.js';
import { Gateway } from '../gateway/server.js';

const program = new Command();

program
  .name('openclaude')
  .description('Your own personal AI assistant powered by Claude')
  .version('0.1.0');

// ─── Start Command ──────────────────────────────────────────────

program
  .command('start')
  .description('Start the OpenClaude Gateway and all services')
  .option('--port <port>', 'Gateway port', '18789')
  .option('--host <host>', 'Gateway host')  // no default — let env/config decide
  .option('--no-scheduler', 'Disable task scheduler')
  .action(async (opts) => {
    console.log(chalk.cyan(`
    ╔═══════════════════════════════════════════╗
    ║                                           ║
    ║          🧠  OpenClaude  v0.1.0           ║
    ║     Personal AI Assistant (Claude)        ║
    ║                                           ║
    ╚═══════════════════════════════════════════╝
    `));

    const config = loadConfig({
      gateway: {
        ...(opts.host !== undefined && { host: opts.host }),
        port: parseInt(opts.port),
        secret: '',
      },
    });

    // No API key needed — uses OAuth via ~/.claude-acc1 + subprocess

    const gateway = new Gateway(config);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      await gateway.stop();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await gateway.stop();
      process.exit(0);
    });

    await gateway.start();
  });

// ─── Setup Wizard ───────────────────────────────────────────────

program
  .command('setup')
  .description('Interactive setup wizard')
  .action(async () => {
    console.log(chalk.cyan('OpenClaude Setup Wizard'));
    console.log(chalk.gray('────────────────────────────────'));
    console.log();
    console.log('1. Get your Anthropic API key from: https://console.anthropic.com/');
    console.log('2. Create a .env file with: ANTHROPIC_API_KEY=sk-ant-...');
    console.log('3. Optionally configure channels (Discord, Telegram, Slack)');
    console.log('4. Run: openclaude start');
    console.log();
    console.log(chalk.green('Quick start:'));
    console.log(chalk.gray('  cp .env.example .env'));
    console.log(chalk.gray('  # Edit .env with your API key'));
    console.log(chalk.gray('  openclaude start'));
  });

// ─── Status ─────────────────────────────────────────────────────

program
  .command('status')
  .description('Show system status')
  .action(async () => {
    try {
      const resp = await fetch('http://127.0.0.1:18789/api/status');
      const status = await resp.json();
      console.log(chalk.cyan('OpenClaude Status'));
      console.log(chalk.gray('────────────────────────────────'));
      console.log(`Uptime: ${Math.floor(status.uptime / 1000)}s`);
      console.log(`Agents: ${status.agents?.length || 0}`);
      console.log(`Channels: ${status.channels?.length || 0}`);
      console.log(`Scheduled Tasks: ${status.scheduledTasks || 0}`);
      console.log(`Memory Entries: ${status.memoryEntries || 0}`);

      if (status.agents?.length) {
        console.log('\nAgents:');
        for (const agent of status.agents) {
          console.log(`  ${chalk.green('●')} ${agent.name} (${agent.id}) - ${agent.sessions} sessions`);
        }
      }

      if (status.channels?.length) {
        console.log('\nChannels:');
        for (const ch of status.channels) {
          const icon = ch.status === 'connected' ? chalk.green('●') : chalk.red('●');
          console.log(`  ${icon} ${ch.type} - ${ch.status}`);
        }
      }
    } catch {
      console.error(chalk.red('Gateway not running. Start with: openclaude start'));
    }
  });

// ─── Doctor ─────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Diagnose configuration issues')
  .action(async () => {
    console.log(chalk.cyan('OpenClaude Doctor'));
    console.log(chalk.gray('────────────────────────────────'));

    const checks = [
      {
        name: 'ANTHROPIC_API_KEY',
        check: () => !!process.env.ANTHROPIC_API_KEY,
        fix: 'Set ANTHROPIC_API_KEY in your .env file',
      },
      {
        name: 'Node.js >= 22',
        check: () => parseInt(process.version.slice(1)) >= 22,
        fix: 'Install Node.js 22 or later',
      },
      {
        name: 'DM Policy',
        check: () => {
          const policy = process.env.DM_POLICY || 'pairing';
          return policy === 'pairing' || policy === 'open';
        },
        fix: 'Set DM_POLICY to "pairing" (recommended) or "open"',
      },
    ];

    let allPassed = true;
    for (const { name, check, fix } of checks) {
      const passed = check();
      if (passed) {
        console.log(`  ${chalk.green('✓')} ${name}`);
      } else {
        console.log(`  ${chalk.red('✗')} ${name}`);
        console.log(chalk.yellow(`    Fix: ${fix}`));
        allPassed = false;
      }
    }

    if (allPassed) {
      console.log(chalk.green('\nAll checks passed!'));
    } else {
      console.log(chalk.yellow('\nSome checks failed. Fix the issues above.'));
    }
  });

// ─── Message ────────────────────────────────────────────────────

program
  .command('message')
  .description('Send a message to the agent via CLI')
  .argument('<text...>', 'Message text')
  .action(async (textParts: string[]) => {
    const content = textParts.join(' ');
    try {
      const resp = await fetch('http://127.0.0.1:18789/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const result = await resp.json();
      console.log(chalk.cyan('Claude:'), result.response);
    } catch {
      console.error(chalk.red('Gateway not running. Start with: openclaude start'));
    }
  });

// ─── Agent Commands ─────────────────────────────────────────────

const agent = program.command('agent').description('Manage agents');

agent
  .command('list')
  .description('List registered agents')
  .action(async () => {
    try {
      const resp = await fetch('http://127.0.0.1:18789/api/agents');
      const agents = await resp.json();
      console.log(chalk.cyan('Agents:'));
      for (const a of agents) {
        console.log(`  ${chalk.green('●')} ${a.name} (${a.id}) - model: ${a.model}`);
      }
    } catch {
      console.error(chalk.red('Gateway not running.'));
    }
  });

// ─── Skill Commands ─────────────────────────────────────────────

const skill = program.command('skill').description('Manage skills');

skill
  .command('list')
  .description('List installed skills')
  .action(async () => {
    try {
      const resp = await fetch('http://127.0.0.1:18789/api/skills');
      const skills = await resp.json();
      if (skills.length === 0) {
        console.log(chalk.yellow('No skills installed.'));
        return;
      }
      console.log(chalk.cyan('Skills:'));
      for (const s of skills) {
        console.log(`  ${chalk.green('●')} ${s.name} v${s.version} - ${s.description}`);
      }
    } catch {
      console.error(chalk.red('Gateway not running.'));
    }
  });

// ─── Task Commands ──────────────────────────────────────────────

const task = program.command('task').description('Manage scheduled tasks');

task
  .command('list')
  .description('List scheduled tasks')
  .action(async () => {
    try {
      const resp = await fetch('http://127.0.0.1:18789/api/tasks');
      const tasks = await resp.json();
      if (tasks.length === 0) {
        console.log(chalk.yellow('No scheduled tasks.'));
        return;
      }
      console.log(chalk.cyan('Scheduled Tasks:'));
      for (const t of tasks) {
        const status = t.enabled ? chalk.green('●') : chalk.gray('○');
        console.log(`  ${status} ${t.name} (${t.cron}) - ${t.prompt.slice(0, 60)}`);
      }
    } catch {
      console.error(chalk.red('Gateway not running.'));
    }
  });

program.parse();
