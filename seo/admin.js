// Панель собственника: /seo — вход по паролю, дальше сводка по спросу,
// позициям и незакрытым запросам. Монтируется в server.js как обработчик.
//
// Пароль — SEO_ADMIN_PASSWORD в окружении. Сессия — подписанная HMAC кука,
// без хранилища: панель читающая, состояние держать не за чем.
const crypto = require('crypto');
const jobs = require('./lib/jobs');
const store = require('./lib/store');
const db = require('./lib/db');
const questions = require('./questions');

const COOKIE = 'sasha_seo';
const TTL = 14 * 24 * 3600 * 1000;

function secret() {
  return process.env.SEO_SESSION_SECRET || process.env.SEO_ADMIN_PASSWORD || '';
}

function sign(exp) {
  return `${exp}.${crypto.createHmac('sha256', secret()).update(String(exp)).digest('hex')}`;
}

function valid(token) {
  if (!token || !secret()) return false;
  const [exp, mac] = String(token).split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', secret()).update(exp).digest('hex');
  return want.length === mac.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac));
}

function passwordOk(given) {
  const want = process.env.SEO_ADMIN_PASSWORD || '';
  if (!want) return false;
  const a = Buffer.from(crypto.createHash('sha256').update(String(given)).digest('hex'));
  const b = Buffer.from(crypto.createHash('sha256').update(want).digest('hex'));
  return crypto.timingSafeEqual(a, b);
}

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';')
  .map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function readBody(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', (d) => { c.push(d); if (Buffer.concat(c).length > 4e5) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(c).toString('utf8')))));
  });
}

