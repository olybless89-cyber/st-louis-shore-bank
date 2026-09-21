import { pool } from './db.js';
import { httpError } from './auth.js';

function requireAdmin(auth) {
  if (!auth) throw httpError(401, 'Not authenticated');
  if (auth.role !== 'admin') throw httpError(403, 'Access denied: admins only', '42501');
}
function requireUser(auth) {
  if (!auth) throw httpError(401, 'Not authenticated', '42501');
}

function genRef(prefix) {
  return prefix + '-' + Math.random().toString(16).slice(2, 10);
}
function genCardFields() {
  let digits = '4';
  for (let i = 0; i < 15; i++) digits += Math.floor(Math.random() * 10);
  const exp = new Date();
  exp.setFullYear(exp.getFullYear() + 4);
  return {
    cardNumber: digits,
    expiryMonth: exp.getMonth() + 1,
    expiryYear: exp.getFullYear(),
    cvv: String(Math.floor(Math.random() * 1000)).padStart(3, '0'),
    pin: String(Math.floor(Math.random() * 10000)).padStart(4, '0'),
  };
}

// ── Users / status / KYC ───────────────────────────────────────────────────

async function admin_get_all_users(auth) {
  requireAdmin(auth);
  const { rows } = await pool.query('SELECT * FROM profiles ORDER BY created_at DESC');
  return rows;
}

async function admin_set_user_status(auth, { target_id, new_status }) {
  requireAdmin(auth);
  if (!['active', 'inactive'].includes(new_status)) throw httpError(400, 'Invalid status: use active or inactive', '22023');
  if (target_id === auth.id) throw httpError(400, 'You cannot change your own status', '44000');
  const { rowCount } = await pool.query('UPDATE profiles SET status=$1, updated_at=now() WHERE id=$2', [new_status, target_id]);
  if (!rowCount) throw httpError(404, 'User not found', 'P0002');
  return null;
}

async function admin_update_kyc(auth, { target_id, new_kyc_status }) {
  requireAdmin(auth);
  if (!['unverified', 'pending', 'verified', 'rejected'].includes(new_kyc_status)) {
    throw httpError(400, 'Invalid KYC status', '22023');
  }
  const { rowCount } = await pool.query('UPDATE profiles SET kyc_status=$1, updated_at=now() WHERE id=$2', [new_kyc_status, target_id]);
  if (!rowCount) throw httpError(404, 'User not found', 'P0002');
  return null;
}

async function admin_update_user_profile(auth, { target_uid, p_full_name, p_email, p_account_number, p_balance, p_transaction_limit }) {
  requireAdmin(auth);
  if (p_email != null && String(p_email).trim() === '') throw httpError(400, 'Email cannot be blank', '22023');
  if (p_full_name != null && String(p_full_name).trim() === '') throw httpError(400, 'Name cannot be blank', '22023');
  if (p_balance != null && p_balance < 0) throw httpError(400, 'Balance cannot be negative', '22023');
  if (p_transaction_limit != null && p_transaction_limit < 0) throw httpError(400, 'Transaction limit cannot be negative', '22023');

  if (p_email != null) {
    const { rowCount } = await pool.query('SELECT 1 FROM profiles WHERE email=$1 AND id<>$2', [p_email, target_uid]);
    if (rowCount) throw httpError(409, 'Another user already has that email', '23505');
  }
  if (p_account_number != null && String(p_account_number).trim() !== '') {
    const { rowCount } = await pool.query('SELECT 1 FROM profiles WHERE account_number=$1 AND id<>$2', [p_account_number, target_uid]);
    if (rowCount) throw httpError(409, 'Another user already has that account number', '23505');
  }

  const { rows } = await pool.query(
    `UPDATE profiles SET
       full_name = COALESCE($1, full_name),
       email = COALESCE($2, email),
       account_number = COALESCE($3, account_number),
       balance = COALESCE($4, balance),
       transaction_limit = COALESCE($5, transaction_limit),
       updated_at = now()
     WHERE id = $6 RETURNING *`,
    [p_full_name, p_email, p_account_number, p_balance, p_transaction_limit, target_uid]
  );
  if (!rows[0]) throw httpError(404, 'User not found', 'P0002');
  if (p_email != null) await pool.query('UPDATE users SET email=$1 WHERE id=$2', [p_email, target_uid]);
  return rows[0];
}

