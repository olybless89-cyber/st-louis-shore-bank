import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pool } from './db.js';
import { TABLES, insertRows } from './importData.js';

// ── Encrypted GitHub backups ────────────────────────────────────────────
// Every change (debounced) and at least once an hour, the whole database is
// exported to JSON, gzipped, encrypted with AES-256-GCM and committed to a
// PRIVATE GitHub repo. Git history keeps every previous version, and a dated
// snapshot is written once a day. If the app boots against an EMPTY database
// it restores the latest backup automatically.
//
// Variables:
//   BACKUP_GITHUB_TOKEN   fine-grained token with Contents: read & write on the backup repo
//   BACKUP_GITHUB_REPO    owner/repo of the PRIVATE backup repo
//   BACKUP_ENCRYPTION_KEY long random secret; keep a copy offline — without it
//                         the backups cannot be decrypted
//   BACKUP_BRANCH         optional, default "main"
//   BACKUP_PATH           optional folder in the repo, default "st-louis-shore-bank"
//   BACKUP_INTERVAL_MINUTES optional, default 60
//   RESTORE_FROM_BACKUP   set "false" to disable auto-restore on an empty DB

// Short-lived codes are not worth keeping.
const SKIP = new Set(['otp_codes', 'password_resets']);

const cfg = () => ({
  token: process.env.BACKUP_GITHUB_TOKEN,
  repo: process.env.BACKUP_GITHUB_REPO,
  key: process.env.BACKUP_ENCRYPTION_KEY,
  branch: process.env.BACKUP_BRANCH || 'main',
  dir: (process.env.BACKUP_PATH || 'st-louis-shore-bank').replace(/^\/+|\/+$/g, ''),
});

export function backupConfigured() {
  const c = cfg();
  return Boolean(c.token && c.repo && c.key);
}

const keyBytes = (secret) => crypto.createHash('sha256').update(secret).digest();

export function encrypt(buf, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(secret), iv);
  const body = Buffer.concat([cipher.update(buf), cipher.final()]);
  // Layout: "SLSB1" | iv(12) | tag(16) | ciphertext
  return Buffer.concat([Buffer.from('SLSB1'), iv, cipher.getAuthTag(), body]);
}

export function decrypt(buf, secret) {
  if (buf.subarray(0, 5).toString() !== 'SLSB1') throw new Error('Not a St Louis Shore Bank backup file');
  const iv = buf.subarray(5, 17);
  const tag = buf.subarray(17, 33);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(33)), decipher.final()]);
}

