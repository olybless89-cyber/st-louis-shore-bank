import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool, runSchema, ensureDatabase } from './db.js';
import {
  signToken, hashPassword, verifyPassword, attachAuth, requireAuth, httpError,
  provisionNewUser, createPasswordReset, consumePasswordReset, logResetLink,
} from './auth.js';
import { runSelect, runInsert, runUpdate, runUpsert } from './gateway.js';
import { RPCS, ANON_ALLOWED } from './rpc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '2mb' }));

async function profilesLookup(userId) {
  const res = await pool.query('SELECT id, role FROM profiles WHERE id = $1', [userId]);
  return res.rows[0] || null;
}
app.use(attachAuth(profilesLookup));

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Auth ─────────────────────────────────────────────────────────────────

app.post('/api/auth/signup', asyncRoute(async (req, res) => {
  const { email, password, options } = req.body || {};
  if (!email || !password) throw httpError(400, 'email and password are required');
  if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  const fullName = options?.data?.full_name || '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let userId;
    try {
      const passwordHash = await hashPassword(password);
      const { rows } = await client.query('INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id', [email, passwordHash]);
      userId = rows[0].id;
    } catch (err) {
      if (err.code === '23505') throw httpError(400, 'Email is already registered');
      throw err;
    }
    await provisionNewUser(client, userId, email, fullName);
    await client.query('COMMIT');
    const token = signToken(userId);
    res.json({ data: { user: { id: userId, email }, session: { access_token: token, user: { id: userId, email } } }, error: null });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/api/auth/signin', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw httpError(400, 'email and password are required');
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw httpError(400, 'Invalid login credentials');
  }
  const token = signToken(user.id);
  res.json({ data: { user: { id: user.id, email }, session: { access_token: token, user: { id: user.id, email } } }, error: null });
}));

app.post('/api/auth/update-password', requireAuth, asyncRoute(async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  const hash = await hashPassword(password);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.auth.id]);
  res.json({ data: {}, error: null });
}));

app.post('/api/auth/forgot-password', asyncRoute(async (req, res) => {
  const { email } = req.body || {};
  // Always the same response, whether or not the address is registered —
  // matches the original resetPasswordForEmail() behavior.
  if (email) {
    const { rows } = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (rows[0]) {
      const token = await createPasswordReset(rows[0].id);
      const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
      logResetLink(email, token, appUrl);
      // No email provider is wired up yet — see README-RAILWAY-MIGRATION.md.
      // The link above is logged server-side so this flow is fully testable
      // today; plug in Resend/SES/Postmark here once you've picked one.
    }
  }
  res.json({ data: {}, error: null });
}));

app.post('/api/auth/verify-reset-token', asyncRoute(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: { message: 'Invalid or expired link' } });
  const crypto = await import('node:crypto');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await pool.query(
    `SELECT u.email FROM password_resets pr JOIN users u ON u.id = pr.user_id
     WHERE pr.token_hash=$1 AND pr.used=false AND pr.expires_at > now()`,
    [tokenHash]
  );
  if (!rows[0]) return res.status(400).json({ error: { message: 'Invalid or expired link' } });
  res.json({ data: { email: rows[0].email }, error: null });
}));

app.post('/api/auth/reset-password', asyncRoute(async (req, res) => {
  const { token, password } = req.body || {};
  if (!password || password.length < 8) throw httpError(400, 'New password must be at least 8 characters');
  const userId = await consumePasswordReset(token);
  if (!userId) throw httpError(400, 'Invalid or expired link');
  const hash = await hashPassword(password);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
  res.json({ data: {}, error: null });
}));

// ── Generic data gateway (mirrors the supabase-js query builder) ──────────

app.post('/api/data/:table/select', asyncRoute(async (req, res) => {
  res.json(await runSelect(req.params.table, req.auth, req.body || {}));
}));
app.post('/api/data/:table/insert', asyncRoute(async (req, res) => {
  res.json(await runInsert(req.params.table, req.auth, req.body || {}));
}));
app.post('/api/data/:table/update', asyncRoute(async (req, res) => {
  res.json(await runUpdate(req.params.table, req.auth, req.body || {}));
}));
app.post('/api/data/:table/upsert', asyncRoute(async (req, res) => {
  res.json(await runUpsert(req.params.table, req.auth, req.body || {}));
}));

// ── RPC dispatch ─────────────────────────────────────────────────────────

app.post('/api/rpc/:name', asyncRoute(async (req, res) => {
  const fn = RPCS[req.params.name];
  if (!fn) throw httpError(404, `Unknown function: ${req.params.name}`, 'PGRST202');
  if (!ANON_ALLOWED.has(req.params.name) && !req.auth) throw httpError(401, 'Not authenticated', '42501');
  const data = await fn(req.auth, req.body || {});
  res.json({ data, error: null });
}));

// ── Errors ──────────────────────────────────────────────────────────────

// Flat error shape ({message, code}, no wrapper) — matches PostgREST's real
// error responses, which the hand-written fetch() calls in chat-widget.js
// and contact.html (never went through the Supabase SDK) already expect.
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ message: err.message || 'Internal error', code: err.code });
});

// ── Static site (clean-URL rewrites, matches vercel.json) ─────────────────

const REWRITES = {
  '/': '/index.html',
  '/business': '/business.html',
  '/personal': '/personal.html',
  '/cards': '/cards.html',
  '/loans': '/loans.html',
  '/contact': '/contact.html',
  '/login': '/login.html',
  '/register': '/register.html',
  '/forgot-password': '/forgot-password.html',
  '/reset-password': '/reset-password.html',
  '/about': '/about.html',
  '/faq': '/faq.html',
  '/apps': '/apps.html',
  '/privacy-policy': '/privacy-policy.html',
  '/terms-of-service': '/terms-of-service.html',
  '/dashboard': '/dashboard.html',
  '/admin-login': '/admin-login.html',
  '/admin/login': '/admin-login.html',
  '/admin': '/admin.html',
};

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], cacheControl: false }));

app.get('*', (req, res) => {
  let p = req.path;
  if (p.startsWith('/admin/') && p !== '/admin/login') p = '/admin.html';
  if (REWRITES[p]) p = REWRITES[p];
  const fp = path.join(PUBLIC_DIR, p);
  if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    return res.sendFile(fp);
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 8080;

async function start() {
  await ensureDatabase().catch((err) => {
    console.error('ensureDatabase failed (continuing — assuming the target database already exists):', err.message);
  });
  if (process.env.AUTO_MIGRATE !== 'false') {
    await runSchema().catch((err) => console.error('Schema migration failed:', err.message));
  }
  app.listen(PORT, () => console.log(`St Louis Shore Bank API+site listening on :${PORT}`));
}

start();
