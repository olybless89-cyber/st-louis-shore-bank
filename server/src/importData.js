import pg from 'pg';
import { pool } from './db.js';

// One-time data copy from another Postgres (e.g. moving Railway -> Render).
// Set IMPORT_DATABASE_URL to the OLD database's public connection string.
// Every row is inserted with ON CONFLICT DO NOTHING, so re-running is safe:
// nothing in the new database is ever overwritten or deleted. Remove the
// variable once the copy is confirmed.

// Parents before children so foreign keys are satisfied.
const TABLES = [
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

async function columnsOf(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

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
      const dstCols = new Set(await columnsOf(pool, table));
      const cols = srcCols.filter((c) => dstCols.has(c));
      const { rows } = await source.query(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM "${table}"`);
      if (!rows.length) { console.log(`Data import: ${table} 0 rows.`); continue; }

      // payment_methods is seeded with defaults by schema.sql; the source's
      // admin-edited values must win, so that one table is upserted.
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
      console.log(`Data import: ${table} ${inserted}/${rows.length} rows copied.`);
    }
    console.log('Data import: finished.');
  } finally {
    await source.end();
  }
}