async function admin_delete_user(auth, { target_uid }) {
  requireAdmin(auth);
  if (target_uid === auth.id) throw httpError(400, 'You cannot delete your own account', '44000');
  const { rows } = await pool.query('SELECT role FROM profiles WHERE id=$1', [target_uid]);
  if (rows[0]?.role === 'admin') throw httpError(400, 'Cannot delete another admin account', '44000');
  const { rowCount } = await pool.query('DELETE FROM users WHERE id=$1', [target_uid]);
  if (!rowCount) throw httpError(404, 'User not found', 'P0002');
  return null;
}

// ── Balance / holds ─────────────────────────────────────────────────────────

async function admin_credit_user(auth, { target_id, amount, reason }) {
  requireAdmin(auth);
  if (!(amount > 0)) throw httpError(400, 'Amount must be positive', '22023');
  const { rowCount } = await pool.query('UPDATE profiles SET balance = balance + $1, updated_at = now() WHERE id=$2', [amount, target_id]);
  if (!rowCount) throw httpError(404, 'User not found', 'P0002');
  await pool.query(
    `INSERT INTO transactions (user_id, type, amount, status, description, reference) VALUES ($1,'credit',$2,'completed',$3,$4)`,
    [target_id, amount, reason || 'Admin credit', genRef('ADM')]
  );
  return null;
}

async function admin_hold_funds(auth, { target_id, amount, reason }) {
  requireAdmin(auth);
  if (!(amount > 0)) throw httpError(400, 'Amount must be positive', '22023');
  const { rowCount } = await pool.query(
    'UPDATE profiles SET balance = balance - $1, held_funds = held_funds + $1, updated_at = now() WHERE id=$2 AND balance >= $1',
    [amount, target_id]
  );
  if (!rowCount) throw httpError(404, 'User not found or insufficient balance', 'P0002');
  const { rows } = await pool.query(
    `INSERT INTO transactions (user_id, type, amount, status, description, reference, held)
     VALUES ($1,'hold',$2,'pending',$3,$4,true) RETURNING id`,
    [target_id, amount, reason || 'Admin hold', genRef('HLD')]
  );
  return rows[0].id;
}

async function admin_release_hold(auth, { hold_transaction_id }) {
  requireAdmin(auth);
  const { rows } = await pool.query(
    `SELECT user_id, amount FROM transactions WHERE id=$1 AND held=true AND type='hold'`,
    [hold_transaction_id]
  );
  if (!rows[0]) throw httpError(404, 'Held transaction not found', 'P0002');
  const { user_id, amount } = rows[0];
  await pool.query(
    'UPDATE profiles SET held_funds = GREATEST(held_funds - $1, 0), balance = balance + $1, updated_at = now() WHERE id=$2',
    [amount, user_id]
  );
  await pool.query(`UPDATE transactions SET held=false, status='completed' WHERE id=$1`, [hold_transaction_id]);
  return null;
}

