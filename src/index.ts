import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  HttpError,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  endSession,
  normaliseEmail,
  requestLoginLink,
  userForSession,
  verifyLoginToken,
  type SessionUser,
} from './auth';
import type { Env } from './env';
import { fplProvider } from './fpl';
import { createLeague, joinLeague, leaderboard, leagueDetail, leaveLeague, myLeagues, type Scope } from './leagues';
import { activeSeasonId, buy, ensureAccount, getPlayer, listFixtures, listPlayers, portfolio, recentTrades, sell } from './market';
import { SELL_FEE_BP, STARTING_CASH_PENCE } from './money';
import { WEIGHTS } from './pricing';
import { runLiveScores, runSyncRecorded, syncStatus } from './sync';

type App = { Bindings: Env; Variables: { user: SessionUser | null } };
const app = new Hono<App>().basePath('/api');

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Something went wrong' }, 500);
});

app.use('*', async (c, next) => {
  c.set('user', await userForSession(c.env, getCookie(c, SESSION_COOKIE)));
  await next();
});

function requireUser(c: Context<App>): SessionUser {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'Please sign in');
  return user;
}

// Same-origin check for state-changing requests (the session cookie is SameSite=Lax too).
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) throw new HttpError(403, 'Cross-site request blocked');
  }
  await next();
});

const intParam = (v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id');
  return n;
};
const scopeParam = (v: string | undefined): Scope => (v === 'alltime' ? 'alltime' : 'season');
const body = async (c: Context<App>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

// --- auth ---
app.post('/auth/request', async (c) => {
  const email = normaliseEmail((await body(c)).email);
  if (!email) throw new HttpError(400, 'Enter a valid email address');
  return c.json({ ok: true, ...(await requestLoginLink(c.env, email, new URL(c.req.url).origin)) });
});

app.post('/auth/verify', async (c) => {
  const token = (await body(c)).token;
  if (typeof token !== 'string' || !token) throw new HttpError(400, 'Missing token');
  const { sessionToken, user, isNew } = await verifyLoginToken(c.env, token);
  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
  return c.json({ user, is_new: isNew });
});

app.post('/auth/logout', async (c) => {
  await endSession(c.env, getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// --- me ---
app.get('/me', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ user: null });
  const seasonId = await c.env.DB.prepare('SELECT id FROM seasons WHERE active = 1').first<number>('id');
  if (seasonId) await ensureAccount(c.env.DB, user.id, seasonId);
  return c.json({ user });
});

app.post('/me', async (c) => {
  const user = requireUser(c);
  const name = String((await body(c)).display_name ?? '').trim();
  if (name.length < 2 || name.length > 24) throw new HttpError(400, 'Display name must be 2 to 24 characters');
  await c.env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, user.id).run();
  return c.json({ user: { ...user, display_name: name } });
});

// --- market ---
app.get('/config', (c) =>
  c.json({ starting_cash_pence: STARTING_CASH_PENCE, sell_fee_bp: SELL_FEE_BP, weights: WEIGHTS }),
);

app.get('/players', async (c) => c.json(await listPlayers(c.env.DB)));

app.get('/players/:id', async (c) => c.json(await getPlayer(c.env.DB, intParam(c.req.param('id')), c.get('user')?.id ?? null)));

app.get('/fixtures', async (c) => c.json(await listFixtures(c.env.DB)));

app.get('/portfolio', async (c) => c.json(await portfolio(c.env.DB, requireUser(c).id)));

app.get('/trades', async (c) => c.json({ trades: await recentTrades(c.env.DB, requireUser(c).id) }));

app.post('/trade', async (c) => {
  const user = requireUser(c);
  const b = await body(c);
  const playerId = intParam(String(b.player_id));
  if (b.side === 'buy') return c.json(await buy(c.env.DB, user.id, playerId, Number(b.amount_pence)));
  if (b.side === 'sell') {
    const shares = b.shares_micro === 'all' || b.shares_micro == null ? null : Number(b.shares_micro);
    return c.json(await sell(c.env.DB, user.id, playerId, shares));
  }
  throw new HttpError(400, "side must be 'buy' or 'sell'");
});

// --- leaderboards & leagues ---
app.get('/leaderboard', async (c) => {
  await activeSeasonId(c.env.DB);
  return c.json({ standings: await leaderboard(c.env.DB, scopeParam(c.req.query('scope'))) });
});

app.get('/leagues', async (c) => c.json({ leagues: await myLeagues(c.env.DB, requireUser(c).id) }));
app.post('/leagues', async (c) => c.json({ league: await createLeague(c.env.DB, requireUser(c).id, (await body(c)).name) }));
app.post('/leagues/join', async (c) => c.json({ league: await joinLeague(c.env.DB, requireUser(c).id, (await body(c)).code) }));
app.get('/leagues/:id', async (c) =>
  c.json(await leagueDetail(c.env.DB, requireUser(c).id, intParam(c.req.param('id')), scopeParam(c.req.query('scope')))),
);
app.post('/leagues/:id/leave', async (c) => {
  await leaveLeague(c.env.DB, requireUser(c).id, intParam(c.req.param('id')));
  return c.json({ ok: true });
});

// --- admin: run the data sync on demand ---
app.post('/admin/sync', async (c) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token || c.req.header('Authorization') !== `Bearer ${token}`) throw new HttpError(403, 'Forbidden');
  try {
    return c.json({ ok: true, ...(await runSyncRecorded(c.env.DB, fplProvider())) });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// Public health check: when data last synced and whether it worked.
app.get('/status', async (c) => c.json(await syncStatus(c.env.DB)));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const at = new Date(event.scheduledTime);
    // The cron runs every minute: the full sync on the quarter hour, live scores in between.
    if (at.getUTCMinutes() % 15 === 0) {
      ctx.waitUntil(
        runSyncRecorded(env.DB, fplProvider()).then(
          (r) => console.log('sync ok', JSON.stringify(r)),
          (e) => console.error('sync failed', e),
        ),
      );
    } else {
      ctx.waitUntil(
        runLiveScores(env.DB, fplProvider(), at).then(
          (events) => events.length && console.log('live scores refreshed', JSON.stringify(events)),
          (e) => console.error('live scores failed', e),
        ),
      );
    }
  },
} satisfies ExportedHandler<Env>;
