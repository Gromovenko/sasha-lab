// Экраны раздела /admin и кабинета клиента. Только сборка HTML из данных:
// маршрутизация, доступ и запись в журнал — в admin/http.js.
const ui = require('./ui');
const accounts = require('./accounts');
const defaultStore = require('./store');
const channels = require('../engine/channels');
const dealStore = require('../engine/store');
const packs = require('../engine/pack');
const quoteEngine = require('../engine/quote');
const db = require('../seo/lib/db');
const { esc, page, nav, tiles, when, ago, ADMIN_NAV, CABINET_NAV } = ui;

const STAGE = { new: 'новая', clarify: 'уточняем', quoted: 'посчитано', sent: 'ответ отправлен', won: 'в работе', lost: 'отказ', spam: 'спам' };
const asObject = (v) => (v && typeof v === 'object' ? v : v ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : {});
const asArray = (v) => (Array.isArray(v) ? v : v ? (() => { try { return JSON.parse(v); } catch { return []; } })() : []);

// Ни один сторонний раздел не имеет права уронить сводку: не накачена миграция,
// нет ключей, отвалился Яндекс — показываем то, что есть.
const soft = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

const head = (title, me, active, body, { logout = '/admin/logout', items = ADMIN_NAV } = {}) =>
  page(`${title} · админка`, `${nav(items, active, me, { logout })}${body}`);

const note = (msg) => (msg ? `<p class="sub">${esc(msg)}</p>` : '');

// ── сводка ────────────────────────────────────────────────────────────────
async function dashboard(me, msg) {
  const deals = await soft(() => dealStore.deals.stats(), {});
  const fresh = await soft(() => dealStore.deals.list({ limit: 8 }), []);
  const newQ = await soft(() => require('../seo/questions').list('new'), []);
  const seo = await soft(() => require('../seo/lib/jobs').summary(), {});
  const users = await soft(() => defaultStore.users.stats(), {});
  const ev = await soft(() => defaultStore.events.stats(24), {});
  const events = await soft(() => defaultStore.events.list({ limit: 12 }), []);

  const cards = fresh.map((d) => {
    const subj = asObject(d.subject);
    const pack = packs.load(d.pack);
    const what = pack.subject.fields.map((f) => subj[f.key]).filter(Boolean).join(' ') || 'объект не назван';
    const waiting = d.last_in_at && (!d.last_out_at || new Date(d.last_in_at) > new Date(d.last_out_at));
    return `<tr><td><a href="/admin/deal?id=${esc(d.id)}">${esc(d.client_name || 'без имени')}</a>
      <div class="muted" style="font-size:12px">${esc(what)}</div></td>
      <td>${esc(channels.get(d.channel).title)}</td>
      <td><span class="badge ${waiting ? 'hot' : ''}">${esc(STAGE[d.stage] || d.stage)}</span></td>
      <td class="num">${d.total_rub ? esc(quoteEngine.money(d.total_rub, pack.currency)) : '—'}</td>
      <td class="num">${esc(ago(d.last_in_at))}</td></tr>`;
  }).join('');

  return head('Сводка', me, '/admin/', `
<h1>Сводка</h1>
<p class="sub">Всё хозяйство студии в одном экране. Данные живые, из той же базы, что видят панели мастера и владельца.</p>
${note(msg)}
${tiles([
  ['ждут ответа', deals.unanswered ?? 0, (deals.unanswered ? 'warn' : '')],
  ['заявок всего', deals.total ?? 0],
  ['в работе', deals.won ?? 0, 'good'],
  ['вопросов с сайта', newQ.length, (newQ.length ? 'warn' : '')],
  ['страниц базы', seo.pages ?? 0],
  ['фраз в семантике', seo.keywords ?? 0],
  ['людей с доступом', users.staff ?? 0],
  ['клиентов', users.clients ?? 0],
  ['ошибок за сутки', ev.errors ?? 0, (ev.errors ? 'bad' : '')],
])}
<h2>Свежие заявки</h2>
${cards ? `<table><tr><th>Клиент</th><th>Канал</th><th>Стадия</th><th class="num">Сумма</th><th class="num">Писал</th></tr>${cards}</table>
<p class="sub"><a href="/admin/deals">все заявки</a> · <a href="/crm/">рабочая панель мастера</a></p>`
  : '<p class="sub">Заявок пока нет. Форма на сайте: <a href="/zayavka/">/zayavka/</a></p>'}

<h2>Что происходило</h2>
${logTable(events)}
<p class="sub"><a href="/admin/log">весь журнал</a></p>`);
}

