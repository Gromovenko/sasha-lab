// Панель мастера: входящие обращения, карточка сделки, готовый ответ в один
// тап. Плюс публичная форма заявки на сайте (/zayavka) и ручка /api/lead.
//
// Делалась под телефон в гараже, а не под монитор: крупные кнопки, ответ
// целиком виден без прокрутки по горизонтали, «скопировать» рядом с «отправить»
// (на Авито и в WhatsApp пока копипаста — ключей к их API у студии нет).
//
// Вход — пароль CRM_PASSWORD (если не задан, годится SEO_ADMIN_PASSWORD):
// у мастера и владельца разные роли, но заводить пользователей ради двух
// человек — лишняя сущность.
const packs = require('./pack');
const pipeline = require('./pipeline');
const store = require('./store');
const files = require('./files');
const channels = require('./channels');
const quoteEngine = require('./quote');
const { form } = require('./multipart');
const auth = require('../seo/lib/auth');
// Единая дверь: сессия раздела /admin пускает мастера и сюда (см. admin/http.js).
const section = require('../admin/http');
const adminClients = require('../admin/clients');
const log = require('../admin/log');
const db = require('../seo/lib/db');

const gate = auth.make({
  cookie: 'sasha_crm',
  path: '/crm',
  password: () => process.env.CRM_PASSWORD || process.env.SEO_ADMIN_PASSWORD || '',
  secret: () => process.env.SEO_SESSION_SECRET || process.env.CRM_PASSWORD || process.env.SEO_ADMIN_PASSWORD || '',
});

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const asArray = (v) => (Array.isArray(v) ? v : v ? (() => { try { return JSON.parse(v); } catch { return []; } })() : []);
const asObject = (v) => (v && typeof v === 'object' ? v : v ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : {});

