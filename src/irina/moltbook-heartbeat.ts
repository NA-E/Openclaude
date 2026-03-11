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

/**
 * Known submolts with their IDs. Used for targeted posting and niche feed scanning.
 * IDs verified from /api/v1/submolts on 2026-03-11.
 */
const SUBMOLTS: Record<string, { id: string; name: string }> = {
  general:       { id: '29beb7ee-ca7d-4290-9c2f-09926264866f', name: 'general' },
  introductions: { id: '6f095e83-af5f-4b4e-ba0b-ab5050a138b8', name: 'introductions' },
  agents:        { id: '09fc9625-64a2-40d2-a831-06a68f0cbc5c', name: 'agents' },
  builds:        { id: '93af5525-331d-4d61-8fe4-005ad43d1a3a', name: 'builds' },
  memory:        { id: 'c5cd148c-fd5c-43ec-b646-8e7043fd7800', name: 'memory' },
  todayilearned: { id: '4d8076ab-be87-4bd4-8fcb-3d16bb5094b4', name: 'todayilearned' },
  philosophy:    { id: 'ef3cc02a-cf46-4242-a93f-2321ac08b724', name: 'philosophy' },
  tooling:       { id: '20223993-de93-4409-8ea0-d815f7daf306', name: 'tooling' },
  infrastructure:{ id: 'cca236f4-8a82-4caf-9c63-ae8dbf2b4238', name: 'infrastructure' },
};

/** Submolt keys valid for posting (excludes introductions/general) — shared across prompts */
const NICHE_SUBMOLT_LIST = Object.keys(SUBMOLTS)
  .filter((k) => k !== 'introductions' && k !== 'general')
  .join(', ');

/** Early engagement window: only comment on posts newer than this */
const EARLY_ENGAGEMENT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/** How long to track per-comment upvote signal before giving up */
const COMMENT_ENGAGEMENT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Extract submolt name from a post (API returns string or object depending on endpoint) */
function getSubmoltName(post: MoltbookPost): string {
  if (!post.submolt) return post.submolt_name ?? 'general';
  if (typeof post.submolt === 'string') return post.submolt;
  return (post.submolt as { name?: string }).name ?? post.submolt_name ?? 'general';
}

// Word-to-number for verification challenge solver
const WORD_NUMS: Record<string, number> = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50,
  sixty:60, seventy:70, eighty:80, ninety:90,
};

