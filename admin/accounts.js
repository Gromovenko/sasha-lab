// Учётные записи: пароли, вход, сессии, роли, восстановление доступа.
//
// Почему не осталась прежняя дверь «один пароль из окружения»: у неё нет имени
// вошедшего (в журнале «кто-то»), нет отзыва доступа (сменить пароль = выгнать
// всех и всем раздать новый), нет кабинета клиента и нет восстановления. Здесь
// всё это есть, а прежний пароль окружения продолжает работать как запасной
// вход владельца (см. envFallback) — чтобы выкат не запер людей снаружи.
//
// Пароль хранится scrypt-хэшем со своей солью на запись. Сравнение — по
// timingSafeEqual, ответ на «нет такого человека» и «неверный пароль» одинаков
// и одинаково медленный: иначе форма входа работает как справочник клиентов.
const crypto = require('crypto');
const defaultStore = require('./store');
const log = require('./log');

const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
const SESSION_DAYS = () => Number(process.env.ADMIN_SESSION_DAYS || 14);
const RESET_MINUTES = () => Number(process.env.ADMIN_RESET_MINUTES || 60);
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

const ROLES = { owner: 4, admin: 3, master: 2, client: 1 };
const ROLE_TITLE = { owner: 'владелец', admin: 'администратор', master: 'мастер', client: 'клиент' };
const isStaff = (u) => Boolean(u) && (ROLES[u.role] || 0) >= ROLES.master;
const atLeast = (u, role) => Boolean(u) && (ROLES[u.role] || 0) >= (ROLES[role] || 99);

// ── пароли ────────────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(password), salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${dk.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [alg, N, r, p, salt, hex] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hex) return false;
  const dk = crypto.scryptSync(String(password), salt, hex.length / 2, { N: Number(N), r: Number(r), p: Number(p) });
  const want = Buffer.from(hex, 'hex');
  return dk.length === want.length && crypto.timingSafeEqual(dk, want);
}

// Требования к паролю намеренно скромные и понятные: длина решает больше, чем
// «обязательный спецсимвол», а невыполнимая политика кончается стикером на мониторе.
function passwordProblem(password) {
  const s = String(password || '');
  if (s.length < 8) return 'пароль короче 8 знаков';
  if (/^\d+$/.test(s)) return 'пароль из одних цифр подбирается за минуты';
  if (['12345678', 'password', 'qwertyui', 'пароль123'].includes(s.toLowerCase())) return 'это один из самых частых паролей';
  return null;
}

const token = () => crypto.randomBytes(32).toString('base64url');
const fingerprint = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// ── люди ──────────────────────────────────────────────────────────────────
async function createUser({ email = null, phone = null, name = null, role = 'client', password = null, status = 'active', meta = {} }, { store = defaultStore, actor = null, req = null } = {}) {
  if (!ROLES[role]) throw new Error(`неизвестная роль: ${role}`);
  if (!email && !phone) throw new Error('нужна почта или телефон');
  if (password) {
    const bad = passwordProblem(password);
    if (bad) throw new Error(bad);
  }
  const user = await store.users.create({ email, phone, name, role, status, meta,
    passwordHash: password ? hashPassword(password) : null });
  await log.security({ area: 'admin', action: 'user.create', actor, userId: user.id, entity: 'user', entityId: user.id,
    message: `${ROLE_TITLE[role]}: ${user.email || user.phone}`, ...log.web(req) }, { store });
  return user;
}

async function setPassword(userId, password, { store = defaultStore, actor = null, req = null, keepSessions = false } = {}) {
  const bad = passwordProblem(password);
  if (bad) throw new Error(bad);
  await store.users.setPassword(userId, hashPassword(password));
  // Смена пароля выбивает все прежние сессии: иначе «меня взломали, я сменил
  // пароль» не значит ничего — чужая кука продолжает работать две недели.
  if (!keepSessions) await store.sessions.revokeAllFor(userId);
  await log.security({ area: 'admin', action: 'user.password', actor, userId, entity: 'user', entityId: userId, ...log.web(req) }, { store });
}

// ── вход ──────────────────────────────────────────────────────────────────
// Запасной вход владельца по паролю из окружения: пока учёток нет (первый
// выкат) или если владелец потерял доступ к почте и телефону разом.
const envPassword = () => process.env.ADMIN_PASSWORD || process.env.SEO_ADMIN_PASSWORD || '';