async function gh(method, path, body, accept = 'application/vnd.github+json') {
  const c = cfg();
  const res = await fetch(`${process.env.BACKUP_GITHUB_API || 'https://api.github.com'}/repos/${c.repo}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'st-louis-shore-bank-backup',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function existingSha(path) {
  const c = cfg();
  const res = await gh('GET', `contents/${path}?ref=${encodeURIComponent(c.branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).sha;
}

async function putFile(path, content, message) {
  const c = cfg();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const sha = await existingSha(path);
    const res = await gh('PUT', `contents/${path}`, {
      message,
      content: content.toString('base64'),
      branch: c.branch,
      ...(sha ? { sha } : {}),
    });
    if (res.ok) return;
    if (res.status === 409 && attempt < 3) continue; // sha raced; retry
    throw new Error(`GitHub write ${path} failed: ${res.status} ${await res.text()}`);
  }
}

export async function exportAll() {
  const tables = {};
  for (const t of TABLES) {
    if (SKIP.has(t)) continue;
    const { rows } = await pool.query(`SELECT * FROM "${t}"`);
    tables[t] = rows;
  }
  return tables;
}

let lastHash = null;
// Becomes true once this process has confirmed it is not about to replace a
// bigger backup with a smaller one (e.g. a fresh empty DB after a crash).
let baselineOk = false;

async function downloadLatest() {
  const c = cfg();
  const res = await gh('GET', `contents/${c.dir}/latest.enc?ref=${encodeURIComponent(c.branch)}`, null, 'application/vnd.github.raw');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Backup download failed: ${res.status} ${await res.text()}`);
  const enc = Buffer.from(await res.arrayBuffer());
  return JSON.parse(zlib.gunzipSync(decrypt(enc, c.key)).toString());
}
let lastSnapshotDay = null;
let running = null;
let lastResult = { at: null, ok: null, message: 'No backup yet' };

export function backupStatus() {
  return { configured: backupConfigured(), ...lastResult };
}

export async function runBackup(reason = 'scheduled', { force = false } = {}) {
  if (!backupConfigured()) return { skipped: 'not configured' };
  if (running) return running;
  running = (async () => {
    try {
      const c = cfg();
      const tables = await exportAll();
      const json = JSON.stringify(tables);
      const hash = crypto.createHash('sha256').update(json).digest('hex');
      const today = new Date().toISOString().slice(0, 10);
      const changed = hash !== lastHash;
      if (!changed && !force && lastSnapshotDay === today) return { skipped: 'no changes' };

      if (!baselineOk) {
        const remote = await downloadLatest();
        const remoteUsers = remote?.tables?.users?.length || 0;
        if (remoteUsers > tables.users.length) {
          throw new Error(`Refusing to back up: GitHub backup has ${remoteUsers} users but this database has only ${tables.users.length}. `
            + 'Restore it first (empty the database and restart, or check RESTORE_FROM_BACKUP).');
        }
        baselineOk = true;
      }

      const payload = Buffer.from(JSON.stringify({
        app: 'st-louis-shore-bank', version: 1, created_at: new Date().toISOString(), tables,
      }));
      const enc = encrypt(zlib.gzipSync(payload), c.key);
      const counts = Object.entries(tables).map(([t, r]) => `${t}=${r.length}`).join(' ');

      if (changed || force) {
        await putFile(`${c.dir}/latest.enc`, enc, `Backup (${reason}) ${new Date().toISOString()}\n\n${counts}`);
      }
      if (lastSnapshotDay !== today) {
        await putFile(`${c.dir}/daily/${today}.enc`, enc, `Daily snapshot ${today}\n\n${counts}`);
        lastSnapshotDay = today;
      }
      lastHash = hash;
      lastResult = { at: new Date().toISOString(), ok: true, message: counts };
      console.log(`Backup to GitHub OK (${reason}): ${counts}`);
      return { ok: true, counts };
    } catch (err) {
      lastResult = { at: new Date().toISOString(), ok: false, message: err.message };
      console.error('Backup to GitHub FAILED:', err.message);
      return { ok: false, error: err.message };
    } finally {
      running = null;
    }
  })();
  return running;
}

// Debounce: many writes in a burst produce one backup ~60s after the last.
let debounceTimer = null;
export function scheduleBackupSoon(reason = 'data change') {
  if (!backupConfigured()) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runBackup(reason), Number(process.env.BACKUP_DEBOUNCE_MS) || 60_000);
}

export function startBackupLoop() {
  if (!backupConfigured()) {
    console.log('GitHub backup not configured (set BACKUP_GITHUB_TOKEN, BACKUP_GITHUB_REPO, BACKUP_ENCRYPTION_KEY).');
    return;
  }
  const minutes = Math.max(5, Number(process.env.BACKUP_INTERVAL_MINUTES) || 60);
  setInterval(() => runBackup('hourly'), minutes * 60_000).unref();
  setTimeout(() => runBackup('startup'), Number(process.env.BACKUP_STARTUP_DELAY_MS) || 30_000).unref();
  // Flush a pending debounced backup before the host stops the container.
  process.once('SIGTERM', async () => {
    if (debounceTimer) { clearTimeout(debounceTimer); await runBackup('shutdown'); }
    process.exit(0);
  });
  console.log(`GitHub backup enabled → ${cfg().repo} every ${minutes} min + after each change.`);
}

// Restore the latest backup, but ONLY when the database has no users at all —
// a fresh/empty database after a crash or a move. Never touches live data.
export async function restoreIfEmpty() {
  if (!backupConfigured() || process.env.RESTORE_FROM_BACKUP === 'false') return;
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;

  const data = await downloadLatest();
  if (!data) { console.log('Restore: database empty, no backup in GitHub yet.'); return; }
  console.log(`Restore: database empty — restoring backup from ${data.created_at}.`);
  for (const t of TABLES) {
    const list = data.tables[t];
    if (!list) continue;
    const n = await insertRows(t, list);
    console.log(`Restore: ${t} ${n}/${list.length} rows.`);
  }
  console.log('Restore: finished.');
}
