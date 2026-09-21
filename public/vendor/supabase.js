/*!
 * Drop-in replacement for @supabase/supabase-js's UMD build, backed by
 * this app's own plain-Postgres API instead of Supabase. Every page still
 * calls `supabase.createClient(url, key)` and uses `.from()/.rpc()/.auth.*`
 * exactly as before — the url/key arguments are accepted but ignored, since
 * every call here is same-origin against this server's own /api/* routes.
 *
 * Covers what this app actually uses: .from(table).select/insert/update/
 * upsert with .eq/.order/.limit/.single/.maybeSingle, .rpc(name, args),
 * .auth.signUp/signInWithPassword/getSession/signOut/updateUser/
 * resetPasswordForEmail (including the password-recovery-link flow via
 * `detectSessionInUrl`), and a no-op .channel() (live chat already polls
 * every 5s as a fallback, so realtime is not required for it to work).
 */
(function (global) {
  'use strict';

  var SESSION_KEY = 'slsb-auth-token';

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveSession(session) {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }

  async function apiFetch(path, opts) {
    opts = opts || {};
    var session = loadSession();
    var headers = { 'Content-Type': 'application/json' };
    if (opts.headers) {
      for (var k in opts.headers) headers[k] = opts.headers[k];
    }
    if (!headers.Authorization && session && session.access_token) {
      headers.Authorization = 'Bearer ' + session.access_token;
    }
    var res;
    try {
      res = await fetch(path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      return { data: null, error: { message: 'Network error. Please try again.', code: 'network_error' } };
    }
    var json = null;
    try {
      json = await res.json();
    } catch (e) {}
    if (!res.ok) {
      var err = (json && json.error) || { message: 'Request failed (' + res.status + ')' };
      if (typeof err === 'string') err = { message: err };
      return { data: null, error: err };
    }
    return json && typeof json === 'object' && 'data' in json ? json : { data: json, error: null };
  }

  function QueryBuilder(table) {
    this.table = table;
    this._filters = [];
    this._order = null;
    this._limit = null;
    this._single = false;
    this._maybeSingle = false;
    this._mode = null;
    this._columns = '*';
    this._values = null;
  }
  QueryBuilder.prototype.select = function (cols) {
    this._columns = cols || '*';
    if (!this._mode) this._mode = 'select';
    return this;
  };
  QueryBuilder.prototype.eq = function (col, val) {
    this._filters.push({ col: col, op: 'eq', value: val });
    return this;
  };
  QueryBuilder.prototype.order = function (col, opts) {
    this._order = { column: col, ascending: !opts || opts.ascending !== false };
    return this;
  };
  QueryBuilder.prototype.limit = function (n) {
    this._limit = n;
    return this;
  };
  QueryBuilder.prototype.single = function () {
    this._single = true;
    return this;
  };
  QueryBuilder.prototype.maybeSingle = function () {
    this._maybeSingle = true;
    return this;
  };
  QueryBuilder.prototype.insert = function (values) {
    this._mode = 'insert';
    this._values = values;
    return this;
  };
  QueryBuilder.prototype.update = function (values) {
    this._mode = 'update';
    this._values = values;
    return this;
  };
  QueryBuilder.prototype.upsert = function (values, opts) {
    this._mode = 'upsert';
    this._values = values;
    this._upsertOpts = opts;
    return this;
  };
  QueryBuilder.prototype._exec = function () {
    var mode = this._mode || 'select';
    var body = {
      columns: this._columns,
      filters: this._filters,
      order: this._order,
      limit: this._limit,
      single: this._single,
      maybeSingle: this._maybeSingle,
      values: this._values,
    };
    return apiFetch('/api/data/' + this.table + '/' + mode, { method: 'POST', body: body });
  };
  QueryBuilder.prototype.then = function (resolve, reject) {
    return this._exec().then(resolve, reject);
  };
  QueryBuilder.prototype.catch = function (reject) {
    return this._exec().catch(reject);
  };

  function createClient(_url, _key, opts) {
    var authOpts = (opts && opts.auth) || {};
    var recoveryMode = !!authOpts.detectSessionInUrl;
    var persistSession = authOpts.persistSession !== false;
    var recoveryToken = null;
    if (recoveryMode) {
      try {
        recoveryToken = new URLSearchParams(window.location.search).get('token');
      } catch (e) {}
    }

    return {
      from: function (table) {
        return new QueryBuilder(table);
      },
      rpc: function (name, args) {
        return apiFetch('/api/rpc/' + name, { method: 'POST', body: args || {} });
      },
      channel: function () {
        // No realtime backend behind this shim. Every page that subscribes
        // also polls on an interval as a fallback, so a harmless no-op chain
        // is enough — nothing breaks, updates just arrive via the poll.
        var chan = {
          on: function () {
            return chan;
          },
          subscribe: function () {
            return chan;
          },
          unsubscribe: function () {},
        };
        return chan;
      },
      removeChannel: function () {},
      auth: {
        signUp: async function (opts) {
          var r = await apiFetch('/api/auth/signup', { method: 'POST', body: opts });
          if (r.data && r.data.session && persistSession) saveSession(r.data.session);
          return r;
        },
        signInWithPassword: async function (opts) {
          var r = await apiFetch('/api/auth/signin', { method: 'POST', body: opts });
          if (r.data && r.data.session && persistSession) saveSession(r.data.session);
          return r;
        },
        getSession: async function () {
          if (recoveryMode) {
            if (!recoveryToken) return { data: { session: null }, error: null };
            var r = await apiFetch('/api/auth/verify-reset-token', { method: 'POST', body: { token: recoveryToken } });
            if (r.data && r.data.email) {
              return { data: { session: { access_token: null, user: { email: r.data.email } } }, error: null };
            }
            return { data: { session: null }, error: r.error || { message: 'Invalid or expired link' } };
          }
          return { data: { session: loadSession() }, error: null };
        },
        signOut: async function () {
          if (persistSession) saveSession(null);
          return { error: null };
        },
        updateUser: async function (fields) {
          if (recoveryMode) {
            if (!recoveryToken) return { data: null, error: { message: 'Invalid or expired link' } };
            return apiFetch('/api/auth/reset-password', { method: 'POST', body: { token: recoveryToken, password: fields.password } });
          }
          return apiFetch('/api/auth/update-password', { method: 'POST', body: fields });
        },
        resetPasswordForEmail: async function (email) {
          return apiFetch('/api/auth/forgot-password', { method: 'POST', body: { email: email } });
        },
      },
    };
  }

  global.supabase = { createClient: createClient };
})(window);
