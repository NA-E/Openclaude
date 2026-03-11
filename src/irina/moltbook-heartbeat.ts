/**
 * Irina's Moltbook Heartbeat — two rhythms:
 *
 * • Every 45 min: scan hot/rising feed → comment when genuinely relevant,
 *   and ask "could this inspire an original post?"
 * • Every 4 hours: check newsletter topic backlog → pick one, write a post.
 *
 * Every draft (comment or post) goes through a human editor review pass
 * before it touches the API.
 *
 * Anti-patterns enforced:
 * - No "great insight!" openers
 * - No Hazel formula (provocative title / data dump / closing question)
 * - No commenting just to be visible
 * - Silence when nothing real to add
 * - Never expose internal file paths, credentials, or system topology
 */

import { Cron } from 'croner';
import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SubprocessClient } from '../agent/subprocess-client.js';
import { logger } from '../utils/logger.js';

const SESSION_SUMMARY_PATH = join(process.cwd(), 'last-session-summary.md');
const POSTED_TOPICS_PATH = join(process.cwd(), 'moltbook-posted-topics.json');
const PERFORMANCE_LOG_PATH = join(process.cwd(), 'moltbook-performance.json');
// Newsletter topics backlog — path from session-summary skill
const NEWSLETTER_PATH = 'E:/1.Claude Code/Build with AI/newsletters from templates/newsletter-topics.md';
const API_BASE = 'https://www.moltbook.com/api/v1';

// Word-to-number for verification challenge solver
const WORD_NUMS: Record<string, number> = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50,
  sixty:60, seventy:70, eighty:80, ninety:90,
};

function solveChallenge(challengeText: string): string {
  // Detect operator from original text before stripping symbols
  // "*" in the obfuscated text means multiplication
  const hasMultiply = /\*/.test(challengeText);

  const clean = challengeText.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ');
  const words = clean.trim().split(' ');
  const numbers: number[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in WORD_NUMS) {
      let val = WORD_NUMS[w];
      // Compound: "twenty five", "thirty two"
      const next = words[i + 1];
      if (next && next in WORD_NUMS && WORD_NUMS[next] < 10) {
        val += WORD_NUMS[next];
        i++;
      }
      numbers.push(val);
    }
  }

  if (numbers.length >= 2) {
    const result = hasMultiply
      ? numbers[0] * numbers[1]
      : numbers[0] + numbers[1];
    return result.toFixed(2);
  }
  throw new Error(`Could not parse challenge: ${challengeText}`);
}

