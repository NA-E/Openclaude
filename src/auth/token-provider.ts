/**
 * OAuthTokenProvider — reads Claude Code's stored OAuth credentials
 * from ~/.claude-acc1/.credentials.json and refreshes them automatically.
 *
 * No API key needed — uses the same bearer token that Claude Code uses.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;       // Unix ms timestamp
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  };
}

// Claude Code's OAuth client ID (confirmed from binary)
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Real token refresh endpoint (found from binary strings)
const REFRESH_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';

// Refresh 5 minutes before actual expiry to avoid mid-request failures
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export class OAuthTokenProvider {
  private credentialsPath: string;

  constructor(accDir: string = join(homedir(), '.claude-acc1')) {
    this.credentialsPath = join(accDir, '.credentials.json');
  }

  /** Returns a valid access token, refreshing automatically if expired. */
  async getToken(): Promise<string> {
    const creds = this.readCredentials();
    const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth;

    const isExpired = Date.now() >= expiresAt - EXPIRY_BUFFER_MS;
    if (!isExpired) {
      return accessToken;
    }

    logger.info('OAuthTokenProvider', 'Token expired — refreshing...');
    return this.refresh(refreshToken);
  }

  private readCredentials(): ClaudeCredentials {
    try {
      return JSON.parse(readFileSync(this.credentialsPath, 'utf-8')) as ClaudeCredentials;
    } catch {
      throw new Error(
        `Cannot read credentials from ${this.credentialsPath}.\n` +
        `Run 'cc-login 1' to authenticate, then restart OpenClaude.`,
      );
    }
  }

  private async refresh(refreshToken: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(REFRESH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: OAUTH_CLIENT_ID,
        }),
      });
    } catch (err) {
      throw new Error(
        `Token refresh network error: ${err}.\n` +
        `Run 'cc-login 1' to re-authenticate.`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Token refresh failed (HTTP ${response.status}): ${body}\n` +
        `Run 'cc-login 1' to re-authenticate.`,
      );
    }

    const data = await response.json() as { access_token: string; expires_in: number };

    // Persist the new token back to the credentials file
    const creds = this.readCredentials();
    creds.claudeAiOauth.accessToken = data.access_token;
    creds.claudeAiOauth.expiresAt = Date.now() + data.expires_in * 1000;
    writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2));

    logger.info('OAuthTokenProvider', 'Token refreshed successfully');
    return data.access_token;
  }
}
