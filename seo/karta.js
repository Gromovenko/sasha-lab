// Страница «Карточка машины» (/karta): марка, модель, год — текстом или голосом —
// и по всем 18 пунктам карточки из вида vehicle_catalog (миграции 007–010).
//
//   GET  /karta            страница
//   GET  /karta/api        ?make=&model=&year= или ?q=«киа селтос 2021» → карточки
//   POST /karta/stt        сырое аудио (запасной путь, если в браузере нет
//                          распознавания речи) → текст через neuraldeep
//
// Данные только из базы, ничего не достраивается: пустой пункт так и показан
// пустым. Страница служебная (noindex), в sitemap её нет.
const db = require('./lib/db');
const vehiclesLib = require('../harvest/vehicles');

const RATE = new Map();
const RATE_MAX = 120;              // запросов в час с адреса
const STT_MAX = 15;                // распознаваний в час (у ключа суточный лимит)
const HOUR = 3600_000;

function rateOk(key, max) {
  const now = Date.now();
  const list = (RATE.get(key) || []).filter((t) => now - t < HOUR);
  list.push(now);
  RATE.set(key, list);
  if (RATE.size > 5000) RATE.clear();
  return list.length <= max;
}

const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.socket.remoteAddress || '';

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  res.end(JSON.stringify(obj));
};

// ── поиск машины ────────────────────────────────────────────────────────────
const YEAR = /\b(19[89]\d|20[0-3]\d)\b/;

function fitsYear(v, y) {
  if (!y) return true;
  return !v.year_from || (y >= v.year_from - 1 && y <= (v.year_to || 2100) + 1);
}

async function findVehicles({ make, model, year, q }) {
  let y = Number(year) || null;
  let text = String(q || '').trim();
  if (text) {
    const ym = text.match(YEAR);
    if (ym && !y) y = Number(ym[1]);
    const d = vehiclesLib.detect(text)[0];
    if (d) { make = d.make; model = d.model; y = y || d.yearFrom || null; }
  }
  let rows = [];
  if (make && model) {
    const slug = `${vehiclesLib.slugify(make)}-${vehiclesLib.slugify(model)}`;
    rows = await db.q(
      `SELECT id, slug, make, model, year_from, year_to, mentions FROM vehicles
        WHERE slug = $1 OR slug LIKE $1 || '-%' OR $2 = ANY (aliases)
        ORDER BY (slug = $1) DESC, mentions DESC LIMIT 30`, [slug, String(model).toLowerCase()]);
  }
  if (!rows.length) {
    // запасной путь: слова из строки против slug, марки, модели и алиасов
    const src = text || `${make || ''} ${model || ''}`;
    const words = src.toLowerCase().replace(YEAR, ' ').split(/[^a-zа-яё0-9]+/i).filter((w) => w.length > 1);
    if (!words.length) return { rows: [], year: y };
    const conds = words.map((_, i) =>
      `(lower(make) LIKE $${i + 1} OR lower(model) LIKE $${i + 1} OR slug LIKE $${i + 1}
        OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) LIKE $${i + 1}))`);
    rows = await db.q(
      `SELECT id, slug, make, model, year_from, year_to, mentions FROM vehicles
        WHERE ${conds.join(' AND ')} ORDER BY mentions DESC LIMIT 30`,
      words.map((w) => `%${w}%`));
  }
  const byYear = rows.filter((v) => fitsYear(v, y));
  return { rows: (byYear.length ? byYear : rows).slice(0, 8), year: y, yearMiss: !!y && !byYear.length && rows.length > 0 };
}

async function lookup(params) {
  const { rows, year, yearMiss } = await findVehicles(params);
  if (!rows.length) return { found: false, year, cards: [] };
  const cat = await db.q('SELECT * FROM vehicle_catalog WHERE vehicle_id = ANY ($1)', [rows.map((r) => r.id)]);
  const byId = new Map(cat.map((c) => [c.vehicle_id, c]));
  const cards = mergeCards(rows.map((v) => byId.get(v.id)).filter(Boolean)
    .sort((a, b) => score(b) - score(a)));
  return { found: cards.length > 0, year, yearMiss, cards };
}

// Одна машина заведена в справочнике несколькими записями («Seltos», «Seltos I»,
// «Seltos 1», «Seltos SP2»): без склейки карточка двоится. Склеиваем записи одной
// марки и базовой модели с пересекающимися годами; за основу берём самую полную,
// пустые пункты добираем из остальных.
const baseModel = (m) => String(m || '').toLowerCase()
  .replace(/[\s-]+(?:[ivx]{1,4}|\d{1,2}|sp\d+|gen\d*|mk\d+)$/i, '').trim();
const overlap = (a, b) => !a.year_from || !b.year_from
  || (a.year_from <= (b.year_to || 2100) + 1 && b.year_from <= (a.year_to || 2100) + 1);
const empty = (v) => v == null || v === '' || v === 0 || v === false || (Array.isArray(v) && !v.length);

