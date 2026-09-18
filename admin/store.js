// Хранилище раздела /admin: люди, сессии, сброс пароля, журнал событий.
//
// Дисциплина та же, что у engine/store.js и seo/lib/store.js: модуль грузится
// всегда, падает только конкретный вызов, если базы нет (на EU её нет вовсе —
// персданные живут на RU). Интерфейс повторён в admin/memory-store.js, тесты
// гоняют ту же логику без postgres.
const db = require('../seo/lib/db');

const norm = {
  email: (v) => (v ? String(v).trim().toLowerCase() : null),
  // Телефон в базе — только цифры: «+7 909 888-75-75», «8 909…» и «79098887575»
  // должны находить ОДНОГО человека, иначе восстановление пароля не сработает
  // ровно тогда, когда оно нужно.
  phone: (v) => {
    const d = String(v || '').replace(/\D/g, '');
    if (!d) return null;
    const full = d.length === 11 && d[0] === '8' ? `7${d.slice(1)}` : d.length === 10 ? `7${d}` : d;
    return full.length >= 10 ? full : null;
  },
};

// bigint в postgres приезжает в node СТРОКОЙ ('7'), а тот же id из row_to_json —
// числом (7). Сравнение «это я?» на строгом равенстве в таком виде всегда ложно:
// владелец однажды заблокировал сам себя. Поэтому все id нормализуются на входе
// в приложение, один раз, здесь.
const num = (v) => (v == null ? null : Number(v));
const user = (r) => (r ? { ...r, id: num(r.id) } : null);
const users = {
  async create({ email = null, phone = null, name = null, role = 'client', passwordHash = null, status = 'active', meta = {} }) {
    const [row] = await db.q(
      `INSERT INTO app_users (email, phone, name, role, password_hash, status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [norm.email(email), norm.phone(phone), name, role, passwordHash, status, meta]);
    return user(row);
  },
  byId: async (id) => user(await db.one('SELECT * FROM app_users WHERE id=$1', [Number(id) || 0])),
  byEmail: async (email) => (norm.email(email) ? user(await db.one('SELECT * FROM app_users WHERE email=$1', [norm.email(email)])) : null),
  byPhone: async (phone) => (norm.phone(phone) ? user(await db.one('SELECT * FROM app_users WHERE phone=$1', [norm.phone(phone)])) : null),
  // Одна дверь для входа и восстановления: человек пишет что помнит.
  async byLogin(login) {
    const s = String(login || '').trim();
    if (!s) return null;
    if (s.includes('@')) return users.byEmail(s);
    return (await users.byPhone(s)) || users.byEmail(s);
  },
  list: async ({ role = null, limit = 200 } = {}) => (await db.q(
    `SELECT * FROM app_users ${role ? 'WHERE role = $2' : ''} ORDER BY created_at DESC LIMIT $1`,
    role ? [limit, role] : [limit])).map(user),
  async update(id, patch) {
    const cols = { email: norm.email, phone: norm.phone, name: null, role: null, status: null, meta: null, password_hash: null, locked_until: null, failed_logins: null };
    const keys = Object.keys(patch).filter((k) => k in cols);
    if (!keys.length) return users.byId(id);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const vals = keys.map((k) => (cols[k] ? cols[k](patch[k]) : patch[k]));
    const [row] = await db.q(`UPDATE app_users SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`, [Number(id), ...vals]);
    return user(row);
  },
  setPassword: (id, hash) => db.q(
    'UPDATE app_users SET password_hash=$2, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1', [Number(id), hash]),
  noteLogin: (id, ok, lockUntil = null) => db.q(
    ok ? 'UPDATE app_users SET last_login_at=now(), failed_logins=0, locked_until=NULL WHERE id=$1'
       : 'UPDATE app_users SET failed_logins = failed_logins + 1, locked_until = $2 WHERE id=$1',
    ok ? [Number(id)] : [Number(id), lockUntil]),
  stats: async () => (await db.q(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE role IN ('owner','admin','master'))::int AS staff,
           count(*) FILTER (WHERE role = 'client')::int AS clients,
           count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
           count(*) FILTER (WHERE password_hash IS NULL)::int AS invited FROM app_users`))[0],
};