// ── заявки ────────────────────────────────────────────────────────────────
async function deals(me, url, msg) {
  const stage = url.searchParams.get('stage');
  const rows = await soft(() => dealStore.deals.list({ stage: stage || null, limit: 200 }), []);
  const tabs = ['', ...Object.keys(STAGE)].map((s) => `<a class="badge${s === (stage || '') ? ' ok' : ''}" href="/admin/deals${s ? `?stage=${s}` : ''}">${esc(s ? STAGE[s] : 'все')}</a>`).join(' ');
  const list = rows.map((d) => {
    const pack = packs.load(d.pack);
    const subj = asObject(d.subject);
    return `<tr><td class="num">${esc(when(d.created_at))}</td>
      <td><a href="/admin/deal?id=${esc(d.id)}">${esc(d.client_name || 'без имени')}</a>
        <div class="muted" style="font-size:12px">${esc(d.client_contact || '—')}</div></td>
      <td>${esc(pack.subject.fields.map((f) => subj[f.key]).filter(Boolean).join(' ') || '—')}</td>
      <td>${esc(channels.get(d.channel).title)}</td>
      <td>${esc(STAGE[d.stage] || d.stage)}</td>
      <td class="num">${d.total_rub ? esc(quoteEngine.money(d.total_rub, pack.currency)) : '—'}</td></tr>`;
  }).join('');
  return head('Заявки', me, '/admin/deals', `<h1>Заявки</h1>
<p class="sub">Приём и ответы — в панели мастера (<a href="/crm/">/crm</a>), здесь полный список и история. ${tabs}</p>
${note(msg)}
${list ? `<table><tr><th class="num">Когда</th><th>Клиент</th><th>Объект</th><th>Канал</th><th>Стадия</th><th class="num">Сумма</th></tr>${list}</table>`
  : '<p class="sub">Пусто.</p>'}`);
}

async function deal(me, id, msg) {
  const d = await soft(() => dealStore.deals.byId(id), null);
  if (!d) return head('Заявка', me, '/admin/deals', '<h1>Заявка не найдена</h1><p><a href="/admin/deals">← к списку</a></p>');
  const pack = packs.load(d.pack);
  const msgs = await soft(() => dealStore.messages.byDeal(id), []);
  const quote = asObject(d.quote);
  const subj = asObject(d.subject);
  const events = await soft(() => defaultStore.events.list({ entity: 'deal', entityId: id, limit: 50 }), []);
  const client = d.client_user_id ? await soft(() => defaultStore.users.byId(d.client_user_id), null) : null;

  const lines = [
    ...(quote.choices || []).map((c) => `<tr><td>${esc(c.title)}</td><td class="num">${esc(c.priceText)}</td></tr>`),
    ...(quote.extras || []).map((e) => `<tr><td>+ ${esc(e.title)}</td><td class="num">${esc(e.sumText)}</td></tr>`),
  ].join('');

  const history = msgs.map((m) => `<div class="msg ${m.direction === 'out' ? 'out' : ''}">
    <div class="t">${m.direction === 'in' ? 'клиент' : 'мы'} · ${esc(when(m.created_at))}${m.error ? ` · <span class="err">${esc(m.error)}</span>` : ''}</div>
    ${esc(m.text)}</div>`).join('');

  return head('Заявка', me, '/admin/deals', `
<p class="sub"><a href="/admin/deals">← заявки</a> · <a href="/crm/d?id=${esc(d.id)}">открыть в панели мастера</a></p>
<h1>${esc(d.client_name || 'Клиент')} <span class="badge">${esc(STAGE[d.stage] || d.stage)}</span></h1>
<p class="sub">${esc(channels.get(d.channel).title)} · ${esc(d.client_contact || '—')} ·
${client ? `кабинет: <a href="/admin/client?id=${client.id}">${esc(client.email || client.phone)}</a>` : 'кабинет не заведён'} ·
создана ${esc(when(d.created_at))}</p>
${note(msg)}
<div class="grid">
  <div class="card"><div class="who">${esc(pack.subject.label)}</div>
    ${pack.subject.fields.map((f) => `<div>${esc(f.label)}: <b>${esc(subj[f.key] ?? '—')}</b></div>`).join('')}</div>
  <div class="card"><div class="who">Смета</div>
    ${lines ? `<table>${lines}<tr><th>Итого</th><th class="num">${esc(quote.totalText || '')}</th></tr></table>` : 'расчёта нет'}</div>
</div>
<h2>Переписка</h2>${history || '<p class="sub">Пусто.</p>'}
<h2>Журнал по заявке</h2>${logTable(events)}`);
}

