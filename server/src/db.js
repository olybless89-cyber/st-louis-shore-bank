import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Attach a Railway Postgres service and reference it as DATABASE_URL.');
  process.exit(1);
}

const useSsl = /sslmode=require/.test(connectionString) || process.env.PGSSL === 'true';

export const pool = new pg.Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function runSchema() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema applied.');
}

// Lets this API share one Postgres *service* with other apps instead of
// needing a dedicated Postgres service of its own: DATABASE_URL points at a
// database name specific to this app (e.g. "stlouisshorebank") on that
// shared server, and DATABASE_ADMIN_URL is a connection string to any
// database that already exists there (Railway's Postgres template exposes
// this as ${{Postgres.DATABASE_URL}}, its own default database). On boot,
// if the target database doesn't exist yet, it's created once here — after
// that this is a no-op every subsequent deploy.
//
// If DATABASE_ADMIN_URL isn't set, this is skipped entirely and DATABASE_URL
// is assumed to already point at an existing, ready-to-use database — the
// original behavior (a dedicated Postgres service per app).
export async function ensureDatabase() {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) return;

  let dbName;
  try {
    dbName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  } catch {
    return;
  }
  if (!dbName) return;

  const admin = new pg.Client({
    connectionString: adminUrl,
    ssl: /sslmode=require/.test(adminUrl) ? { rejectUnauthorized: false } : undefined,
  });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`ensureDatabase: created database "${dbName}" on the shared Postgres instance.`);
    }
  } finally {
    await admin.end();
  }
}
