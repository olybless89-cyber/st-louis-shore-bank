import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';


// Never crash on a missing secret. Fallback is derived from DATABASE_URL so
// logins survive restarts; set JWT_SECRET yourself for production.
const JWT_SECRET =
  process.env.JWT_SECRET ||
  crypto.createHash('sha256').update('stlsb:' + (process.env.DATABASE_URL || crypto.randomBytes(32).toString('hex'))).digest('hex');
if (!process.env.JWT_SECRET) {
  console.error('⚠️  JWT_SECRET is not set — using a derived fallback. Set JWT_SECRET (openssl rand -base64 48).');
}

export function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '30d' });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Middleware: parses the bearer token (if any) and loads { id, role } onto
// req.auth. Does not reject unauthenticated requests — routes that require
// a session use requireAuth/requireAdmin below.
export function attachAuth(profilesLookup) {
  return async (req, _res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      const payload = token && verifyToken(token);
      if (payload) {
        const profile = await profilesLookup(payload.sub);
        if (profile) req.auth = { id: profile.id, role: profile.role };
      }
    } catch (err) {
      console.error('attachAuth error:', err.message);
    }
    next();
  };
}

export function requireAuth(req, _res, next) {
  if (!req.auth) return next(httpError(401, 'Not authenticated'));
  next();
}

export function requireAdmin(req, _res, next) {
  if (!req.auth) return next(httpError(401, 'Not authenticated'));
  if (req.auth.role !== 'admin') return next(httpError(403, 'Access denied: admins only', '42501'));
  next();
}

export function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

// ── New-user provisioning (replaces the Postgres triggers on auth.users) ──
// Mints a 10-digit numeric account number and a fake virtual card, matching
// handle_new_user() / handle_new_user_card() from the original schema.
function genAccountNumber() {
  let acct = '';
  for (let i = 0; i < 10; i++) acct += Math.floor(Math.random() * 10);
  return acct;
}

function genCardFields() {
  let digits = '4'; // Visa-style leading digit, purely cosmetic
  for (let i = 0; i < 15; i++) digits += Math.floor(Math.random() * 10);
  const exp = new Date();
  exp.setFullYear(exp.getFullYear() + 4);
  const cvv = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const pin = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return { cardNumber: digits, expiryMonth: exp.getMonth() + 1, expiryYear: exp.getFullYear(), cvv, pin };
}

export async function provisionNewUser(client, userId, email, fullName) {
  let accountNumber = genAccountNumber();
  // Extremely unlikely, but keep account numbers unique.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rowCount } = await client.query('SELECT 1 FROM profiles WHERE account_number = $1', [accountNumber]);
    if (rowCount === 0) break;
    accountNumber = genAccountNumber();
  }
  await client.query(
    `INSERT INTO profiles (id, email, full_name, role, status, account_number)
     VALUES ($1,$2,$3,'user','active',$4)
     ON CONFLICT (id) DO NOTHING`,
    [userId, email, fullName || '', accountNumber]
  );
  const card = genCardFields();
  await client.query(
    `INSERT INTO cards (user_id, card_number, expiry_month, expiry_year, cvv, pin, status)
     VALUES ($1,$2,$3,$4,$5,$6,'active')
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, card.cardNumber, card.expiryMonth, card.expiryYear, card.cvv, card.pin]
  );
}

// ── Password reset (replaces Supabase Auth's resetPasswordForEmail/recover) ─
// No email provider is wired up yet (see README) — the raw reset link is
// logged server-side so this is testable end-to-end today; swap
// logResetLink() for a real send once you've picked a provider.
export async function createPasswordReset(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
    [userId, tokenHash, expiresAt]
  );
  return token;
}

export async function consumePasswordReset(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await pool.query(
    `SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used = false AND expires_at > now()`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) return null;
  await pool.query(`UPDATE password_resets SET used = true WHERE id = $1`, [row.id]);
  return row.user_id;
}

export async function sendResetLink(email, token, appUrl, name) {
  const link = `${appUrl.replace(/\/$/, '')}/reset-password?token=${token}`;
  const { sendMail, BRAND } = await import('./mailer.js');
  await sendMail({
    to: email,
    subject: `${BRAND} — reset your password`,
    text: `Hello ${name || 'there'}\n\nUse this link to reset your password (valid for 1 hour):\n${link}\n\nIf you didn't request this, you can ignore this email.\n\n${BRAND}`,
    html: `<!doctype html><html><body style="margin:0;background:#f1f1f1;font-family:Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f1;padding:24px 0;"><tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:8px;overflow:hidden;">
          <tr><td style="background:#0b2e13;padding:20px 32px;color:#fff;font-size:18px;font-weight:bold;">${BRAND}</td></tr>
          <tr><td style="padding:20px 32px 0;color:#111;font-size:22px;font-weight:bold;">Hello ${(name || 'there').replace(/[<>&]/g,'')}</td></tr>
          <tr><td style="padding:14px 32px 0;color:#222;font-size:15px;line-height:1.5;">You asked to reset your password. Click the button below — this link is valid for 1 hour.</td></tr>
          <tr><td style="padding:24px 32px;"><a href="${link}" style="background:#0b2e13;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:15px;display:inline-block;">Reset password</a></td></tr>
          <tr><td style="padding:0 32px 28px;color:#888;font-size:13px;">If you didn't request this, you can safely ignore this email.</td></tr>
        </table></td></tr></table></body></html>`,
  });
  console.log(`[password reset] link issued to ${email}`);
  return link;
}

// ── Admin bootstrap from environment ──────────────────────────────────────
// If ADMIN_EMAIL and ADMIN_PASSWORD are set, ensure that admin exists on boot.
// Idempotent: creates the account if missing (with a profile + role=admin); if
// it already exists it only re-asserts role=admin and does NOT overwrite the
// password — so the admin can change their password later without a deploy
// resetting it. Set ADMIN_RESET_PASSWORD=true once to force-reset it.
export async function ensureAdminFromEnv() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    let userId;
    if (rows[0]) {
      userId = rows[0].id;
      if (process.env.ADMIN_RESET_PASSWORD === 'true') {
        await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(password), userId]);
        console.log(`Admin password reset for ${email}`);
      }
    } else {
      const hash = await hashPassword(password);
      const r = await client.query('INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id', [email, hash]);
      userId = r.rows[0].id;
      await provisionNewUser(client, userId, email, 'Administrator');
      console.log(`Admin account created: ${email}`);
    }
    await client.query("UPDATE profiles SET role = 'admin', status = 'active', updated_at = now() WHERE id = $1", [userId]);
    await client.query('COMMIT');
    console.log(`Admin ensured: ${email}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('ensureAdminFromEnv failed:', err.message);
  } finally {
    client.release();
  }
}
