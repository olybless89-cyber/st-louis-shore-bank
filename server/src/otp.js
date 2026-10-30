import crypto from 'node:crypto';
import { pool } from './db.js';
import { sendMail, otpEmailHtml, otpEmailText, BRAND } from './mailer.js';

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

function genCode() {
  // 6-digit numeric, uniform, no modulo bias.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hash(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

// Create + email a fresh OTP. Invalidates any earlier unused codes for the
// same email+purpose so only the newest one works. Returns { sent }.
export async function issueOtp({ email, purpose = 'verify', name, userId = null }) {
  if (!email) throw new Error('email is required');
  const code = genCode();
  const expiresAt = new Date(Date.now() + TTL_MS);

  await pool.query(
    `UPDATE otp_codes SET used = true WHERE email = $1 AND purpose = $2 AND used = false`,
    [email, purpose]
  );
  await pool.query(
    `INSERT INTO otp_codes (email, user_id, purpose, code_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [email, userId, purpose, hash(code), expiresAt]
  );

  const displayName = name || email.split('@')[0];
  const res = await sendMail({
    to: email,
    subject: `${BRAND} — your verification code`,
    html: otpEmailHtml({ name: displayName, code, purpose }),
    text: otpEmailText({ name: displayName, code }),
  });
  return { sent: res.sent };
}

// Verify a submitted code. Returns { ok, reason, userId }.
export async function verifyOtp({ email, code, purpose = 'verify' }) {
  if (!email || !code) return { ok: false, reason: 'Code and email are required' };
  const { rows } = await pool.query(
    `SELECT id, user_id, code_hash, attempts, expires_at
       FROM otp_codes
      WHERE email = $1 AND purpose = $2 AND used = false
      ORDER BY created_at DESC
      LIMIT 1`,
    [email, purpose]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'No code found — request a new one' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'Code expired — request a new one' };
  if (row.attempts >= MAX_ATTEMPTS) {
    await pool.query(`UPDATE otp_codes SET used = true WHERE id = $1`, [row.id]);
    return { ok: false, reason: 'Too many attempts — request a new one' };
  }
  if (hash(String(code).trim()) !== row.code_hash) {
    await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return { ok: false, reason: 'Invalid code' };
  }
  await pool.query(`UPDATE otp_codes SET used = true WHERE id = $1`, [row.id]);
  return { ok: true, userId: row.user_id };
}