async function login({ login: loginName, password, req = null }, { store = defaultStore } = {}) {
  const w = log.web(req);
  const deny = async (reason, userId = null) => {
    await log.security({ area: 'auth', action: 'login.fail', actor: String(loginName || '').slice(0, 120),
      userId, message: reason, ...w }, { store });
    return { ok: false, error: 'Неверный логин или пароль' };
  };
  const user = await store.users.byLogin(loginName);
  if (!user) {
    // Ровно та же работа по времени, что и при существующем человеке: иначе по
    // скорости ответа перебирается база клиентов.
    crypto.scryptSync(String(password || ''), 'timing', 32, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return deny('нет такого логина');
  }
  if (user.status === 'blocked') return deny('учётка заблокирована', user.id);
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { ok: false, error: `Слишком много попыток. Попробуйте через ${Math.ceil((new Date(user.locked_until) - Date.now()) / 60000)} мин` };
  }
  if (!user.password_hash) return deny('пароль ещё не задан', user.id);
  if (!verifyPassword(password, user.password_hash)) {
    const fails = (user.failed_logins || 0) + 1;
    const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60000) : null;
    await store.users.noteLogin(user.id, false, lock);
    return deny(lock ? `неверный пароль, блок на ${LOCK_MINUTES} мин` : 'неверный пароль', user.id);
  }
  await store.users.noteLogin(user.id, true);
  const t = token();
  await store.sessions.create({ userId: user.id, tokenHash: fingerprint(t),
    expiresAt: new Date(Date.now() + SESSION_DAYS() * 864e5), ip: w.ip, ua: w.ua });
  await log.security({ area: 'auth', action: 'login.ok', actor: user.email || user.phone, userId: user.id, ...w }, { store });
  return { ok: true, user, token: t };
}

async function session(t, { store = defaultStore, touch = true } = {}) {
  if (!t) return null;
  const s = await store.sessions.withUser(fingerprint(t));
  if (!s || !s.user || s.user.status === 'blocked') return null;
  if (touch) await store.sessions.touch(fingerprint(t)).catch(() => null);
  return s.user;
}

async function logout(t, { store = defaultStore, req = null, user = null } = {}) {
  if (!t) return;
  await store.sessions.revoke(fingerprint(t));
  await log.security({ area: 'auth', action: 'logout', actor: user ? (user.email || user.phone) : null,
    userId: user?.id || null, ...log.web(req) }, { store });
}

// ── восстановление пароля ─────────────────────────────────────────────────
// Наружу форма отвечает одинаково всегда («если контакт известен — ссылка
// ушла»), иначе она превращается в проверку «есть ли такой клиент у студии».
// Правда о том, ушло ли что-нибудь и куда, лежит в журнале.
async function requestReset({ login: loginName, req = null, origin = '', deliver = null }, { store = defaultStore } = {}) {
  const w = log.web(req);
  const user = await store.users.byLogin(loginName);
  if (!user || user.status === 'blocked') {
    await log.security({ area: 'auth', action: 'reset.unknown', actor: String(loginName || '').slice(0, 120), ...w }, { store });
    return { ok: true, sent: false };
  }
  // Не даём превратить форму в рассылку: 3 письма за 10 минут на человека.
  if (await store.resets.recentFor(user.id, 10) >= 3) {
    await log.warn({ area: 'auth', action: 'reset.throttled', userId: user.id, actor: user.email || user.phone, ...w }, { store });
    return { ok: true, sent: false };
  }
  const t = token();
  const link = `${origin}/admin/reset?token=${t}`;
  const send = deliver || require('./notify').resetLink;
  const r = await send({ user, link, minutes: RESET_MINUTES() });
  await store.resets.create({ userId: user.id, tokenHash: fingerprint(t),
    expiresAt: new Date(Date.now() + RESET_MINUTES() * 60000), ip: w.ip, sentVia: r.via || null });
  await log.security({ area: 'auth', action: r.ok ? 'reset.sent' : 'reset.undelivered', userId: user.id,
    actor: user.email || user.phone, message: r.ok ? `через ${r.via}` : r.error || 'канал не настроен',
    // Ссылка в журнал НЕ кладётся: журнал читают несколько человек, а ссылка —
    // это вход в чужую учётку. Владельцу её выдаёт `node admin/cli.js reset-link`.
    meta: { via: r.via || null }, ...w }, { store });
  if (!r.ok) console.log(`ссылка на смену пароля (${user.email || user.phone}): ${link}`);
  return { ok: true, sent: r.ok, via: r.via || null, link };
}

async function resetPassword({ token: t, password, req = null }, { store = defaultStore } = {}) {
  const bad = passwordProblem(password);
  if (bad) return { ok: false, error: bad };
  const row = await store.resets.use(fingerprint(t || ''));
  if (!row) {
    await log.security({ area: 'auth', action: 'reset.badtoken', ...log.web(req) }, { store });
    // dead — отдельный признак: по мёртвой ссылке форму нового пароля больше
    // не показываем, иначе человек трижды вводит пароль в никуда.
    return { ok: false, dead: true, error: 'Ссылка устарела или уже использована. Запросите новую.' };
  }
  const user = await store.users.byId(row.user_id);
  await setPassword(user.id, password, { store, actor: user.email || user.phone, req });
  await log.security({ area: 'auth', action: 'reset.done', userId: user.id, actor: user.email || user.phone, ...log.web(req) }, { store });
  return { ok: true, user };
}

// Проверка токена до показа формы: не спрашиваем новый пароль по мёртвой ссылке.
const resetValid = async (t, { store = defaultStore } = {}) => Boolean(t && await store.resets.byToken(fingerprint(t)));

module.exports = {
  ROLES, ROLE_TITLE, isStaff, atLeast,
  hashPassword, verifyPassword, passwordProblem, token, fingerprint,
  createUser, setPassword, login, session, logout,
  requestReset, resetPassword, resetValid, envPassword,
  SESSION_DAYS, RESET_MINUTES, MAX_FAILS, LOCK_MINUTES,
};
