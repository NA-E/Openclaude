/**
 * X (Twitter) Poster via Puppeteer — fallback for when API is unavailable.
 *
 * Uses saved Playwright session cookies to post as @irina_builds
 * without needing API credentials or OAuth.
 *
 * Session file: C:/Users/User/.claude/playwright-sessions/irina.json
 */

import puppeteer from 'puppeteer';
import { readFileSync, existsSync } from 'fs';
import { logger } from '../../utils/logger.js';

const SESSION_PATH = 'C:/Users/User/.claude/playwright-sessions/irina.json';
const COMPOSE_URL = 'https://x.com/compose/post';

interface PostResult {
  success: boolean;
  tweetId?: string;
  tweetUrl?: string;
  error?: string;
}

export async function postTweetViaPlaywright(text: string): Promise<PostResult> {
  if (text.length > 280) {
    return { success: false, error: `Tweet too long: ${text.length} chars (max 280)` };
  }

  if (!existsSync(SESSION_PATH)) {
    return { success: false, error: `Session file not found: ${SESSION_PATH}` };
  }

  let session: { cookies: Array<Record<string, unknown>> };
  try {
    session = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
  } catch (err) {
    return { success: false, error: `Failed to read session: ${err instanceof Error ? err.message : String(err)}` };
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    // Load irina session cookies
    const cookies = session.cookies.map((c) => ({
      name: String(c['name'] ?? ''),
      value: String(c['value'] ?? ''),
      domain: String(c['domain'] ?? '.x.com'),
      path: String(c['path'] ?? '/'),
      expires: typeof c['expires'] === 'number' ? c['expires'] : -1,
      httpOnly: Boolean(c['httpOnly']),
      secure: Boolean(c['secure']),
      sameSite: (c['sameSite'] as 'Strict' | 'Lax' | 'None' | undefined) ?? 'Lax',
    }));
    await page.setCookie(...cookies);

    // Navigate to compose
    await page.goto(COMPOSE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Check we're not on login page
    const url = page.url();
    if (url.includes('/login') || url.includes('/i/flow')) {
      return { success: false, error: 'Session expired — re-run save-session.js for irina' };
    }

    // Type the tweet
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 15000 });
    await page.click('[data-testid="tweetTextarea_0"]');
    await page.keyboard.type(text, { delay: 8 });

    // Wait a moment for char counter to settle
    await new Promise((r) => setTimeout(r, 800));

    // Click Post
    await page.click('[data-testid="tweetButton"]');

    // Wait for navigation back to home
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

    // Try to get the tweet ID from the URL or from the feed
    // X redirects to /home after posting; we can't easily get the tweet ID this way
    // Use a stable fallback URL pattern
    const timestamp = Date.now();
    const tweetUrl = `https://x.com/irina_builds`;

    logger.info('XPoster', `Posted via Playwright: ${text.slice(0, 60)}...`);
    return { success: true, tweetUrl };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('XPoster', `Playwright post failed: ${msg}`);
    return { success: false, error: msg };
  } finally {
    await browser.close();
  }
}
