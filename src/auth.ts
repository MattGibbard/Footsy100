// Passwordless sign-in: we email a one-time link, the browser exchanges the
// token for a session cookie.

import type { Env } from './env';

export const SESSION_COOKIE = 'f100_session';
const TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LINKS_PER_HOUR = 5;

export interface SessionUser {
  id: number;
  email: string;
  display_name: string;
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const sqlTime = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);

export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export async function requestLoginLink(env: Env, email: string, origin: string): Promise<{ devLink?: string }> {
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > datetime('now', '-1 hour')`,
  )
    .bind(email)
    .first<number>('n');
  if ((recent ?? 0) >= MAX_LINKS_PER_HOUR) throw new HttpError(429, 'Too many sign-in links requested. Try again later.');

  const token = randomToken();
  await env.DB.prepare('INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), email, sqlTime(new Date(Date.now() + TOKEN_TTL_MS)))
    .run();

  // The link opens the app, which then POSTs the token. A plain GET link would be
  // used up by email scanners that prefetch links.
  const link = `${(env.APP_URL || origin).replace(/\/$/, '')}/verify?token=${encodeURIComponent(token)}`;

  if (env.DEV_MODE === 'true' && !env.RESEND_API_KEY) return { devLink: link };
  if (!env.RESEND_API_KEY) throw new HttpError(500, 'Email sending is not configured');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'Footsy100 <onboarding@resend.dev>',
      to: [email],
      subject: 'Your Footsy100 sign-in link',
      text: `Sign in to Footsy100:\n\n${link}\n\nThis link expires in 15 minutes. If you didn't ask for it, ignore this email.`,
      html: `<p>Sign in to Footsy100:</p><p><a href="${link}">Sign in</a></p><p>This link expires in 15 minutes. If you didn't ask for it, ignore this email.</p>`,
    }),
  });
  if (!res.ok) throw new HttpError(502, 'Could not send the sign-in email');
  return {};
}

export async function verifyLoginToken(env: Env, token: string): Promise<{ sessionToken: string; user: SessionUser; isNew: boolean }> {
  const hash = await sha256(token);
  const claimed = await env.DB.prepare(
    `UPDATE login_tokens SET used_at = datetime('now')
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now') RETURNING email`,
  )
    .bind(hash)
    .first<{ email: string }>();
  if (!claimed) throw new HttpError(400, 'This sign-in link is invalid or has expired.');

  let user = await env.DB.prepare('SELECT id, email, display_name FROM users WHERE email = ?').bind(claimed.email).first<SessionUser>();
  let isNew = false;
  if (!user) {
    const name = claimed.email.split('@')[0].slice(0, 24);
    user = (await env.DB.prepare('INSERT INTO users (email, display_name) VALUES (?, ?) RETURNING id, email, display_name')
      .bind(claimed.email, name)
      .first<SessionUser>())!;
    isNew = true;
  }

  const sessionToken = randomToken();
  await env.DB.prepare('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(sessionToken), user.id, sqlTime(new Date(Date.now() + SESSION_TTL_MS)))
    .run();
  return { sessionToken, user, isNew };
}

export async function userForSession(env: Env, sessionToken: string | undefined): Promise<SessionUser | null> {
  if (!sessionToken) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > datetime('now')`,
  )
    .bind(await sha256(sessionToken))
    .first<SessionUser>();
}

export async function endSession(env: Env, sessionToken: string | undefined) {
  if (sessionToken) await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(sessionToken)).run();
}

export const SESSION_MAX_AGE_S = SESSION_TTL_MS / 1000;

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502,
    message: string,
  ) {
    super(message);
  }
}