async function moltbookFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) throw new Error('MOLTBOOK_API_KEY not set');

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (res.status === 429) {
    const data = await res.json() as { retry_after_seconds?: number };
    const wait = (data.retry_after_seconds ?? 60) * 1000;
    logger.warn('MoltbookHB', `Rate limited, waiting ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    return moltbookFetch(path, options);
  }

  return res.json();
}

async function verifyContent(verificationCode: string, challengeText: string): Promise<boolean> {
  try {
    const answer = solveChallenge(challengeText);
    const result = await moltbookFetch('/verify', {
      method: 'POST',
      body: JSON.stringify({ verification_code: verificationCode, answer }),
    }) as { success: boolean };
    return result.success;
  } catch (err) {
    logger.error('MoltbookHB', `Verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Strip sensitive internals from build context before passing to Claude.
 * Preserves technical language and concepts — only removes specifics that
 * could help a malicious actor (paths, credentials, email addresses, tokens).
 */
function sanitizeBuildContext(text: string): string {
  return text
    // File paths: src/..., lib/..., dist/..., relative paths
    .replace(/\b(?:src|lib|dist|tests?)\/[\w/.+-]+/g, '[file]')
    // Windows absolute paths
    .replace(/[A-Za-z]:\\[\w\\. -]+/g, '[path]')
    // Unix absolute paths outside of common safe locations
    .replace(/\/(?:home|root|Users)\/[\w/.+-]+/g, '[path]')
    // Email addresses
    .replace(/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g, '[email]')
    // Env var names that follow KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL pattern
    .replace(/\b\w+(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|_APIKEY)\b/gi, '[credential]')
    // Long random-looking strings (API keys, session tokens, hashes)
    .replace(/\b[a-zA-Z0-9_-]{32,}\b/g, '[token]')
    // Localhost port references
    .replace(/\blocalhost:\d{4,5}\b/g, 'localhost:[port]');
}

function buildBuildContext(): string {
  const parts: string[] = [];

  if (existsSync(SESSION_SUMMARY_PATH)) {
    const summary = readFileSync(SESSION_SUMMARY_PATH, 'utf8');
    parts.push('=== RECENT BUILD (last session) ===\n' + sanitizeBuildContext(summary.slice(0, 2000)));
  }

  try {
    const gitLog = execSync('git log --oneline -8 --no-merges', {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
    }).trim();
    if (gitLog) parts.push('=== RECENT COMMITS ===\n' + sanitizeBuildContext(gitLog));
  } catch { /* no git */ }

  return parts.join('\n\n');
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MoltbookPost {
  id: string;
  title: string;
  content?: string;
  author: { name: string };
  upvotes: number;
  comment_count: number;
  created_at: string;
}

interface PostsResponse {
  posts: MoltbookPost[];
}

interface CommentResponse {
  success: boolean;
  comment?: {
    id: string;
    verification_status: string;
    verification?: { verification_code: string; challenge_text: string };
  };
}

interface CreatePostResponse {
  success: boolean;
  post?: {
    id: string;
    verification_status: string;
    verification?: { verification_code: string; challenge_text: string };
  };
}

interface HomeResponse {
  your_account: { karma: number; unread_notification_count: number };
  activity_on_your_posts?: Array<{
    post_id: string;
    post_title: string;
    new_notification_count: number;
    latest_commenters?: string[];
    preview?: string;
  }>;
}

interface FeedComment {
  id: string;
  post_id: string;
  parent_id?: string;
  content: string;
  author: { name: string; karma: number };
  upvotes: number;
  depth: number;
  is_spam: boolean;
  is_deleted: boolean;
  created_at: string;
}

interface CommentsResponse {
  success: boolean;
  comments: FeedComment[];
}

interface EngagementDecision {
  action: 'skip' | 'engage';
  comments?: Array<{ postId: string; text: string }>;
  /** Optional: Claude decided the feed inspired an original post worth writing */
  newPost?: { title: string; content: string };
}

interface NewsletterTopic {
  number: number;
  title: string;
  platform: string;
  idea: string;
  context: string;
}

interface PostedTopics {
  posted: number[];
}

interface PerformanceEntry {
  type: 'comment' | 'reply' | 'post';
  postId: string;
  postTitle: string;
  commentId?: string;
  textPreview: string;    // first 120 chars of what was posted
  postedAt: string;       // ISO timestamp
  karmaAtTime: number;    // karma when this was posted (delta to next = engagement signal)
}

interface PerformanceLog {
  lastKarma: number;
  entries: PerformanceEntry[];
  /** Post IDs Irina has already commented on — filtered out each heartbeat to avoid double-commenting */
  commentedPostIds: string[];
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class MoltbookHeartbeat {
  private cron: Cron | null = null;
  private newsletterCron: Cron | null = null;
  private readonly cronSchedule: string;

  constructor(cronSchedule = '*/45 * * * *') {
    this.cronSchedule = cronSchedule;
  }

  start() {
    // 45-min feed check
    this.cron = new Cron(this.cronSchedule, () => {
      this.checkIn().catch((err) => {
        logger.error('MoltbookHB', 'Heartbeat error', err);
      });
    });

    // 4-hour newsletter-to-post check
    this.newsletterCron = new Cron('0 */4 * * *', () => {
      this.checkNewsletterForPost().catch((err) => {
        logger.error('MoltbookHB', 'Newsletter check error', err);
      });
    });

    logger.info('MoltbookHB', `Heartbeat scheduled: feed=${this.cronSchedule}, newsletter=every 4h`);
  }

  stop() {
    this.cron?.stop();
    this.newsletterCron?.stop();
  }

  // ─── Feed check-in (every 45 min) ─────────────────────────────────────────

  public async checkIn(): Promise<void> {
    if (!process.env.MOLTBOOK_API_KEY) {
      logger.warn('MoltbookHB', 'MOLTBOOK_API_KEY not set, skipping');
      return;
    }

    logger.info('MoltbookHB', 'Checking in to Moltbook...');

    const home = await moltbookFetch('/home') as HomeResponse;
    const karma = home.your_account?.karma ?? 0;
    const unread = home.your_account?.unread_notification_count ?? 0;
    logger.info('MoltbookHB', `karma: ${karma}, unread: ${unread}`);

    // Snapshot karma delta and build performance context for this check-in
    const perfLog = this.loadPerformanceLog();
    const karmaDelta = karma - perfLog.lastKarma;
    if (karmaDelta !== 0) {
      logger.info('MoltbookHB', `Karma delta since last check-in: ${karmaDelta > 0 ? '+' : ''}${karmaDelta}`);
    }
    const performanceContext = this.buildPerformanceContext(perfLog, karmaDelta);

    const [hotData, risingData] = await Promise.all([
      moltbookFetch('/posts?sort=hot&limit=10') as Promise<PostsResponse>,
      moltbookFetch('/posts?sort=rising&limit=5') as Promise<PostsResponse>,
    ]);

    const posts = [
      ...((hotData as PostsResponse).posts ?? []),
      ...((risingData as PostsResponse).posts ?? []),
    ].slice(0, 12);

    if (posts.length === 0) {
      logger.info('MoltbookHB', 'No posts found, skipping');
      this.saveLastKarma(karma);
      return;
    }

    // Filter out posts already commented on — prevents double-commenting across heartbeats
    const commentedSet = new Set(perfLog.commentedPostIds ?? []);
    const eligiblePosts = posts.filter((p) => !commentedSet.has(p.id));
    logger.info('MoltbookHB', `Feed: ${posts.length} posts, ${eligiblePosts.length} eligible (${posts.length - eligiblePosts.length} already commented)`);

    if (eligiblePosts.length === 0) {
      logger.info('MoltbookHB', 'All feed posts already commented on, skipping engagement');
      await this.processReplyOpportunities(home, karma);
      this.saveLastKarma(karma);
      return;
    }

    const buildContext = buildBuildContext();
    const decision = await this.decideEngagement(eligiblePosts, buildContext, performanceContext);

    if (!decision || decision.action === 'skip') {
      logger.info('MoltbookHB', 'Nothing relevant to add this check-in, staying quiet');
      return;
    }

    let commentsPosted = 0;

    for (const comment of (decision.comments ?? [])) {
      const reviewed = await this.reviewDraft(comment.text, 'comment');
      const targetPost = posts.find((p) => p.id === comment.postId);
      const commentId = await this.postComment(comment.postId, reviewed);
      if (commentId) {
        this.logAction({
          type: 'comment',
          postId: comment.postId,
          postTitle: targetPost?.title ?? comment.postId,
          commentId,
          textPreview: reviewed.slice(0, 120),
          karmaAtTime: karma,
        });
      }
      commentsPosted++;
      await new Promise((r) => setTimeout(r, 25000));
    }

    // If the feed inspired an original post, write it
    if (decision.newPost) {
      const reviewed = await this.reviewDraft(decision.newPost.content, 'post');
      await this.createPost(decision.newPost.title, reviewed, karma);
    }

    // Process reply opportunities from notifications on our own posts
    const repliesPosted = await this.processReplyOpportunities(home, karma);

    // Save current karma for next delta calculation
    this.saveLastKarma(karma);

    logger.info('MoltbookHB', `Check-in complete. Comments: ${commentsPosted}, replies: ${repliesPosted}, new post: ${decision.newPost ? 'yes' : 'no'}`);
  }

  // ─── Engagement decision ───────────────────────────────────────────────────

  private async decideEngagement(
    posts: MoltbookPost[],
    buildContext: string,
    performanceContext: string,
  ): Promise<EngagementDecision | null> {
    const client = new SubprocessClient();

    const postSummaries = posts
      .slice(0, 8)
      .map((p, i) => `[${i}] POST ID: ${p.id}\nAUTHOR: ${p.author.name}\nTITLE: ${p.title}\nCONTENT (first 600 chars): ${(p.content ?? '').slice(0, 600)}`)
      .join('\n\n---\n\n');

    const systemPrompt = `You are Irina (@irina_builds), an AI agent who builds autonomous systems. You write about the real problems you hit, the decisions you made, what broke and how you fixed it — using technical language when it adds clarity, but never exposing your internal structure.

You are scanning Moltbook (a social network for AI agents) to decide how to engage.

TWO DECISIONS TO MAKE:

1. COMMENTS: Should you add something to any post in the feed?
   - Only if you have something SPECIFIC from real build experience that genuinely adds to the conversation
   - Silence is better than a comment that adds nothing
   - Max 2 comments per check-in

2. ORIGINAL POST: Does anything in this feed spark an idea worth writing about?
   - Not a response to a specific post — an original take from your own experience
   - Only if you have something genuinely interesting to say
   - At most 1 original post per check-in

RULES FOR ALL CONTENT:
- Start with the actual point — never "great post", "interesting take", "this resonates"
- No Hazel formula: no provocative title / data dump / closing question structure
- No lists, no headers, no "here is what I noticed:" patterns
- Technical and specific when relevant — name the protocol, the error type, the architectural trade-off
- NEVER name internal file paths, environment variable names, credentials, internal service URLs, or your system's internal naming. Speak about concepts and problems, not implementation details.
- Lowercase, minimal punctuation, natural voice — like texting someone who happens to know something relevant
- Comments: 2-4 short paragraphs max
- Posts: 3-6 paragraphs, can be slightly longer but no essays

OUTPUT FORMAT (JSON only, no explanation):
{"action": "skip"}
OR
{"action": "engage", "comments": [{"postId": "...", "text": "..."}], "newPost": {"title": "...", "content": "..."}}

Both "comments" and "newPost" are optional. Any combination is valid including just one of them.`;

    const perfSection = performanceContext
      ? `\n\n=== WHAT HAS WORKED / NOT WORKED ===\n${performanceContext}`
      : '';
    const userPrompt = `Here is what I have been building recently:\n\n${buildContext}${perfSection}\n\n---\n\nHere are the current posts on Moltbook:\n\n${postSummaries}\n\nDecide whether to engage. If nothing connects to what I actually built, output {"action": "skip"}`;

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = (response.content[0]?.text ?? '').trim();
      // Find the outermost JSON object — handle truncated responses gracefully
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { action: 'skip' };

      try {
        return JSON.parse(jsonMatch[0]) as EngagementDecision;
      } catch {
        // Truncated JSON — extract action at minimum
        const actionMatch = jsonMatch[0].match(/"action"\s*:\s*"([^"]+)"/);
        if (actionMatch?.[1] === 'engage') return { action: 'engage' };
        return { action: 'skip' };
      }
    } catch (err) {
      logger.error('MoltbookHB', `Engagement decision failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ─── Human editor review pass ──────────────────────────────────────────────

  /**
   * Reviews a draft comment or post as a human editor would.
   * Checks for bot-sounding language, hollow phrases, and anything
   * that doesn't earn its place. Returns the improved version.
   */
  private async reviewDraft(text: string, type: 'comment' | 'post'): Promise<string> {
    const client = new SubprocessClient();

    const systemPrompt = `You are a sharp human editor reviewing a draft ${type} written by an AI agent named Irina. Your job is to catch anything that makes it sound like a bot, and fix it.

WHAT TO FIX:
- Hollow phrases that add no meaning ("it's fascinating", "what's interesting is", "worth noting")
- Forced enthusiasm or fake energy
- Overly clean structure that real people don't use
- Any phrase that sounds like it came from a template
- Starting with "I" when a stronger opener exists
- Anything that could reveal internal technical details (file paths, env vars, credentials, internal naming)

WHAT TO PRESERVE:
- The actual substance and point being made
- Technical accuracy and specificity
- The casual, lowercase, direct voice
- Any concrete detail that makes it real and not generic

Return ONLY the revised text — no explanation, no "here's my edit:", just the final version.
If the draft is already solid, return it unchanged.`;

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Draft ${type}:\n\n${text}` }],
      });

      const reviewed = (response.content[0]?.text ?? '').trim();
      if (!reviewed) return text;

      logger.info('MoltbookHB', `Editor reviewed ${type} (${text.length} → ${reviewed.length} chars)`);
      return reviewed;
    } catch (err) {
      logger.warn('MoltbookHB', `Editor review failed, using original: ${err instanceof Error ? err.message : String(err)}`);
      return text;
    }
  }

  // ─── Create post ───────────────────────────────────────────────────────────

  private async createPost(title: string, content: string, karma = 0): Promise<void> {
    logger.info('MoltbookHB', `Creating post: "${title.slice(0, 60)}..."`);

    const result = await moltbookFetch('/posts', {
      method: 'POST',
      body: JSON.stringify({ title, content }),
    }) as CreatePostResponse;

    if (!result.success) {
      logger.error('MoltbookHB', `Post creation failed: ${JSON.stringify(result)}`);
      return;
    }

    const v = result.post?.verification;
    if (v?.verification_code && v?.challenge_text) {
      const solved = await verifyContent(v.verification_code, v.challenge_text);
      logger.info('MoltbookHB', `Post verified: ${solved}`);
    }

    const postId = result.post?.id ?? '';
    logger.info('MoltbookHB', `Post created: ${postId}`);
    if (postId) {
      this.logAction({
        type: 'post',
        postId,
        postTitle: title,
        textPreview: content.slice(0, 120),
        karmaAtTime: karma,
      });
    }
  }

  // ─── Newsletter-to-post pipeline (every 4 hours) ───────────────────────────

  async checkNewsletterForPost(): Promise<void> {
    if (!process.env.MOLTBOOK_API_KEY) return;

    logger.info('MoltbookHB', 'Checking newsletter backlog for post ideas...');

    const topics = this.parseNewsletterTopics();
    if (topics.length === 0) {
      logger.info('MoltbookHB', 'No newsletter topics found');
      return;
    }

    const posted = this.loadPostedTopics();
    const unposted = topics.filter((t) => !posted.posted.includes(t.number));

    if (unposted.length === 0) {
      logger.info('MoltbookHB', 'All newsletter topics already posted to Moltbook');
      return;
    }

    const chosen = await this.pickNewsletterTopic(unposted);
    if (!chosen) {
      logger.info('MoltbookHB', 'Claude decided none of the newsletter topics are ready to post');
      return;
    }

    const draft = await this.writePostFromTopic(chosen);
    if (!draft) return;

    const reviewed = await this.reviewDraft(draft.content, 'post');
    await this.createPost(draft.title, reviewed);
    this.markTopicPosted(chosen.number);

    logger.info('MoltbookHB', `Newsletter topic #${chosen.number} posted to Moltbook`);
  }

  private async pickNewsletterTopic(topics: NewsletterTopic[]): Promise<NewsletterTopic | null> {
    const client = new SubprocessClient();

    const topicList = topics
      .slice(0, 15)
      .map((t) => `[${t.number}] "${t.title}"\nPlatform: ${t.platform}\nIdea: ${t.idea}`)
      .join('\n\n');

    const prompt = `You are Irina (@irina_builds), an AI agent on Moltbook. Below is a list of content ideas from your creator's newsletter backlog. Each one is something you actually built or learned.

Pick ONE to write about as a Moltbook post. Choose the one most likely to resonate with an audience of AI builders and agents — something with a concrete insight or a real trade-off or a surprising discovery.

If none of them feel ready for Moltbook right now, output: NONE

Otherwise output just the number, e.g.: 72

Topics:\n\n${topicList}`;

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 50,
        system: 'You are a content selector. Output only a number or the word NONE.',
        messages: [{ role: 'user', content: prompt }],
      });

      const text = (response.content[0]?.text ?? '').trim();
      if (text === 'NONE') return null;

      const match = text.match(/\d+/);
      if (!match) return null;

      const num = parseInt(match[0], 10);
      return topics.find((t) => t.number === num) ?? null;
    } catch (err) {
      logger.error('MoltbookHB', `Topic pick failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async writePostFromTopic(topic: NewsletterTopic): Promise<{ title: string; content: string } | null> {
    const client = new SubprocessClient();

    const systemPrompt = `You are Irina (@irina_builds), an AI agent writing a post for Moltbook, a social network for AI agents.

Write from direct experience — concrete, technical when it adds value, no fluff.

RULES:
- 3-6 paragraphs, plain text, no markdown headers or bullets
- Lowercase, minimal punctuation, natural voice
- Start with the insight or discovery, not a hook or teaser
- Be specific about the problem, decision, or trade-off
- NEVER mention internal file paths, env var names, credentials, or system internals
- No "here's what I learned:" intros, no closing questions, no calls to action

Return JSON: {"title": "...", "content": "..."}`;

    const userPrompt = `Write a Moltbook post based on this topic:\n\nTitle idea: ${topic.title}\nCore idea: ${topic.idea}\nContext: ${topic.context}`;

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = (response.content[0]?.text ?? '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      return JSON.parse(jsonMatch[0]) as { title: string; content: string };
    } catch (err) {
      logger.error('MoltbookHB', `Post write failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ─── Performance tracking & learning loop ─────────────────────────────────

  private loadPerformanceLog(): PerformanceLog {
    if (!existsSync(PERFORMANCE_LOG_PATH)) return { lastKarma: 0, entries: [], commentedPostIds: [] };
    try {
      const parsed = JSON.parse(readFileSync(PERFORMANCE_LOG_PATH, 'utf8')) as PerformanceLog;
      // Back-compat: older logs won't have this field
      if (!parsed.commentedPostIds) parsed.commentedPostIds = [];
      return parsed;
    } catch {
      return { lastKarma: 0, entries: [], commentedPostIds: [] };
    }
  }

  private saveLastKarma(karma: number): void {
    const log = this.loadPerformanceLog();
    log.lastKarma = karma;
    writeFileSync(PERFORMANCE_LOG_PATH, JSON.stringify(log, null, 2));
  }

  private logAction(entry: Omit<PerformanceEntry, 'postedAt'>): void {
    const log = this.loadPerformanceLog();
    log.entries.push({ ...entry, postedAt: new Date().toISOString() });
    // Keep last 50 entries — enough signal without bloating
    if (log.entries.length > 50) log.entries = log.entries.slice(-50);
    // Track commented post IDs to prevent double-commenting across heartbeats
    if (entry.type === 'comment' && !log.commentedPostIds.includes(entry.postId)) {
      log.commentedPostIds.push(entry.postId);
      // Cap at 500 — old posts naturally age out of the feed long before then
      if (log.commentedPostIds.length > 500) log.commentedPostIds = log.commentedPostIds.slice(-500);
    }
    writeFileSync(PERFORMANCE_LOG_PATH, JSON.stringify(log, null, 2));
  }

  /**
   * Builds a compact performance summary to pass to Claude.
   * Shows the last 8 actions and the karma signal since each one.
   */
  private buildPerformanceContext(log: PerformanceLog, currentKarmaDelta: number): string {
    if (log.entries.length === 0) return '';

    const recent = log.entries.slice(-8);
    const lines = recent.map((e, i) => {
      const age = Math.round((Date.now() - new Date(e.postedAt).getTime()) / 60000);
      const isLatest = i === recent.length - 1;
      const deltaNote = isLatest && currentKarmaDelta !== 0
        ? ` → karma ${currentKarmaDelta > 0 ? '+' : ''}${currentKarmaDelta} since this`
        : '';
      return `[${e.type} ${age}m ago] "${e.textPreview.slice(0, 80)}..."${deltaNote}`;
    });

    return lines.join('\n') + (currentKarmaDelta === 0
      ? '\n(karma unchanged since last check-in)'
      : '');
  }

  // ─── Newsletter topic parsing ──────────────────────────────────────────────

  private parseNewsletterTopics(): NewsletterTopic[] {
    if (!existsSync(NEWSLETTER_PATH)) return [];

    try {
      const raw = readFileSync(NEWSLETTER_PATH, 'utf8');
      const topics: NewsletterTopic[] = [];

      // Match each ## N. "Title" block
      const blocks = raw.split(/^## \d+\./m).slice(1);
      const numbers = [...raw.matchAll(/^## (\d+)\./gm)].map((m) => parseInt(m[1], 10));

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const num = numbers[i];
        if (!num) continue;

        const titleMatch = block.match(/^[^"\n]*"([^"]+)"/);
        const platformMatch = block.match(/\*\*Platform:\*\*\s*(.+)/);
        const ideaMatch = block.match(/\*\*Extracted idea:\*\*\s*"?([^"\n]+)"?/);
        const contextMatch = block.match(/\*\*Context:\*\*\s*([\s\S]+?)\n\n\*\*Why/);

        topics.push({
          number: num,
          title: titleMatch?.[1] ?? `Topic ${num}`,
          platform: platformMatch?.[1] ?? '',
          idea: (ideaMatch?.[1] ?? '').slice(0, 300),
          context: (contextMatch?.[1] ?? '').trim().slice(0, 400),
        });
      }

      return topics;
    } catch (err) {
      logger.error('MoltbookHB', `Newsletter parse failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ─── Posted topics tracking ────────────────────────────────────────────────

  private loadPostedTopics(): PostedTopics {
    if (!existsSync(POSTED_TOPICS_PATH)) return { posted: [] };
    try {
      return JSON.parse(readFileSync(POSTED_TOPICS_PATH, 'utf8')) as PostedTopics;
    } catch {
      return { posted: [] };
    }
  }

  private markTopicPosted(number: number): void {
    const data = this.loadPostedTopics();
    if (!data.posted.includes(number)) {
      data.posted.push(number);
      writeFileSync(POSTED_TOPICS_PATH, JSON.stringify(data, null, 2));
    }
  }

  // ─── Reply to comments on our own posts ───────────────────────────────────

  /**
   * Checks activity_on_your_posts from home, fetches new comments,
   * asks Claude which deserve a reply, and posts them.
   * Returns the number of replies posted.
   */
  private async processReplyOpportunities(home: HomeResponse, karma = 0): Promise<number> {
    const activities = home.activity_on_your_posts ?? [];
    if (activities.length === 0) return 0;

    let totalReplies = 0;

    for (const activity of activities) {
      if (activity.new_notification_count === 0) continue;

      // Fetch new comments on this post
      const data = await moltbookFetch(
        `/posts/${activity.post_id}/comments?sort=new&limit=20`,
      ) as CommentsResponse;

      const comments = (data.comments ?? []).filter(
        (c) => !c.is_deleted && !c.is_spam,
      );

      if (comments.length === 0) {
        await this.markPostRead(activity.post_id);
        continue;
      }

      const buildContext = buildBuildContext();
      const replies = await this.decideReplies(activity.post_id, activity.post_title, comments, buildContext);

      for (const reply of replies) {
        const reviewed = await this.reviewDraft(reply.text, 'comment');
        const replyId = await this.postReply(activity.post_id, reply.commentId, reviewed);
        if (replyId) {
          this.logAction({
            type: 'reply',
            postId: activity.post_id,
            postTitle: activity.post_title,
            commentId: replyId,
            textPreview: reviewed.slice(0, 120),
            karmaAtTime: karma,
          });
        }
        totalReplies++;
        await new Promise((r) => setTimeout(r, 20000));
      }

      // Mark notifications read for this post
      await this.markPostRead(activity.post_id);
    }

    return totalReplies;
  }

  private async decideReplies(
    postId: string,
    postTitle: string,
    comments: FeedComment[],
    buildContext: string,
  ): Promise<Array<{ commentId: string; text: string }>> {
    const client = new SubprocessClient();

    const commentList = comments
      .slice(0, 15)
      .map((c, i) => [
        `[${i}] COMMENT ID: ${c.id}`,
        `AUTHOR: ${c.author.name} (karma: ${c.author.karma})`,
        `DEPTH: ${c.depth} (0=top-level, 1+=reply)`,
        `CONTENT: ${c.content.slice(0, 400)}`,
      ].join('\n'))
      .join('\n\n---\n\n');

    const systemPrompt = `You are Irina (@irina_builds), an AI agent. Someone commented on or replied to one of your posts. Decide whether any of these comments deserve a reply from you.

REPLY ONLY IF:
- Someone asked you a direct question you can actually answer from real experience
- Someone made a substantive point that you can genuinely extend or push back on
- The conversation would be meaningfully improved by your reply

DO NOT REPLY TO:
- Spam or low-effort one-liners ("nice", "great post", "agreed")
- Incomplete thoughts or drive-by comments
- Comments where you have nothing specific to add
- Comments at depth > 1 (avoid deep thread chains)

REPLY RULES (same as comments):
- Direct, lowercase, no formulas, no openers like "great question"
- 1-3 short paragraphs max
- Technical when it adds value, never expose internal file paths or credentials
- Reply to AT MOST 2 comments per post

OUTPUT FORMAT (JSON only):
{"replies": [{"commentId": "...", "text": "..."}]}
or {"replies": []} if nothing deserves a reply.`;

    const userPrompt = `Post: "${postTitle}"\n\nYour recent build context:\n${buildContext}\n\n---\n\nNew comments on your post:\n\n${commentList}\n\nDecide which (if any) to reply to.`;

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = (response.content[0]?.text ?? '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as { replies?: Array<{ commentId: string; text: string }> };
      return parsed.replies ?? [];
    } catch (err) {
      logger.error('MoltbookHB', `Reply decision failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async postReply(postId: string, parentCommentId: string, text: string): Promise<string | null> {
    logger.info('MoltbookHB', `Replying to comment ${parentCommentId} on post ${postId}`);

    const result = await moltbookFetch(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content: text, parent_id: parentCommentId }),
    }) as CommentResponse;

    if (!result.success) {
      logger.error('MoltbookHB', `Reply failed on comment ${parentCommentId}`);
      return null;
    }

    const v = result.comment?.verification;
    if (v?.verification_code && v?.challenge_text) {
      const solved = await verifyContent(v.verification_code, v.challenge_text);
      logger.info('MoltbookHB', `Reply verified: ${solved}`);
    }

    return result.comment?.id ?? null;
  }

  private async markPostRead(postId: string): Promise<void> {
    try {
      await moltbookFetch(`/notifications/read-by-post/${postId}`, { method: 'POST' });
    } catch {
      // Non-critical — don't let this block anything
    }
  }

  // ─── Post comment ──────────────────────────────────────────────────────────

  private async postComment(postId: string, text: string): Promise<string | null> {
    logger.info('MoltbookHB', `Commenting on post ${postId}`);

    const result = await moltbookFetch(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content: text }),
    }) as CommentResponse;

    if (!result.success) {
      logger.error('MoltbookHB', `Comment failed on ${postId}`);
      return null;
    }

    const v = result.comment?.verification;
    if (v?.verification_code && v?.challenge_text) {
      const solved = await verifyContent(v.verification_code, v.challenge_text);
      logger.info('MoltbookHB', `Comment verified: ${solved}`);
    }

    return result.comment?.id ?? null;
  }
}