// ── клиенты ───────────────────────────────────────────────────────────────
async function clients(me, url, msg) {
  const rows = await soft(() => defaultStore.users.list({ role: 'client', limit: 300 }), []);
  const list = rows.map((u) => `<tr>
    <td><a href="/admin/client?id=${u.id}">${esc(u.name || u.email || u.phone)}</a></td>
    <td>${esc(u.email || '—')}</td><td>${esc(u.phone || '—')}</td>
    <td>${u.password_hash ? '<span class="badge ok">кабинет активен</span>' : '<span class="badge">приглашён</span>'}
        ${u.status === 'blocked' ? '<span class="badge bad">заблокирован</span>' : ''}</td>
    <td class="num">${esc(when(u.created_at))}</td>
    <td class="num">${esc(u.last_login_at ? when(u.last_login_at) : '—')}</td></tr>`).join('');
  return head('Клиенты', me, '/admin/clients', `<h1>Клиенты</h1>
<p class="sub">Учётка клиента заводится сама, когда человек оставляет заявку: контакт уже есть, остаётся задать пароль
(ссылку он получает из формы «забыли пароль» или отсюда).</p>
${note(msg)}
${list ? `<table><tr><th>Имя</th><th>Почта</th><th>Телефон</th><th>Кабинет</th><th class="num">Создан</th><th class="num">Был</th></tr>${list}</table>`
  : '<p class="sub">Пока никого.</p>'}`);
}

async function client(me, id, msg) {
  const u = await soft(() => defaultStore.users.byId(id), null);
  if (!u) return head('Клиент', me, '/admin/clients', '<h1>Не найден</h1><p><a href="/admin/clients">← к списку</a></p>');
  const deals = await soft(() => defaultStore.clientDeals.list(u, 50), []);
  const events = await soft(() => defaultStore.events.list({ userId: u.id, limit: 30 }), []);
  return head('Клиент', me, '/admin/clients', `
<p class="sub"><a href="/admin/clients">← клиенты</a></p>
<h1>${esc(u.name || u.email || u.phone)}</h1>
<p class="sub">${esc(u.email || '')} ${esc(u.phone || '')} · роль: ${esc(accounts.ROLE_TITLE[u.role] || u.role)} ·
${u.password_hash ? 'кабинет активен' : 'пароль не задан'} · создан ${esc(when(u.created_at))}</p>
${note(msg)}
<div class="row">
  <form class="inline" method="POST" action="/admin/users/invite"><input type="hidden" name="id" value="${u.id}">
    <button class="ghost small">Выслать ссылку на пароль</button></form>
  <form class="inline" method="POST" action="/admin/users/status"><input type="hidden" name="id" value="${u.id}">
    <input type="hidden" name="status" value="${u.status === 'blocked' ? 'active' : 'blocked'}">
    <button class="ghost small">${u.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'}</button></form>
</div>
<h2>Заявки (${deals.length})</h2>
${deals.length ? `<table>${deals.map((d) => `<tr><td class="num">${esc(when(d.created_at))}</td>
  <td><a href="/admin/deal?id=${esc(d.id)}">${esc(d.id)}</a></td><td>${esc(STAGE[d.stage] || d.stage)}</td>
  <td class="num">${d.total_rub ? `${d.total_rub} ₽` : '—'}</td></tr>`).join('')}</table>` : '<p class="sub">Заявок нет.</p>'}
<h2>Журнал</h2>${logTable(events)}`);
}

// ── вопросы с сайта ───────────────────────────────────────────────────────
async function questions(me, msg) {
  const q = require('../seo/questions');
  const list = await soft(() => q.list(), []);
  const rows = list.map((x) => `<tr><td class="num">${esc(when(x.at))}</td>
    <td>${esc(x.name)}<div class="muted" style="font-size:12px">${esc(x.contact)}${x.car ? ` · ${esc(x.car)}` : ''}</div></td>
    <td>${esc(x.text.slice(0, 220))}</td>
    <td>${esc(x.status)}${x.slug ? ` · <a href="/baza/${esc(x.slug)}/">страница</a>` : ''}</td>
    <td>${x.status === 'new' ? `<a href="/seo/q?id=${esc(x.id)}">ответить</a>` : ''}</td></tr>`).join('');
  return head('Вопросы', me, '/admin/questions', `<h1>Вопросы с сайта</h1>
<p class="sub">Ответ публикуется материалом базы знаний; контакт спросившего на сайт не попадает.</p>
${note(msg)}
${rows ? `<table><tr><th class="num">Когда</th><th>Кто</th><th>Вопрос</th><th>Статус</th><th></th></tr>${rows}</table>`
  : '<p class="sub">Вопросов не было. Форма: <a href="/baza/vopros/">/baza/vopros/</a></p>'}`);
}

