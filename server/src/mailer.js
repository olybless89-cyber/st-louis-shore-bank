import nodemailer from 'nodemailer';

// Portable SMTP mailer. Works with any provider — Gmail, your own cPanel
// domain mailbox, SendGrid/Mailgun/Postmark/Resend SMTP, Amazon SES — by
// setting the SMTP_* env vars. If they aren't set, emails are logged to the
// server console instead of sent, so every flow stays testable with no
// provider wired up (the same approach the password-reset flow used).
//
// Env vars:
//   SMTP_HOST      e.g. smtp.gmail.com, mail.yourdomain.com, smtp.resend.com
//   SMTP_PORT      465 (SSL) or 587 (STARTTLS). Default 587.
//   SMTP_USER      SMTP username / mailbox address
//   SMTP_PASS      SMTP password / app password / API key
//   MAIL_FROM      "Sky Prime <no-reply@yourdomain.com>" (defaults to SMTP_USER)
//   MAIL_BRAND     Brand name shown in the email. Default "St Louis Shore Bank".
//   SUPPORT_EMAIL  Support contact shown in the footer.
//   SUPPORT_PHONE  Support phone shown in the footer.

const HOST = process.env.SMTP_HOST;
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;

export const BRAND = process.env.MAIL_BRAND || 'St Louis Shore Bank';
const FROM = process.env.MAIL_FROM || (USER ? `${BRAND} <${USER}>` : `${BRAND} <no-reply@localhost>`);
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@stlouisshorebank.com';
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || '';

export const mailConfigured = Boolean(HOST && USER && PASS);

let transporter = null;
if (mailConfigured) {
  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465, // SSL on 465, STARTTLS on 587/others
    auth: { user: USER, pass: PASS },
  });
} else {
  console.error('⚠️  SMTP is not configured — emails will be logged to the console, not sent. Set SMTP_HOST/SMTP_USER/SMTP_PASS to send for real.');
}

// Generic send. Never throws into the request path — a mail failure must not
// break signup/login; it's logged and the caller carries on.
export async function sendMail({ to, subject, html, text }) {
  if (!transporter) {
    console.log(`\n── EMAIL (not sent — SMTP unconfigured) ──\nTo: ${to}\nSubject: ${subject}\n${text || html}\n──────────────────────────────────────\n`);
    return { sent: false };
  }
  try {
    const info = await transporter.sendMail({ from: FROM, to, subject, html, text });
    console.log(`Email sent to ${to} (${info.messageId})`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`Email to ${to} failed: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Branded OTP email — same shape as the sample: greeting by name, the code,
// and a support footer telling the user what to do if it wasn't them.
export function otpEmailHtml({ name, code, purpose }) {
  const action =
    purpose === 'login' ? 'validate your sign-in' :
    purpose === 'reset' ? 'reset your password' :
    'validate verification';
  const footer = [
    SUPPORT_PHONE ? `<strong>${escapeHtml(SUPPORT_PHONE)}</strong>` : null,
    `send an email to <a href="mailto:${escapeHtml(SUPPORT_EMAIL)}" style="color:#1a73e8;text-decoration:none;">${escapeHtml(SUPPORT_EMAIL)}</a>`,
  ].filter(Boolean).join(' or ');

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f1f1;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f1;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
        <tr><td style="background:#0b2e13;padding:20px 32px;color:#ffffff;font-size:18px;font-weight:bold;">
          ${escapeHtml(BRAND)}
        </td></tr>
        <tr><td style="padding:12px 32px 0;color:#555;font-size:13px;">OTP Notifications</td></tr>
        <tr><td style="padding:16px 32px 0;color:#111;font-size:26px;font-weight:bold;">
          Hello ${escapeHtml(name || 'there')}
        </td></tr>
        <tr><td style="padding:16px 32px 0;color:#222;font-size:16px;line-height:1.5;">
          Kindly use <strong style="font-size:18px;letter-spacing:1px;">${escapeHtml(code)}</strong> to ${action}!
        </td></tr>
        <tr><td style="padding:12px 32px 0;color:#888;font-size:13px;">
          This code expires in 10 minutes. Do not share it with anyone.
        </td></tr>
        <tr><td style="padding:28px 32px 0;color:#1f7a3d;font-size:15px;line-height:1.6;">
          If this wasn't you, please contact support on ${footer} immediately to help secure your account.
        </td></tr>
        <tr><td style="padding:32px 32px 28px;color:#333;font-size:15px;">
          All the best,<br>${escapeHtml(BRAND.toUpperCase())},
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function otpEmailText({ name, code }) {
  return `Hello ${name || 'there'}\n\nKindly use ${code} to validate verification!\n\nThis code expires in 10 minutes. Do not share it with anyone.\n\nIf this wasn't you, contact support at ${SUPPORT_EMAIL}${SUPPORT_PHONE ? ' or ' + SUPPORT_PHONE : ''} immediately.\n\nAll the best,\n${BRAND}`;
}
