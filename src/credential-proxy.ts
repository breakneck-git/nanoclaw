/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// HTTP statuses Anthropic returns when the request was rejected before any
// inference ran (overloaded / unavailable / rate-limited). Safe to replay.
const RETRYABLE_STATUS = new Set([429, 503, 529]);
const PROXY_MAX_RETRIES = 3;
const RETRY_AFTER_CAP_MS = 10_000;

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into ms, clamped
 * to a sane cap so a hostile/huge value can't stall the container near its
 * hard timeout. Returns undefined if absent/unparseable (caller falls back
 * to exponential backoff).
 */
function parseRetryAfterMs(
  header: string | string[] | undefined,
): number | undefined {
  if (!header) return undefined;
  const v = Array.isArray(header) ? header[0] : header;
  const secs = Number(v);
  if (Number.isFinite(secs)) {
    return Math.min(Math.max(secs, 0) * 1000, RETRY_AFTER_CAP_MS);
  }
  const when = Date.parse(v);
  if (!Number.isNaN(when)) {
    return Math.min(Math.max(when - Date.now(), 0), RETRY_AFTER_CAP_MS);
  }
  return undefined;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  // Sentinel value returned as a fake API key when the OAuth token lacks
  // org:create_api_key scope. Subsequent requests using this sentinel are
  // forwarded with Authorization: Bearer instead of x-api-key.
  const OAUTH_SENTINEL = 'nanoclaw-oauth-direct';

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // OAuth mode: intercept create_api_key — return sentinel when the token
        // lacks org:create_api_key scope (e.g. claude.ai Pro subscription).
        if (
          authMode === 'oauth' &&
          req.url?.includes('/api/oauth/claude_cli/create_api_key')
        ) {
          const mock = JSON.stringify({ api_key: OAUTH_SENTINEL });
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(mock),
          });
          res.end(mock);
          return;
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
          // Sentinel API key → convert to Bearer for direct OAuth inference
          if (headers['x-api-key'] === OAUTH_SENTINEL) {
            delete headers['x-api-key'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        // Anthropic returns 529 (overloaded), 503 and 429 as immediate
        // HTTP-level rejections BEFORE any inference runs — the request was
        // not processed, so replaying the buffered body is safe (no double
        // charge, no duplicate side effects). Retry transparently with
        // exponential backoff so a momentary capacity blip doesn't surface
        // to the user as a failed turn. We only retry while nothing has
        // been written to the client yet (never mid-stream).
        const attemptUpstream = (attempt: number) => {
          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              const status = upRes.statusCode ?? 0;
              if (
                RETRYABLE_STATUS.has(status) &&
                attempt < PROXY_MAX_RETRIES &&
                !res.headersSent
              ) {
                upRes.resume(); // drain & discard so the socket frees
                const backoff =
                  parseRetryAfterMs(upRes.headers['retry-after']) ??
                  Math.min(1000 * 2 ** attempt, 8000);
                logger.warn(
                  {
                    url: req.url,
                    status,
                    attempt: attempt + 1,
                    backoffMs: backoff,
                  },
                  'Upstream transient error; retrying after backoff',
                );
                setTimeout(() => attemptUpstream(attempt + 1), backoff);
                return;
              }
              res.writeHead(status, upRes.headers);
              upRes.pipe(res);
            },
          );

          upstream.on('error', (err: NodeJS.ErrnoException) => {
            // ECONNREFUSED / ENOTFOUND mean nothing is listening or DNS is
            // wrong — a config error that won't fix itself in a few seconds.
            // Fail fast. Only retry transient transport faults (reset,
            // timeout, transient DNS) which co-occur with capacity blips.
            const transient =
              err.code === 'ECONNRESET' ||
              err.code === 'ETIMEDOUT' ||
              err.code === 'EAI_AGAIN' ||
              err.code === 'EPIPE';
            if (transient && attempt < PROXY_MAX_RETRIES && !res.headersSent) {
              const backoff = Math.min(1000 * 2 ** attempt, 8000);
              logger.warn(
                { err, url: req.url, attempt: attempt + 1, backoffMs: backoff },
                'Upstream connection error; retrying after backoff',
              );
              setTimeout(() => attemptUpstream(attempt + 1), backoff);
              return;
            }
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        };

        attemptUpstream(0);
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