// ── знания и спрос ────────────────────────────────────────────────────────
async function knowledge(me, msg) {
  const jobs = require('../seo/lib/jobs');
  const s = await soft(() => jobs.summary(), {});
  const gaps = await soft(() => jobs.gaps({ limit: 25 }), []);
  const harvest = await soft(() => require('../harvest/store').stats(), { db: false });
  const runs = await soft(() => require('../seo/lib/store').runs.last(8), []);
  return head('Знания', me, '/admin/knowledge', `<h1>Знания и спрос</h1>
<p class="sub">Подробные экраны — в <a href="/seo/">панели SEO</a>. Здесь состояние слоя целиком.</p>
${note(msg)}
${tiles([['страниц', s.pages ?? 0], ['фраз', s.keywords ?? 0], ['в топ-10', s.top10 ?? 0, 'good'],
  ['спрос без страницы', s.gaps ?? 0, (s.gaps ? 'warn' : '')],
  ['источников', harvest.sources ?? 0], ['документов', harvest.documents ?? 0],
  ['машин', harvest.vehicles ?? 0], ['комплектующих', harvest.parts ?? 0]])}
<h2>Спрос без страницы</h2>
${gaps.length ? `<table><tr><th>Запрос</th><th class="num">Частота</th></tr>${gaps
  .map((g) => `<tr><td>${esc(g.phrase)}</td><td class="num">${esc(g.count || g.shows || '')}</td></tr>`).join('')}</table>`
  : '<p class="sub">Пусто — либо всё закрыто, либо частотность не собиралась.</p>'}
<h2>Последние прогоны</h2>
${runs.length ? `<table><tr><th>Задача</th><th>Итог</th><th class="num">Когда</th></tr>${runs
  .map((r) => `<tr><td>${esc(r.job)}</td><td>${r.finished_at ? (r.ok ? '<span class="ok">успех</span>' : `<span class="err">${esc(r.error || 'ошибка')}</span>`) : 'идёт'}</td>
  <td class="num">${esc(when(r.started_at))}</td></tr>`).join('')}</table>` : '<p class="sub">Сбор ещё не запускался.</p>'}`);
}

