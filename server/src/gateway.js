import { pool } from './db.js';
import { httpError } from './auth.js';

// Mirrors the ownership rules the original Supabase RLS policies enforced —
// every table here is strictly "your own rows only" from the client; any
// cross-user read/write goes through an admin RPC (server/src/rpc.js)
// instead, exactly like the original SECURITY DEFINER functions.
//
// Note on `profiles.update`: the original RLS policy
// (`using (auth.uid()=id) with check (auth.uid()=id)`) technically let a
// user overwrite ANY column on their own row, including role/balance/status
// — a self-privilege-escalation hole. The client only ever used it for
// full_name/phone, so this rebuild closes that hole by allowing just those
// two columns; every balance/role/status change still goes through an admin
// RPC either way.
const POLICIES = {
  profiles: {
    ownColumn: 'id',
    select: { allowedColumns: null }, // null = full row (*), matches original usage
    update: { allowedColumns: ['full_name', 'phone'] },
  },
  transactions: {
    ownColumn: 'user_id',
    select: { allowedColumns: null },
  },
  deposit_requests: {
    ownColumn: 'user_id',
    select: { allowedColumns: null },
    insert: { allowedColumns: ['amount', 'method', 'reference'] },
  },
  transfer_requests: {
    ownColumn: 'user_id',
    select: { allowedColumns: null },
    insert: { allowedColumns: ['amount', 'recipient_name', 'recipient_account', 'bank_name', 'reason', 'note'] },
  },
  loan_applications: {
    ownColumn: 'user_id',
    select: { allowedColumns: null },
    insert: { allowedColumns: ['amount', 'term_months', 'purpose', 'monthly_income'] },
  },
  support_tickets: {
    ownColumn: 'user_id',
    select: { allowedColumns: null },
    // admin_reply is insertable (not just updatable) because register.html's
    // welcome-email trick creates an already-"replied" ticket in one insert
    // — same shape the original RLS/grants allowed.
    insert: { allowedColumns: ['category', 'subject', 'message', 'status', 'admin_reply'] },
    update: { allowedColumns: ['message', 'status'] },
  },
};

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
function assertIdent(name) {
  if (!IDENT_RE.test(name)) throw httpError(400, `Invalid identifier: ${name}`);
  return name;
}

function pickAllowed(values, allowedColumns) {
  if (!values || typeof values !== 'object') return {};
  if (!allowedColumns) return { ...values };
  const out = {};
  for (const col of allowedColumns) {
    if (Object.prototype.hasOwnProperty.call(values, col)) out[col] = values[col];
  }
  return out;
}

function buildWhere(filters, startIndex) {
  const clauses = [];
  const params = [];
  let i = startIndex;
  for (const f of filters || []) {
    if (f.op !== 'eq') continue; // only `.eq()` is used anywhere in this app
    assertIdent(f.col);
    clauses.push(`${f.col} = $${i}`);
    params.push(f.value);
    i++;
  }
  return { clauses, params, next: i };
}

export async function runSelect(table, auth, body) {
  const policy = POLICIES[table]?.select;
  if (!policy) throw httpError(403, `Table not allowed: ${table}`);
  if (!auth) throw httpError(401, 'Not authenticated');

  const cols = policy.allowedColumns ? policy.allowedColumns.join(', ') : '*';
  const own = POLICIES[table].ownColumn;
  const where = buildWhere(body?.filters, 2);
  const clauses = [`${own} = $1`, ...where.clauses];
  const params = [auth.id, ...where.params];

  let sql = `SELECT ${cols} FROM ${table} WHERE ${clauses.join(' AND ')}`;
  if (body?.order?.column) {
    assertIdent(body.order.column);
    sql += ` ORDER BY ${body.order.column} ${body.order.ascending === false ? 'DESC' : 'ASC'}`;
  }
  if (body?.limit) sql += ` LIMIT ${Number(body.limit) || 50}`;

  const { rows } = await pool.query(sql, params);

  if (body?.single) {
    if (rows.length === 0) return { data: null, error: { message: 'No rows found', code: 'PGRST116' } };
    return { data: rows[0], error: null };
  }
  if (body?.maybeSingle) {
    return { data: rows[0] || null, error: null };
  }
  return { data: rows, error: null };
}

