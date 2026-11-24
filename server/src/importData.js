import pg from 'pg';
import { pool } from './db.js';

// Parents before children so foreign keys are satisfied.
export const TABLES = [
  'users',
  'profiles',
  'transactions',
  'deposit_requests',
  'transfer_requests',
  'loan_applications',
  'support_tickets',
  'payment_methods',
  'cards',
  'password_resets',
  'otp_codes',
  'tx_notifications',
];

export async function columnsOf(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

// Insert rows into a table without ever overwriting or deleting what's there
// (ON CONFLICT DO NOTHING). payment_methods is the exception: schema.sql seeds
// defaults, and the admin-edited values being restored must win.
export async function insertRows(table, rows) {
  if (!rows.length) return 0;
  const dstCols = new Set(await columnsOf(pool, table));
  const cols = Object.keys(rows[0]).filter((c) => dstCols.has(c));
  if (!cols.length) return 0;
  const conflict = table === 'payment_methods'
    ? `ON CONFLICT (id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}`
    : 'ON CONFLICT DO NOTHING';
  const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')})
               VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ${conflict}`;
  let inserted = 0;
  for (const row of rows) {
    const r = await pool.query(sql, cols.map((c) => {
      const v = row[c];
      return v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
    }));
    inserted += r.rowCount;
  }
  return inserted;
}

// One-time data copy from another Postgres (e.g. moving hosts).
// Set IMPORT_DATABASE_URL to the OLD database's public connection string.
// Safe to re-run; remove the variable once the copy is confirmed.
export async function importFromSource() {
  const src = process.env.IMPORT_DATABASE_URL;
  if (!src) return;

  const source = new pg.Client({
    connectionString: src,
    ssl: /localhost|127\.0\.0\.1|\.internal/.test(src) ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  await source.connect();
  console.log('Data import: connected to source database.');
  try {
    for (const table of TABLES) {
      const srcCols = await columnsOf(source, table);
      if (!srcCols.length) { console.log(`Data import: ${table} not in source, skipped.`); continue; }
      const { rows } = await source.query(`SELECT * FROM "${table}"`);
      const inserted = await insertRows(table, rows);
      console.log(`Data import: ${table} ${inserted}/${rows.length} rows copied.`);
    }
    console.log('Data import: finished.');
  } finally {
    await source.end();
  }
}