// ── доступы ───────────────────────────────────────────────────────────────
async function users(me, msg) {
  const rows = await soft(() => defaultStore.users.list({ limit: 300 }), []);
  const staff = rows.filter((u) => accounts.isStaff(u));
  const list = staff.map((u) => `<tr>
    <td>${esc(u.name || '—')}<div class="muted" style="font-size:12px">${esc(u.email || u.phone || '')}</div></td>
    <td>${esc(accounts.ROLE_TITLE[u.role] || u.role)}</td>
    <td>${u.status === 'blocked' ? '<span class="badge bad">заблокирован</span>' : '<span class="badge ok">активен</span>'}
        ${u.password_hash ? '' : '<span class="badge">пароль не задан</span>'}</td>
    <td class="num">${esc(u.last_login_at ? when(u.last_login_at) : '—')}</td>
    <td>${Number(u.id) === Number(me.id) ? '<span class="muted">это вы</span>' : `
      <form class="inline" method="POST" action="/admin/users/role">
        <input type="hidden" name="id" value="${u.id}">
        <select name="role" onchange="this.form.submit()">${Object.keys(accounts.ROLES)
          .map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${esc(accounts.ROLE_TITLE[r])}</option>`).join('')}</select></form>
      <form class="inline" method="POST" action="/admin/users/status"><input type="hidden" name="id" value="${u.id}">
        <input type="hidden" name="status" value="${u.status === 'blocked' ? 'active' : 'blocked'}">
        <button class="ghost small">${u.status === 'blocked' ? 'разблокировать' : 'заблокировать'}</button></form>
      <form class="inline" method="POST" action="/admin/users/invite"><input type="hidden" name="id" value="${u.id}">
        <button class="ghost small">ссылка на пароль</button></form>
      <form class="inline" method="POST" action="/admin/users/kick"><input type="hidden" name="id" value="${u.id}">
        <button class="ghost small">закрыть сессии</button></form>`}</td></tr>`).join('');

  return head('Доступы', me, '/admin/users', `<h1>Доступы</h1>
<p class="sub">Роли: владелец — всё, включая доступы; администратор — данные и настройки; мастер — заявки и цены;
клиент — только свой кабинет. Пароль никто, включая владельца, не видит: человеку уходит ссылка, он задаёт пароль сам.</p>
${note(msg)}
<table><tr><th>Кто</th><th>Роль</th><th>Состояние</th><th class="num">Последний вход</th><th></th></tr>${list}</table>
<h2>Добавить человека</h2>
<form method="POST" action="/admin/users/create" class="grid">
  <label>Имя<input name="name" required></label>
  <label>Почта<input name="email" type="email"></label>
  <label>Телефон<input name="phone"></label>
  <label>Роль<select name="role">${['master', 'admin', 'owner']
    .map((r) => `<option value="${r}">${esc(accounts.ROLE_TITLE[r])}</option>`).join('')}</select></label>
  <label style="grid-column:1/-1"><button type="submit">Создать и выслать ссылку на пароль</button></label>
</form>`);
}

// ── журнал ────────────────────────────────────────────────────────────────
function logTable(rows) {
  if (!rows || !rows.length) return '<p class="sub">Записей нет.</p>';
  return `<table class="log"><tr><th class="num">Когда</th><th>Уровень</th><th>Слой</th><th>Событие</th><th>Кто</th><th>Подробности</th></tr>
${rows.map((e) => `<tr><td class="num">${esc(when(e.at))}</td>
  <td><span class="lv ${esc(e.level)}">${esc(e.level)}</span></td><td>${esc(e.area)}</td>
  <td>${esc(e.action)}</td><td>${esc(e.actor || '')}</td>
  <td>${esc(e.message || '')}${e.entity ? ` <span class="muted">[${esc(e.entity)}:${esc(e.entity_id || '')}]</span>` : ''}
      ${e.ip ? `<span class="muted"> ${esc(e.ip)}</span>` : ''}</td></tr>`).join('')}</table>`;
}

async function logPage(me, url, msg) {
  const area = url.searchParams.get('area') || null;
  const level = url.searchParams.get('level') || null;
  const rows = await soft(() => defaultStore.events.list({ area, level, limit: 300 }), []);
  const stats = await soft(() => defaultStore.events.stats(24), {});
  const pick = (name, values, cur) => [''].concat(values).map((v) => `<a class="badge${(cur || '') === v ? ' ok' : ''}"
    href="/admin/log?${name}=${encodeURIComponent(v)}">${esc(v || 'все')}</a>`).join(' ');
  return head('Журнал', me, '/admin/log', `<h1>Журнал</h1>
<p class="sub">Одна лента на все контуры: вход и выход, действия в панелях, прогоны сбора, ошибки каналов.
Хранится ${esc(process.env.ADMIN_LOG_DAYS || 180)} дней, чистится задачей <code>node admin/cli.js purge</code>.</p>
${note(msg)}
${tiles([['за сутки', stats.total ?? 0], ['предупреждений', stats.warns ?? 0, (stats.warns ? 'warn' : '')],
  ['ошибок', stats.errors ?? 0, (stats.errors ? 'bad' : '')], ['по безопасности', stats.security ?? 0]])}
<p class="sub">Слой: ${pick('area', ['auth', 'admin', 'cabinet', 'crm', 'engine', 'seo', 'harvest', 'system'], area)}</p>
<p class="sub">Уровень: ${pick('level', require('./log').LEVELS, level)}</p>
${logTable(rows)}`);
}

// ── парсеры ───────────────────────────────────────────────────────────────
// Сбор базы знаний по источникам: сколько взяли, когда писали последний раз,
// идёт ли сейчас. Запуск и остановка — только через общий замок очереди
// (harvest/control.js), чтобы на сервере никогда не шло два сбора разом.
const FRESH_DAYS = 8;   // недельный крон + сутки запаса
function parserState(row, run) {
  if (run) return ['идёт', 'hot'];
  if (row.enabled === false) return ['выключен', ''];
  if (!row.documents) return ['пусто', 'bad'];
  const days = row.last_doc_at ? (Date.now() - new Date(row.last_doc_at).getTime()) / 86400000 : Infinity;
  return days <= FRESH_DAYS ? ['свежий', 'ok'] : [`давно: ${Math.round(days)} дн`, 'bad'];
}

async function parsers(me, msg) {
  const control = require('../harvest/control');
  const { SOURCES } = require('../harvest/sources');
  const st = await soft(() => control.status(), { busy: false, locks: [] });
  const fromDb = await soft(() => require('../harvest/store').sourceStats(), []);
  const byHost = new Map(fromDb.map((r) => [r.host, r]));
  const rows = SOURCES.map((s) => ({ documents: 0, last_doc_at: null, last24h: 0, ...byHost.get(s.host),
    host: s.host, kind: s.kind, title: s.title || s.host, enabled: s.enabled !== false }));
  // Источники, которых в реестре уже нет, но документы в базе остались.
  for (const r of fromDb) if (!SOURCES.some((s) => s.host === r.host)) rows.push({ ...r, enabled: false, retired: true });
  const can = accounts.atLeast(me, 'admin');
  const total = rows.reduce((a, r) => a + (r.documents || 0), 0);
  const day = rows.reduce((a, r) => a + (r.last24h || 0), 0);
  const lockLabel = (l) => (l.main ? 'общий замок' : `отдельный: ${l.name.replace(/^sashalab-harvest-?|\.lock$/g, '')}`);

  const running = st.locks.length ? `<table><tr><th>Замок</th><th>Качает</th><th class="num">Идёт с</th><th class="num">Процессов</th><th></th></tr>${st.locks
    .map((l) => `<tr><td>${esc(lockLabel(l))}</td>
  <td>${l.crawling.length ? l.crawling.map((c) => `<span class="badge hot">${esc(c.what)}</span>`).join('') : '<span class="muted">ждёт память / между источниками</span>'}</td>
  <td class="num">${esc(when(l.since))}<br><span class="muted">${esc(ago(l.since))}</span></td><td class="num">${l.pids.length}</td>
  <td>${can ? `<form class="inline" method="POST" action="/admin/parsers/stop" onsubmit="return confirm('Остановить сбор? Собранное останется в базе, следующий запуск продолжит с места обрыва.')">
    <input type="hidden" name="lock" value="${esc(l.name)}"><button class="small ghost">Остановить</button></form>` : ''}</td></tr>`).join('')}</table>`
    : '<p class="sub">Сбор сейчас не идёт.</p>';

  const off = !can || st.busy;
  const table = `<table><tr><th></th><th>Источник</th><th>Этап</th><th class="num">Документов</th><th class="num">За сутки</th><th class="num">Последняя запись</th><th>Статус</th><th></th></tr>${rows
    .map((r) => {
      const run = control.runningFor(r, st);
      const [label, cls] = parserState(r, run);
      const startable = r.enabled && !r.retired;
      return `<tr><td>${startable ? `<input type="checkbox" name="host" value="${esc(r.host)}" style="width:auto"${off ? ' disabled' : ''}>` : ''}</td>
  <td>${esc(r.title)}<br><a class="muted" href="/admin/parsers/log?host=${encodeURIComponent(r.host)}">${esc(r.host)}</a></td>
  <td>${esc(r.kind)}</td><td class="num">${esc(r.documents || 0)}</td><td class="num">${r.last24h ? `+${esc(r.last24h)}` : '—'}</td>
  <td class="num">${esc(when(r.last_doc_at))}<br><span class="muted">${esc(ago(r.last_doc_at))}</span></td>
  <td><span class="badge ${cls}">${esc(label)}</span>${run && run.what !== r.host ? `<br><span class="muted">этапом ${esc(run.what)}</span>` : ''}</td>
  <td>${startable && !off ? `<button class="small ghost" name="one" value="${esc(r.host)}">Запустить</button>` : ''}</td></tr>`;
    }).join('')}</table>`;

  return head('Парсеры', me, '/admin/parsers', `<h1>Парсеры</h1>
<p class="sub">Сбор базы знаний по источникам. Запуск идёт через общую очередь (<code>scripts/harvest-queue.sh</code>)
под замком <code>/tmp/sashalab-harvest.lock</code>: один сбор на сервер, с проверкой свободной памяти и паузами, замеренными для каждого сайта.
Время — московское.</p>
${note(msg)}
${tiles([['источников', rows.length], ['документов', total], ['за сутки', day, day ? 'good' : ''],
  ['сейчас', st.busy ? 'идёт' : st.locks.length ? 'сбоку' : 'стоит', st.busy ? 'warn' : '']])}
<h2>Идёт сейчас</h2>
${running}
<h2>Источники</h2>
${!can ? '<p class="sub">Запускать и останавливать сбор может администратор или владелец.</p>'
  : st.busy ? '<p class="sub">Пока идёт сбор под общим замком, новый не запускается — сначала остановите текущий.</p>' : ''}
<form method="POST" action="/admin/parsers/start">
${table}
${off ? '' : '<div class="row"><button>Запустить выбранные</button><span class="muted" style="align-self:center">по очереди, по одному за раз</span></div>'}
</form>`);
}

function parserLog(me, host, text, file) {
  return head('Лог сбора', me, '/admin/parsers', `<h1>Лог сбора: ${esc(host)}</h1>
<p class="sub"><a href="/admin/parsers">← к парсерам</a> · <code>${esc(file)}</code> · последние строки</p>
${text == null ? '<p class="sub">Лога нет: этот источник ещё не собирался через очередь на этом сервере.</p>'
  : `<pre class="log card" style="white-space:pre-wrap;overflow-x:auto">${esc(text)}</pre>`}`);
}

// ── службы ────────────────────────────────────────────────────────────────
async function services(me, msg) {
  const mig = await soft(() => db.q('SELECT version, applied_at FROM schema_migrations ORDER BY version'), []);
  const sess = await soft(() => defaultStore.sessions.active(), 0);
  const ch = channels.status();
  const keys = [
    ['SASHALAB_PG_URL', 'база проекта'], ['NEURALDEEP_API_KEY', 'разбор текста и зрение по фото'],
    ['RESEND_API_KEY', 'почта (письма клиентам и сброс пароля)'], ['TELEGRAM_BOT_TOKEN', 'телеграм-канал'],
    ['AVITO_CLIENT_ID', 'Авито: чтение и ответы'], ['SMSRU_API_ID', 'СМС владельцу и клиентам'],
    ['WORDSTAT_TOKEN', 'частотность Wordstat'], ['YANDEX_WEBMASTER_TOKEN', 'показы из Вебмастера'],
    ['GSC_CLIENT_EMAIL', 'показы из Search Console'],
  ];
  const keyRows = keys.map(([k, why]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(why)}</td>
    <td>${process.env[k] ? '<span class="badge ok">задан</span>' : '<span class="badge">нет</span>'}</td></tr>`).join('');
  return head('Службы', me, '/admin/services', `<h1>Службы и настройки</h1>
<p class="sub">Что подключено на этом контуре. Ключи лежат в <code>seo/.env</code> на сервере и в панель не выводятся —
здесь видно только факт «задан/нет».</p>
${note(msg)}
${tiles([['хранилище', db.enabled ? 'есть' : 'нет', db.enabled ? 'good' : 'bad'],
  ['миграций накачено', mig.length], ['живых сессий', sess],
  ['каналов подключено', `${ch.filter((c) => c.configured).length}/${ch.length}`]])}
<h2>Каналы связи</h2>
<table><tr><th>Канал</th><th>Приём</th><th>Состояние</th></tr>
${ch.map((c) => `<tr><td>${esc(c.title)}</td><td>${c.inbound ? 'да' : '—'}</td>
<td>${c.configured ? '<span class="badge ok">подключён</span>' : '<span class="badge">нет ключей</span>'}</td></tr>`).join('')}</table>
<h2>Ключи</h2><table><tr><th>Переменная</th><th>За что отвечает</th><th></th></tr>${keyRows}</table>
<h2>Миграции базы</h2>
${mig.length ? `<table><tr><th>Файл</th><th class="num">Накачена</th></tr>${mig
  .map((m) => `<tr><td>${esc(m.version)}</td><td class="num">${esc(when(m.applied_at))}</td></tr>`).join('')}</table>`
  : '<p class="sub">Нет данных: база недоступна.</p>'}
<p class="sub">Накатить новые: <code>npm run migrate</code>. Пересобрать базу знаний: <code>npm run build</code>.</p>`);
}

