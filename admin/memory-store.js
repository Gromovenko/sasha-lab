// Хранилище раздела /admin в памяти, интерфейс — как у admin/store.js.
// Нужно тестам: вход, блокировка перебора, сессии и одноразовость ссылки на
// сброс пароля должны проверяться там, где postgres нет (EU, CI, ноутбук).
const { norm } = require('./store');

function memoryAdminStore() {
  const st = { users: [], sessions: new Map(), resets: new Map(), events: [], deals: [], seq: 0 };
  const now = () => new Date();
  const clone = (o) => (o ? { ...o } : null);

  const users = {
    async create({ email = null, phone = null, name = null, role = 'client', passwordHash = null, status = 'active', meta = {} }) {
      const e = norm.email(email);
      const p = norm.phone(phone);
      if (e && st.users.some((u) => u.email === e)) throw new Error('duplicate key value violates unique constraint "app_users_email_key"');
      if (p && st.users.some((u) => u.phone === p)) throw new Error('duplicate key value violates unique constraint "app_users_phone_key"');
      const row = { id: ++st.seq, email: e, phone: p, name, role, password_hash: passwordHash, status, meta,
        failed_logins: 0, locked_until: null, created_at: now(), updated_at: now(), last_login_at: null };
      st.users.push(row);
      return clone(row);
    },
    async byId(id) { return clone(st.users.find((u) => u.id === Number(id))); },
    async byEmail(email) { const e = norm.email(email); return e ? clone(st.users.find((u) => u.email === e)) : null; },
    async byPhone(phone) { const p = norm.phone(phone); return p ? clone(st.users.find((u) => u.phone === p)) : null; },
    async byLogin(login) {
      const s = String(login || '').trim();
      if (!s) return null;
      if (s.includes('@')) return users.byEmail(s);
      return (await users.byPhone(s)) || users.byEmail(s);
    },
    async list({ role = null, limit = 200 } = {}) {
      return st.users.filter((u) => !role || u.role === role).slice(-limit).reverse().map(clone);
    },
    async update(id, patch) {
      const u = st.users.find((x) => x.id === Number(id));
      if (!u) return null;
      for (const [k, v] of Object.entries(patch)) {
        u[k] = k === 'email' ? norm.email(v) : k === 'phone' ? norm.phone(v) : v;
      }
      u.updated_at = now();
      return clone(u);
    },
    async setPassword(id, hash) {
      const u = st.users.find((x) => x.id === Number(id));
      Object.assign(u, { password_hash: hash, failed_logins: 0, locked_until: null, updated_at: now() });
    },
    async noteLogin(id, ok, lockUntil = null) {
      const u = st.users.find((x) => x.id === Number(id));
      if (!u) return;
      if (ok) Object.assign(u, { last_login_at: now(), failed_logins: 0, locked_until: null });
      else Object.assign(u, { failed_logins: u.failed_logins + 1, locked_until: lockUntil });
    },
    async stats() {
      return { total: st.users.length,
        staff: st.users.filter((u) => ['owner', 'admin', 'master'].includes(u.role)).length,
        clients: st.users.filter((u) => u.role === 'client').length,
        blocked: st.users.filter((u) => u.status === 'blocked').length,
        invited: st.users.filter((u) => !u.password_hash).length };
    },
  };

  const sessions = {
    async create({ userId, tokenHash, expiresAt, ip = null, ua = null }) {
      st.sessions.set(tokenHash, { token_hash: tokenHash, user_id: Number(userId), expires_at: new Date(expiresAt),
        created_at: now(), last_seen_at: now(), ip, ua, revoked_at: null });
    },
    async withUser(tokenHash) {
      const s = st.sessions.get(tokenHash);
      if (!s || s.revoked_at || s.expires_at <= now()) return null;
      return { ...s, user: await users.byId(s.user_id) };
    },
    async touch(tokenHash) { const s = st.sessions.get(tokenHash); if (s) s.last_seen_at = now(); },
    async revoke(tokenHash) { const s = st.sessions.get(tokenHash); if (s) s.revoked_at = now(); },
    async revokeAllFor(userId) { for (const s of st.sessions.values()) if (s.user_id === Number(userId)) s.revoked_at = now(); },
    async listFor(userId) { return [...st.sessions.values()].filter((s) => s.user_id === Number(userId) && !s.revoked_at && s.expires_at > now()); },
    async purge() {},
    async active() { return [...st.sessions.values()].filter((s) => !s.revoked_at && s.expires_at > now()).length; },
  };

  const resets = {
    async create({ userId, tokenHash, expiresAt, ip = null, sentVia = null }) {
      st.resets.set(tokenHash, { token_hash: tokenHash, user_id: Number(userId), expires_at: new Date(expiresAt),
        created_at: now(), used_at: null, ip, sent_via: sentVia });
    },
    async byToken(tokenHash) {
      const r = st.resets.get(tokenHash);
      return r && !r.used_at && r.expires_at > now() ? clone(r) : null;
    },
    async use(tokenHash) {
      const r = st.resets.get(tokenHash);
      if (!r || r.used_at || r.expires_at <= now()) return null;
      r.used_at = now();
      return clone(r);
    },
    async recentFor(userId, minutes = 10) {
      const edge = Date.now() - minutes * 60000;
      return [...st.resets.values()].filter((r) => r.user_id === Number(userId) && r.created_at.getTime() > edge).length;
    },
    async last(limit = 20) { return [...st.resets.values()].slice(-limit).reverse(); },
  };

  const events = {
    async add(e) {
      st.events.push({ id: st.events.length + 1, at: now(), level: e.level || 'info', area: e.area || 'app',
        action: e.action, message: e.message || null, user_id: e.userId || null, actor: e.actor || null,
        entity: e.entity || null, entity_id: e.entityId == null ? null : String(e.entityId),
        ip: e.ip || null, ua: e.ua || null, meta: e.meta || {} });
    },
    async list({ area = null, level = null, entity = null, entityId = null, userId = null, limit = 200 } = {}) {
      return st.events.filter((e) => (!area || e.area === area) && (!level || e.level === level)
        && (!entity || e.entity === entity) && (!entityId || e.entity_id === String(entityId))
        && (!userId || e.user_id === Number(userId))).slice(-limit).reverse();
    },
    async stats() {
      return { total: st.events.length,
        errors: st.events.filter((e) => e.level === 'error').length,
        warns: st.events.filter((e) => e.level === 'warn').length,
        security: st.events.filter((e) => e.level === 'security').length };
    },
    async purge() {},
  };

  const clientDeals = {
    async list(user) {
      const tail = user.phone ? String(user.phone).slice(-10) : null;
      return st.deals.filter((d) => d.client_user_id === user.id
        || (user.email && String(d.client_contact || '').toLowerCase() === user.email)
        || (tail && String(d.client_contact || '').replace(/\D/g, '').endsWith(tail)));
    },
    async attach(dealId, userId) {
      const d = st.deals.find((x) => x.id === dealId);
      if (d && !d.client_user_id) d.client_user_id = Number(userId);
    },
  };

  return { users, sessions, resets, events, clientDeals, norm, _state: st };
}

module.exports = { memoryAdminStore };
