/**
 * St Louis Shore Bank Live Chat Widget
 * Attaches a floating 💬 button to any page.
 * User-facing: injects into dashboard.html / public pages.
 * Uses Supabase support_tickets + Realtime for instant delivery.
 *
 * Usage (logged-in pages):
 *   <script>
 *     window.BFBChat = { userId: '<uuid>', userEmail: 'user@x.com', userName: 'Jane' };
 *   </script>
 *   <script src="/chat-widget.js"></script>
 *
 * Usage (public pages — pre-login):
 *   <script src="/chat-widget.js"></script>
 *   (no BFBChat config needed — shows a "contact us" guest form)
 */
(function () {
  'use strict';

  const SUPA_URL = 'https://YOUR-PROJECT-REF.supabase.co';
  const SUPA_KEY = 'YOUR_SUPABASE_ANON_KEY';
  const SUPPORT_EMAIL = 'support@stlouisshorebank.com';

  // ── Helpers ───────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmt(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── Auth: use the logged-in user's session token ─────────────────────────
  // @supabase/supabase-js persists the session in localStorage under
  // sb-<project-ref>-auth-token. RLS on support_tickets requires
  // auth.uid() = user_id, so calling with the anon key only (the old code)
  // meant every ticket read/write failed — the widget was dead even for
  // logged-in users. Send the user's access token whenever one is stored.
  // supabase-js derives its storage key from the first hostname label
  // (`sb-<ref>-auth-token`), where <ref> is the project ref on *.supabase.co
  // but just the first host label otherwise (e.g. the /supa proxy origin in
  // self-hosted mode). Mirror that here so the widget finds the session.
  const PROJECT_REF = (SUPA_URL.match(/^https?:\/\/([^.]+)\.supabase\.co/)
    || SUPA_URL.match(/^https?:\/\/([^/.]+)/))[1];
  function userToken() {
    try {
      const raw = localStorage.getItem('sb-' + PROJECT_REF + '-auth-token');
      if (!raw) return null;
      const sess = JSON.parse(raw);
      const tok = sess && (sess.access_token || (sess.session && sess.session.access_token));
      return tok || null;
    } catch (e) { return null; }
  }

  // ── Supabase REST helper (no SDK needed) ──────────────────────────────────
  async function sbFetch(method, path, body) {
    const token = userToken() || SUPA_KEY;
    const r = await fetch(SUPA_URL + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_KEY,
        'Authorization': 'Bearer ' + token,
        'Prefer': method === 'POST' ? 'return=representation' : ''
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return r.ok ? r.json() : null;
  }

  // ── Inject CSS ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  #mv-chat-fab{position:fixed;bottom:24px;right:24px;z-index:9999;
    width:56px;height:56px;border-radius:50%;
    background:linear-gradient(135deg,#2563eb,#1d4ed8);
    box-shadow:0 4px 20px rgba(37,99,235,.45);
    border:none;cursor:pointer;display:flex;align-items:center;
    justify-content:center;font-size:24px;transition:.2s;color:#fff}
  #mv-chat-fab:hover{transform:scale(1.1)}
  #mv-chat-fab .mv-unread{position:absolute;top:4px;right:4px;
    background:#ef4444;color:#fff;border-radius:50%;
    width:18px;height:18px;font-size:10px;font-weight:700;
    display:none;align-items:center;justify-content:center;
    border:2px solid #fff}
  #mv-chat-box{position:fixed;bottom:90px;right:24px;z-index:9998;
    width:360px;max-height:520px;background:#fff;
    border-radius:18px;box-shadow:0 8px 40px rgba(0,0,0,.18);
    display:none;flex-direction:column;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  #mv-chat-box.open{display:flex}
  .mv-chat-head{background:linear-gradient(135deg,#1e3a8a,#2563eb);
    padding:16px 18px;display:flex;align-items:center;gap:12px;
    color:#fff}
  .mv-chat-head .mv-avatar{width:38px;height:38px;border-radius:50%;
    background:rgba(255,255,255,.2);display:flex;align-items:center;
    justify-content:center;font-size:18px;flex-shrink:0}
  .mv-chat-head-info{flex:1}
  .mv-chat-head-title{font-size:14px;font-weight:700}
  .mv-chat-head-sub{font-size:11px;opacity:.8;margin-top:1px}
  .mv-online-dot{width:9px;height:9px;border-radius:50%;
    background:#22c55e;border:2px solid #fff;flex-shrink:0}
  .mv-chat-close{background:none;border:none;color:#fff;
    font-size:20px;cursor:pointer;padding:2px 6px;opacity:.8;margin-left:auto}
  .mv-chat-close:hover{opacity:1}
  .mv-chat-msgs{flex:1;overflow-y:auto;padding:16px;
    display:flex;flex-direction:column;gap:10px;min-height:200px;
    max-height:320px;background:#f8fafc}
  .mv-msg{max-width:80%;display:flex;flex-direction:column;gap:2px}
  .mv-msg.user{align-self:flex-end;align-items:flex-end}
  .mv-msg.admin{align-self:flex-start;align-items:flex-start}
  .mv-bubble{padding:9px 13px;border-radius:14px;font-size:13px;
    line-height:1.5;word-break:break-word}
  .mv-msg.user .mv-bubble{background:#2563eb;color:#fff;
    border-bottom-right-radius:3px}
  .mv-msg.admin .mv-bubble{background:#fff;color:#1e293b;
    border:1px solid #e2e8f0;border-bottom-left-radius:3px;
    box-shadow:0 1px 4px rgba(0,0,0,.06)}
  .mv-msg-time{font-size:10px;color:#94a3b8}
  .mv-chat-typing{font-size:12px;color:#94a3b8;padding:0 16px 6px;
    height:20px;display:none}
  .mv-chat-form{padding:12px 14px;border-top:1px solid #e2e8f0;
    background:#fff;display:flex;gap:8px;align-items:flex-end}
  .mv-chat-input{flex:1;border:1.5px solid #e2e8f0;border-radius:12px;
    padding:9px 12px;font-size:13px;resize:none;outline:none;
    max-height:80px;min-height:38px;font-family:inherit;line-height:1.4;
    transition:.15s}
  .mv-chat-input:focus{border-color:#2563eb}
  .mv-chat-send{width:38px;height:38px;border-radius:50%;
    background:#2563eb;border:none;cursor:pointer;color:#fff;
    display:flex;align-items:center;justify-content:center;
    flex-shrink:0;transition:.15s}
  .mv-chat-send:hover{background:#1d4ed8}
  .mv-chat-send:disabled{background:#93c5fd;cursor:not-allowed}
  .mv-chat-empty{flex:1;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:8px;color:#94a3b8;
    font-size:13px;padding:24px}
  .mv-chat-empty span{font-size:32px}
  /* Guest form */
  .mv-guest-form{padding:20px;display:flex;flex-direction:column;gap:12px}
  .mv-guest-form input,.mv-guest-form textarea{border:1.5px solid #e2e8f0;
    border-radius:10px;padding:9px 12px;font-size:13px;outline:none;
    font-family:inherit;transition:.15s;width:100%;box-sizing:border-box}
  .mv-guest-form input:focus,.mv-guest-form textarea:focus{border-color:#2563eb}
  .mv-guest-form textarea{resize:none;min-height:80px}
  .mv-guest-submit{background:#2563eb;color:#fff;border:none;
    border-radius:10px;padding:10px;font-size:13px;font-weight:600;
    cursor:pointer;transition:.15s}
  .mv-guest-submit:hover{background:#1d4ed8}
  .mv-guest-ok{background:#dcfce7;color:#166534;border-radius:10px;
    padding:12px;font-size:13px;text-align:center;display:none}
  `;
  document.head.appendChild(style);

  // ── Build DOM ─────────────────────────────────────────────────────────────
  const fab = document.createElement('button');
  fab.id = 'mv-chat-fab';
  fab.title = 'Live Chat Support';
  fab.innerHTML = '💬<span class="mv-unread" id="mv-unread-dot"></span>';

  const box = document.createElement('div');
  box.id = 'mv-chat-box';
  box.innerHTML = `
    <div class="mv-chat-head">
      <div class="mv-avatar">🏦</div>
      <div class="mv-chat-head-info">
        <div class="mv-chat-head-title">St Louis Shore Bank Support</div>
        <div class="mv-chat-head-sub">We typically reply in minutes</div>
      </div>
      <div class="mv-online-dot"></div>
      <button class="mv-chat-close" id="mv-chat-close">✕</button>
    </div>
    <div id="mv-chat-body"></div>
    <div class="mv-chat-typing" id="mv-chat-typing">Support is typing…</div>
    <div class="mv-chat-form" id="mv-chat-form-wrap">
      <textarea class="mv-chat-input" id="mv-chat-input"
        placeholder="Type a message…" rows="1"></textarea>
      <button class="mv-chat-send" id="mv-chat-send" title="Send">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5">
          <line x1="22" y1="2" x2="11" y2="13"/>
          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>`;

  document.body.appendChild(fab);
  document.body.appendChild(box);

  // ── State ─────────────────────────────────────────────────────────────────
  const cfg = window.BFBChat || {};
  let ticketId = null;
  let realtimeSub = null;
  let open = false;
  let msgs = [];

  // ── Toggle ────────────────────────────────────────────────────────────────
  fab.addEventListener('click', () => toggle());
  document.getElementById('mv-chat-close').addEventListener('click', () => toggle(false));

  function toggle(force) {
    open = force !== undefined ? force : !open;
    box.classList.toggle('open', open);
    if (open) {
      document.getElementById('mv-unread-dot').style.display = 'none';
      if (cfg.userId) initChat();
      else renderGuest();
      setTimeout(() => document.getElementById('mv-chat-input') &&
        document.getElementById('mv-chat-input').focus(), 100);
    }
  }

  // ── Guest form (not logged in) ─────────────────────────────────────────────
  function renderGuest() {
    document.getElementById('mv-chat-body').innerHTML = `
      <div class="mv-guest-form">
        <p style="font-size:13px;color:#475569;margin:0">
          Send us a message and we'll reply to your email shortly.<br>
          Or email us directly at
          <a href="mailto:${SUPPORT_EMAIL}" style="color:#2563eb">${SUPPORT_EMAIL}</a>
        </p>
        <input id="mv-g-name"  placeholder="Your name" />
        <input id="mv-g-email" placeholder="Your email" type="email"/>
        <textarea id="mv-g-msg" placeholder="How can we help?"></textarea>
        <button class="mv-guest-submit" id="mv-g-btn">Send Message</button>
        <div class="mv-guest-ok" id="mv-g-ok">
          ✅ Message sent! We'll reply to your email soon.
        </div>
      </div>`;
    document.getElementById('mv-chat-form-wrap').style.display = 'none';
    document.getElementById('mv-g-btn').addEventListener('click', sendGuest);
  }

  async function sendGuest() {
    const name  = document.getElementById('mv-g-name').value.trim();
    const email = document.getElementById('mv-g-email').value.trim();
    const msg   = document.getElementById('mv-g-msg').value.trim();
    if (!name || !email || !msg) return;
    document.getElementById('mv-g-btn').disabled = true;
    document.getElementById('mv-g-btn').textContent = 'Sending…';

    // Guests have no session, so a plain insert is rejected by RLS (and the
    // old placeholder-zero user_id also violated the auth.users FK). The
    // create_guest_ticket RPC (migration 008) is SECURITY DEFINER: it inserts
    // server-side with a NULL user_id.
    const res = await sbFetch('POST', '/rest/v1/rpc/create_guest_ticket', {
      p_name: name, p_email: email, p_message: msg
    });

    if (res) {
      document.getElementById('mv-g-ok').style.display = 'block';
      document.getElementById('mv-g-btn').style.display = 'none';
    } else {
      document.getElementById('mv-g-btn').disabled = false;
      document.getElementById('mv-g-btn').textContent = 'Send Message';
      const okEl = document.getElementById('mv-g-ok');
      okEl.textContent = '⚠️ Could not send — please email ' + SUPPORT_EMAIL;
      okEl.style.background = '#fee2e2'; okEl.style.color = '#991b1b';
      okEl.style.display = 'block';
    }
  }

  // ── Logged-in chat ────────────────────────────────────────────────────────
  async function initChat() {
    renderMessages([]);  // show spinner
    const body = document.getElementById('mv-chat-body');
    body.innerHTML = `<div class="mv-chat-empty"><span>💬</span>Loading…</div>`;

    // Find existing open ticket for this user (category = 'live_chat')
    const tickets = await sbFetch('GET',
      `/rest/v1/support_tickets?user_id=eq.${cfg.userId}&category=eq.live_chat&order=created_at.desc&limit=1`);

    if (tickets && tickets.length) {
      ticketId = tickets[0].id;
      msgs = buildMsgs(tickets[0]);
    } else {
      // Create a new live chat session
      const created = await sbFetch('POST', '/rest/v1/support_tickets', {
        user_id: cfg.userId,
        category: 'live_chat',
        subject: 'Live chat — ' + (cfg.userName || cfg.userEmail || 'User'),
        message: '__chat_init__',
        status: 'open'
      });
      if (created && created.length) {
        ticketId = created[0].id;
        msgs = [];
      }
    }

    renderMessages(msgs);
    subscribeRealtime();
  }

  function buildMsgs(ticket) {
    const out = [];
    // Parse message field — lines starting with [admin] or [user]
    const raw = ticket.message || '';
    raw.split('\n---\n').forEach(chunk => {
      if (chunk === '__chat_init__') return;
      const isAdmin = chunk.startsWith('[admin]');
      out.push({
        side: isAdmin ? 'admin' : 'user',
        text: chunk.replace(/^\[(admin|user)\]\s*/, '').replace(/\s*\[\d{4}-[^\]]+\]$/, ''),
        time: ticket.updated_at
      });
    });
    if (ticket.admin_reply && ticket.status !== 'closed' &&
        !(ticket.message || '').includes('[admin] ' + ticket.admin_reply)) {
      // Live-chat replies are also appended to the message thread by
      // admin_append_ticket_message; only surface admin_reply here when it is
      // not already represented there (regular ticket replies).
      out.push({ side: 'admin', text: ticket.admin_reply, time: ticket.updated_at });
    }
    return out;
  }

  function renderMessages(list) {
    const body = document.getElementById('mv-chat-body');
    if (!list.length) {
      body.innerHTML = `<div class="mv-chat-empty">
        <span>👋</span>
        <div>Hi ${esc(cfg.userName || 'there')}! How can we help you today?</div>
      </div>`;
      return;
    }
    body.innerHTML = `<div class="mv-chat-msgs" id="mv-msgs">` +
      list.map(m => `
        <div class="mv-msg ${m.side}">
          <div class="mv-bubble">${esc(m.text)}</div>
          <div class="mv-msg-time">${m.time ? fmt(m.time) : ''}</div>
        </div>`).join('') +
      `</div>`;
    const el = document.getElementById('mv-msgs');
    if (el) el.scrollTop = el.scrollHeight;
  }

  // ── Send message ──────────────────────────────────────────────────────────
  const input = document.getElementById('mv-chat-input');
  const sendBtn = document.getElementById('mv-chat-send');

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 80) + 'px';
  });
  sendBtn.addEventListener('click', sendMsg);

  async function sendMsg() {
    if (!cfg.userId) return;
    const text = input.value.trim();
    if (!text || !ticketId) return;
    sendBtn.disabled = true;
    input.value = '';
    input.style.height = '38px';

    msgs.push({ side: 'user', text, time: new Date().toISOString() });
    renderMessages(msgs);

    // Append to ticket message field via RPC-less approach:
    // Re-fetch current message, append, update
    const current = await sbFetch('GET',
      `/rest/v1/support_tickets?id=eq.${ticketId}&select=message,status`);
    const prev = current && current[0] ? current[0].message || '' : '';
    const updated = prev + '\n---\n[user] ' + text + ' [' + new Date().toISOString() + ']';
    await sbFetch('PATCH',
      `/rest/v1/support_tickets?id=eq.${ticketId}`, {
        message: updated,
        status: 'open',
        updated_at: new Date().toISOString()
      });

    sendBtn.disabled = false;
  }

  // ── Realtime subscription ─────────────────────────────────────────────────
  function subscribeRealtime() {
    if (!window.supabase || !ticketId) return;
    const sb = window.supabase.createClient(SUPA_URL, SUPA_KEY,
      { global: { headers: { Authorization: 'Bearer ' + (userToken() || SUPA_KEY) } } });
    realtimeSub = sb
      .channel('mv-chat-' + ticketId)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'support_tickets',
        filter: 'id=eq.' + ticketId
      }, payload => {
        const t = payload.new;
        msgs = buildMsgs(t);
        renderMessages(msgs);
        if (!open) {
          const dot = document.getElementById('mv-unread-dot');
          dot.style.display = 'flex';
          dot.textContent = '!';
        }
      })
      .subscribe();
  }

  // ── Poll fallback (if Realtime not available) ─────────────────────────────
  setInterval(async () => {
    if (!open || !ticketId) return;
    const data = await sbFetch('GET',
      `/rest/v1/support_tickets?id=eq.${ticketId}&select=message,admin_reply,status,updated_at`);
    if (data && data[0]) {
      const newMsgs = buildMsgs(data[0]);
      if (newMsgs.length !== msgs.length) {
        msgs = newMsgs;
        renderMessages(msgs);
      }
    }
  }, 5000);

})();