async function admin_get_user_transactions(auth, { target_uid, filter_type, filter_status }) {
  requireAdmin(auth);
  const clauses = ['user_id = $1'];
  const params = [target_uid];
  if (filter_type) { params.push(filter_type); clauses.push(`type = $${params.length}`); }
  if (filter_status) { params.push(filter_status); clauses.push(`status = $${params.length}`); }
  const { rows } = await pool.query(`SELECT * FROM transactions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params);
  return rows;
}

async function admin_update_transaction(auth, { target_id, p_status, p_amount, p_created_at, p_description }) {
  requireAdmin(auth);
  const { rows: existing } = await pool.query('SELECT amount, user_id FROM transactions WHERE id=$1', [target_id]);
  if (!existing[0]) throw httpError(404, 'Transaction not found', 'P0002');
  const { rows } = await pool.query(
    `UPDATE transactions SET
       status = COALESCE($1, status),
       amount = COALESCE($2, amount),
       created_at = COALESCE($3, created_at),
       description = COALESCE($4, description)
     WHERE id = $5 RETURNING *`,
    [p_status, p_amount, p_created_at, p_description, target_id]
  );
  if (p_amount != null) {
    const delta = p_amount - existing[0].amount;
    if (delta !== 0) {
      await pool.query('UPDATE profiles SET balance = balance + $1, updated_at = now() WHERE id=$2', [delta, existing[0].user_id]);
    }
  }
  return rows[0];
}

// ── Deposit / transfer / loan review ────────────────────────────────────────

async function reviewRequest(auth, table, idField, id, new_status, note, creditDebit) {
  requireAdmin(auth);
  if (!['approved', 'rejected'].includes(new_status)) throw httpError(400, 'Invalid status: use approved or rejected', '22023');
  const { rows } = await pool.query(`SELECT user_id, amount, status FROM ${table} WHERE id=$1`, [id]);
  if (!rows[0]) throw httpError(404, `${table} row not found`, 'P0002');
  if (rows[0].status === 'approved') throw httpError(409, 'Already reviewed', '44000');
  await pool.query(`UPDATE ${table} SET status=$1, note=$2 WHERE id=$3`, [new_status, note ?? null, id]);
  if (new_status === 'approved') {
    const sign = creditDebit === 'credit' ? 1 : -1;
    await pool.query('UPDATE profiles SET balance = balance + $1, updated_at = now() WHERE id=$2', [sign * rows[0].amount, rows[0].user_id]);
  }
  return null;
}

async function admin_get_all_deposits(auth) {
  requireAdmin(auth);
  return (await pool.query('SELECT * FROM deposit_requests ORDER BY created_at DESC')).rows;
}
async function admin_get_deposit(auth, { d_id }) {
  requireAdmin(auth);
  return (await pool.query('SELECT * FROM deposit_requests WHERE id=$1', [d_id])).rows[0] || null;
}
async function admin_review_deposit(auth, { deposit_id, new_status, note }) {
  return reviewRequest(auth, 'deposit_requests', 'id', deposit_id, new_status, note, 'credit')
    .then(async (r) => {
      if (new_status === 'approved') {
        const { rows } = await pool.query('SELECT user_id, amount FROM deposit_requests WHERE id=$1', [deposit_id]);
        await pool.query(
          `INSERT INTO transactions (user_id, type, amount, status, description, reference) VALUES ($1,'deposit',$2,'completed','Deposit approved',$3)`,
          [rows[0].user_id, rows[0].amount, 'DEP-' + deposit_id]
        );
      }
      return r;
    });
}

async function admin_get_all_transfers(auth) {
  requireAdmin(auth);
  return (await pool.query('SELECT * FROM transfer_requests ORDER BY created_at DESC')).rows;
}
async function admin_get_transfer(auth, { t_id }) {
  requireAdmin(auth);
  return (await pool.query('SELECT * FROM transfer_requests WHERE id=$1', [t_id])).rows[0] || null;
}
async function admin_review_transfer(auth, { transfer_id, new_status, note }) {
  return reviewRequest(auth, 'transfer_requests', 'id', transfer_id, new_status, note, 'debit')
    .then(async (r) => {
      if (new_status === 'approved') {
        const { rows } = await pool.query('SELECT user_id, amount FROM transfer_requests WHERE id=$1', [transfer_id]);
        await pool.query(
          `INSERT INTO transactions (user_id, type, amount, status, description, reference) VALUES ($1,'transfer',$2,'completed','Transfer approved',$3)`,
          [rows[0].user_id, rows[0].amount, 'TRF-' + transfer_id]
        );
      }
      return r;
    });
}

async function admin_get_all_loans(auth) {
  requireAdmin(auth);
  return (await pool.query('SELECT * FROM loan_applications ORDER BY created_at DESC')).rows;
}
async function admin_get_loan(auth, { l_id }) {
  requireAdmin(auth);
  return (await pool.query('SELECT * FROM loan_applications WHERE id=$1', [l_id])).rows[0] || null;
}
async function admin_review_loan(auth, { loan_id, new_status, note }) {
  return reviewRequest(auth, 'loan_applications', 'id', loan_id, new_status, note, 'credit')
    .then(async (r) => {
      if (new_status === 'approved') {
        const { rows } = await pool.query('SELECT user_id, amount FROM loan_applications WHERE id=$1', [loan_id]);
        await pool.query(
          `INSERT INTO transactions (user_id, type, amount, status, description, reference) VALUES ($1,'loan',$2,'completed','Loan approved',$3)`,
          [rows[0].user_id, rows[0].amount, 'LOAN-' + loan_id]
        );
      }
      return r;
    });
}

// ── Tickets / webmail / live chat ───────────────────────────────────────────

async function admin_get_all_tickets(auth) {
  requireAdmin(auth);
  return (await pool.query('SELECT * FROM support_tickets ORDER BY created_at DESC')).rows;
}
async function admin_get_ticket(auth, { t_id }) {
  requireAdmin(auth);
  return (await pool.query('SELECT * FROM support_tickets WHERE id=$1', [t_id])).rows[0] || null;
}
async function admin_reply_ticket(auth, { ticket_id, reply, new_status }) {
  requireAdmin(auth);
  const { rowCount } = await pool.query(
    `UPDATE support_tickets SET admin_reply=$1, status=COALESCE($2,'closed'), updated_at=now() WHERE id=$3`,
    [reply, new_status, ticket_id]
  );
  if (!rowCount) throw httpError(404, 'Ticket not found', 'P0002');
  return null;
}
async function admin_send_message(auth, { target_user, p_subject, p_body, p_category }) {
  requireAdmin(auth);
  await pool.query(
    `INSERT INTO support_tickets (user_id, subject, message, category, admin_reply, status) VALUES ($1,$2,'Admin message',$3,$4,'closed')`,
    [target_user, p_subject, p_category || 'account', p_body]
  );
  return null;
}
async function admin_get_user_transactions_wrap(auth, args) {
  return admin_get_user_transactions(auth, args);
}
async function admin_append_ticket_message(auth, { ticket_id, msg, p_admin_reply, new_status }) {
  requireAdmin(auth);
  const { rows: cur } = await pool.query('SELECT message FROM support_tickets WHERE id=$1', [ticket_id]);
  if (!cur[0]) throw httpError(404, 'Ticket not found', 'P0002');
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const appended = `${cur[0].message || ''}\n---\n[admin] ${msg} [${stamp}]`;
  const { rows } = await pool.query(
    `UPDATE support_tickets SET message=$1, admin_reply=COALESCE($2,$3), status=COALESCE($4,status), updated_at=now() WHERE id=$5 RETURNING *`,
    [appended, p_admin_reply, msg, new_status, ticket_id]
  );
  return rows[0];
}
async function admin_set_ticket_status(auth, { ticket_id, new_status }) {
  requireAdmin(auth);
  await pool.query('UPDATE support_tickets SET status=$1, updated_at=now() WHERE id=$2', [new_status, ticket_id]);
  return null;
}

async function create_guest_ticket(_auth, { p_name, p_email, p_message }) {
  const name = String(p_name || '').trim().slice(0, 120);
  const email = String(p_email || '').trim().slice(0, 200);
  const message = String(p_message || '').trim().slice(0, 4000);
  if (!name || !email || !message) throw httpError(400, 'name, email and message are required', '22023');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'invalid email address', '22023');
  const { rows } = await pool.query(
    `INSERT INTO support_tickets (user_id, category, subject, message, status)
     VALUES (null,'general',$1,$2,'open') RETURNING id`,
    ['Guest enquiry from ' + name, message + `\n\n—\nFrom: ${name} <${email}>`]
  );
  return rows[0].id;
}

async function create_contact_message(_auth, { p_name, p_email, p_phone, p_message }) {
  const name = String(p_name || '').trim().slice(0, 120);
  const email = String(p_email || '').trim().slice(0, 200);
  const phone = String(p_phone || '').trim().slice(0, 60);
  const message = String(p_message || '').trim().slice(0, 4000);
  if (!name || !email || !message) throw httpError(400, 'name, email and message are required', '22023');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'invalid email address', '22023');
  const { rows } = await pool.query(
    `INSERT INTO support_tickets (user_id, category, subject, message, status)
     VALUES (null,'contact',$1,$2,'open') RETURNING id`,
    ['Contact form: ' + name, message + `\n\n—\nFrom: ${name} <${email}>` + (phone ? `\nPhone: ${phone}` : '')]
  );
  return rows[0].id;
}

// ── Wire codes ───────────────────────────────────────────────────────────

async function admin_get_wire_codes(auth, { target_uid }) {
  requireAdmin(auth);
  const { rows } = await pool.query('SELECT wire_codes FROM profiles WHERE id=$1', [target_uid]);
  const cfg = rows[0]?.wire_codes || { enabled: false };
  return { api_columns_ready: true, codes: cfg };
}
async function admin_set_wire_codes(auth, { target_uid, p_codes }) {
  requireAdmin(auth);
  const { rows } = await pool.query('UPDATE profiles SET wire_codes=$1, updated_at=now() WHERE id=$2 RETURNING *', [p_codes, target_uid]);
  if (!rows[0]) throw httpError(404, 'User not found', 'P0002');
  return rows[0];
}

async function submit_wire_transfer(auth, { p_amount, p_cost_code, p_tax_code, p_release_code }) {
  requireUser(auth);
  const { rows } = await pool.query('SELECT wire_codes FROM profiles WHERE id=$1', [auth.id]);
  const wc = rows[0]?.wire_codes;
  if (!wc || wc.enabled === false || wc.enabled == null) throw httpError(400, 'International wire codes are not enabled for this user', '44000');
  if (!(p_amount > 0)) throw httpError(400, 'Amount must be positive', '22023');

  const req_ = wc.require || { cost: true, tax: true, release: true };
  const need = {
    cost: req_.cost !== false && wc.require != null ? !!req_.cost : true,
    tax: req_.tax !== false && wc.require != null ? !!req_.tax : true,
    release: req_.release !== false && wc.require != null ? !!req_.release : true,
  };
  if (wc.require == null) { need.cost = true; need.tax = true; need.release = true; }

  if ((need.cost && !String(p_cost_code || '').trim()) ||
      (need.tax && !String(p_tax_code || '').trim()) ||
      (need.release && !String(p_release_code || '').trim())) {
    throw httpError(400, 'All required wire codes must be provided', '22023');
  }
  if (need.cost && wc.cost !== String(p_cost_code || '').trim()) throw httpError(400, 'Invalid cost-of-transfer code', 'P0004');
  if (need.tax && wc.tax !== String(p_tax_code || '').trim()) throw httpError(400, 'Invalid tax code', 'P0004');
  if (need.release && wc.release !== String(p_release_code || '').trim()) throw httpError(400, 'Invalid release code', 'P0004');

  const { rowCount } = await pool.query(
    'UPDATE profiles SET balance = balance - $1, held_funds = held_funds + $1, updated_at = now() WHERE id=$2 AND balance >= $1',
    [p_amount, auth.id]
  );
  if (!rowCount) throw httpError(400, 'Insufficient balance', 'P0002');

  const wireRef = genRef('WIRE');
  const { rows: reqRows } = await pool.query(
    `INSERT INTO transfer_requests (user_id, amount, recipient_name, recipient_account, bank_name, reason, note, status)
     VALUES ($1,$2,'International Wire','Wire Desk','St Louis Shore Bank','International wire (verified codes)',$3,'pending') RETURNING id`,
    [auth.id, p_amount, `Cost: ${p_cost_code}; Tax: ${p_tax_code}; Release: ${p_release_code}`]
  );
  await pool.query(
    `INSERT INTO transactions (user_id, type, amount, status, description, reference, held) VALUES ($1,'hold',$2,'pending','International wire fee hold',$3,true)`,
    [auth.id, p_amount, wireRef]
  );
  return { amount: p_amount, type: 'transfer', reference: wireRef, request_id: reqRows[0].id };
}

// ── Payment methods ──────────────────────────────────────────────────────

async function admin_get_payment_methods(auth) {
  requireAdmin(auth);
  const { rows } = await pool.query(
    `SELECT * FROM payment_methods ORDER BY CASE id WHEN 'bitcoin' THEN 1 WHEN 'bank_transfer' THEN 2 ELSE 3 END`
  );
  return rows;
}
async function get_active_payment_methods() {
  const { rows } = await pool.query(
    `SELECT id, wallet_address, network, bank_name, account_name, account_number, swift_bic, iban, bank_address, currency, paypal_email, instructions, updated_at
     FROM payment_methods WHERE active = true ORDER BY CASE id WHEN 'bitcoin' THEN 1 WHEN 'bank_transfer' THEN 2 ELSE 3 END`
  );
  return rows;
}
const PM_FIELDS = ['wallet_address', 'network', 'bank_name', 'account_name', 'account_number', 'swift_bic', 'iban', 'bank_address', 'currency', 'paypal_email', 'instructions'];
async function admin_update_payment_method(auth, { p_method, p_patch }) {
  requireAdmin(auth);
  if (!['bitcoin', 'bank_transfer', 'paypal'].includes(p_method)) throw httpError(400, 'Invalid payment method', '22023');
  if (!p_patch || typeof p_patch !== 'object') throw httpError(400, 'Invalid payload', '22023');
  const { rows } = await pool.query('SELECT * FROM payment_methods WHERE id=$1', [p_method]);
  const r = rows[0];
  if (!r) throw httpError(404, 'Payment method not found', 'P0002');

  const next = { ...r };
  if ('active' in p_patch) next.active = !!p_patch.active;
  for (const f of PM_FIELDS) {
    if (p_patch[f] != null && String(p_patch[f]).trim() !== '') next[f] = String(p_patch[f]).trim();
  }
  if (p_method === 'bitcoin' && !next.wallet_address) throw httpError(400, 'Bitcoin wallet address is required', '22023');
  if (p_method === 'bank_transfer' && (!next.bank_name || !next.account_name || !next.account_number)) {
    throw httpError(400, 'Bank name, account name and account number are required for Bank Transfer', '22023');
  }
  if (p_method === 'paypal') {
    if (!next.paypal_email) throw httpError(400, 'PayPal email is required', '22023');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.paypal_email)) throw httpError(400, 'Invalid PayPal email address', '22023');
  }
  const { rows: updated } = await pool.query(
    `UPDATE payment_methods SET active=$1, wallet_address=$2, network=$3, bank_name=$4, account_name=$5, account_number=$6,
       swift_bic=$7, iban=$8, bank_address=$9, currency=$10, paypal_email=$11, instructions=$12, updated_by=$13, updated_at=now()
     WHERE id=$14 RETURNING *`,
    [next.active, next.wallet_address, next.network, next.bank_name, next.account_name, next.account_number,
     next.swift_bic, next.iban, next.bank_address, next.currency, next.paypal_email, next.instructions, auth.id, p_method]
  );
  return updated[0];
}
async function admin_toggle_payment_method(auth, { p_method, p_active }) {
  requireAdmin(auth);
  if (!['bitcoin', 'bank_transfer', 'paypal'].includes(p_method)) throw httpError(400, 'Invalid payment method', '22023');
  const { rows } = await pool.query('UPDATE payment_methods SET active=$1, updated_by=$2, updated_at=now() WHERE id=$3 RETURNING *', [!!p_active, auth.id, p_method]);
  if (!rows[0]) throw httpError(404, 'Payment method not found', 'P0002');
  return rows[0];
}

// ── Cards ────────────────────────────────────────────────────────────────

async function get_my_card(auth) {
  requireUser(auth);
  const { rows } = await pool.query(
    'SELECT id, card_number, expiry_month, expiry_year, status, created_at FROM cards WHERE user_id=$1',
    [auth.id]
  );
  return rows;
}
async function admin_get_all_cards(auth) {
  requireAdmin(auth);
  return (await pool.query('SELECT * FROM cards ORDER BY created_at DESC')).rows;
}
async function admin_issue_card(auth, { target_uid }) {
  requireAdmin(auth);
  const { rowCount } = await pool.query('SELECT 1 FROM profiles WHERE id=$1', [target_uid]);
  if (!rowCount) throw httpError(404, 'User not found', 'P0002');
  const g = genCardFields();
  const { rows } = await pool.query(
    `INSERT INTO cards (user_id, card_number, expiry_month, expiry_year, cvv, pin, status)
     VALUES ($1,$2,$3,$4,$5,$6,'active')
     ON CONFLICT (user_id) DO UPDATE SET card_number=excluded.card_number, expiry_month=excluded.expiry_month,
       expiry_year=excluded.expiry_year, cvv=excluded.cvv, pin=excluded.pin, updated_at=now()
     RETURNING *`,
    [target_uid, g.cardNumber, g.expiryMonth, g.expiryYear, g.cvv, g.pin]
  );
  return rows[0];
}
async function admin_update_card(auth, { target_uid, p_card_number, p_expiry_month, p_expiry_year, p_cvv, p_status, p_pin }) {
  requireAdmin(auth);
  if (p_status != null && !['active', 'frozen', 'blocked'].includes(p_status)) throw httpError(400, 'Invalid status: use active, frozen or blocked', '22023');
  if (p_card_number != null && p_card_number.replace(/\D/g, '').length < 12) throw httpError(400, 'Card number looks too short', '22023');
  if (p_expiry_month != null && (p_expiry_month < 1 || p_expiry_month > 12)) throw httpError(400, 'Expiry month must be 1-12', '22023');
  if (p_pin != null && (!/^\d+$/.test(p_pin) || ![4, 6].includes(p_pin.length))) throw httpError(400, 'PIN must be 4 or 6 digits', '22023');
  const { rows } = await pool.query(
    `UPDATE cards SET card_number=COALESCE($1,card_number), expiry_month=COALESCE($2,expiry_month), expiry_year=COALESCE($3,expiry_year),
       cvv=COALESCE($4,cvv), status=COALESCE($5,status), pin=COALESCE($6,pin), updated_at=now()
     WHERE user_id=$7 RETURNING *`,
    [p_card_number, p_expiry_month, p_expiry_year, p_cvv, p_status, p_pin, target_uid]
  );
  if (!rows[0]) throw httpError(404, 'This user has no card on file yet — issue one first', 'P0002');
  return rows[0];
}
async function admin_set_card_status(auth, { target_uid, new_status }) {
  requireAdmin(auth);
  if (!['active', 'frozen', 'blocked'].includes(new_status)) throw httpError(400, 'Invalid status: use active, frozen or blocked', '22023');
  const { rowCount } = await pool.query('UPDATE cards SET status=$1, updated_at=now() WHERE user_id=$2', [new_status, target_uid]);
  if (!rowCount) throw httpError(404, 'This user has no card on file yet — issue one first', 'P0002');
  return null;
}

// ── Stats ────────────────────────────────────────────────────────────────

async function admin_get_stats(auth) {
  requireAdmin(auth);
  const q = (sql) => pool.query(sql).then((r) => r.rows[0].c);
  const [total_users, active_users, pending_transfers, pending_loans, pending_deposits, open_tickets, total_transactions] = await Promise.all([
    q('SELECT count(*)::int c FROM profiles'),
    q(`SELECT count(*)::int c FROM profiles WHERE status='active'`),
    q(`SELECT count(*)::int c FROM transfer_requests WHERE status='pending'`),
    q(`SELECT count(*)::int c FROM loan_applications WHERE status='pending'`),
    q(`SELECT count(*)::int c FROM deposit_requests WHERE status='pending'`),
    q(`SELECT count(*)::int c FROM support_tickets WHERE status IN ('open','pending')`),
    q('SELECT count(*)::int c FROM transactions'),
  ]);
  const sums = await pool.query('SELECT COALESCE(SUM(balance),0) total_balance, COALESCE(SUM(held_funds),0) total_held FROM profiles');
  return {
    total_users, active_users,
    total_balance: Number(sums.rows[0].total_balance),
    total_held: Number(sums.rows[0].total_held),
    pending_transfers, pending_loans, pending_deposits, open_tickets, total_transactions,
  };
}

async function admin_get_all_transactions(auth) {
  requireAdmin(auth);
  return (await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 500')).rows;
}

export const RPCS = {
  admin_get_all_users,
  admin_set_user_status,
  admin_update_kyc,
  admin_update_user_profile,
  admin_delete_user,
  admin_credit_user,
  admin_hold_funds,
  admin_release_hold,
  admin_get_user_transactions: admin_get_user_transactions_wrap,
  admin_update_transaction,
  admin_get_all_deposits,
  admin_get_deposit,
  admin_review_deposit,
  admin_get_all_transfers,
  admin_get_transfer,
  admin_review_transfer,
  admin_get_all_loans,
  admin_get_loan,
  admin_review_loan,
  admin_get_all_tickets,
  admin_get_ticket,
  admin_reply_ticket,
  admin_send_message,
  admin_append_ticket_message,
  admin_set_ticket_status,
  create_guest_ticket,
  create_contact_message,
  admin_get_wire_codes,
  admin_set_wire_codes,
  submit_wire_transfer,
  admin_get_payment_methods,
  get_active_payment_methods,
  admin_update_payment_method,
  admin_toggle_payment_method,
  get_my_card,
  admin_get_all_cards,
  admin_issue_card,
  admin_update_card,
  admin_set_card_status,
  admin_get_stats,
  admin_get_all_transactions,
};

// RPCs anyone can call without a session (matches `grant ... to anon` in the
// original schema for the two guest-form inserts and the public deposit
// method list).
export const ANON_ALLOWED = new Set(['create_guest_ticket', 'create_contact_message', 'get_active_payment_methods']);
