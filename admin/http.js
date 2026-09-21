// Раздел /admin — одно место, где видно всё: заявки, клиенты, вопросы, спрос,
// база знаний, службы, журнал и доступы. Плюс личный кабинет клиента /cabinet.
//
// Зачем он, если уже есть /crm и /seo: те две панели — рабочие столы (мастер
// отвечает клиенту, владелец смотрит спрос). /admin — уровень выше: кто вошёл,
// что происходило, что настроено, кому открыт доступ. Прежние панели остаются
// и подчищаются постепенно; вход у всех теперь общий — сессия /admin годится
// и для /crm, и для /seo (см. staffOk, его зовут обе панели).
const { form, readBody } = require('../engine/multipart');
const accounts = require('./accounts');
const clients = require('./clients');
const defaultStore = require('./store');
const log = require('./log');
const notify = require('./notify');
const pages = require('./pages');
const ui = require('./ui');
const db = require('../seo/lib/db');
const dealStore = require('../engine/store');
const { esc, page } = ui;

const COOKIE = 'sasha_admin';
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';')
  .map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
// Кука одна на админку и кабинет: сессия и роль лежат в базе, а не в куке, —
// значит, «повысить себе роль», подменив её, нельзя.
const setCookie = (t) => `${COOKIE}=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${accounts.SESSION_DAYS() * 86400}`;
const dropCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

