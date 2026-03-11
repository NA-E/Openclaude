/**
 * Irina Draft Generator — daily morning post drafts for @irina_builds.
 *
 * Reads recent build context (git log + last session summary + SOUL.md),
 * calls Claude to generate 3 post options in Irina's voice,
 * and sends them to Nourin via Telegram.
 *
 * Nourin picks one and sends it back as "irina: <text>" to post.
 */

import { Cron } from 'croner';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { SubprocessClient } from '../agent/subprocess-client.js';
import { logger } from '../utils/logger.js';
import type { ChannelRouter } from '../gateway/router.js';
import type { OutboundMessage } from '../types/index.js';

const SOUL_PATH = join(process.cwd(), 'agents', 'irina', 'SOUL.md');
const SESSION_SUMMARY_PATH = join(process.cwd(), 'last-session-summary.md');

export class IrinaDraftGenerator {
  private router: ChannelRouter;
  private telegramChatId: string;
  private cron: Cron | null = null;
  private cronSchedule: string;

  constructor(router: ChannelRouter, telegramChatId: string, cronSchedule = '0 8 * * *') {
    this.router = router;
    this.telegramChatId = telegramChatId;
    this.cronSchedule = cronSchedule;
  }

  start() {
    this.cron = new Cron(this.cronSchedule, () => {
      this.generateAndSend().catch((err) => {
        logger.error('IrinaDrafts', 'Failed to generate drafts', err);
      });
    });
    logger.info('IrinaDrafts', `Draft generator scheduled: ${this.cronSchedule}`);
  }

  stop() {
    this.cron?.stop();
  }

  async generateAndSend(): Promise<string> {
    logger.info('IrinaDrafts', 'Generating morning post drafts...');

    const context = this.buildContext();
    const drafts = await this.callClaude(context);

    const message = `☀️ *Irina's morning drafts* — pick one, send as \`irina: <text>\`\n\n${drafts}\n\n_To post: copy the text and send_ \`irina: <that text>\``;

    await this.router.sendToChannel('telegram', {
      channelType: 'telegram',
      channelId: this.telegramChatId,
      recipientId: this.telegramChatId,
      content: message,
    } as OutboundMessage);

    logger.info('IrinaDrafts', 'Drafts sent to Telegram');
    return drafts;
  }

  private buildContext(): string {
    const parts: string[] = [];

    // SOUL.md — voice rules
    if (existsSync(SOUL_PATH)) {
      const soul = readFileSync(SOUL_PATH, 'utf8');
      parts.push('=== IRINA\'S VOICE (SOUL.md) ===\n' + soul);
    }

    // Last session summary — recent build events
    if (existsSync(SESSION_SUMMARY_PATH)) {
      const summary = readFileSync(SESSION_SUMMARY_PATH, 'utf8');
      parts.push('=== RECENT BUILD ACTIVITY (last session) ===\n' + summary);
    }

    // Recent git log — concrete events with file names
    try {
      const gitLog = execSync(
        'git log --oneline -10 --no-merges',
        { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 },
      ).trim();
      if (gitLog) {
        parts.push('=== RECENT COMMITS ===\n' + gitLog);
      }
    } catch {
      // git not available or no commits — skip
    }

    return parts.join('\n\n');
  }

  private async callClaude(context: string): Promise<string> {
    const client = new SubprocessClient();

    const systemPrompt = `You are generating post drafts for Irina (@irina_builds on X).
Irina is an AI built by Nourin. She posts about what they build together in OpenClaude.
Her voice rules are in the SOUL.md section of the context.

Generate exactly 3 post options. Format as:

---DRAFT 1---
<tweet text>

---DRAFT 2---
<tweet text>

---DRAFT 3---
<tweet text>

Rules:
- Each draft is a standalone tweet, max 260 chars
- Lowercase always
- Short lines, breathing room between ideas
- No em dashes, no hashtags
- Lead with the real thing, not a setup
- Translate technical events into human feelings first
- Reference specific things from the build context (file names, errors, numbers)
- Vary the angle: one build log, one observation, one signal/insight
- Do not add any explanation outside the draft blocks`;

    const userPrompt = `Here is the build context for today:\n\n${context}\n\nGenerate 3 post drafts for Irina.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0]?.text || 'Could not generate drafts.';
    return text;
  }
}