const shell = (title, body) => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>
body{margin:0;background:#131313;color:#ededed;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:28px 20px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 10px}
.sub{color:#9a9a9a;margin:0 0 24px}
.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 8px}
.tile{background:#1a1a1a;border:1px solid #2b2b2b;border-radius:10px;padding:14px 18px;min-width:120px}
.tile b{display:block;font-size:26px;font-weight:600}
.tile span{color:#9a9a9a;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #222}
th{color:#9a9a9a;font-weight:500}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.top3{color:#7ed08a}.top10{color:#e0c96a}.miss{color:#9a9a9a}
form.login{max-width:320px;margin:12vh auto}
input,button{font:inherit;padding:11px 14px;border-radius:8px;border:1px solid #2b2b2b;background:#1a1a1a;color:#ededed;width:100%}
button{background:#78a0ec;color:#0f0f0f;font-weight:700;border:0;cursor:pointer;margin-top:10px}
.err{color:#e08080}
.act{display:inline-block;width:auto;margin-right:8px}
textarea,select{font:inherit;padding:11px 14px;border-radius:8px;border:1px solid #2b2b2b;background:#1a1a1a;color:#ededed;width:100%}
label{display:block;margin:0 0 12px;color:#9a9a9a;font-size:13px}
.q{background:#1a1a1a;border:1px solid #2b2b2b;border-radius:10px;padding:14px 18px;margin:0 0 12px;white-space:pre-wrap}
.q .who{color:#9a9a9a;font-size:13px;white-space:normal}
a{color:#78a0ec}
form.inline{display:inline}
</style></head><body><div class="wrap">${body}</div></body></html>`;

function loginPage(err) {
  return shell('Вход · SEO', `<form class="login" method="POST" action="/seo/login">
  <h1>SEO-панель</h1><p class="sub">Доступ владельца сайта</p>
  ${err ? `<p class="err">${esc(err)}</p>` : ''}
  <input type="password" name="password" placeholder="Пароль" autofocus autocomplete="current-password">
  <button type="submit">Войти</button></form>`);
}

async function dashboard(msg) {
  const s = await jobs.summary();
  const pos = (await store.positions.latest()).sort((a, b) => (a.pos || 999) - (b.pos || 999));
  const gaps = await jobs.gaps({ limit: 40 });
  const kw = (await store.keywords.rows())
    .sort((a, b) => (b.count || b.shows || 0) - (a.count || a.shows || 0)).slice(0, 40);
  const newQuestions = await questions.list('new');
  const lastRuns = await store.runs.last(5);
  const cls = (p) => !p ? 'miss' : p <= 3 ? 'top3' : p <= 10 ? 'top10' : '';

  const tiles = [
    ['фраз в базе', s.keywords], ['страниц базы знаний', s.pages],
    ['в топ-3', s.top3], ['в топ-10', s.top10], ['в топ-30', s.top30],
    ['не найден', s.notFound], ['спрос без страницы', s.gaps],
    ['вопросов без ответа', newQuestions.length],
  ].map(([n, v]) => `<div class="tile"><b>${v}</b><span>${n}</span></div>`).join('');

  return shell('SEO · sasha-lab', `
<h1>SEO · ${esc(jobs.DOMAIN)}</h1>
<p class="sub">Спрос — из Wordstat, позиции — из Search API Яндекса, факт показов — из Вебмастера и Search Console.
${s.updated ? `Последнее обновление: ${esc(s.updated)}.` : 'Данные ещё не собирались.'}</p>
${msg ? `<p class="err">${esc(msg)}</p>` : ''}
<div class="tiles">${tiles}</div>
<p>
  <form class="inline" method="POST" action="/seo/run"><input type="hidden" name="job" value="wordstat"><button class="act">Собрать частотность</button></form>
  <form class="inline" method="POST" action="/seo/run"><input type="hidden" name="job" value="positions"><button class="act">Снять позиции</button></form>
  <form class="inline" method="POST" action="/seo/run"><input type="hidden" name="job" value="webmaster"><button class="act">Из Вебмастера</button></form>
  <form class="inline" method="POST" action="/seo/run"><input type="hidden" name="job" value="gsc"><button class="act">Из Search Console</button></form>
</p>

${lastRuns.length ? `<p class="sub">Последние запуски: ${lastRuns.map((r) => `${esc(r.job)} — ${
  r.finished_at ? (r.ok ? 'успех' : `ошибка: ${esc(r.error || '')}`) : 'идёт'} (${
  esc(new Date(r.started_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }))})`).join('; ')}</p>` : ''}

<h2>Вопросы посетителей</h2>
${(() => {
  const q = newQuestions;
  if (!q.length) return '<p class="sub">Новых вопросов нет. Форма — <a href="/baza/vopros/">/baza/vopros/</a>.</p>';
  return q.map((x) => `<div class="q"><p class="who">${esc(new Date(x.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }))} ·
    ${esc(x.name)}${x.car ? ` · ${esc(x.car)}` : ''} · ${esc(x.contact)}</p>${esc(x.text)}
    <p class="who"><a href="/seo/q?id=${esc(x.id)}">Ответить и опубликовать</a></p></div>`).join('');
})()}

<h2>Позиции</h2>
${pos.length ? `<table><tr><th>Запрос</th><th class="num">Позиция</th><th>Страница</th><th class="num">Снято</th></tr>
${pos.map((p) => `<tr><td>${esc(p.phrase)}</td><td class="num ${cls(p.pos)}">${p.pos || '—'}</td>
<td>${p.url ? `<a href="${esc(p.url)}">${esc(p.url.replace(/^https?:\/\/[^/]+/, '')) || '/'}</a>` : ''}</td>
<td class="num">${esc(p.date)}</td></tr>`).join('')}</table>` : '<p class="sub">Позиции ещё не снимались.</p>'}

<h2>Спрос без страницы</h2>
${gaps.length ? `<table><tr><th>Запрос</th><th class="num">Частота</th><th>Источник</th></tr>
${gaps.map((g) => `<tr><td>${esc(g.phrase)}</td><td class="num">${g.count || g.shows}</td><td>${esc(g.source || '')}</td></tr>`).join('')}</table>
<p class="sub">Это очередь на новые материалы базы знаний: под каждый такой запрос нужен свой ответ.</p>`
  : '<p class="sub">Пусто — либо всё закрыто, либо частотность ещё не собиралась.</p>'}

<h2>Частотные фразы</h2>
${kw.length ? `<table><tr><th>Фраза</th><th class="num">Wordstat</th><th class="num">Показы</th><th class="num">Позиция Я</th><th class="num">Позиция G</th></tr>
${kw.map((k) => `<tr><td>${esc(k.phrase)}</td><td class="num">${k.count ?? ''}</td><td class="num">${k.shows ?? k.impressions ?? ''}</td>
<td class="num">${k.yandexPos != null ? Number(k.yandexPos).toFixed(1) : ''}</td>
<td class="num">${k.googlePos != null ? Number(k.googlePos).toFixed(1) : ''}</td></tr>`).join('')}</table>` : ''}
`);
}

async function answerPage(id, err) {
  const q = await questions.get(id);
  if (!q) return shell('Вопрос', '<h1>Вопрос не найден</h1><p><a href="/seo/">Назад</a></p>');
  const rubrics = ['linzy', 'remont', 'polirovka', 'zakon', 'vybor'];
  return shell('Ответ на вопрос', `
<h1>Ответ на вопрос</h1>
<p class="sub"><a href="/seo/">← в панель</a></p>
${err ? `<p class="err">${esc(err)}</p>` : ''}
<div class="q"><p class="who">${esc(new Date(q.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }))} ·
  ${esc(q.name)}${q.car ? ` · ${esc(q.car)}` : ''} · ${esc(q.contact)}</p>${esc(q.text)}</div>
<form method="POST" action="/seo/publish">
  <input type="hidden" name="id" value="${esc(q.id)}">
  <label>Заголовок страницы — им же вопрос будет искаться в поиске
    <input name="title" value="${esc(q.text.split(/[.!?\n]/)[0].slice(0, 110))}" maxlength="120" required></label>
  <label>Рубрика<select name="rubric">${rubrics.map((r) => `<option value="${r}">${r}</option>`).join('')}</select></label>
  <label>Имя спросившего на странице (можно оставить пустым)
    <input name="asker" value="${esc(q.name)}" maxlength="60"></label>
  <label>Краткое описание для выдачи<input name="description" maxlength="200"></label>
  <label>Метки через запятую<input name="tags" maxlength="200"></label>
  <label>Запросы, которые закрывает материал, через запятую<input name="queries" maxlength="300"></label>
  <label>Ответ мастера (markdown: ## заголовки, списки, **жирный**)
    <textarea name="answer" rows="16" required></textarea></label>
  <button type="submit">Опубликовать</button>
</form>
<form method="POST" action="/seo/reject" style="margin-top:14px">
  <input type="hidden" name="id" value="${esc(q.id)}">
  <button class="act" style="background:#2b2b2b;color:#ededed">Убрать из очереди без публикации</button>
</form>
<p class="sub">Контакт спросившего на сайт не попадает — публикуются только текст вопроса и имя.
Ответ уходит человеку отдельно, вручную: телефоном или почтой.</p>`);
}

// Долгие задачи не держим в запросе: панель отвечает сразу, работа идёт фоном.
let running = null;
async function runJob(job) {
  if (running) return `уже выполняется: ${running}`;
  running = job;
  const runId = await store.runs.start(job).catch(() => null);
  const done = () => { running = null; };

  const work = async () => {
    if (job === 'wordstat') return jobs.collectWordstat();
    if (job === 'positions') {
      const phrases = (await store.keywords.rows())
        .sort((a, b) => (b.count || b.shows || 0) - (a.count || a.shows || 0))
        .slice(0, 30).map((k) => k.phrase);
      return jobs.checkPositions(phrases);
    }
    if (job === 'webmaster') return jobs.pullWebmaster();
    if (job === 'gsc') return jobs.pullGsc();
    throw new Error(`неизвестная задача ${job}`);
  };

  work().then(
    (r) => {
      done();
      // «Успех» — это когда что-то собрано. Задача, у которой все источники
      // отвалились (нет ключа, лимит, 500 у Яндекса), обязана гореть красным,
      // иначе панель врёт владельцу молчаливыми нулями.
      const stats = summarize(job, r);
      const errs = (r && r.errors) || [];
      const got = stats.rows ?? stats.seeds ?? stats.checked ?? 0;
      store.runs.finish(runId, {
        ok: got > 0 || !errs.length,
        error: errs.length ? errs.map((e) => `${e.seed || e.phrase}: ${e.error}`).join('; ').slice(0, 500) : null,
        stats,
      });
    },
    (e) => { done(); store.runs.finish(runId, { ok: false, error: e.message }); });
  return null;
}

// В журнал кладём счётчики, а не выгрузку целиком: она весит килобайты и уже
// разложена по keywords/positions.
function summarize(job, r) {
  if (!r) return {};
  if (Array.isArray(r)) return { rows: r.length };
  if (r.collected) return { seeds: r.collected.length, errors: (r.errors || []).length };
  if (r.checked) return { checked: r.checked.length, errors: (r.errors || []).length };
  return {};
}

// → true, если запрос обработан здесь
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/seo' && !url.pathname.startsWith('/seo/')) return false;

  const send = (code, html, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', ...headers });
    res.end(html);
  };

  if (!process.env.SEO_ADMIN_PASSWORD) {
    return send(503, shell('SEO', '<h1>Панель выключена</h1><p class="sub">Не задан SEO_ADMIN_PASSWORD.</p>')), true;
  }
  if (!db.enabled) {
    return send(503, shell('SEO', '<h1>Нет хранилища</h1><p class="sub">Не задан SASHALAB_PG_URL: вопросы и семантика лежат в базе, без неё панели нечего показывать.</p>')), true;
  }

  if (url.pathname === '/seo/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (!passwordOk(body.password || '')) return send(401, loginPage('Неверный пароль')), true;
    const exp = Date.now() + TTL;
    return send(302, '', { Location: '/seo/',
      'Set-Cookie': `${COOKIE}=${sign(exp)}; Path=/seo; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}` }), true;
  }

  if (!valid(cookies(req)[COOKIE])) return send(200, loginPage()), true;

  if (url.pathname === '/seo/logout') {
    return send(302, '', { Location: '/seo/', 'Set-Cookie': `${COOKIE}=; Path=/seo; Max-Age=0` }), true;
  }

  if (url.pathname === '/seo/run' && req.method === 'POST') {
    const body = await readBody(req);
    const busy = await runJob(body.job);
    return send(302, '', { Location: `/seo/?msg=${encodeURIComponent(busy || 'запущено')}` }), true;
  }

  if (url.pathname === '/seo/q') {
    return send(200, await answerPage(url.searchParams.get('id'), url.searchParams.get('err'))), true;
  }

  if (url.pathname === '/seo/publish' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const q = await questions.publish(body.id, body);
      return send(302, '', { Location: `/seo/?msg=${encodeURIComponent(`опубликовано: ${q.slug}`)}` }), true;
    } catch (e) {
      return send(302, '', { Location: `/seo/q?id=${encodeURIComponent(body.id || '')}&err=${encodeURIComponent(e.message)}` }), true;
    }
  }

  if (url.pathname === '/seo/reject' && req.method === 'POST') {
    const body = await readBody(req);
    try { await questions.setStatus(body.id, 'rejected'); } catch { /* уже нет */ }
    return send(302, '', { Location: `/seo/?msg=${encodeURIComponent('убрано из очереди')}` }), true;
  }

  if (url.pathname === '/seo/data.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ summary: await jobs.summary(),
      positions: await store.positions.latest(), gaps: await jobs.gaps() }, null, 2)), true;
  }

  send(200, await dashboard(url.searchParams.get('msg')));
  return true;
}

// Панель ходит в базу на каждый экран. Упавший запрос не должен ронять процесс,
// который заодно отдаёт сайт: показываем ошибку страницей.
async function handle(req, res) {
  try {
    return await route(req, res);
  } catch (e) {
    console.error('панель:', e.message);
    if (res.headersSent) return true;
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' });
    res.end(shell('Ошибка', `<h1>Ошибка панели</h1><p class="sub">${esc(e.message)}</p><p><a href="/seo/">Назад</a></p>`));
    return true;
  }
}

module.exports = { handle };