function origin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
  const proto = req.headers['x-forwarded-proto'] || (/^(127\.|localhost)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

const me = (req, opts) => accounts.session(cookies(req)[COOKIE], opts);
const who = (u) => (u ? u.email || u.phone || `#${u.id}` : null);

// ── экраны входа ──────────────────────────────────────────────────────────
const loginPage = ({ err = null, where = '/admin', title = 'Вход в админку', note = 'Заявки, клиенты, знания, журнал и доступы.' } = {}) =>
  page(title, `<form class="auth" method="POST" action="${where}/login">
  <h1>${esc(title)}</h1><p class="sub">${esc(note)}</p>
  ${err ? `<p class="err">${esc(err)}</p>` : ''}
  <label>Почта или телефон<input name="login" autofocus autocomplete="username"></label>
  <label>Пароль<input type="password" name="password" autocomplete="current-password"></label>
  <button type="submit">Войти</button>
  <p class="sub" style="margin-top:14px"><a href="${where}/forgot">Забыли пароль?</a>${
    where === '/cabinet' ? ' · <a href="/cabinet/register">Первый раз здесь</a>' : ''}</p></form>`);

const forgotPage = ({ where = '/admin', done = false } = {}) => page('Восстановление доступа',
  `<form class="auth" method="POST" action="${where}/forgot"><h1>Восстановление доступа</h1>
  ${done
    ? `<p class="sub">Если такой контакт нам известен, ссылка на смену пароля уже отправлена. Она действует ${accounts.RESET_MINUTES()} мин и сработает один раз.</p>
       <p class="sub"><a href="${where}/login">← ко входу</a></p>`
    : `<p class="sub">Укажите почту или телефон — пришлём ссылку на смену пароля.</p>
       <label>Почта или телефон<input name="login" autofocus></label>
       <input type="hidden" name="where" value="${where}">
       <button type="submit">Прислать ссылку</button>
       <p class="sub" style="margin-top:14px"><a href="${where}/login">← ко входу</a></p>`}</form>`);

const resetPage = ({ token = '', err = null, dead = false } = {}) => page('Новый пароль',
  dead ? `<form class="auth"><h1>Ссылка не работает</h1>
    <p class="sub">Она одноразовая и живёт ${accounts.RESET_MINUTES()} мин. Запросите новую — это бесплатно и быстро.</p>
    <p><a href="/admin/forgot">Запросить ссылку</a></p></form>`
  : `<form class="auth" method="POST" action="/admin/reset">
  <h1>Новый пароль</h1><p class="sub">После сохранения все прежние входы с этой учётки закроются.</p>
  ${err ? `<p class="err">${esc(err)}</p>` : ''}
  <input type="hidden" name="token" value="${esc(token)}">
  <label>Пароль (от 8 знаков)<input type="password" name="password" autofocus autocomplete="new-password"></label>
  <label>Ещё раз<input type="password" name="password2" autocomplete="new-password"></label>
  <button type="submit">Сохранить</button></form>`);

const donePage = (title, text, link, label) => page(title,
  `<form class="auth"><h1>${esc(title)}</h1><p class="sub">${esc(text)}</p><p><a href="${esc(link)}">${esc(label)}</a></p></form>`);

// Первый запуск: служебных учёток нет, завести владельца больше некому.
// Форма живёт ровно до появления первой такой учётки, а если в окружении остался
// прежний пароль панелей — он же её и отпирает.
const setupPage = (err) => page('Первый вход', `<form class="auth" method="POST" action="/admin/setup">
  <h1>Первый вход</h1><p class="sub">Служебных учёток ещё нет. Заведите владельца — дальше доступы раздаются из раздела «Доступы».</p>
  ${err ? `<p class="err">${esc(err)}</p>` : ''}
  <label>Имя<input name="name" autofocus></label>
  <label>Почта<input name="email" type="email" autocomplete="username"></label>
  <label>Телефон<input name="phone"></label>
  <label>Пароль (от 8 знаков)<input type="password" name="password" autocomplete="new-password"></label>
  ${accounts.envPassword() ? '<label>Прежний пароль панели (ADMIN_PASSWORD / SEO_ADMIN_PASSWORD)<input type="password" name="envpass"></label>' : ''}
  <button type="submit">Создать владельца</button></form>`);

// Служебных учёток может не быть только один раз в жизни контура — после
// появления первой перестаём спрашивать базу на каждый запрос.
let staffExists = false;
async function needSetup(store) {
  if (staffExists) return false;
  const s = await store.users.stats();
  staffExists = (s.staff || 0) > 0;
  return !staffExists;
}

// ── маршруты ──────────────────────────────────────────────────────────────
async function route(req, res, { store = defaultStore } = {}) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const inAdmin = p === '/admin' || p.startsWith('/admin/');
  const inCabinet = p === '/cabinet' || p.startsWith('/cabinet/');
  if (!inAdmin && !inCabinet) return false;

  const section = inAdmin ? '/admin' : '/cabinet';
  const send = (code, html, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store', ...headers });
    res.end(html);
    return true;
  };
  const go = (to, msg = null) => send(302, '', { Location: msg ? `${to}${to.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}` : to });
  const body = async () => (await form(req)).fields;
  const msg = url.searchParams.get('msg');

  // Раздел целиком живёт в базе: без неё нечего показывать и некого пускать.
  if (!db.enabled) {
    return send(503, page('Админка', `<form class="auth"><h1>Нет хранилища</h1>
      <p class="sub">Не задан SASHALAB_PG_URL. Люди, сессии, журнал и заявки живут в базе — без неё раздел не работает.</p></form>`));
  }

  // ── первый владелец ─────────────────────────────────────────────────────
  if (await needSetup(store)) {
    if (p === '/admin/setup' && req.method === 'POST') {
      const f = await body();
      try {
        if (accounts.envPassword() && String(f.envpass || '') !== accounts.envPassword()) throw new Error('прежний пароль панели не подошёл');
        const user = await accounts.createUser({ email: f.email, phone: f.phone, name: f.name, role: 'owner', password: f.password },
          { store, actor: 'setup', req });
        staffExists = true;
        const r = await accounts.login({ login: f.email || f.phone, password: f.password, req }, { store });
        await log.security({ area: 'admin', action: 'setup', userId: user.id, actor: who(user), ...log.web(req) }, { store });
        return send(302, '', { Location: '/admin/', 'Set-Cookie': setCookie(r.token) });
      } catch (e) { return send(200, setupPage(e.message)); }
    }
    if (inCabinet) return send(200, setupPage(null));
    return send(200, setupPage(null));
  }
  if (p === '/admin/setup') return go('/admin/login');

  // ── публичные экраны входа ──────────────────────────────────────────────
  if (p === `${section}/login`) {
    if (req.method !== 'POST') {
      return send(200, loginPage(inCabinet
        ? { where: '/cabinet', title: 'Кабинет клиента', note: 'Ваши заявки, расчёты и переписка со студией.' }
        : {}));
    }
    const f = await body();
    const r = await accounts.login({ login: f.login, password: f.password, req }, { store });
    if (!r.ok) {
      return send(401, loginPage({ err: r.error, ...(inCabinet ? { where: '/cabinet', title: 'Кабинет клиента' } : {}) }));
    }
    // Клиенту в админке делать нечего, сотруднику в кабинете — тоже:
    // каждого уводим в его раздел, независимо от того, где он вошёл.
    const to = accounts.isStaff(r.user) ? '/admin/' : '/cabinet/';
    if (!accounts.isStaff(r.user)) await clients.attachDeals(r.user, { store }).catch(() => null);
    return send(302, '', { Location: to, 'Set-Cookie': setCookie(r.token) });
  }

  if (p === `${section}/forgot`) {
    if (req.method !== 'POST') return send(200, forgotPage({ where: section }));
    const f = await body();
    await accounts.requestReset({ login: f.login, req, origin: origin(req) }, { store });
    return send(200, forgotPage({ where: section, done: true }));
  }

  if (p === '/admin/reset') {
    if (req.method !== 'POST') {
      const t = url.searchParams.get('token') || '';
      return send(200, resetPage({ token: t, dead: !(await accounts.resetValid(t, { store })) }));
    }
    const f = await body();
    if (String(f.password || '') !== String(f.password2 || '')) return send(200, resetPage({ token: f.token, err: 'пароли не совпали' }));
    const r = await accounts.resetPassword({ token: f.token, password: f.password, req }, { store });
    if (!r.ok) return send(200, resetPage({ token: f.token, err: r.error, dead: Boolean(r.dead) }));
    const to = accounts.isStaff(r.user) ? '/admin/login' : '/cabinet/login';
    return send(200, donePage('Пароль изменён', 'Прежние входы с этой учётки закрыты. Войдите с новым паролем.', to, 'Войти'));
  }

  if (p === '/cabinet/register') {
    if (req.method !== 'POST') return send(200, pages.registerPage());
    const f = await body();
    try {
      const login = String(f.login || '').trim();
      if (!login) throw new Error('нужна почта или телефон');
      const bad = accounts.passwordProblem(f.password);
      if (bad) throw new Error(bad);
      let user = await store.users.byLogin(login);
      if (user && user.password_hash) throw new Error('такой кабинет уже есть — войдите или восстановите пароль');
      if (user) {
        // Учётка уже заведена по заявке: человеку остаётся задать пароль.
        await accounts.setPassword(user.id, f.password, { store, actor: who(user), req });
        if (f.name && !user.name) await store.users.update(user.id, { name: f.name });
      } else {
        user = await accounts.createUser({
          email: login.includes('@') ? login : null, phone: login.includes('@') ? null : login,
          name: f.name || null, role: 'client', password: f.password }, { store, actor: login, req });
      }
      await clients.attachDeals(await store.users.byId(user.id), { store }).catch(() => null);
      return send(200, pages.registerPage({ done: true }));
    } catch (e) { return send(200, pages.registerPage({ err: e.message })); }
  }

  if (p === `${section}/logout`) {
    const u = await me(req, { store, touch: false });
    await accounts.logout(cookies(req)[COOKIE], { store, req, user: u });
    return send(302, '', { Location: `${section}/login`, 'Set-Cookie': dropCookie() });
  }

  // ── дальше только для вошедших ──────────────────────────────────────────
  const user = await me(req, { store });
  if (!user) return go(`${section}/login`);
  const staff = accounts.isStaff(user);
  if (inAdmin && !staff) return go('/cabinet/');
  if (inCabinet && staff && p === '/cabinet') return go('/admin/');
  const ctx = { store, actor: who(user), req };

  // ── кабинет клиента ─────────────────────────────────────────────────────
  if (inCabinet) {
    if (p === '/cabinet/message' && req.method === 'POST') {
      const f = await body();
      const text = String(f.text || '').trim().slice(0, 4000);
      const d = await dealStore.deals.byId(f.id);
      const mine = d && (Number(d.client_user_id) === user.id
        || (user.email && String(d.client_contact || '').toLowerCase() === user.email));
      if (!mine || !text) return go(`/cabinet/d?id=${encodeURIComponent(f.id || '')}`, 'сообщение не отправлено');
      await dealStore.messages.add({ dealId: d.id, direction: 'in', channel: 'web', author: 'client', text });
      await log.info({ area: 'cabinet', action: 'deal.message', userId: user.id, actor: who(user),
        entity: 'deal', entityId: d.id, ...log.web(req) }, { store });
      // Пересчёт — фоном: клиент не должен ждать модель, а мастер увидит
      // обновлённый ответ в своей панели.
      require('../engine/pipeline').think(d.id, {}).catch((e) => log.warn({ area: 'engine', action: 'think.fail', entity: 'deal', entityId: d.id, message: e.message }, { store }));
      return go(`/cabinet/d?id=${encodeURIComponent(d.id)}`, 'сообщение отправлено — мастер увидит его в панели');
    }
    if (p === '/cabinet/profile/password' && req.method === 'POST') {
      const f = await body();
      if (!accounts.verifyPassword(f.current, user.password_hash)) return go('/cabinet/profile', 'текущий пароль неверен');
      if (String(f.password || '') !== String(f.password2 || '')) return go('/cabinet/profile', 'пароли не совпали');
      try { await accounts.setPassword(user.id, f.password, ctx); } catch (e) { return go('/cabinet/profile', e.message); }
      return send(302, '', { Location: '/cabinet/login', 'Set-Cookie': dropCookie() });
    }
    if (p === '/cabinet/profile/kick' && req.method === 'POST') {
      await store.sessions.revokeAllFor(user.id);
      return send(302, '', { Location: '/cabinet/login', 'Set-Cookie': dropCookie() });
    }
    if (p === '/cabinet/profile') {
      return send(200, await pages.profile(user, msg, { items: ui.CABINET_NAV, active: '/cabinet/profile',
        logout: '/cabinet/logout', action: '/cabinet/profile' }));
    }
    if (p === '/cabinet/d') return send(200, await pages.cabinetDeal(user, url.searchParams.get('id'), msg));
    return send(200, await pages.cabinet(user, msg));
  }

  // ── админка ─────────────────────────────────────────────────────────────
  if (p.startsWith('/admin/users/') && req.method === 'POST') {
    if (!accounts.atLeast(user, 'admin')) return go('/admin/users', 'доступов не хватает: это делает администратор или владелец');
    const f = await body();
    const target = f.id ? await store.users.byId(f.id) : null;
    try {
      if (p === '/admin/users/create') {
        if (f.role === 'owner' && !accounts.atLeast(user, 'owner')) throw new Error('владельца назначает только владелец');
        const created = await accounts.createUser({ email: f.email, phone: f.phone, name: f.name, role: f.role || 'master' }, ctx);
        const r = await accounts.requestReset({ login: created.email || created.phone, req, origin: origin(req) }, { store });
        return go('/admin/users', r.sent ? `создан, ссылка на пароль ушла через ${r.via}` : 'создан; ссылку на пароль отправить нечем — смотрите admin/cli.js reset-link');
      }
      if (!target) throw new Error('человек не найден');
      if (p === '/admin/users/role') {
        if (Number(target.id) === Number(user.id)) throw new Error('свою роль не меняют');
        if ((f.role === 'owner' || target.role === 'owner') && !accounts.atLeast(user, 'owner')) throw new Error('роль владельца меняет только владелец');
        await store.users.update(target.id, { role: f.role });
        await log.security({ area: 'admin', action: 'user.role', actor: ctx.actor, userId: target.id, entity: 'user',
          entityId: target.id, message: `${target.role} → ${f.role}`, ...log.web(req) }, { store });
        return go('/admin/users', 'роль изменена');
      }
      if (p === '/admin/users/status') {
        if (Number(target.id) === Number(user.id)) throw new Error('себя блокировать нельзя');
        await store.users.update(target.id, { status: f.status === 'blocked' ? 'blocked' : 'active' });
        if (f.status === 'blocked') await store.sessions.revokeAllFor(target.id);
        await log.security({ area: 'admin', action: 'user.status', actor: ctx.actor, userId: target.id, entity: 'user',
          entityId: target.id, message: f.status, ...log.web(req) }, { store });
        return go(target.role === 'client' ? `/admin/client?id=${target.id}` : '/admin/users', 'состояние изменено');
      }
      if (p === '/admin/users/invite') {
        const r = await accounts.requestReset({ login: target.email || target.phone, req, origin: origin(req) }, { store });
        return go(target.role === 'client' ? `/admin/client?id=${target.id}` : '/admin/users',
          r.sent ? `ссылка ушла через ${r.via}` : 'отправить нечем: нет настроенного канала — ссылка в логе процесса');
      }
      if (p === '/admin/users/kick') {
        await store.sessions.revokeAllFor(target.id);
        await log.security({ area: 'admin', action: 'user.kick', actor: ctx.actor, userId: target.id, entity: 'user', entityId: target.id, ...log.web(req) }, { store });
        return go('/admin/users', 'сессии закрыты');
      }
    } catch (e) { return go('/admin/users', e.message); }
  }

  if (p === '/admin/profile/password' && req.method === 'POST') {
    const f = await body();
    if (!accounts.verifyPassword(f.current, user.password_hash)) return go('/admin/profile', 'текущий пароль неверен');
    if (String(f.password || '') !== String(f.password2 || '')) return go('/admin/profile', 'пароли не совпали');
    try { await accounts.setPassword(user.id, f.password, ctx); } catch (e) { return go('/admin/profile', e.message); }
    return send(302, '', { Location: '/admin/login', 'Set-Cookie': dropCookie() });
  }
  if (p === '/admin/profile/kick' && req.method === 'POST') {
    await store.sessions.revokeAllFor(user.id);
    return send(302, '', { Location: '/admin/login', 'Set-Cookie': dropCookie() });
  }

  // ── парсеры: запуск и остановка сбора через общий замок ─────────────────
  if (p.startsWith('/admin/parsers/') && req.method === 'POST') {
    const control = require('../harvest/control');
    const { SOURCES } = require('../harvest/sources');
    if (!accounts.atLeast(user, 'admin')) return go('/admin/parsers', 'доступов не хватает: сбор запускает администратор или владелец');
    // Форма с чекбоксами шлёт host несколько раз — общий разбор форм оставляет
    // только последний, поэтому тело читаем сами.
    const params = new URLSearchParams((await readBody(req, 64 * 1024)).toString('utf8'));
    if (p === '/admin/parsers/start') {
      const wanted = params.get('one') ? [params.get('one')] : params.getAll('host');
      // Только хосты из реестра и только включённые: строка из формы уходит
      // аргументом в очередь, мусору туда дороги нет.
      const hosts = [...new Set(wanted)].filter((h) => SOURCES.some((s) => s.host === h && s.enabled !== false));
      const r = await control.start(hosts);
      await log[r.ok ? 'info' : 'warn']({ area: 'harvest', action: 'parsers.start', actor: ctx.actor, userId: user.id,
        message: `${hosts.join(' ') || '—'}${r.ok ? '' : ` — ${r.error}`}`, meta: { hosts, pid: r.pid || null }, ...log.web(req) }, { store });
      return go('/admin/parsers', r.ok ? `сбор запущен: ${hosts.join(', ')}` : `не запущено: ${r.error}`);
    }
    if (p === '/admin/parsers/stop') {
      const lock = params.get('lock') || control.MAIN;
      const r = await control.stop(lock);
      await log.info({ area: 'harvest', action: 'parsers.stop', actor: ctx.actor, userId: user.id,
        message: `${lock}: ${r.ok ? `процессов ${r.stopped || 0}` : r.error}`, meta: r, ...log.web(req) }, { store });
      if (!r.ok) return go('/admin/parsers', r.error);
      return go('/admin/parsers', r.note || (r.still ? `остановлено не всё: осталось процессов ${r.still}` : `сбор остановлен (процессов: ${r.stopped})`));
    }
  }
  if (p === '/admin/parsers/log') {
    const host = url.searchParams.get('host') || '';
    if (!require('../harvest/sources').SOURCES.some((s) => s.host === host)) return go('/admin/parsers', 'нет такого источника');
    const t = require('../harvest/control').tail(host);
    return send(200, pages.parserLog(user, host, t.text, t.file));
  }
  if (p === '/admin/parsers') return send(200, await pages.parsers(user, msg));
  if (p === '/admin/api/parsers.json') {
    const control = require('../harvest/control');
    const data = { ...control.status(), sources: await pages.soft(() => require('../harvest/store').sourceStats(), []) };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.end(JSON.stringify(data, null, 2));
    return true;
  }

  // Машиночитаемая сводка: для дашборда владельца и внешних проверок.
  if (p === '/admin/api/summary.json') {
    const data = {
      deals: await pages.soft(() => dealStore.deals.stats(), null),
      users: await pages.soft(() => store.users.stats(), null),
      events24h: await pages.soft(() => store.events.stats(24), null),
      seo: await pages.soft(() => require('../seo/lib/jobs').summary(), null),
      channels: require('../engine/channels').status(),
      db: db.enabled,
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.end(JSON.stringify(data, null, 2));
    return true;
  }

  if (p === '/admin/deals') return send(200, await pages.deals(user, url, msg));
  if (p === '/admin/deal') return send(200, await pages.deal(user, url.searchParams.get('id'), msg));
  if (p === '/admin/clients') return send(200, await pages.clients(user, url, msg));
  if (p === '/admin/client') return send(200, await pages.client(user, url.searchParams.get('id'), msg));
  if (p === '/admin/questions') return send(200, await pages.questions(user, msg));
  if (p === '/admin/knowledge') return send(200, await pages.knowledge(user, msg));
  if (p === '/admin/users') return send(200, await pages.users(user, msg));
  if (p === '/admin/log') return send(200, await pages.logPage(user, url, msg));
  if (p === '/admin/services') return send(200, await pages.services(user, msg));
  if (p === '/admin/profile') return send(200, await pages.profile(user, msg));
  return send(200, await pages.dashboard(user, msg));
}

async function handle(req, res, opts = {}) {
  try {
    return await route(req, res, opts);
  } catch (e) {
    console.error('админка:', e.stack || e.message);
    log.error({ area: 'admin', action: 'crash', message: e.message, ...log.web(req) }, opts).catch(() => null);
    if (res.headersSent) return true;
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' });
    res.end(page('Ошибка', `<form class="auth"><h1>Ошибка админки</h1><p class="sub">${esc(e.message)}</p>
      <p><a href="/admin/">Назад</a></p></form>`));
    return true;
  }
}

// Общая дверь для старых панелей: сотрудник, вошедший в /admin, не должен
// вводить ещё один пароль в /crm и /seo.
async function staffUser(req, { store = defaultStore } = {}) {
  try {
    const u = await accounts.session(cookies(req)[COOKIE], { store, touch: false });
    return accounts.isStaff(u) ? u : null;
  } catch { return null; }
}
const staffOk = async (req, opts) => Boolean(await staffUser(req, opts));

module.exports = { handle, route, staffOk, staffUser, COOKIE, setCookie, dropCookie, origin };
