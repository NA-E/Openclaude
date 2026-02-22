/**
 * Browser Controller — Web automation via Puppeteer.
 *
 * OpenClaw has a dedicated Chrome/Chromium with CDP, snapshots, actions.
 * OpenClaude provides the same via Puppeteer with page snapshots,
 * navigation, form filling, and data extraction.
 */

import { logger } from '../utils/logger.js';

interface BrowserConfig {
  headless: boolean;
  executablePath?: string;
}

interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  links: { text: string; href: string }[];
}

export class BrowserController {
  private config: BrowserConfig;
  private browser: unknown = null;
  private page: unknown = null;

  constructor(config: BrowserConfig) {
    this.config = config;
  }

  async launch(): Promise<void> {
    try {
      const puppeteer = await import('puppeteer');
      this.browser = await puppeteer.default.launch({
        headless: this.config.headless,
        executablePath: this.config.executablePath || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const browser = this.browser as { newPage(): Promise<unknown> };
      this.page = await browser.newPage();
      logger.info('Browser', 'Browser launched');
    } catch (err) {
      logger.error('Browser', 'Failed to launch browser', err);
      throw err;
    }
  }

  async navigate(url: string): Promise<PageSnapshot> {
    if (!this.page) await this.launch();
    const page = this.page as {
      goto(url: string, opts?: unknown): Promise<void>;
      title(): Promise<string>;
      url(): string;
      evaluate(fn: () => unknown): Promise<unknown>;
    };

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    return this.snapshot();
  }

  async snapshot(): Promise<PageSnapshot> {
    const page = this.page as {
      title(): Promise<string>;
      url(): string;
      evaluate(fn: () => unknown): Promise<unknown>;
    };

    const title = await page.title();
    const url = page.url();

    const extracted = (await page.evaluate(() => {
      const text = document.body?.innerText?.slice(0, 10000) || '';
      const anchors = Array.from(document.querySelectorAll('a[href]')).slice(0, 50);
      const links = anchors.map((a) => ({
        text: (a as HTMLAnchorElement).innerText.trim().slice(0, 100),
        href: (a as HTMLAnchorElement).href,
      }));
      return { text, links };
    })) as { text: string; links: { text: string; href: string }[] };

    return { url, title, ...extracted };
  }

  async click(selector: string): Promise<void> {
    const page = this.page as { click(sel: string): Promise<void> };
    await page.click(selector);
  }

  async type(selector: string, text: string): Promise<void> {
    const page = this.page as { type(sel: string, text: string): Promise<void> };
    await page.type(selector, text);
  }

  async screenshot(): Promise<Buffer> {
    const page = this.page as { screenshot(opts?: unknown): Promise<Buffer> };
    return page.screenshot({ fullPage: true });
  }

  async evaluate(script: string): Promise<unknown> {
    const page = this.page as { evaluate(fn: string): Promise<unknown> };
    return page.evaluate(script);
  }

  async close(): Promise<void> {
    if (this.browser) {
      const browser = this.browser as { close(): Promise<void> };
      await browser.close();
      this.browser = null;
      this.page = null;
      logger.info('Browser', 'Browser closed');
    }
  }
}