// ── свой профиль ──────────────────────────────────────────────────────────
async function profile(me, msg, { items = ADMIN_NAV, active = '/admin/profile', logout = '/admin/logout', action = '/admin/profile' } = {}) {
  const sessions = await soft(() => defaultStore.sessions.listFor(me.id), []);
  return head('Профиль', me, active, `<h1>Профиль</h1>
<p class="sub">${esc(me.email || '')} ${esc(me.phone || '')} · ${esc(accounts.ROLE_TITLE[me.role] || me.role)}</p>
${note(msg)}
<h2>Сменить пароль</h2>
<form method="POST" action="${action}/password" style="max-width:380px">
  <label>Текущий пароль<input type="password" name="current" autocomplete="current-password"></label>
  <label>Новый пароль (от 8 знаков)<input type="password" name="password" autocomplete="new-password"></label>
  <label>Ещё раз<input type="password" name="password2" autocomplete="new-password"></label>
  <button type="submit">Сохранить</button>
</form>
<p class="sub">После смены пароля все входы, включая этот, закроются — войдёте заново.</p>
<h2>Мои сессии (${sessions.length})</h2>
${sessions.length ? `<table><tr><th>Устройство</th><th>Адрес</th><th class="num">Вход</th><th class="num">Активность</th></tr>
${sessions.map((s) => `<tr><td>${esc(String(s.ua || '').slice(0, 60) || '—')}</td><td>${esc(s.ip || '—')}</td>
<td class="num">${esc(when(s.created_at))}</td><td class="num">${esc(ago(s.last_seen_at))}</td></tr>`).join('')}</table>
<form method="POST" action="${action}/kick" style="margin-top:10px"><button class="ghost">Выйти на всех устройствах</button></form>`
  : '<p class="sub">Активных сессий нет.</p>'}`, { items, logout });
}