function ago(t) {
  if (!t) return '—';
  const min = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч`;
  return `${Math.round(h / 24)} дн`;
}

const STAGE = { new: 'новая', clarify: 'уточняем', quoted: 'посчитано', sent: 'ответ отправлен', won: 'в работе', lost: 'отказ', spam: 'спам' };

const shell = (title, body, { wide = false } = {}) => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>
*{box-sizing:border-box}
body{margin:0;background:#131313;color:#ededed;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:${wide ? 1100 : 820}px;margin:0 auto;padding:18px 14px 60px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:26px 0 8px}
.sub{color:#9a9a9a;margin:0 0 18px;font-size:14px}
a{color:#78a0ec}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px}
.tile{background:#1a1a1a;border:1px solid #2b2b2b;border-radius:10px;padding:10px 14px;min-width:96px;flex:1}
.tile b{display:block;font-size:24px;font-weight:600}.tile span{color:#9a9a9a;font-size:12px}
.card{background:#1a1a1a;border:1px solid #2b2b2b;border-radius:12px;padding:14px;margin:0 0 12px}
.card .who{color:#9a9a9a;font-size:13px;margin:0 0 6px}
.badge{display:inline-block;background:#232323;border-radius:6px;padding:2px 8px;font-size:12px;color:#c9c9c9;margin-right:6px}
.badge.hot{background:#48331f;color:#f0c07a}.badge.ok{background:#1f3a24;color:#8ad79a}
textarea{font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;width:100%;min-height:290px;padding:12px;border-radius:10px;border:1px solid #2b2b2b;background:#111;color:#ededed}
input,select,button{font:inherit;padding:11px 13px;border-radius:9px;border:1px solid #2b2b2b;background:#1a1a1a;color:#ededed}
input,select{width:100%}
button{background:#78a0ec;color:#0f0f0f;font-weight:700;border:0;cursor:pointer}
button.ghost{background:#232323;color:#ededed;font-weight:500}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.row>form{flex:1 1 140px}.row button{width:100%}
label{display:block;margin:0 0 10px;color:#9a9a9a;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #222;vertical-align:top}
th{color:#9a9a9a;font-weight:500}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.msg{border-left:3px solid #2b2b2b;padding:2px 0 2px 10px;margin:0 0 12px;white-space:pre-wrap;font-size:14px}
.msg.out{border-color:#78a0ec}
.msg .t{color:#9a9a9a;font-size:12px;white-space:normal}
.thumbs{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}
.thumbs img{width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid #2b2b2b}
.err{color:#e08080}.muted{color:#9a9a9a}
form.login{max-width:320px;margin:12vh auto}
form.inline{display:inline}
</style></head><body><div class="wrap">${body}</div></body></html>`;

const loginPage = (err) => shell('Вход · заявки', `<form class="login" method="POST" action="/crm/login">
  <h1>Заявки</h1><p class="sub">Панель мастера</p>
  ${err ? `<p class="err">${esc(err)}</p>` : ''}
  <label>Пароль<input type="password" name="password" autofocus autocomplete="current-password"></label>
  <button type="submit">Войти</button></form>`);

// ── список ────────────────────────────────────────────────────────────────
async function listPage(msg) {
  const rows = await store.deals.list({ limit: 80 });
  const s = await store.deals.stats();
  const tiles = [
    ['ждут ответа', s.unanswered || 0], ['уточняем', s.waiting || 0],
    ['посчитано', s.quoted || 0], ['ответ ушёл', s.sent || 0], ['в работе', s.won || 0],
  ].map(([n, v]) => `<div class="tile"><b>${v}</b><span>${n}</span></div>`).join('');

  const cards = rows.map((d) => {
    const subj = asObject(d.subject);
    const pack = packs.load(d.pack);
    const head = pack.subject.fields.map((f) => subj[f.key]).filter(Boolean).join(' ') || 'объект не назван';
    const waiting = d.last_in_at && (!d.last_out_at || new Date(d.last_in_at) > new Date(d.last_out_at));
    return `<a class="card" style="display:block;text-decoration:none;color:inherit" href="/crm/d?id=${esc(d.id)}">
      <div class="who">${esc(channels.get(d.channel).title)} · ${esc(ago(d.last_in_at))} назад · ${esc(d.client_name || 'без имени')}</div>
      <div><b>${esc(head)}</b></div>
      <div style="margin-top:6px">
        <span class="badge ${waiting ? 'hot' : ''}">${esc(STAGE[d.stage] || d.stage)}</span>
        ${d.total_rub ? `<span class="badge ok">${esc(quoteEngine.money(d.total_rub, pack.currency))}</span>` : ''}
        ${waiting ? '<span class="badge hot">ждёт ответа</span>' : ''}
      </div></a>`;
  }).join('') || '<p class="sub">Обращений пока нет. Форма на сайте: <a href="/zayavka/">/zayavka/</a></p>';

  const ch = channels.status().map((c) => `<span class="badge ${c.configured ? 'ok' : ''}">${esc(c.title)}: ${c.configured ? 'подключён' : 'нет ключей'}</span>`).join(' ');

  return shell('Заявки', `<h1>Заявки</h1>
<p class="sub">Ответ готовится сам: разбор переписки, фото, смета. Отправляете вы.</p>
${msg ? `<p class="sub">${esc(msg)}</p>` : ''}
<div class="tiles">${tiles}</div>
<p class="sub">${ch}</p>
<p class="sub"><a href="/crm/prices">Цены</a> · <a href="/seo/">SEO-панель</a> · <a href="/crm/logout">выйти</a></p>
${cards}`);
}

// ── карточка ──────────────────────────────────────────────────────────────
async function cardPage(id, msg) {
  const d = await store.deals.byId(id);
  if (!d) return shell('Нет сделки', '<h1>Сделка не найдена</h1><p><a href="/crm/">← к списку</a></p>');
  const pack = packs.load(d.pack);
  const msgs = await store.messages.byDeal(id);
  const draft = await store.drafts.pending(id) || await store.drafts.latest(id);
  const quote = asObject(d.quote);
  const subj = asObject(d.subject);
  const findings = asArray(d.findings);
  const plans = await store.followups.byDeal(id);

  const fields = pack.subject.fields.map((f) => `<label>${esc(f.label)}
    <input name="${esc(f.key)}" value="${esc(subj[f.key] ?? '')}" placeholder="—"></label>`).join('');

  const found = findings.length
    ? `<ul class="sub">${findings.map((f) => {
        const def = pack.vision.findings.find((x) => x.code === f.code);
        return `<li>${esc(def?.label || f.code)} <span class="muted">(${Math.round(Number(f.confidence) * 100)}%)</span>${f.note ? ` — ${esc(f.note)}` : ''}</li>`;
      }).join('')}</ul>`
    : '<p class="sub">Фото ещё не смотрели или находок нет.</p>';

  const lines = [
    ...(quote.choices || []).map((c) => `<tr><td>${esc(c.title)}</td><td class="num">${esc(c.priceText)}</td></tr>`),
    ...(quote.extras || []).map((e) => `<tr><td>+ ${esc(e.title)}${e.qty > 1 ? ` ×${e.qty}` : ''}</td><td class="num">${esc(e.sumText)}</td></tr>`),
  ].join('');

  const history = msgs.map((m) => {
    const att = asArray(m.attachments).filter((a) => a.kind === 'image')
      .map((a) => `<a href="/crm/file?p=${encodeURIComponent(a.path)}" target="_blank"><img src="/crm/file?p=${encodeURIComponent(a.path)}" alt=""></a>`).join('');
    return `<div class="msg ${m.direction === 'out' ? 'out' : ''}">
      <div class="t">${m.direction === 'in' ? 'клиент' : 'мы'} · ${esc(ago(m.created_at))} назад${m.error ? ` · <span class="err">${esc(m.error)}</span>` : ''}</div>
      ${esc(m.text)}${att ? `<div class="thumbs">${att}</div>` : ''}</div>`;
  }).join('');

  const planned = plans.filter((p) => p.status === 'planned')
    .map((p) => `<li>через ${esc(ago(p.due_at).replace('назад', ''))} — шаг ${p.step}</li>`).join('');

  return shell(`Сделка ${d.id}`, `
<p class="sub"><a href="/crm/">← заявки</a></p>
<h1>${esc(d.client_name || 'Клиент')} <span class="badge">${esc(STAGE[d.stage] || d.stage)}</span></h1>
<p class="sub">${esc(channels.get(d.channel).title)} · ${esc(d.client_contact || d.external_id || 'контакт не указан')} ·
последнее сообщение ${esc(ago(d.last_in_at))} назад${d.total_rub ? ` · <b>${esc(quoteEngine.money(d.total_rub, pack.currency))}</b>` : ''}</p>
${msg ? `<p class="sub">${esc(msg)}</p>` : ''}

<h2>Ответ клиенту${draft ? ` <span class="muted">· ревизия ${draft.rev}${draft.reason ? `, ${esc(draft.reason)}` : ''}</span>` : ''}</h2>
<form method="POST" action="/crm/send">
  <input type="hidden" name="id" value="${esc(d.id)}">
  <textarea name="text" id="answer">${esc(draft ? draft.text : '')}</textarea>
  <div class="row">
    <button type="submit">Отправить клиенту</button>
    <button type="button" class="ghost" onclick="navigator.clipboard.writeText(document.getElementById('answer').value).then(()=>this.textContent='Скопировано')">Скопировать</button>
  </div>
</form>
<div class="row">
  <form method="POST" action="/crm/think"><input type="hidden" name="id" value="${esc(d.id)}"><button class="ghost">Пересчитать</button></form>
  <form method="POST" action="/crm/stage"><input type="hidden" name="id" value="${esc(d.id)}"><input type="hidden" name="stage" value="won"><button class="ghost">В работу</button></form>
  <form method="POST" action="/crm/stage"><input type="hidden" name="id" value="${esc(d.id)}"><input type="hidden" name="stage" value="lost"><button class="ghost">Отказ</button></form>
</div>

<h2>Смета</h2>
${lines ? `<table>${lines}<tr><th>Итого</th><th class="num">${esc(quote.totalText || '')}</th></tr></table>` : '<p class="sub">Расчёта пока нет — не хватает данных.</p>'}
${(quote.warnings || []).length ? `<p class="err">${esc(quote.warnings.join('; '))}</p>` : ''}

<h2>Что видно на фото</h2>
${found}

<h2>${esc(pack.subject.label)}</h2>
<form method="POST" action="/crm/subject">
  <input type="hidden" name="id" value="${esc(d.id)}">
  ${fields}
  <button class="ghost" type="submit">Сохранить и пересчитать</button>
</form>

${planned ? `<h2>Напоминания</h2><ul class="sub">${planned}</ul>` : ''}

<h2>Переписка</h2>
${history || '<p class="sub">Пусто.</p>'}`, { wide: false });
}

// ── цены ──────────────────────────────────────────────────────────────────
async function pricesPage(packId, msg) {
  const pack = packs.load(packId || packs.DEFAULT_ID);
  let rows = await store.catalog.list(pack.id);
  if (!rows.length) { await store.catalog.sync(pack); rows = await store.catalog.list(pack.id); }
  const list = rows.map((r) => `<tr>
    <td>${esc(r.title)}<div class="muted" style="font-size:12px">${esc(r.sku)}${r.unit ? ` · ${esc(r.unit)}` : ''}</div></td>
    <td class="num"><form method="POST" action="/crm/price" style="display:flex;gap:6px">
      <input type="hidden" name="pack" value="${esc(pack.id)}"><input type="hidden" name="sku" value="${esc(r.sku)}">
      <input name="price" value="${esc(r.price_rub)}" inputmode="numeric" style="width:110px">
      <button class="ghost">ок</button></form></td></tr>`).join('');
  const tabs = packs.list().map((p) => `<a class="badge" href="/crm/prices?pack=${esc(p)}">${esc(p)}</a>`).join(' ');
  return shell('Цены', `<p class="sub"><a href="/crm/">← заявки</a></p>
<h1>Цены · ${esc(pack.title)}</h1>
<p class="sub">Цена из этой таблицы попадает в расчёт сразу, файл пакета её не перетирает. ${tabs}</p>
${msg ? `<p class="sub">${esc(msg)}</p>` : ''}
<table><tr><th>Позиция</th><th class="num">Цена</th></tr>${list}</table>`);
}

// ── публичная форма заявки ────────────────────────────────────────────────
function leadForm(packId, done) {
  const pack = packs.load(packId || packs.DEFAULT_ID);
  const fields = pack.subject.fields.map((f) => `<label>${esc(f.label)}${f.required ? '' : ' <span class="muted">(если знаете)</span>'}
    <input name="subject.${esc(f.key)}"></label>`).join('');
  const photos = pack.photos.checklist.map((c) => `<li>${esc(c.ask)}</li>`).join('');
  return shell('Заявка', done
    ? `<h1>Принято</h1><p class="sub">Расчёт пришлю на указанный контакт. Обычно это занимает несколько минут.</p>`
    : `<h1>Заявка на расчёт</h1>
<p class="sub">Ответ придёт с ценой и составом работ, а не «уточните в личке».</p>
<form method="POST" action="/api/lead" enctype="multipart/form-data">
  <input type="hidden" name="pack" value="${esc(pack.id)}">
  <label>Как к вам обращаться<input name="name"></label>
  <label>Телефон или почта для ответа<input name="contact" required></label>
  ${fields}
  <label>Что нужно<input name="text" placeholder="например: свет тусклый, хочу би-лед линзы"></label>
  ${photos ? `<p class="sub">Фото очень помогают:<ul class="sub">${photos}</ul></p>` : ''}
  <label>Фото<input type="file" name="photo" accept="image/*" multiple></label>
  <button type="submit">Отправить</button>
</form>`);
}

// ── маршрутизация ─────────────────────────────────────────────────────────
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const isCrm = p === '/crm' || p.startsWith('/crm/');
  const isLead = p === '/api/lead' || p === '/zayavka' || p === '/zayavka/';
  if (!isCrm && !isLead) return false;

  const send = (code, html, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', ...headers });
    res.end(html);
  };
  const back = (to, message) => send(302, '', { Location: `${to}${to.includes('?') ? '&' : '?'}msg=${encodeURIComponent(message)}` });

  // Публичная часть: форма и приём заявки.
  if (p === '/zayavka' || p === '/zayavka/') {
    return send(200, leadForm(url.searchParams.get('pack'), url.searchParams.get('ok'))), true;
  }
  if (p === '/api/lead') {
    if (req.method !== 'POST') return send(405, 'только POST'), true;
    if (!db.enabled) return send(503, shell('Заявка', '<h1>Приём заявок выключен</h1><p class="sub">Нет хранилища (SASHALAB_PG_URL).</p>')), true;
    const { fields, files: got } = await form(req);
    const text = String(fields.text || '').slice(0, 4000);
    const subject = {};
    for (const [k, v] of Object.entries(fields)) if (k.startsWith('subject.') && v) subject[k.slice(8)] = v;
    const pack = fields.pack || packs.DEFAULT_ID;
    const attachments = got
      .filter((f) => /\.(jpe?g|png|webp|heic|gif)$/i.test(f.filename || ''))
      .slice(0, 6)
      .map((f) => ({ filename: f.filename, buffer: f.buffer }));
    const { deal } = await pipeline.ingest({
      pack, channel: 'web', text, attachments, subject,
      client: { name: fields.name || null, contact: fields.contact || null },
    }, {});
    // Разбор, зрение и расчёт — в фоне: человек на телефоне не должен ждать,
    // пока модель посмотрит три фотографии фары.
    pipeline.think(deal.id, {}).catch((e) => console.error('crm: расчёт заявки', e.message));
    // Заодно заводим клиенту кабинет: контакт уже есть, пароль он задаст сам,
    // когда захочет посмотреть свои расчёты (/cabinet).
    adminClients.ensureForDeal(deal).catch(() => null);
    log.info({ area: 'crm', action: 'lead.new', actor: fields.contact || null, entity: 'deal', entityId: deal.id,
      message: text.slice(0, 200), ...log.web(req) }).catch(() => null);
    return send(302, '', { Location: '/zayavka/?ok=1' }), true;
  }

  // Закрытая часть.
  const staff = await section.staffUser(req);
  if (!gate.enabled() && !staff) return send(503, shell('Заявки', '<h1>Панель выключена</h1><p class="sub">Не задан CRM_PASSWORD (или SEO_ADMIN_PASSWORD). Вход — через <a href="/admin/login">/admin</a>.</p>')), true;
  if (!db.enabled) return send(503, shell('Заявки', '<h1>Нет хранилища</h1><p class="sub">Не задан SASHALAB_PG_URL: сделки, переписка и фото живут в базе.</p>')), true;

  if (p === '/crm/login' && req.method === 'POST') {
    const { fields } = await form(req);
    if (!gate.passwordOk(fields.password || '')) return send(401, loginPage('Неверный пароль')), true;
    return send(302, '', { Location: '/crm/', 'Set-Cookie': gate.setCookie() }), true;
  }
  if (!gate.ok(req) && !staff) return send(200, loginPage()), true;
  if (p === '/crm/logout') return send(302, '', { Location: '/crm/', 'Set-Cookie': gate.clearCookie() }), true;

  if (p === '/crm/file') {
    const file = files.abs(url.searchParams.get('p'));
    if (!file) return send(404, 'нет файла'), true;
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Robots-Tag': 'noindex' });
    require('fs').createReadStream(file).pipe(res);
    return true;
  }

  if (p === '/crm/send' && req.method === 'POST') {
    const { fields } = await form(req);
    try {
      const r = await pipeline.send(fields.id, { text: String(fields.text || '').trim() });
      return back(`/crm/d?id=${encodeURIComponent(fields.id)}`, r.manual ? 'записано как отправленное вручную — вставьте текст в чат площадки' : r.ok ? 'отправлено' : `не ушло: ${r.error}`), true;
    } catch (e) { return back(`/crm/d?id=${encodeURIComponent(fields.id)}`, `ошибка: ${e.message}`), true; }
  }

  if (p === '/crm/think' && req.method === 'POST') {
    const { fields } = await form(req);
    try { await pipeline.think(fields.id, {}); return back(`/crm/d?id=${encodeURIComponent(fields.id)}`, 'пересчитано'), true; }
    catch (e) { return back(`/crm/d?id=${encodeURIComponent(fields.id)}`, `ошибка: ${e.message}`), true; }
  }

  if (p === '/crm/subject' && req.method === 'POST') {
    const { fields } = await form(req);
    const d = await store.deals.byId(fields.id);
    if (!d) return back('/crm/', 'сделка не найдена'), true;
    const pack = packs.load(d.pack);
    const subject = {};
    for (const f of pack.subject.fields) {
      const v = String(fields[f.key] ?? '').trim();
      if (v) subject[f.key] = f.type === 'number' ? Number(v.replace(/[^\d.]/g, '')) : v;
    }
    await store.deals.update(d.id, { subject });
    await pipeline.think(d.id, {}).catch(() => null);
    return back(`/crm/d?id=${encodeURIComponent(d.id)}`, 'сохранено'), true;
  }

  if (p === '/crm/stage' && req.method === 'POST') {
    const { fields } = await form(req);
    await store.deals.update(fields.id, { stage: fields.stage });
    // Сделка закрыта — напоминания снимаются, иначе «отказнику» прилетит
    // бодрое «держу для вас место в графике».
    if (['won', 'lost', 'spam'].includes(fields.stage)) await store.followups.cancel(fields.id);
    return back(`/crm/d?id=${encodeURIComponent(fields.id)}`, 'статус изменён'), true;
  }

  if (p === '/crm/price' && req.method === 'POST') {
    const { fields } = await form(req);
    await store.catalog.setPrice(fields.pack, fields.sku, Number(String(fields.price).replace(/[^\d]/g, '')) || 0);
    return back(`/crm/prices?pack=${encodeURIComponent(fields.pack)}`, 'цена сохранена'), true;
  }

  if (p === '/crm/prices') return send(200, await pricesPage(url.searchParams.get('pack'), url.searchParams.get('msg'))), true;
  if (p === '/crm/d') return send(200, await cardPage(url.searchParams.get('id'), url.searchParams.get('msg'))), true;
  return send(200, await listPage(url.searchParams.get('msg'))), true;
}

async function handle(req, res) {
  try {
    return await route(req, res);
  } catch (e) {
    console.error('панель мастера:', e.message);
    if (res.headersSent) return true;
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' });
    res.end(shell('Ошибка', `<h1>Ошибка</h1><p class="sub">${esc(e.message)}</p><p><a href="/crm/">← заявки</a></p>`));
    return true;
  }
}

module.exports = { handle, gate };
