import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool, runSchema, ensureDatabase, dbConfigured } from './db.js';

let dbReady = false;
import {
  signToken, hashPassword, verifyPassword, attachAuth, requireAuth, httpError,
  provisionNewUser, createPasswordReset, consumePasswordReset, sendResetLink,
} from './auth.js';
import { runSelect, runInsert, runUpdate, runUpsert } from './gateway.js';
import { RPCS, ANON_ALLOWED } from './rpc.js';
import { issueOtp, verifyOtp } from './otp.js';

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

// Always 200 so deploys go live; "db" tells you whether Postgres is wired up.
app.get('/health', (_req, res) => res.json({ ok: true, db: dbConfigured ? (dbReady ? 'ready' : 'connecting') : 'not_configured' }));

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
    // Fire a verification OTP email (best-effort — never blocks signup).
    issueOtp({ email, purpose: 'verify', name: fullName, userId }).catch((e) => console.error('signup OTP failed:', e.message));
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
  const { rows } = await pool.query(
    `SELECT u.id, u.password_hash, p.status
       FROM users u LEFT JOIN profiles p ON p.id = u.id
      WHERE u.email = $1`, [email]);
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw httpError(400, 'Invalid login credentials');
  }
  if (user.status === 'frozen') {
    throw httpError(403, 'Your account has been frozen. Please contact support.', 'ACCOUNT_FROZEN');
  }
  if (user.status === 'inactive') {
    throw httpError(403, 'Your account is inactive. Please contact support.', 'ACCOUNT_INACTIVE');
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
    const { rows } = await pool.query('SELECT u.id, p.full_name FROM users u LEFT JOIN profiles p ON p.id = u.id WHERE u.email=$1', [email]);
    if (rows[0]) {
      const token = await createPasswordReset(rows[0].id);
      const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
      // Emails the link when SMTP is configured; otherwise it's logged (so the
      // flow stays testable with no provider). See README for SMTP_* vars.
      sendResetLink(email, token, appUrl, rows[0].full_name).catch((e) => console.error('reset email failed:', e.message));
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

// ── OTP email verification ────────────────────────────────────────────────

// Send (or resend) an OTP to an email address. Always responds the same way
// whether or not the address is registered, so it can't be used to probe who
// has an account. `purpose`: "verify" (default), "login", or "reset".
app.post('/api/auth/send-otp', asyncRoute(async (req, res) => {
  const { email, purpose } = req.body || {};
  if (!email) throw httpError(400, 'email is required');
  const p = ['verify', 'login', 'reset'].includes(purpose) ? purpose : 'verify';
  const { rows } = await pool.query('SELECT u.id, p.full_name FROM users u LEFT JOIN profiles p ON p.id = u.id WHERE u.email = $1', [email]);
  const user = rows[0];
  // For "verify" we send even to brand-new signups; for login/reset only if the user exists.
  if (user || p === 'verify') {
    await issueOtp({ email, purpose: p, name: user?.full_name, userId: user?.id || null })
      .catch((e) => console.error('send-otp failed:', e.message));
  }
  res.json({ data: { sent: true }, error: null });
}));

// Verify a submitted OTP code.
app.post('/api/auth/verify-otp', asyncRoute(async (req, res) => {
  const { email, code, purpose } = req.body || {};
  const p = ['verify', 'login', 'reset'].includes(purpose) ? purpose : 'verify';
  const result = await verifyOtp({ email, code, purpose: p });
  if (!result.ok) throw httpError(400, result.reason || 'Invalid code');
  // Mark the profile verified on a successful "verify".
  if (p === 'verify' && result.userId) {
    await pool.query("UPDATE profiles SET kyc_status = CASE WHEN kyc_status='unverified' THEN 'email_verified' ELSE kyc_status END WHERE id = $1", [result.userId]).catch(() => {});
  }
  // Issue a session token when verifying by login OTP.
  const payload = { data: { verified: true }, error: null };
  if (p === 'login' && result.userId) {
    payload.data.session = { access_token: signToken(result.userId), user: { id: result.userId, email } };
  }
  res.json(payload);
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

// Open the port FIRST so the host's healthcheck passes immediately, then set
// up the database in the background (retrying while Postgres boots).
async function setupDatabase() {
  if (!dbConfigured) return;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await ensureDatabase().catch((err) => {
        console.error('ensureDatabase failed (assuming the database already exists):', err.message);
      });
      if (process.env.AUTO_MIGRATE !== 'false') await runSchema();
      else await pool.query('select 1');
      dbReady = true;
      console.log('Database ready.');
      return;
    } catch (err) {
      console.error(`Database setup attempt ${attempt}/10 failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, Math.min(3000 * attempt, 15000)));
    }
  }
  console.error('Database still unreachable — check DATABASE_URL. Site stays up; API calls will fail.');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`St Louis Shore Bank API+site listening on :${PORT}`);
  setupDatabase();
});