// ── кабинет клиента ───────────────────────────────────────────────────────
async function cabinet(me, msg) {
  const deals = await soft(() => defaultStore.clientDeals.list(me, 50), []);
  const rows = deals.map((d) => {
    const pack = packs.load(d.pack);
    const subj = asObject(d.subject);
    return `<div class="card"><div class="who">${esc(when(d.created_at))} · ${esc(STAGE[d.stage] || d.stage)}</div>
      <b>${esc(pack.subject.fields.map((f) => subj[f.key]).filter(Boolean).join(' ') || 'Заявка')}</b>
      ${d.total_rub ? `<span class="badge ok">${esc(quoteEngine.money(d.total_rub, pack.currency))}</span>` : ''}
      <div style="margin-top:8px"><a href="/cabinet/d?id=${esc(d.id)}">открыть</a></div></div>`;
  }).join('');
  return head('Кабинет', me, '/cabinet/', `<h1>Ваши заявки</h1>
<p class="sub">Здесь видно расчёт, переписку и статус работы. Новый вопрос можно задать прямо в заявке.</p>
${note(msg)}
${rows || `<p class="sub">Заявок пока нет. Оставить: <a href="/zayavka/">форма расчёта</a>.</p>`}`,
  { items: CABINET_NAV, logout: '/cabinet/logout' });
}

