/**
 * X (Twitter) Poster — Irina's autonomous posting module.
 *
 * Posts tweets as @irina_builds using OAuth 1.0a.
 * No external OAuth library needed — signs with Node.js crypto.
 *
 * Required env vars:
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
 */

import { createHmac } from 'crypto';
import { logger } from '../../utils/logger.js';
import { postTweetViaPlaywright } from './playwright-poster.js';

const TWEET_ENDPOINT = 'https://api.twitter.com/2/tweets';

interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

interface PostResult {
  success: boolean;
  tweetId?: string;
  tweetUrl?: string;
  error?: string;
}

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildOAuthHeader(method: string, url: string, creds: XCredentials): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };

  // Sort params alphabetically for signing
  const sortedParams = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
    .join('&');

  const signatureBase = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sortedParams),
  ].join('&');

  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(signatureBase).digest('base64');

  oauthParams['oauth_signature'] = signature;

  const headerValue = 'OAuth ' + Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(', ');

  return headerValue;
}

export async function postTweet(text: string, creds?: XCredentials): Promise<PostResult> {
  const credentials: XCredentials = creds ?? {
    apiKey: process.env.X_API_KEY ?? '',
    apiSecret: process.env.X_API_SECRET ?? '',
    accessToken: process.env.X_ACCESS_TOKEN ?? '',
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET ?? '',
  };

  if (!credentials.apiKey || !credentials.apiSecret || !credentials.accessToken || !credentials.accessTokenSecret) {
    return { success: false, error: 'Missing X API credentials (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET)' };
  }

  if (text.length > 280) {
    return { success: false, error: `Tweet too long: ${text.length} chars (max 280)` };
  }

  const authHeader = buildOAuthHeader('POST', TWEET_ENDPOINT, credentials);
  const body = JSON.stringify({ text });

  try {
    const res = await fetch(TWEET_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'OpenClaude/1.0',
      },
      body,
    });

    const data = await res.json() as { data?: { id: string }; errors?: Array<{ message: string }> };

    if (!res.ok) {
      const errMsg = data.errors?.[0]?.message ?? `HTTP ${res.status}`;
      // API unavailable (402 = payment required on free tier) — fall back to Playwright
      if (res.status === 402 || res.status === 403) {
        logger.warn('XPoster', `API returned ${res.status}, falling back to Playwright poster`);
        return postTweetViaPlaywright(text);
      }
      logger.error('XPoster', `Failed to post tweet: ${errMsg}`);
      return { success: false, error: errMsg };
    }

    const tweetId = data.data?.id;
    const tweetUrl = `https://x.com/irina_builds/status/${tweetId}`;
    logger.info('XPoster', `Posted tweet ${tweetId}: ${text.slice(0, 60)}...`);
    return { success: true, tweetId, tweetUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('XPoster', `Network error: ${msg}`);
    return { success: false, error: msg };
  }
}