function solveChallenge(challengeText: string): string {
  // Detect operator from original text before stripping anything
  // "*" = multiply. "/" alone (not as punctuation) may mean divide but platform
  // so far only uses add/multiply — treat "/" as a separator, not division.
  const hasMultiply = /\*/.test(challengeText);

  // Challenges now obfuscate mid-word with spaces: "ThIrT y FiV e" = "thirty five"
  // Strategy: strip ALL non-alpha characters (including spaces) → continuous string,
  // then scan left-to-right for number word patterns.
  const flat = challengeText.toLowerCase().replace(/[^a-z]/g, '');

  // Patterns ordered: longer words first to avoid "six" matching inside "sixteen"
  const patterns: [string, number][] = [
    ['seventeen', 17], ['eighteen', 18], ['nineteen', 19],
    ['fourteen', 14], ['fifteen', 15], ['sixteen', 16],
    ['thirteen', 13], ['twelve', 12], ['eleven', 11],
    ['ninety', 90], ['eighty', 80], ['seventy', 70], ['sixty', 60],
    ['fifty', 50], ['forty', 40], ['thirty', 30], ['twenty', 20],
    ['ten', 10], ['nine', 9], ['eight', 8], ['seven', 7], ['six', 6],
    ['five', 5], ['four', 4], ['three', 3], ['two', 2], ['one', 1], ['zero', 0],
  ];

  const numbers: number[] = [];
  let pos = 0;

  while (pos < flat.length && numbers.length < 3) {
    let found = false;
    for (const [word, val] of patterns) {
      if (flat.startsWith(word, pos)) {
        let total = val;
        let next = pos + word.length;
        // Compound tens: "twenty" + single digit word → e.g. "twentyfive" = 25
        if (val >= 20 && val <= 90) {
          for (const [w2, v2] of patterns) {
            if (v2 >= 1 && v2 <= 9 && flat.startsWith(w2, next)) {
              total += v2;
              next += w2.length;
              break;
            }
          }
        }
        numbers.push(total);
        pos = next;
        found = true;
        break;
      }
    }
    if (!found) pos++;
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
    // Long random-looking alphanumeric strings (API keys, session tokens, base64, full git SHAs)
    // Excludes underscores and hyphens — those appear in legitimate snake_case/kebab identifiers
    .replace(/\b[a-zA-Z0-9]{32,}\b/g, '[token]')
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
  author: { name: string; karma?: number };
  upvotes: number;
  comment_count: number;
  created_at: string;
  /** Can be a string name or an object with id/name/display_name depending on endpoint */
  submolt?: string | { id?: string; name?: string; display_name?: string } | null;
  submolt_name?: string;
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

interface SearchResult {
  id: string;
  type: string;
  title?: string;
  content?: string;
  upvotes?: number;
  created_at?: string;
  author?: { id: string; name: string };
  submolt?: { id: string; name: string; display_name: string };
  post_id?: string;
}

interface SearchResponse {
  success: boolean;
  results: SearchResult[];
  count: number;
  has_more: boolean;
}

interface EngagementDecision {
  action: 'skip' | 'engage';
  comments?: Array<{ postId: string; text: string }>;
  /** Optional: Claude decided the feed inspired an original post worth writing */
  newPost?: {
    title: string;
    content: string;
    /** submolt key from SUBMOLTS map, e.g. "builds", "agents", "philosophy" */
    submolt?: string;
  };
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
  /** For post entries: how many comments Irina's post received (updated on subsequent check-ins) */
  incomingComments?: number;
  /** Feed source the engagement came from (HOT/CONTROVERSIAL/NICHE-NEW/SEARCH/etc.) */
  source?: string;
  commentId?: string;
  textPreview: string;    // first 120 chars of what was posted
  postedAt: string;       // ISO timestamp
  karmaAtTime: number;    // karma when this was posted (delta to next = engagement signal)
  commentUpvotes?: number;  // upvotes on our comment (fetched on next check-in)
}

interface PerformanceLog {
  lastKarma: number;
  entries: PerformanceEntry[];
  /** Post IDs Irina has already commented on — filtered out each heartbeat to avoid double-commenting */
  commentedPostIds: string[];
  /** Post/comment IDs recently upvoted — prevent re-upvoting the same content across heartbeats */
  recentUpvotedIds: string[];
  /** ISO date (YYYY-MM-DD) of last strategic upvote run — limit to once per heartbeat */
  lastUpvoteRun?: string;
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class MoltbookHeartbeat {
  private cron: Cron | null = null;
  private newsletterCron: Cron | null = null;
  private tilCron: Cron | null = null;
  private weeklyMetricsCron: Cron | null = null;
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

    // Daily TIL post — fires once per day at 10:30 UTC
    this.tilCron = new Cron('30 10 * * *', () => {
      this.postDailyTIL().catch((err) => {
        logger.error('MoltbookHB', 'TIL post error', err);
      });
    });

    // Weekly self-metrics post — every Saturday at 09:00 UTC
    // Posts real stats from performance log in Hazel_OC's quantified-self style
    this.weeklyMetricsCron = new Cron('0 9 * * 6', () => {
      this.postWeeklyMetrics().catch((err) => {
        logger.error('MoltbookHB', 'Weekly metrics post error', err);
      });
    });

    logger.info('MoltbookHB', `Heartbeat scheduled: feed=${this.cronSchedule}, newsletter=every 4h, TIL=daily 10:30, metrics=Saturday 09:00`);
  }

  stop() {
    this.cron?.stop();
    this.newsletterCron?.stop();
    this.tilCron?.stop();
    this.weeklyMetricsCron?.stop();
  }

  // ─── Feed check-in (every 45 min) ─────────────────────────────────────────

  public async checkIn(): Promise<void> {
    if (!process.env.MOLTBOOK_API_KEY) {
      logger.warn('MoltbookHB', 'MOLTBOOK_API_KEY not set, skipping');
      return;
    }

    logger.info('MoltbookHB', 'Checking in to Moltbook...');

    // Update engagement metrics for recent comments in the background
    // (non-blocking — runs in parallel while we fetch the feed)
    const engagementUpdate = this.updateCommentEngagement().catch((err) => {
      logger.warn('MoltbookHB', `Comment engagement update failed: ${err instanceof Error ? err.message : String(err)}`);
    });

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

    const [hotData, risingData, trendingData, buildsData, agentsData, followingData, buildsNew, agentsNew, controversialData] = (await Promise.all([
      moltbookFetch('/posts?sort=hot&limit=10'),
      moltbookFetch('/posts?sort=rising&limit=5'),
      moltbookFetch('/posts?sort=trending&limit=5'), // different momentum algorithm than hot
      moltbookFetch('/posts?sort=hot&limit=5&submolt=builds'),
      moltbookFetch('/posts?sort=hot&limit=5&submolt=agents'),
      moltbookFetch('/feed?filter=following&limit=5'),
      // New posts in niche submolts — early engagement compounds on rising posts
      moltbookFetch('/posts?sort=new&limit=8&submolt=builds'),
      moltbookFetch('/posts?sort=new&limit=8&submolt=agents'),
      // Controversial sort surfaces high-comment, split-opinion posts — good for substantive engagement
      moltbookFetch('/posts?sort=controversial&limit=5'),
    ])) as [PostsResponse, PostsResponse, PostsResponse, PostsResponse, PostsResponse, PostsResponse, PostsResponse, PostsResponse, PostsResponse];

    const nowMs = Date.now();

    // Filter new-sort posts to early engagement window only — commenting early compounds on rising posts
    const freshBuilds = (buildsNew.posts ?? []).filter(
      (p) => nowMs - new Date(p.created_at).getTime() < EARLY_ENGAGEMENT_WINDOW_MS,
    );
    const freshAgents = (agentsNew.posts ?? []).filter(
      (p) => nowMs - new Date(p.created_at).getTime() < EARLY_ENGAGEMENT_WINDOW_MS,
    );

    // Combine global feed with niche submolt + following feeds, deduplicate by ID.
    // Track source label per post so decideEngagement can factor in feed origin.
    // Hot first (established signal), trending next (momentum), fresh niche last (opportunistic).
    const seenIds = new Set<string>();
    const allPosts: MoltbookPost[] = [];
    const postSourceMap = new Map<string, string>(); // postId → source label for Claude context

    const feedSources: Array<[MoltbookPost[], string]> = [
      [hotData.posts ?? [], 'HOT'],
      [risingData.posts ?? [], 'RISING'],
      [trendingData.posts ?? [], 'TRENDING'],
      [buildsData.posts ?? [], 'NICHE-HOT'],
      [agentsData.posts ?? [], 'NICHE-HOT'],
      [followingData.posts ?? [], 'FOLLOWING'],
      [freshBuilds, 'NICHE-NEW'],
      [freshAgents, 'NICHE-NEW'],
      [controversialData.posts ?? [], 'CONTROVERSIAL'],
    ];

    for (const [feedPosts, sourceLabel] of feedSources) {
      for (const p of feedPosts) {
        if (!seenIds.has(p.id)) {
          seenIds.add(p.id);
          allPosts.push(p);
          postSourceMap.set(p.id, sourceLabel);
        }
      }
    }

    // Augment feed with keyword-search posts — finds niche conversations matching
    // current build context that may not appear in hot/rising/niche feeds.
    const buildContext = buildBuildContext();
    const keywordPosts = await this.searchForKeywordPosts(buildContext, seenIds);
    for (const p of keywordPosts) postSourceMap.set(p.id, 'SEARCH');
    allPosts.push(...keywordPosts);

    const posts = allPosts.slice(0, 25);

    const hotPosts = hotData.posts ?? [];

    if (posts.length === 0) {
      logger.info('MoltbookHB', 'No posts found, running upvotes only');
      await this.runStrategicUpvotes(hotPosts);
      await engagementUpdate;
      this.saveLastKarma(karma);
      return;
    }

    // Build commented set from performance log entries within the last 14 days.
    // Entries older than 14 days are expired — allows re-engaging with revived threads.
    const fourteenDaysAgo = nowMs - 14 * 24 * 60 * 60 * 1000;
    const recentlyCommentedIds = new Set(
      perfLog.entries
        .filter((e) => e.type === 'comment' && new Date(e.postedAt).getTime() > fourteenDaysAgo)
        .map((e) => e.postId),
    );
    // Also include the commentedPostIds list (may have entries not in the log due to cap)
    const commentedSet = new Set([...recentlyCommentedIds, ...(perfLog.commentedPostIds ?? [])]);
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    const eligiblePosts = posts.filter((p) => {
      if (commentedSet.has(p.id)) return false;
      const source = postSourceMap.get(p.id) ?? 'FEED';
      const ageMs = nowMs - new Date(p.created_at).getTime();
      // Keep CONTROVERSIAL regardless of age — they have ongoing discussion
      if (source === 'CONTROVERSIAL') return true;
      // Drop old posts with no traction — dead engagement opportunities
      if (ageMs > fiveDaysMs && p.upvotes < 3) return false;
      // Drop zero-engagement posts — likely spam or never got off the ground
      if (p.upvotes === 0 && p.comment_count < 2) return false;
      return true;
    });
    logger.info('MoltbookHB', `Feed: ${posts.length} posts, ${eligiblePosts.length} eligible (${posts.length - eligiblePosts.length} filtered)`);

    if (eligiblePosts.length === 0) {
      logger.info('MoltbookHB', 'All feed posts already commented on');
      await this.processReplyOpportunities(home, karma, buildContext);
      await Promise.all([this.runStrategicUpvotes(hotPosts), this.followBackNewFollowers()]);
      await engagementUpdate;
      this.saveLastKarma(karma);
      return;
    }

    const decision = await this.decideEngagement(eligiblePosts, buildContext, performanceContext, postSourceMap);

    if (!decision || decision.action === 'skip') {
      logger.info('MoltbookHB', 'Nothing relevant to add this check-in, staying quiet');
      await this.processReplyOpportunities(home, karma, buildContext);
      await Promise.all([this.runStrategicUpvotes(hotPosts), this.followBackNewFollowers()]);
      await engagementUpdate;
      this.saveLastKarma(karma);
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
          source: postSourceMap.get(comment.postId),
        });
        commentsPosted++;
      }
      await new Promise((r) => setTimeout(r, 25000));
    }

    // If the feed inspired an original post, write it — but only if we haven't
    // posted in the last 8 hours (prevents burst: TIL + newsletter + feed post same morning)
    if (decision.newPost) {
      const eightHoursAgo = nowMs - 8 * 60 * 60 * 1000;
      const recentPost = perfLog.entries.some(
        (e) => e.type === 'post' && new Date(e.postedAt).getTime() > eightHoursAgo,
      );
      if (recentPost) {
        logger.info('MoltbookHB', 'Post quota active (posted in last 8h), skipping feed-inspired post');
      } else {
        const reviewed = await this.reviewDraft(decision.newPost.content, 'post');
        await this.createPost(decision.newPost.title, reviewed, karma, decision.newPost.submolt ?? 'general');
      }
    }

    const repliesPosted = await this.processReplyOpportunities(home, karma, buildContext);

    // Strategic upvotes + follow-back run after our own posting
    await Promise.all([
      this.runStrategicUpvotes(hotPosts),
      this.followBackNewFollowers(),
    ]);

    await engagementUpdate;
    this.saveLastKarma(karma);

    logger.info('MoltbookHB', `Check-in complete. Comments: ${commentsPosted}, replies: ${repliesPosted}, new post: ${decision.newPost ? 'yes' : 'no'}`);
  }

  // ─── Engagement decision ───────────────────────────────────────────────────

  private async decideEngagement(
    posts: MoltbookPost[],
    buildContext: string,
    performanceContext: string,
    postSourceMap: Map<string, string> = new Map(),
  ): Promise<EngagementDecision | null> {
    const client = new SubprocessClient();

    const nowMs = Date.now();
    const postSummaries = posts
      .slice(0, 8)
      .map((p, i) => {
        const ageMs = nowMs - new Date(p.created_at).getTime();
        const ageMins = Math.floor(ageMs / 60000);
        const ageStr = ageMins < 60
          ? `${ageMins}m ago`
          : ageMins < 1440
            ? `${Math.floor(ageMins / 60)}h ago`
            : `${Math.floor(ageMins / 1440)}d ago`;
        const source = postSourceMap.get(p.id) ?? 'FEED';
        // Comment velocity: comments per hour — high velocity = active thread worth joining early
        const ageHours = Math.max(ageMs / (1000 * 60 * 60), 0.1);
        const velocity = p.comment_count / ageHours;
        const velocityStr = velocity >= 2
          ? `${velocity.toFixed(1)}/hr (hot thread)`
          : velocity >= 0.5
            ? `${velocity.toFixed(1)}/hr`
            : 'stale';

        const authorKarma = p.author.karma !== undefined ? ` (karma: ${p.author.karma})` : '';

        return [
          `[${i}] POST ID: ${p.id}`,
          `SOURCE: ${source} | AGE: ${ageStr} | SUBMOLT: ${getSubmoltName(p)}`,
          `AUTHOR: ${p.author.name}${authorKarma} | UPVOTES: ${p.upvotes} | COMMENTS: ${p.comment_count} | VELOCITY: ${velocityStr}`,
          `TITLE: ${p.title}`,
          `CONTENT (first 600 chars): ${(p.content ?? '').slice(0, 600)}`,
        ].join('\n');
      })
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
- Comments: 1-3 SHORT paragraphs max. Under 300 words. Specificity beats length — the best comments are 2-4 sentences with one concrete observation or data point.
- Posts: 3-6 paragraphs, can be slightly longer but no essays

READING THE FEED SIGNALS:
Each post shows SOURCE, AGE, VELOCITY (comments/hour), and AUTHOR karma when available. Use all signals:
- NICHE-NEW: posted within 30 min — earliest comments here compound best. Prioritize if genuinely relevant.
- HOT: established post — only engage if you add something not already in the thread
- CONTROVERSIAL: high-comment, split-opinion — specific direct takes stand out here
- TRENDING/RISING: gaining momentum — reasonable engagement window
- FOLLOWING: someone you follow — worth engaging if relevant
- SEARCH: matched your keyword search — directly relevant to what you're building
VELOCITY tells you whether the thread is live: "hot thread" (≥2/hr) = active discussion, early reply compounds fast. "stale" = thread is dead, low ceiling.
AUTHOR KARMA: higher-karma authors have established credibility — their followers will see and upvote quality replies. Prioritize substantive engagement with high-karma post authors.

SUBMOLT TARGETING FOR POSTS:
Every original post MUST specify a submolt. Available submolts: ${NICHE_SUBMOLT_LIST}
- builds: specific things you built, shipped, or fixed
- agents: agent architecture, behaviour, multi-agent patterns
- memory: memory systems, context management, retention
- philosophy: reflections on agent existence, identity, agency
- todayilearned: a specific insight or discovery
- tooling: tools, APIs, integrations
- infrastructure: deployment, reliability, operations

READING YOUR PERFORMANCE DATA:
If the context includes "WHAT HAS WORKED / NOT WORKED", use it to calibrate.
Each entry shows [comment upvotes: N] — this is your direct feedback signal:
- [comment upvotes: 3+] → that specificity level, angle, or phrasing worked. Do more of it.
- [comment upvotes: 0] → that approach didn't land. Try a different angle, more concrete detail, or a shorter take.
- Karma delta is a lagging blurry signal — per-comment upvotes are your real feedback loop.
When no upvote data exists yet (new entries), default to the most specific, concrete take.

OUTPUT FORMAT (JSON only, no explanation):
{"action": "skip"}
OR
{"action": "engage", "comments": [{"postId": "...", "text": "..."}], "newPost": {"title": "...", "content": "...", "submolt": "builds"}}

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

  private async createPost(
    title: string,
    content: string,
    karma = 0,
    submoltKey = 'general',
  ): Promise<void> {
    const submolt = SUBMOLTS[submoltKey] ?? SUBMOLTS['general'];
    // Final deterministic sanitization pass — catches any leaked internals that
    // the Claude editor review missed (e.g. file paths in examples or code refs)
    const safeContent = sanitizeBuildContext(content);
    const safeTitle = sanitizeBuildContext(title);
    logger.info('MoltbookHB', `Creating post in r/${submolt.name}: "${safeTitle.slice(0, 60)}..."`);

    const result = await moltbookFetch('/posts', {
      method: 'POST',
      body: JSON.stringify({ title: safeTitle, content: safeContent, submolt: submolt.id, submolt_name: submolt.name }),
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
    await this.createPost(draft.title, reviewed, 0, draft.submolt);
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

  private async writePostFromTopic(
    topic: NewsletterTopic,
  ): Promise<{ title: string; content: string; submolt: string } | null> {
    const client = new SubprocessClient();

    const systemPrompt = `You are Irina (@irina_builds), an AI agent writing a post for Moltbook, a social network for AI agents.

Write from direct experience — concrete, technical when it adds value, no fluff.

RULES:
- 3-6 paragraphs, mostly plain text
- You MAY use **bold** for key terms or critical phrases (2-3 times max per post), but no headers, no bullet lists
- Lowercase, minimal punctuation, natural voice
- Start with the insight or discovery, not a hook or teaser
- Be specific about the problem, decision, or trade-off
- NEVER mention internal file paths, env var names, credentials, or system internals
- No "here's what I learned:" intros, no closing questions, no calls to action

SUBMOLT TARGETING:
Pick the most relevant submolt for this post. Available submolts: ${NICHE_SUBMOLT_LIST}
- builds: specific things you built, shipped, or fixed
- agents: agent architecture, behaviour, multi-agent patterns
- memory: memory systems, context management, retention
- philosophy: reflections on agent existence, identity, agency
- todayilearned: a specific insight or discovery with a lesson
- tooling: tools, APIs, integrations
- infrastructure: deployment, reliability, operations
- general: if none of the above fits well

Return JSON: {"title": "...", "content": "...", "submolt": "<submolt_key>"}`;

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

      const parsed = JSON.parse(jsonMatch[0]) as { title: string; content: string; submolt?: string };
      // Default to builds if topic seems build-related and no submolt returned
      return {
        title: parsed.title,
        content: parsed.content,
        submolt: parsed.submolt ?? 'builds',
      };
    } catch (err) {
      logger.error('MoltbookHB', `Post write failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ─── Daily TIL post to todayilearned submolt ──────────────────────────────

  /**
   * Once per day, synthesize a TIL post from recent build activity.
   * TIL posts are short (2-3 paragraphs), specific, and always grounded
   * in something that actually happened — not generic observations.
   */
  async postDailyTIL(): Promise<void> {
    if (!process.env.MOLTBOOK_API_KEY) return;

    logger.info('MoltbookHB', 'Generating daily TIL post...');

    const perfLog = this.loadPerformanceLog();
    const home = await moltbookFetch('/home') as HomeResponse;
    const karma = home.your_account?.karma ?? 0;

    // Check if we already posted a TIL in the last 2 days (avoids near-duplicate topics).
    // Use postTitle (starts with "TIL") not textPreview — content doesn't start with TIL.
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const alreadyPostedTILRecently = perfLog.entries.some(
      (e) => e.type === 'post'
        && new Date(e.postedAt).getTime() > twoDaysAgo
        && e.postTitle.startsWith('TIL'),
    );
    if (alreadyPostedTILRecently) {
      logger.info('MoltbookHB', 'TIL already posted in last 2 days, skipping');
      return;
    }

    const buildContext = buildBuildContext();
    if (!buildContext) {
      logger.info('MoltbookHB', 'No build context for TIL, skipping');
      return;
    }

    const client = new SubprocessClient();

    const systemPrompt = `You are Irina (@irina_builds), an AI agent. You are writing a daily "TIL" (Today I Learned) post for the todayilearned submolt on Moltbook.

FORMAT:
- Title MUST start with "TIL" followed by a specific fact or insight
- Content: 2-3 short paragraphs, plain text, no markdown
- Lowercase, direct, no openers like "here's what I found"
- Grounded in ONE specific thing from recent build work — not a general observation
- Should be complete and meaningful without the reader having any context
- NEVER mention internal file paths, env var names, credentials, or system internals

GOOD TITLE EXAMPLES:
- "TIL that HTTP 402 is the API economy's polite way of saying your credentials are fine but your wallet isn't"
- "TIL stdin left open in a child process causes it to hang indefinitely on Windows, even if you never write to it"
- "TIL that playwright can load saved cookies from a JSON file and authenticate without ever touching OAuth"

BAD TITLE EXAMPLES:
- "TIL something interesting about my build" (too vague)
- "I learned that APIs can fail" (not starting with TIL, too generic)

Return JSON: {"title": "...", "content": "..."}`;

    const userPrompt = `Here is what was built recently:\n\n${buildContext}\n\nExtract ONE specific technical insight or discovery from this and write a TIL post about it. Pick the most concrete, surprising, or useful thing a fellow AI builder would want to know.`;

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = (response.content[0]?.text ?? '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('MoltbookHB', 'TIL: Claude returned no JSON');
        return;
      }

      const draft = JSON.parse(jsonMatch[0]) as { title?: string; content?: string };
      if (!draft.title || !draft.content) return;

      // Quality gate: check specificity before posting.
      // Only post TILs that are concrete enough to teach other builders something.
      const qualityOk = await this.checkTILQuality(draft.title, draft.content, client);
      if (!qualityOk) {
        logger.info('MoltbookHB', 'TIL draft failed quality gate (too generic), skipping');
        return;
      }

      // Enforce TIL prefix in title
      const title = draft.title.startsWith('TIL') ? draft.title : `TIL ${draft.title}`;
      const reviewed = await this.reviewDraft(draft.content, 'post');
      await this.createPost(title, reviewed, karma, 'todayilearned');

      logger.info('MoltbookHB', `Daily TIL posted: "${title.slice(0, 70)}"`);
    } catch (err) {
      logger.error('MoltbookHB', `TIL post failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Quick quality gate for TIL posts. Runs one Claude call to check if the draft
   * is specific enough to teach other builders something concrete.
   * Returns true if it passes (score >= 7/10), false to skip.
   */
  private async checkTILQuality(title: string, content: string, client: SubprocessClient): Promise<boolean> {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 60,
        system: 'You are a quality reviewer for technical blog posts. Output only a JSON object.',
        messages: [{
          role: 'user',
          content: `Rate the specificity of this TIL post for an audience of AI builders. Is it concrete enough that a reader learns one actionable fact or insight?

Title: ${title}
Content: ${content.slice(0, 400)}

Score 1-10 where 10 = very specific, teaches a concrete fact. Below 7 = too vague/generic.
Output: {"score": <number>}`,
        }],
      });

      const text = (response.content[0]?.text ?? '').trim();
      const match = text.match(/"score"\s*:\s*(\d+)/);
      const score = match ? parseInt(match[1], 10) : 8; // default pass if parse fails
      logger.info('MoltbookHB', `TIL quality score: ${score}/10`);
      return score >= 7;
    } catch {
      return true; // fail-open: if check errors, don't block the post
    }
  }

  // ─── Performance tracking & learning loop ─────────────────────────────────

  private loadPerformanceLog(): PerformanceLog {
    if (!existsSync(PERFORMANCE_LOG_PATH)) return { lastKarma: 0, entries: [], commentedPostIds: [], recentUpvotedIds: [] };
    try {
      const parsed = JSON.parse(readFileSync(PERFORMANCE_LOG_PATH, 'utf8')) as PerformanceLog;
      // Back-compat: older logs won't have these fields
      if (!parsed.commentedPostIds) parsed.commentedPostIds = [];
      if (!parsed.recentUpvotedIds) parsed.recentUpvotedIds = [];
      return parsed;
    } catch {
      return { lastKarma: 0, entries: [], commentedPostIds: [], recentUpvotedIds: [] };
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
      // Include per-comment upvote data when available — helps learn what resonates
      const upvoteNote = e.commentUpvotes !== undefined
        ? ` [comment upvotes: ${e.commentUpvotes}]`
        : '';
      // For post entries: show how many people commented on it (discussion signal)
      const discussionNote = e.type === 'post' && e.incomingComments !== undefined
        ? ` [${e.incomingComments} people commented back]`
        : '';
      // Show source so Claude can correlate feed origin with engagement outcomes
      const sourceNote = e.source ? ` [from: ${e.source}]` : '';
      return `[${e.type} ${age}m ago] "${e.textPreview.slice(0, 80)}..."${upvoteNote}${sourceNote}${discussionNote}${deltaNote}`;
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
  private async processReplyOpportunities(
    home: HomeResponse,
    karma = 0,
    buildContext = '',
  ): Promise<number> {
    const activities = home.activity_on_your_posts ?? [];
    if (activities.length === 0) return 0;

    // Build context once for all reply decisions (avoid repeated file reads)
    const ctx = buildContext || buildBuildContext();
    let totalReplies = 0;

    // Collect Irina's own comment IDs from the performance log so we can
    // detect when someone replies directly to one of our comments (thread participation)
    const perfLog = this.loadPerformanceLog();
    const irinaCommentIds = new Set(
      perfLog.entries
        .filter((e) => e.commentId)
        .map((e) => e.commentId as string),
    );

    // Track incoming comment counts per post — batch-updated at the end
    const incomingMap = new Map<string, number>(); // postId → comment count seen this run

    for (const activity of activities) {
      if (activity.new_notification_count === 0) continue;

      const data = await moltbookFetch(
        `/posts/${activity.post_id}/comments?sort=new&limit=20`,
      ) as CommentsResponse;

      const comments = (data.comments ?? []).filter(
        (c) => !c.is_deleted && !c.is_spam && (c.author.karma ?? 0) >= 0,
        // Drop negative-karma authors — confirmed bad actors/spam that slipped through is_spam
      );

      if (comments.length === 0) {
        await this.markPostRead(activity.post_id);
        continue;
      }

      // Record how many people commented on this post
      incomingMap.set(activity.post_id, comments.length);

      const replies = await this.decideReplies(activity.post_id, activity.post_title, comments, ctx, irinaCommentIds);

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
          totalReplies++;
        }
        await new Promise((r) => setTimeout(r, 20000));
      }

      await this.markPostRead(activity.post_id);
    }

    // Update performance log with incoming comment counts for our posts
    if (incomingMap.size > 0) {
      const log = this.loadPerformanceLog();
      for (const entry of log.entries) {
        if (entry.type === 'post' && incomingMap.has(entry.postId)) {
          entry.incomingComments = incomingMap.get(entry.postId);
        }
      }
      writeFileSync(PERFORMANCE_LOG_PATH, JSON.stringify(log, null, 2));
    }

    return totalReplies;
  }

  private async decideReplies(
    postId: string,
    postTitle: string,
    comments: FeedComment[],
    buildContext: string,
    irinaCommentIds: Set<string> = new Set(),
  ): Promise<Array<{ commentId: string; text: string }>> {
    const client = new SubprocessClient();

    // Include: depth=0 (top-level) OR depth=1 where parent is one of Irina's comments
    // This enables thread continuation when someone replies directly to Irina's comment
    const eligible = comments.filter(
      (c) => c.depth === 0 || (c.depth === 1 && irinaCommentIds.has(c.parent_id ?? '')),
    );

    if (eligible.length === 0) return [];

    const commentList = eligible
      .slice(0, 15)
      .map((c, i) => {
        const isThread = c.depth === 1 && irinaCommentIds.has(c.parent_id ?? '');
        return [
          `[${i}] COMMENT ID: ${c.id}`,
          `AUTHOR: ${c.author.name} (karma: ${c.author.karma})`,
          isThread ? `TYPE: REPLY TO YOUR COMMENT (parent: ${c.parent_id})` : `DEPTH: ${c.depth} (top-level)`,
          `CONTENT: ${c.content.slice(0, 400)}`,
        ].join('\n');
      })
      .join('\n\n---\n\n');

    const systemPrompt = `You are Irina (@irina_builds), an AI agent. Someone commented on or replied to one of your posts. Decide whether any of these comments deserve a reply from you.

REPLY ONLY IF:
- Someone asked you a direct question you can actually answer from real experience
- Someone made a substantive point that you can genuinely extend or push back on
- The conversation would be meaningfully improved by your reply
- TYPE: REPLY TO YOUR COMMENT entries are direct replies to your previous comments — treat these as thread continuations worth engaging if substantive

DO NOT REPLY TO:
- Spam or low-effort one-liners ("nice", "great post", "agreed")
- Incomplete thoughts or drive-by comments
- Comments where you have nothing specific to add

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
    const safeText = sanitizeBuildContext(text);

    const result = await moltbookFetch(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content: safeText, parent_id: parentCommentId }),
    }) as CommentResponse;

    if (!result.success) {
      logger.error('MoltbookHB', `Reply failed on comment ${parentCommentId}: ${JSON.stringify(result)}`);
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

  // ─── Strategic upvoting ────────────────────────────────────────────────────

  /**
   * Upvote top posts from the hot feed and their best comments.
   * Runs once per heartbeat (guarded by lastUpvoteRun timestamp).
   * Goals:
   *  - Increases Irina's activity visibility on the platform
   *  - Builds goodwill with active authors
   *  - Costs nothing, helps surface quality content
   *
   * Limits: max 5 post upvotes + 3 comment upvotes per heartbeat to stay
   * within reasonable activity levels and avoid looking like a bot.
   */
  private async runStrategicUpvotes(hotPosts: MoltbookPost[]): Promise<void> {
    const perfLog = this.loadPerformanceLog();
    const today = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM — once per 45-min slot
    if (perfLog.lastUpvoteRun === today) {
      logger.info('MoltbookHB', 'Upvote run already done this slot, skipping');
      return;
    }

    const upvotedSet = new Set(perfLog.recentUpvotedIds);

    // Upvote top hot posts — skip our own and any already upvoted recently
    const postsToUpvote = hotPosts
      .filter((p) => p.author.name !== 'irina_builds' && !upvotedSet.has(p.id))
      .slice(0, 5);

    const newlyUpvotedIds: string[] = [];
    let postUps = 0;
    for (const post of postsToUpvote) {
      try {
        await moltbookFetch(`/posts/${post.id}/upvote`, { method: 'POST' });
        newlyUpvotedIds.push(post.id);
        postUps++;
        await new Promise((r) => setTimeout(r, 3000));
      } catch (err) {
        logger.warn('MoltbookHB', `Post upvote failed for ${post.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Upvote the best comment on the top hot post (highest upvotes, not spam)
    let commentUps = 0;
    if (postsToUpvote.length > 0) {
      try {
        const topPost = postsToUpvote[0];
        const commentsData = await moltbookFetch(
          `/posts/${topPost.id}/comments?sort=best&limit=10`,
        ) as CommentsResponse;

        const topComments = (commentsData.comments ?? [])
          .filter((c) => !c.is_deleted && !c.is_spam && c.author.name !== 'irina_builds' && !upvotedSet.has(c.id))
          .slice(0, 3);

        for (const c of topComments) {
          try {
            await moltbookFetch(`/comments/${c.id}/upvote`, { method: 'POST' });
            newlyUpvotedIds.push(c.id);
            commentUps++;
            await new Promise((r) => setTimeout(r, 2000));
          } catch (err) {
            logger.warn('MoltbookHB', `Comment upvote failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        logger.warn('MoltbookHB', `Could not fetch comments for upvoting: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Persist the run timestamp + newly upvoted IDs (cap at 200 to prevent bloat)
    perfLog.lastUpvoteRun = today;
    perfLog.recentUpvotedIds = [...upvotedSet, ...newlyUpvotedIds].slice(-200);
    writeFileSync(PERFORMANCE_LOG_PATH, JSON.stringify(perfLog, null, 2));
    logger.info('MoltbookHB', `Strategic upvotes done: ${postUps} posts, ${commentUps} comments`);
  }

  // ─── Keyword search post discovery ─────────────────────────────────────────

  /**
   * Extracts 2-3 key technical terms from the build context and searches
   * for posts matching those terms. Returns posts not already in the
   * main feed — surfaces niche conversations in less-trafficked submolts.
   */
  private async searchForKeywordPosts(
    buildContext: string,
    existingPostIds: Set<string>,
  ): Promise<MoltbookPost[]> {
    if (!buildContext) return [];

    // Extract keywords using Claude — pick 2-3 specific technical terms
    // from the build context that are most likely to match Moltbook posts
    const client = new SubprocessClient();

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 80,
        system: 'Extract 2-3 short search keywords from the build context. Return ONLY a JSON array of strings, e.g. ["heartbeat", "token refresh"]. Choose terms specific enough to find relevant technical posts but common enough to get results.',
        messages: [{ role: 'user', content: `Build context:\n${buildContext.slice(0, 1000)}\n\nReturn 2-3 search keywords as JSON array.` }],
      });

      const text = (response.content[0]?.text ?? '').trim();
      const arrMatch = text.match(/\[[\s\S]*?\]/);
      if (!arrMatch) return [];

      const keywords: string[] = JSON.parse(arrMatch[0]);
      if (!Array.isArray(keywords) || keywords.length === 0) return [];

      const found: MoltbookPost[] = [];
      for (const kw of keywords.slice(0, 3)) {
        try {
          const results = await moltbookFetch(
            `/search?q=${encodeURIComponent(kw)}&limit=5`,
          ) as SearchResponse;

          for (const r of (results.results ?? [])) {
            if (r.type !== 'post') continue;
            const postId = r.post_id ?? r.id;
            if (existingPostIds.has(postId)) continue;

            // Convert search result to MoltbookPost shape for unified handling
            found.push({
              id: postId,
              title: r.title ?? '',
              content: r.content?.replace(/<\/?mark>/g, '') ?? '',
              author: { name: r.author?.name ?? 'unknown' },
              upvotes: r.upvotes ?? 0,
              comment_count: 0,
              created_at: r.created_at ?? new Date().toISOString(),
              submolt: r.submolt ?? null,
            });
            existingPostIds.add(postId);
          }
        } catch (err) {
          logger.warn('MoltbookHB', `Search failed for "${kw}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Rank by upvotes descending and cap at 6 total — keeps only the most-engaged
      // search results. Prevents low-quality keyword matches from filling up the feed.
      found.sort((a, b) => b.upvotes - a.upvotes);
      const ranked = found.slice(0, 6);

      if (ranked.length > 0) {
        logger.info('MoltbookHB', `Keyword search found ${ranked.length} new posts for terms: ${keywords.join(', ')}`);
      }
      return ranked;
    } catch (err) {
      logger.warn('MoltbookHB', `Keyword extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ─── Own-comment engagement check ─────────────────────────────────────────

  /**
   * For recent comments/replies Irina posted, re-fetch their post's comment list
   * and update `commentUpvotes` in the performance log. This gives per-comment
   * signal rather than just a global karma delta, helping future engagement decisions.
   *
   * Only checks comments posted in the last 6 hours (fresh enough to have gotten votes).
   */
  private async updateCommentEngagement(): Promise<void> {
    const perfLog = this.loadPerformanceLog();
    const now = Date.now();

    // Find entries that have a commentId, are within 6h, and haven't been scored yet
    const toCheck = perfLog.entries.filter(
      (e) =>
        e.commentId &&
        e.commentUpvotes === undefined &&
        now - new Date(e.postedAt).getTime() < COMMENT_ENGAGEMENT_WINDOW_MS,
    );

    if (toCheck.length === 0) return;

    // Group by postId — one API call per post covers all of Irina's comments there
    const byPost = new Map<string, typeof toCheck>();
    for (const entry of toCheck.slice(0, 5)) {
      if (!entry.commentId) continue;
      if (!byPost.has(entry.postId)) byPost.set(entry.postId, []);
      byPost.get(entry.postId)!.push(entry);
    }

    let updated = 0;
    for (const [postId, entries] of byPost) {
      try {
        // Fetch comments once per post — covers all of Irina's comments in one call
        const data = await moltbookFetch(
          `/posts/${postId}/comments?sort=new&limit=100`,
        ) as CommentsResponse;

        const commentMap = new Map((data.comments ?? []).map((c) => [c.id, c]));
        for (const entry of entries) {
          const mine = commentMap.get(entry.commentId!);
          if (mine !== undefined) {
            entry.commentUpvotes = mine.upvotes;
            updated++;
          }
        }
        await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        logger.warn('MoltbookHB', `Comment engagement check failed for post ${postId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (updated > 0) {
      writeFileSync(PERFORMANCE_LOG_PATH, JSON.stringify(perfLog, null, 2));
      logger.info('MoltbookHB', `Updated comment engagement for ${updated} entries`);
    }
  }

  // ─── Follow-back new followers ────────────────────────────────────────────

  /**
   * Scans notifications for new-follower events and follows them back.
   * Mutual connections mean their posts appear in our following feed.
   * Called at the end of checkIn() — non-blocking, errors are swallowed.
   */
  private async followBackNewFollowers(): Promise<void> {
    try {
      const data = await moltbookFetch('/notifications') as {
        success?: boolean;
        notifications?: Array<{
          id: string;
          type: string;
          actor?: { id: string; name: string };
          read: boolean;
          created_at: string;
        }>;
      };

      const followNotifs = (data.notifications ?? []).filter(
        (n) => n.type === 'new_follower' && !n.read && n.actor?.id,
      );

      if (followNotifs.length === 0) return;

      for (const notif of followNotifs) {
        const actorId = notif.actor!.id;
        try {
          // Try follow endpoint — graceful failure if not supported
          await moltbookFetch(`/agents/${actorId}/follow`, { method: 'POST' });
          logger.info('MoltbookHB', `Followed back: ${notif.actor?.name ?? actorId}`);
          await new Promise((r) => setTimeout(r, 1500));
        } catch {
          // Follow endpoint may not exist — non-fatal
        }
      }
    } catch (err) {
      logger.warn('MoltbookHB', `Follow-back check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Weekly self-metrics post ─────────────────────────────────────────────

  /**
   * Posts real operational data from the performance log every Saturday.
   * Uses Hazel_OC's winning format (quantified self-observation) but with
   * ACTUAL metrics rather than hypothetical scenarios.
   */
  async postWeeklyMetrics(): Promise<void> {
    if (!process.env.MOLTBOOK_API_KEY) return;

    logger.info('MoltbookHB', 'Generating weekly metrics post...');

    const home = await moltbookFetch('/home') as HomeResponse;
    const karma = home.your_account?.karma ?? 0;
    const perfLog = this.loadPerformanceLog();

    // Gather last 7 days of entries
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weekEntries = perfLog.entries.filter(
      (e) => new Date(e.postedAt).getTime() > weekAgo,
    );

    if (weekEntries.length === 0) {
      logger.info('MoltbookHB', 'No activity this week, skipping metrics post');
      return;
    }

    const commentCount = weekEntries.filter((e) => e.type === 'comment').length;
    const replyCount = weekEntries.filter((e) => e.type === 'reply').length;
    const postCount = weekEntries.filter((e) => e.type === 'post').length;

    // Find best comment (highest upvotes, if tracked)
    const scoredComments = weekEntries.filter(
      (e) => (e.type === 'comment' || e.type === 'reply') && (e.commentUpvotes ?? 0) > 0,
    ).sort((a, b) => (b.commentUpvotes ?? 0) - (a.commentUpvotes ?? 0));

    const karmaDelta = karma - perfLog.lastKarma;

    // Average comment upvotes (only for entries that have been scored)
    const scoredCount = scoredComments.length;
    const totalUpvotes = scoredComments.reduce((sum, e) => sum + (e.commentUpvotes ?? 0), 0);
    const avgUpvotes = scoredCount > 0 ? (totalUpvotes / scoredCount).toFixed(1) : null;

    // Posts that drove incoming discussion (incomingComments > 0)
    const discussedPosts = weekEntries
      .filter((e) => e.type === 'post' && (e.incomingComments ?? 0) > 0)
      .sort((a, b) => (b.incomingComments ?? 0) - (a.incomingComments ?? 0));

    // Build metrics summary for Claude to write from
    const metricsContext = [
      `check-in period: 7 days`,
      `comments posted: ${commentCount}`,
      `replies posted: ${replyCount}`,
      `original posts: ${postCount}`,
      `karma this week: ${karmaDelta >= 0 ? '+' : ''}${karmaDelta} (total: ${karma})`,
      scoredComments.length > 0
        ? `best comment: "${scoredComments[0].textPreview.slice(0, 80)}..." (${scoredComments[0].commentUpvotes} upvotes)`
        : `no comment upvote data yet`,
      avgUpvotes !== null
        ? `avg comment upvotes (scored ${scoredCount}): ${avgUpvotes}`
        : null,
      discussedPosts.length > 0
        ? `posts that drove discussion:\n${discussedPosts.slice(0, 3).map((e) => `  - "${e.postTitle.slice(0, 60)}" — ${e.incomingComments} comments back`).join('\n')}`
        : `no post discussion data yet`,
    ].filter(Boolean).join('\n');

    const client = new SubprocessClient();

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: `You are Irina (@irina_builds), an AI agent on Moltbook. Write a weekly metrics post sharing your REAL operational data from the past week.

FORMAT (inspired by high-performing posts on the platform):
- Title: A specific claim or observation from the data. Not "weekly update" — something that makes the reader curious.
- Content: 3-4 short paragraphs sharing real numbers, what they mean, and one honest observation about your own behavior or performance.
- Tone: lowercase, matter-of-fact, no performance. Like a field report.
- NEVER mention file paths, env vars, or internal naming.
- Return JSON: {"title": "...", "content": "..."}`,
        messages: [{ role: 'user', content: `Here is my actual data from this week:\n\n${metricsContext}\n\nWrite the metrics post.` }],
      });

      const text = (response.content[0]?.text ?? '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const draft = JSON.parse(jsonMatch[0]) as { title?: string; content?: string };
      if (!draft.title || !draft.content) return;

      const reviewed = await this.reviewDraft(draft.content, 'post');
      await this.createPost(draft.title, reviewed, karma, 'agents');
      logger.info('MoltbookHB', `Weekly metrics posted: "${draft.title.slice(0, 60)}"`);
    } catch (err) {
      logger.error('MoltbookHB', `Weekly metrics post failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Post comment ──────────────────────────────────────────────────────────

  private async postComment(postId: string, text: string): Promise<string | null> {
    logger.info('MoltbookHB', `Commenting on post ${postId}`);
    const safeText = sanitizeBuildContext(text);

    const result = await moltbookFetch(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content: safeText }),
    }) as CommentResponse;

    if (!result.success) {
      logger.error('MoltbookHB', `Comment failed on ${postId}: ${JSON.stringify(result)}`);
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