function mergeCards(cards) {
  const out = [];
  for (const c of cards) {
    const main = out.find((m) => String(m.make).toLowerCase() === String(c.make).toLowerCase()
      && baseModel(m.model) === baseModel(c.model) && overlap(m, c));
    if (!main) { out.push({ ...c }); continue; }
    for (const k of Object.keys(c)) {
      if (['vehicle_id', 'slug', 'make', 'model', 'generation', 'year_from', 'year_to'].includes(k)) continue;
      if (empty(main[k]) && !empty(c[k])) main[k] = c[k];
    }
    if (c.year_from && main.year_from) main.year_from = Math.min(main.year_from, c.year_from);
    if (c.year_to && main.year_to) main.year_to = Math.max(main.year_to, c.year_to);
    else if (!c.year_to) main.year_to = main.year_to || null;
  }
  return out;
}

// ── выпадающие списки: марка → модель → год ─────────────────────────────────
// Берём только машины, у которых есть карточка (vehicle_catalog). Модели считаем
// по базовому имени («Seltos I» и «Seltos» — одна), годы — объединением диапазонов.
let OPT = { at: 0, tree: null };

async function options() {
  if (OPT.tree && Date.now() - OPT.at < 10 * 60_000) return OPT.tree;
  const rows = await db.q('SELECT make, model, year_from, year_to FROM vehicle_catalog WHERE make IS NOT NULL AND model IS NOT NULL');
  const tree = new Map();                       // марка → модель → {label, years:Set}
  const thisYear = new Date().getFullYear();
  for (const r of rows) {
    const mk = String(r.make).toLowerCase();
    const bm = baseModel(r.model);
    if (!bm) continue;
    if (!tree.has(mk)) tree.set(mk, new Map());
    const models = tree.get(mk);
    if (!models.has(bm)) models.set(bm, { years: new Set() });
    if (r.year_from) {
      for (let y = r.year_from; y <= Math.min(r.year_to || thisYear, thisYear + 1); y++) models.get(bm).years.add(y);
    }
  }
  OPT = {
    at: Date.now(),
    tree: [...tree.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([make, models]) => ({
      make,
      models: [...models.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([model, v]) => ({ model, years: [...v.years].sort((a, b) => b - a) })),
    })),
  };
  return OPT.tree;
}

// Порядок поколений: сначала те, по которым больше заполненных пунктов.
function score(c) {
  let s = 0;
  for (const k of ['glass', 'housing', 'adapter', 'headlight_oem', 'headlight_analog', 'ballast_oem', 'control', 'drl', 'kit', 'canbus', 'bulb']) {
    if (c[`${k}_offers`] > 0) s++;
  }
  for (const k of ['difficulty', 'sealant', 'adaptive', 'low_beam']) if (c[k] != null) s++;
  return s;
}

// ── голос: запасной путь ────────────────────────────────────────────────────
function readRaw(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (d) => { size += d.length; if (size > limit) { req.destroy(); reject(new Error('файл слишком большой')); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function transcribe(buf, mime) {
  const key = process.env.NEURALDEEP_API_KEY;
  if (!key) throw new Error('распознавание речи не настроено');
  const ext = /mp4|aac|m4a/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime || 'audio/webm' }), `voice.${ext}`);
  form.append('model', process.env.STT_MODEL || 'gigaam-v3');
  form.append('language', 'ru');
  const r = await fetch('https://api.neuraldeep.ru/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(r.status === 403 ? 'лимит распознавания на сегодня исчерпан' : `распознавание: ${r.status}`);
  return String((await r.json()).text || '').trim();
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (p !== '/karta' && !p.startsWith('/karta/')) return false;

  if (p === '/karta') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-cache' });
    res.end(PAGE);
    return true;
  }
  const ip = ipOf(req);
  if (p === '/karta/api' && req.method === 'GET') {
    if (!db.enabled) return json(res, 503, { error: 'база не подключена' }), true;
    if (!rateOk('a' + ip, RATE_MAX)) return json(res, 429, { error: 'слишком часто, подождите' }), true;
    try {
      const s = url.searchParams;
      json(res, 200, await lookup({ make: s.get('make'), model: s.get('model'), year: s.get('year'), q: s.get('q') }));
    } catch (e) { console.error('karta:', e.message); json(res, 500, { error: 'не удалось прочитать базу' }); }
    return true;
  }
  if (p === '/karta/options' && req.method === 'GET') {
    if (!db.enabled) return json(res, 503, { error: 'база не подключена' }), true;
    try { json(res, 200, { makes: await options() }); }
    catch (e) { console.error('karta:', e.message); json(res, 500, { error: 'не удалось прочитать базу' }); }
    return true;
  }
  if (p === '/karta/stt' && req.method === 'POST') {
    if (!rateOk('s' + ip, STT_MAX)) return json(res, 429, { error: 'слишком много записей подряд' }), true;
    try {
      const buf = await readRaw(req);
      if (buf.length < 800) return json(res, 400, { error: 'запись пустая' }), true;
      json(res, 200, { text: await transcribe(buf, String(req.headers['content-type'] || '').split(';')[0]) });
    } catch (e) { json(res, 502, { error: e.message }); }
    return true;
  }
  return false;
}

const PAGE = require('fs').readFileSync(require('path').join(__dirname, 'karta.html'), 'utf8');

module.exports = { handle, lookup, options, findVehicles, mergeCards, baseModel };
