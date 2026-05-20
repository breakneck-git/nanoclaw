/**
 * Automatic refresh for Google OAuth tokens stored in ~/.gmail-mcp/
 * Refreshes all credential files that have a refresh_token and are
 * within 10 minutes of expiry. Runs at startup and every 30 minutes.
 */
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

interface GoogleCredentials {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expiry_date?: number; // ms since epoch
}

interface GcpOAuthKeys {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const GMAIL_MCP_DIR = path.join(os.homedir(), '.gmail-mcp');
const REFRESH_BEFORE_EXPIRY_MS = 0; // refresh only when already expired

function loadClientCredentials(): {
  clientId: string;
  clientSecret: string;
} | null {
  const keysPath = path.join(GMAIL_MCP_DIR, 'gcp-oauth.keys.json');
  if (!fs.existsSync(keysPath)) return null;
  try {
    const keys: GcpOAuthKeys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const creds = keys.installed || keys.web;
    if (!creds?.client_id || !creds?.client_secret) return null;
    return { clientId: creds.client_id, clientSecret: creds.client_secret };
  } catch {
    return null;
  }
}

function refreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString();

    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 100)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function refreshOneCred(
  creds: GoogleCredentials,
  clientId: string,
  clientSecret: string,
  label: string,
): Promise<boolean> {
  if (!creds.refresh_token) return false;

  const now = Date.now();
  const expiry = creds.expiry_date ?? 0;
  if (expiry - now > REFRESH_BEFORE_EXPIRY_MS) return false;

  logger.info(
    { file: label, expiresIn: Math.round((expiry - now) / 1000) },
    'Refreshing Google token',
  );

  try {
    const result = await refreshToken(
      clientId,
      clientSecret,
      creds.refresh_token,
    );
    if (result.error || !result.access_token) {
      logger.error(
        { file: label, error: result.error, desc: result.error_description },
        'Google token refresh failed',
      );
      return false;
    }

    creds.access_token = result.access_token;
    creds.expiry_date = Date.now() + (result.expires_in ?? 3600) * 1000;
    // Google may rotate the refresh_token — persist the new one if returned
    if (result.refresh_token) {
      creds.refresh_token = result.refresh_token;
    }

    logger.info(
      { file: label, expiresIn: result.expires_in },
      'Google token refreshed',
    );
    return true;
  } catch (err) {
    logger.error({ file: label, err }, 'Google token refresh error');
    return false;
  }
}

async function refreshCredentialFile(
  filePath: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return;
  }
  if (!data || typeof data !== 'object') return;

  const fileName = path.basename(filePath);
  let changed = false;

  // Flat format: { access_token, refresh_token, expiry_date, ... } — used by gmail-mcp, google-drive-mcp
  if ('refresh_token' in (data as Record<string, unknown>)) {
    const creds = data as GoogleCredentials;
    if (await refreshOneCred(creds, clientId, clientSecret, fileName))
      changed = true;
  } else {
    // Account-keyed format: { <account>: { access_token, refresh_token, ... } } — used by cocal google-calendar-mcp
    for (const [account, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      if (!value || typeof value !== 'object') continue;
      const creds = value as GoogleCredentials;
      if (
        await refreshOneCred(
          creds,
          clientId,
          clientSecret,
          `${fileName}[${account}]`,
        )
      ) {
        changed = true;
      }
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

export async function refreshGoogleTokens(): Promise<void> {
  if (!fs.existsSync(GMAIL_MCP_DIR)) return;

  const client = loadClientCredentials();
  if (!client) return;

  const files = fs
    .readdirSync(GMAIL_MCP_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'gcp-oauth.keys.json');

  for (const file of files) {
    await refreshCredentialFile(
      path.join(GMAIL_MCP_DIR, file),
      client.clientId,
      client.clientSecret,
    );
  }
}

export function startGoogleTokenRefresh(): void {
  // No-op: tokens are refreshed on-demand before each container run
}