// Tables a frozen account must not be able to write to (money movement).
const FROZEN_BLOCKED_INSERT = new Set(['deposit_requests', 'transfer_requests', 'loan_applications']);

async function assertNotFrozen(auth) {
  const { rows } = await pool.query('SELECT status FROM profiles WHERE id = $1', [auth.id]);
  const status = rows[0]?.status;
  if (status === 'frozen') throw httpError(403, 'Your account is frozen. This action is not allowed — please contact support.', 'ACCOUNT_FROZEN');
  if (status === 'inactive') throw httpError(403, 'Your account is inactive. This action is not allowed — please contact support.', 'ACCOUNT_INACTIVE');
}

export async function runInsert(table, auth, body) {
  const policy = POLICIES[table]?.insert;
  if (!policy) throw httpError(403, `Insert not allowed on: ${table}`);
  if (!auth) throw httpError(401, 'Not authenticated');
  if (FROZEN_BLOCKED_INSERT.has(table)) await assertNotFrozen(auth);

  const own = POLICIES[table].ownColumn;
  const values = pickAllowed(body?.values, policy.allowedColumns);
  values[own] = auth.id;

  const cols = Object.keys(values);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
  try {
    const { rows } = await pool.query(sql, cols.map((c) => values[c]));
    return { data: rows, error: null };
  } catch (err) {
    return { data: null, error: { message: err.message, code: err.code } };
  }
}

export async function runUpdate(table, auth, body) {
  const policy = POLICIES[table]?.update;
  if (!policy) throw httpError(403, `Update not allowed on: ${table}`);
  if (!auth) throw httpError(401, 'Not authenticated');

  const own = POLICIES[table].ownColumn;
  const values = pickAllowed(body?.values, policy.allowedColumns);
  const cols = Object.keys(values);
  if (cols.length === 0) return { data: [], error: null };

  const setClauses = cols.map((c, i) => `${c} = $${i + 1}`);
  const params = cols.map((c) => values[c]);
  let i = params.length + 1;

  // Own-row filter always applies, regardless of what the client sent.
  const whereClauses = [`${own} = $${i}`];
  params.push(auth.id);
  i++;

  // Extra filters (e.g. `.eq('id', ticketId)`) narrow further but can never
  // override ownership — every clause is AND-ed together.
  const extra = buildWhere(body?.filters, i);
  whereClauses.push(...extra.clauses);
  params.push(...extra.params);

  const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')} RETURNING *`;
  try {
    const { rows } = await pool.query(sql, params);
    return { data: rows, error: null };
  } catch (err) {
    return { data: null, error: { message: err.message, code: err.code } };
  }
}

// Only used for `profiles` as a "make sure my row exists" fallback, matching
// the client's `.upsert({id, role:'user', status:'active'}, {onConflict:'id'})`
// calls in login.html/dashboard.html. Deliberately ignores the role/status
// the client sent — those are never client-settable — and is a no-op if the
// row already exists.
export async function runUpsert(table, auth, _body) {
  if (table !== 'profiles') throw httpError(403, `Upsert not allowed on: ${table}`);
  if (!auth) throw httpError(401, 'Not authenticated');
  const { rows } = await pool.query('SELECT * FROM profiles WHERE id = $1', [auth.id]);
  if (rows[0]) return { data: [rows[0]], error: null };
  // Extremely defensive path — normally provisionNewUser() at signup already
  // created this row. Insert a bare-minimum profile so the page never hangs.
  const { rows: inserted } = await pool.query(
    `INSERT INTO profiles (id, role, status) VALUES ($1,'user','active')
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    [auth.id]
  );
  return { data: inserted, error: null };
}