async function cabinetDeal(me, id, msg) {
  const d = await soft(() => dealStore.deals.byId(id), null);
  const mine = d && (Number(d.client_user_id) === Number(me.id)
    || (me.email && String(d.client_contact || '').toLowerCase() === me.email)
    || (me.phone && String(d.client_contact || '').replace(/\D/g, '').endsWith(String(me.phone).slice(-10))));
  if (!mine) return head('Заявка', me, '/cabinet/', '<h1>Заявка не найдена</h1><p><a href="/cabinet/">← в кабинет</a></p>',
    { items: CABINET_NAV, logout: '/cabinet/logout' });
  const pack = packs.load(d.pack);
  const msgs = await soft(() => dealStore.messages.byDeal(id), []);
  const quote = asObject(d.quote);
  const lines = [
    ...(quote.choices || []).map((c) => `<tr><td>${esc(c.title)}</td><td class="num">${esc(c.priceText)}</td></tr>`),
    ...(quote.extras || []).map((e) => `<tr><td>+ ${esc(e.title)}</td><td class="num">${esc(e.sumText)}</td></tr>`),
  ].join('');
  // Клиенту показываем только отправленное: черновики и заметки мастера — не его дело.
  const history = msgs.filter((m) => m.direction === 'in' || m.sent_at)
    .map((m) => `<div class="msg ${m.direction === 'out' ? 'out' : ''}">
      <div class="t">${m.direction === 'in' ? 'вы' : 'студия'} · ${esc(when(m.created_at))}</div>${esc(m.text)}</div>`).join('');
  return head('Заявка', me, '/cabinet/', `
<p class="sub"><a href="/cabinet/">← мои заявки</a></p>
<h1>Заявка от ${esc(when(d.created_at))}</h1>
<p class="sub">Статус: ${esc(STAGE[d.stage] || d.stage)}</p>
${note(msg)}
${lines ? `<h2>Расчёт</h2><table>${lines}<tr><th>Итого</th><th class="num">${esc(quote.totalText || '')}</th></tr></table>
<p class="sub">Расчёт предварительный: окончательная цена — после осмотра.</p>` : ''}
<h2>Переписка</h2>${history || '<p class="sub">Пока пусто.</p>'}
<form method="POST" action="/cabinet/message">
  <input type="hidden" name="id" value="${esc(d.id)}">
  <label>Написать студии<textarea name="text" placeholder="вопрос, уточнение, фото пришлю в WhatsApp…"></textarea></label>
  <button type="submit">Отправить</button>
</form>`, { items: CABINET_NAV, logout: '/cabinet/logout' });
}

const registerPage = ({ err = null, done = false } = {}) => page('Регистрация', `<form class="auth" method="POST" action="/cabinet/register">
  <h1>Кабинет клиента</h1>
  ${done ? `<p class="sub">Готово. Теперь можно <a href="/cabinet/login">войти</a>.</p>`
  : `<p class="sub">Укажите тот контакт, который оставляли в заявке, — к кабинету сразу подтянутся ваши расчёты.</p>
  ${err ? `<p class="err">${esc(err)}</p>` : ''}
  <label>Имя<input name="name"></label>
  <label>Почта или телефон<input name="login" required></label>
  <label>Пароль (от 8 знаков)<input type="password" name="password" autocomplete="new-password"></label>
  <button type="submit">Создать кабинет</button>
  <p class="sub" style="margin-top:14px"><a href="/cabinet/login">← ко входу</a></p>`}</form>`);

module.exports = { dashboard, deals, deal, clients, client, questions, knowledge, users,
  logPage, logTable, services, parsers, parserLog, profile, cabinet, cabinetDeal, registerPage, STAGE, soft };
