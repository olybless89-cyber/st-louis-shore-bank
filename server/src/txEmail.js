// Transaction notification emails — one master template, dynamic content,
// status-specific styling. Sends via the existing SMTP mailer; logs instead
// when SMTP isn't configured. Idempotent per (transaction, status).
import { pool } from './db.js';
import { sendMail, BRAND, SUPPORT_EMAIL, SUPPORT_PHONE, WEBSITE } from './mailer.js';

const DEFAULT_CURRENCY = process.env.BANK_CURRENCY || 'USD';
const DASHBOARD_URL = (process.env.APP_URL || process.env.PUBLIC_URL || '').replace(/\/$/, '');

// ── helpers ────────────────────────────────────────────────────────────────
function esc(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatAmount(amount, currency = DEFAULT_CURRENCY) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function formatDate(d) {
  const date = d ? new Date(d) : new Date();
  try {
    return new Intl.DateTimeFormat('en', {
      dateStyle: 'medium', timeStyle: 'short',
      timeZone: process.env.BANK_TIMEZONE || 'UTC',
    }).format(date) + (process.env.BANK_TIMEZONE ? '' : ' UTC');
  } catch {
    return date.toISOString();
  }
}

// Mask all but the last 4 of an account/card-like value.
function mask(value) {
  if (!value) return '';
  const s = String(value).replace(/\s+/g, '');
  if (s.length <= 4) return s;
  return '••••' + s.slice(-4);
}

const TYPE_LABELS = {
  credit: 'Account Credit', deposit: 'Deposit', transfer: 'Transfer',
  withdrawal: 'Withdrawal', loan: 'Loan Disbursement', loan_repayment: 'Loan Repayment',
  refund: 'Refund', reversal: 'Reversal', hold: 'Funds Hold', card: 'Card Payment',
  bill: 'Bill Payment', airtime: 'Airtime Purchase', data: 'Data Subscription',
  wire: 'International Transfer', exchange: 'Currency Exchange',
};
function typeLabel(type) {
  if (!type) return 'Transaction';
  return TYPE_LABELS[type] || type.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// status → normalized bucket + colors + customer message
function statusInfo(status) {
  const s = String(status || '').toLowerCase();
  if (['successful', 'success', 'completed', 'complete', 'approved', 'done'].includes(s)) {
    return { key: 'successful', label: 'Successful', color: '#16a34a', bg: '#f0fdf4',
      message: 'Your transaction has been successfully processed. Below are the transaction details:' };
  }
  if (['failed', 'rejected', 'declined', 'error'].includes(s)) {
    return { key: 'failed', label: 'Failed', color: '#dc2626', bg: '#fef2f2',
      message: 'Unfortunately, your transaction could not be completed. Please review the transaction details below.' };
  }
  if (['pending', 'processing', 'in_progress'].includes(s)) {
    return { key: 'pending', label: s === 'processing' ? 'Processing' : 'Pending', color: '#d97706', bg: '#fffbeb',
      message: 'Your transaction is currently being processed. We will notify you once its status has been updated.' };
  }
  if (['reversed', 'refunded'].includes(s)) {
    return { key: 'reversed', label: s === 'refunded' ? 'Refunded' : 'Reversed', color: '#2563eb', bg: '#eff6ff',
      message: s === 'refunded'
        ? 'Your transaction has been refunded. Below are the details:'
        : 'Your transaction has been reversed. Below are the details:' };
  }
  return { key: 'info', label: status || 'Update', color: '#334155', bg: '#f8fafc',
    message: 'Here is an update on your recent transaction:' };
}

function heading(type, info) {
  const t = typeLabel(type);
  if (info.key === 'successful') {
    if (/deposit/i.test(t)) return 'Deposit Successfully Received';
    if (/credit/i.test(t)) return 'Account Credited Successfully';
    return `${t} Successfully Processed`;
  }
  if (info.key === 'pending') return `${t} Pending`;
  if (info.key === 'failed') return `${t} Failed`;
  if (info.key === 'reversed') {
    if (info.label === 'Refunded') return /refund/i.test(t) ? 'Refund Successfully Processed' : `${t} Refunded`;
    return /revers/i.test(t) ? 'Reversal Successfully Processed' : `${t} Reversed`;
  }
  return `${t} — ${info.label}`;
}

// Build the ordered list of detail rows, skipping empty/irrelevant values.
function detailRows(ctx, info) {
  const currency = ctx.currency || DEFAULT_CURRENCY;
  const rows = [
    ['Transaction Reference', ctx.reference],
    ['Transaction Type', typeLabel(ctx.type)],
    ['Amount', ctx.amount != null ? formatAmount(ctx.amount, currency) : ''],
    ['Transaction Fee', ctx.fee != null && Number(ctx.fee) > 0 ? formatAmount(ctx.fee, currency) : ''],
    ['Transaction Method', ctx.method],
    ['Recipient / Beneficiary', ctx.recipient_name],
    ['Recipient Account', ctx.recipient_account ? mask(ctx.recipient_account) : ''],
    ['Recipient Bank', ctx.recipient_bank],
    ['Sender', ctx.sender_name],
    ['Date & Time', formatDate(ctx.created_at)],
    ['Status', info.label],
    // Remaining balance only when authoritatively known and the money actually moved.
    ['Remaining Balance', (info.key === 'successful' && ctx.available_balance != null)
      ? formatAmount(ctx.available_balance, currency) : ''],
    ['Reason', info.key === 'failed' ? ctx.reason : ''],
    ['Original Reference', info.key === 'reversed' ? ctx.original_reference : ''],
    ['Description', ctx.description],
  ];
  return rows.filter(([, v]) => v != null && String(v).trim() !== '');
}

// ── render (pure) ────────────────────────────────────────────────────────────
export function renderTransactionEmail(ctx) {
  const info = statusInfo(ctx.status);
  const head = heading(ctx.type, info);
  const name = ctx.customer_name || 'Customer';
  const rows = detailRows(ctx, info);
  const dash = DASHBOARD_URL ? `${DASHBOARD_URL}/dashboard` : '';
  const year = new Date().getFullYear();

  const rowsHtml = rows.map(([label, value], i) => `
    <tr style="background:${i % 2 ? '#ffffff' : '#f8fafc'}">
      <td style="padding:11px 16px;color:#64748b;font-size:13px;border-bottom:1px solid #eef2f7;white-space:nowrap">${esc(label)}</td>
      <td style="padding:11px 16px;color:#0f172a;font-size:13px;border-bottom:1px solid #eef2f7;text-align:right;font-weight:600">${
        label === 'Status'
          ? `<span style="color:${info.color}">${esc(String(value))}</span>`
          : esc(String(value))
      }</td>
    </tr>`).join('');

  const button = dash ? `
    <tr><td style="padding:24px 32px 4px">
      <a href="${esc(dash)}" style="background:#0b2e5c;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block">View Dashboard</a>
    </td></tr>` : '';

  const supportLine = [
    SUPPORT_EMAIL ? `<a href="mailto:${esc(SUPPORT_EMAIL)}" style="color:#0b2e5c;text-decoration:none">${esc(SUPPORT_EMAIL)}</a>` : '',
    SUPPORT_PHONE ? esc(SUPPORT_PHONE) : '',
    WEBSITE ? `<a href="${esc(WEBSITE)}" style="color:#0b2e5c;text-decoration:none">${esc(WEBSITE.replace(/^https?:\/\//, ''))}</a>` : '',
  ].filter(Boolean).join(' &nbsp;•&nbsp; ');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(head)}</title></head>
<body style="margin:0;padding:0;background:#eef1f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
        <!-- Header -->
        <tr><td style="background:#0b2e5c;padding:22px 32px">
          <table role="presentation" width="100%"><tr>
            <td style="color:#ffffff;font-size:19px;font-weight:700;letter-spacing:.2px">${esc(BRAND)}</td>
            <td style="text-align:right;color:#aquamarine;font-size:12px"><span style="color:#9fb4d4">Transaction Notification</span></td>
          </tr></table>
        </td></tr>
        <!-- Status strip -->
        <tr><td style="background:${info.bg};padding:10px 32px;border-bottom:1px solid #eef2f7">
          <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${info.color};margin-right:8px"></span>
          <span style="color:${info.color};font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.4px">${esc(info.label)}</span>
        </td></tr>
        <!-- Greeting + heading -->
        <tr><td style="padding:26px 32px 0;color:#0f172a;font-size:15px">Dear ${esc(name)},</td></tr>
        <tr><td style="padding:10px 32px 0;color:#0f172a;font-size:22px;font-weight:700">${esc(head)}</td></tr>
        <tr><td style="padding:12px 32px 0;color:#475569;font-size:14px;line-height:1.55">${esc(info.message)}</td></tr>
        ${button}
        <!-- Details table -->
        <tr><td style="padding:20px 32px 4px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
            ${rowsHtml}
          </table>
        </td></tr>
        <!-- Divider + footer -->
        <tr><td style="padding:24px 32px 0"><hr style="border:none;border-top:1px solid #e2e8f0;margin:0"></td></tr>
        <tr><td style="padding:16px 32px 4px;color:#94a3b8;font-size:12px;line-height:1.6">
          <strong style="color:#475569">Security Notice:</strong> ${esc(BRAND)} will never ask you to disclose your password, PIN, OTP, or other confidential banking credentials through email. If you did not authorize this transaction, please contact our support team immediately.
        </td></tr>
        <tr><td style="padding:10px 32px 0;color:#94a3b8;font-size:12px">${supportLine}</td></tr>
        <tr><td style="padding:10px 32px 0;color:#b6c0cc;font-size:11px;line-height:1.6">
          This is an automated transaction notification. Please do not reply to this email.
        </td></tr>
        <tr><td style="padding:10px 32px 26px;color:#b6c0cc;font-size:11px">© ${year} ${esc(BRAND)}. All rights reserved.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const textRows = rows.map(([l, v]) => `  ${l}: ${v}`).join('\n');
  const text = `${BRAND}\n${head}\n\nDear ${name},\n\n${info.message}\n\n${textRows}\n\n${dash ? 'View your dashboard: ' + dash + '\n\n' : ''}Security Notice: ${BRAND} will never ask for your password, PIN, OTP, or other credentials by email. If you did not authorize this transaction, contact support${SUPPORT_EMAIL ? ' at ' + SUPPORT_EMAIL : ''} immediately.\n\nThis is an automated notification — please do not reply.\n© ${year} ${BRAND}`;

  const subject = `${BRAND}: ${head}`;
  return { subject, html, text, info };
}

// ── send (idempotent, best-effort) ───────────────────────────────────────────
// Loads authoritative customer + balance from the ledger, dedups per
// (reference|id, status), renders, and sends. Never throws — a mail failure
// must not affect the banking transaction that triggered it.
export async function notifyTransaction(ctx = {}) {
  try {
    if (!ctx.user_id) return { sent: false, reason: 'no user' };

    // Authoritative customer record + current balance (never invented).
    const { rows } = await pool.query(
      'SELECT p.full_name, p.balance, COALESCE(p.email, u.email) AS email FROM profiles p JOIN users u ON u.id = p.id WHERE p.id = $1',
      [ctx.user_id]
    );
    const prof = rows[0];
    if (!prof || !prof.email) return { sent: false, reason: 'no email' };

    const info = statusInfo(ctx.status);
    const dedupKey = `${ctx.reference || ctx.transaction_id || ctx.user_id}:${info.key}`;

    // Idempotency: claim the key first; if it's taken, we've already notified.
    const claim = await pool.query(
      'INSERT INTO tx_notifications (dedup_key, user_id) VALUES ($1,$2) ON CONFLICT (dedup_key) DO NOTHING RETURNING id',
      [dedupKey, ctx.user_id]
    );
    if (claim.rowCount === 0) return { sent: false, reason: 'duplicate' };

    const full = {
      ...ctx,
      customer_name: ctx.customer_name || prof.full_name,
      available_balance: ctx.available_balance != null ? ctx.available_balance : prof.balance,
    };
    const { subject, html, text } = renderTransactionEmail(full);
    const res = await sendMail({ to: prof.email, subject, html, text });

    // If delivery truly failed (not just "SMTP off"), release the claim so a
    // later retry can re-send.
    if (res && res.sent === false && res.error) {
      await pool.query('DELETE FROM tx_notifications WHERE dedup_key = $1', [dedupKey]).catch(() => {});
    }
    return { sent: !!(res && res.sent) };
  } catch (err) {
    console.error('notifyTransaction failed:', err.message);
    return { sent: false, reason: err.message };
  }
}