const sess = (r) => (r ? { ...r, user_id: num(r.user_id), user: user(r.user) } : null);
const sessions = {
  create: ({ userId, tokenHash, expiresAt, ip = null, ua = null }) => db.q(
    'INSERT INTO app_sessions (token_hash, user_id, expires_at, ip, ua) VALUES ($1,$2,$3,$4,$5)',
    [tokenHash, Number(userId), expiresAt, ip, String(ua || '').slice(0, 300)]),
  // Живая сессия + человек одним запросом: на каждый экран панели ходить
  // в базу дважды незачем.
  withUser: async (tokenHash) => sess(await db.one(
    `SELECT s.token_hash, s.user_id, s.expires_at, s.ip, row_to_json(u.*) AS user
       FROM app_sessions s JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [tokenHash])),
  touch: (tokenHash) => db.q('UPDATE app_sessions SET last_seen_at=now() WHERE token_hash=$1', [tokenHash]),
  revoke: (tokenHash) => db.q('UPDATE app_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [tokenHash]),
  revokeAllFor: (userId) => db.q('UPDATE app_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [Number(userId)]),
  listFor: (userId) => db.q(
    `SELECT * FROM app_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC LIMIT 20`, [Number(userId)]),
  purge: () => db.q("DELETE FROM app_sessions WHERE expires_at < now() - interval '30 days'"),
  active: async () => Number((await db.one('SELECT count(*)::int AS n FROM app_sessions WHERE revoked_at IS NULL AND expires_at > now()')).n),
};

const resets = {
  create: ({ userId, tokenHash, expiresAt, ip = null, sentVia = null }) => db.q(
    'INSERT INTO app_password_resets (token_hash, user_id, expires_at, ip, sent_via) VALUES ($1,$2,$3,$4,$5)',
    [tokenHash, Number(userId), expiresAt, ip, sentVia]),
  byToken: async (tokenHash) => {
    const r = await db.one('SELECT * FROM app_password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()', [tokenHash]);
    return r ? { ...r, user_id: num(r.user_id) } : null;
  },
  // Пометка «использован» — одним UPDATE с условием: два одновременных перехода
  // по ссылке не должны оба сменить пароль.
  async use(tokenHash) {
    const [r] = await db.q(
      'UPDATE app_password_resets SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING *',
      [tokenHash]);
    return r ? { ...r, user_id: num(r.user_id) } : null;
  },
  recentFor: async (userId, minutes = 10) => Number((await db.one(
    `SELECT count(*)::int AS n FROM app_password_resets WHERE user_id=$1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [Number(userId), String(minutes)])).n),
  last: (limit = 20) => db.q(
    `SELECT r.*, u.email, u.phone, u.name FROM app_password_resets r JOIN app_users u ON u.id = r.user_id
      ORDER BY r.created_at DESC LIMIT $1`, [limit]),
};

const events = {
  add: (e) => db.q(
    `INSERT INTO app_events (level, area, action, message, user_id, actor, entity, entity_id, ip, ua, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [e.level || 'info', e.area || 'app', e.action, e.message || null, e.userId ? Number(e.userId) : null,
     e.actor || null, e.entity || null, e.entityId == null ? null : String(e.entityId),
     e.ip || null, String(e.ua || '').slice(0, 300) || null, e.meta || {}]),
  list: ({ area = null, level = null, entity = null, entityId = null, userId = null, limit = 200 } = {}) => {
    const w = [];
    const p = [Math.min(Number(limit) || 200, 1000)];
    const add = (sql, v) => { p.push(v); w.push(sql.replace('$n', `$${p.length}`)); };
    if (area) add('area = $n', area);
    if (level) add('level = $n', level);
    if (entity) add('entity = $n', entity);
    if (entityId) add('entity_id = $n', String(entityId));
    if (userId) add('user_id = $n', Number(userId));
    return db.q(`SELECT * FROM app_events ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT $1`, p);
  },
  stats: async (hours = 24) => (await db.q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE level = 'error')::int AS errors,
            count(*) FILTER (WHERE level = 'warn')::int AS warns,
            count(*) FILTER (WHERE level = 'security')::int AS security
       FROM app_events WHERE at > now() - ($1 || ' hours')::interval`, [String(hours)]))[0],
  purge: (days = 180) => db.q("DELETE FROM app_events WHERE at < now() - ($1 || ' days')::interval", [String(days)]),
};

// Заявки клиента: по учётке и по контакту, который он оставлял до регистрации.
const clientDeals = {
  list: async (u, limit = 50) => (await db.q(
    `SELECT * FROM deals
      WHERE client_user_id = $1
         OR ($2::text IS NOT NULL AND lower(client_contact) = $2)
         OR ($3::text IS NOT NULL AND regexp_replace(coalesce(client_contact,''), '\\D', '', 'g') LIKE '%' || $3)
      ORDER BY updated_at DESC LIMIT $4`,
    [Number(u.id), u.email || null, u.phone ? String(u.phone).slice(-10) : null, limit]))
    .map((d) => ({ ...d, client_user_id: num(d.client_user_id) })),
  // Привязка заявки к учётке: вызывается, когда человек впервые вошёл в кабинет.
  attach: (dealId, userId) => db.q('UPDATE deals SET client_user_id=$2 WHERE id=$1 AND client_user_id IS NULL', [dealId, Number(userId)]),
};

module.exports = { users, sessions, resets, events, clientDeals, norm, db };
