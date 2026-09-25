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
  // Карточка ОДНА: все записи справочника одной марки и семейства модели
  // склеиваются, показываем самое полное семейство.
  const card = mergeCards(rows.map((v) => byId.get(v.id)).filter(Boolean)
    .sort((a, b) => score(b) - score(a)))[0];
  if (!card) return { found: false, year, cards: [] };
  const ids = cat.filter((c) => sameFamily(card, c)).map((c) => c.vehicle_id);
  const src = await sources(ids);
  return { found: true, year, yearMiss, cards: [{
    make: card.make, model: card.model, year_from: card.year_from, year_to: card.year_to,
    confidence: card.confidence, confirmed: card.confirmed,
    shop: src.shop, items: buildItems(card, src),
  }] };
}

// Одна машина заведена в справочнике несколькими записями («Seltos», «Seltos I»,
// «Seltos 1», «Seltos SP2», «SELTOS HALOGEN»). Склеиваем записи одной марки и
// одного семейства модели независимо от годов; за основу берём самую полную,
// пустые пункты добираем из остальных.
const baseModel = (m) => String(m || '').toLowerCase()
  .replace(/[\s-]+(?:[ivx]{1,4}|\d{1,2}|sp\d+|gen\d*|mk\d+)$/i, '').trim();
const sameFamily = (a, b) => {
  if (String(a.make).toLowerCase() !== String(b.make).toLowerCase()) return false;
  const x = baseModel(a.model), y = baseModel(b.model);
  return x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ');
};
const empty = (v) => v == null || v === '' || v === 0 || v === false || (Array.isArray(v) && !v.length);

function mergeCards(cards) {
  const out = [];
  for (const c of cards) {
    const main = out.find((m) => sameFamily(m, c));
    if (!main) { out.push({ ...c }); continue; }
    for (const k of Object.keys(c)) {
      if (['vehicle_id', 'slug', 'make', 'model', 'generation', 'year_from', 'year_to'].includes(k)) continue;
      if (empty(main[k]) && !empty(c[k])) main[k] = c[k];
    }
    if (c.year_from) main.year_from = main.year_from ? Math.min(main.year_from, c.year_from) : c.year_from;
    if (c.year_to) main.year_to = main.year_to ? Math.max(main.year_to, c.year_to) : c.year_to;
  }
  return out;
}

// ── ссылки на источники: по каждому пункту список живых адресов ─────────────
const PER_ITEM = 6;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'источник'; } };
const short = (t, n = 90) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const ALIVE = `(d.id IS NULL OR (d.skip_reason IS NULL AND (d.http_status IS NULL OR d.http_status = 200)))
  AND NOT EXISTS (SELECT 1 FROM vehicle_links x WHERE x.url = %U AND x.http_status IS NOT NULL AND x.http_status <> 200)`;

async function sources(ids) {
  const parts = await db.q(
    `SELECT * FROM (
       SELECT vp.kind, p.name, p.url, p.price_rub, p.available,
              row_number() OVER (PARTITION BY vp.kind ORDER BY (p.available IS TRUE) DESC,
                (p.price_rub > 0) DESC, p.price_rub, p.last_seen DESC) AS rn
         FROM vehicle_parts vp JOIN parts p ON p.id = vp.part_id
         LEFT JOIN documents d ON d.url = p.url
        WHERE vp.vehicle_id = ANY ($1) AND ${ALIVE.replace('%U', 'p.url')}) t
      WHERE rn <= 60`, [ids]);
  const facts = await db.q(
    `SELECT d.url, d.title, f.confidence, f.difficulty, f.needs_opening, f.hours, f.sealant,
            f.adaptive, f.low_beam_source
       FROM fitment f CROSS JOIN LATERAL unnest(f.evidence) e
       JOIN documents d ON d.id = e
      WHERE f.vehicle_id = ANY ($1) AND ${ALIVE.replace('%U', 'd.url')}
      ORDER BY f.confidence DESC, d.fetched_at DESC LIMIT 600`, [ids]);
  const shop = await db.q(
    `SELECT l.url, l.title FROM vehicle_links l JOIN sources s ON s.id = l.source_id
      WHERE l.vehicle_id = ANY ($1) AND s.kind = 'parts' AND (l.http_status IS NULL OR l.http_status = 200)
      ORDER BY CASE l.basis WHEN 'url' THEN 0 WHEN 'title' THEN 1 ELSE 2 END, l.url LIMIT 40`, [ids]);
  const uniq = (list) => { const seen = new Set(); return list.filter((x) => !seen.has(x.url) && seen.add(x.url)); };
  const pl = (kind, re) => uniq(parts.filter((r) => r.kind === kind && (!re || re.test(r.name))))
    .slice(0, PER_ITEM).map((r) => ({
      url: r.url, host: hostOf(r.url),
      title: short(r.name) + (r.price_rub > 0 ? ` — ${Number(r.price_rub).toLocaleString('ru-RU')} ₽` : ''),
    }));
  const fl = (pred) => uniq(facts.filter(pred)).slice(0, PER_ITEM)
    .map((r) => ({ url: r.url, host: hostOf(r.url), title: short(r.title) || hostOf(r.url) }));
  return {
    shop: uniq(shop).slice(0, PER_ITEM).map((r) => ({ url: r.url, host: hostOf(r.url), title: short(r.title) || hostOf(r.url) })),
    glass: pl('glass'), housing: pl('housing'), adapter: pl('adapter'),
    teardown: fl((r) => r.difficulty != null || r.needs_opening != null || r.hours != null),
    sealant: fl((r) => r.sealant != null),
    adaptive: fl((r) => r.adaptive != null),
    low_beam: fl((r) => r.low_beam_source != null),
    canbus: pl('wire', /обманк|canbus|can-шин|имитатор/i),
    bulb: pl('bulb'),
    headlight_oem: pl('headlight_oem'), headlight_analog: pl('headlight_analog'),
    ballast_oem: pl('ballast', /штатн|oem|оригинал/i),
    control: pl('control'), drl: pl('drl'), kit: pl('kit'),
  };
}

// Пункты карточки: только те, по которым в базе что-то есть.
function buildItems(c, src) {
  const items = [];
  const rub = (n) => Number(n).toLocaleString('ru-RU') + ' ₽';
  const add = (n, label, value, links) => { if (value) items.push({ n, label, value, links: links || [] }); };
  const part = (k) => {
    const cnt = Number(c[`${k}_offers`]) || 0;
    if (!cnt) return '';
    let s = `предложений: ${cnt}`;
    if (c[`${k}_price_min`] != null) s += ` · от ${rub(c[`${k}_price_min`])}`;
    if (c[`${k}_in_stock`]) s += ' · в наличии';
    return s;
  };
  add(4, 'Стекло фары', part('glass'), src.glass);
  add(5, 'Корпус фары', part('housing'), src.housing);
  add(6, 'Переходная рамка под bi-LED', part('adapter'), src.adapter);
  const t = [];
  if (c.difficulty != null) t.push(`сложность: ${c.difficulty}`);
  if (c.needs_opening != null) t.push(`вскрытие: ${c.needs_opening ? 'да' : 'нет'}`);
  if (c.hours_max != null) t.push(`до ${Number(c.hours_max)} ч`);
  add(7, 'Сложность разбора фары', t.join(' · '), src.teardown);
  add(8, 'Заводской герметик', c.sealant || c.sealant_raw, src.sealant);
  if (c.adaptive != null) add(9, 'Адаптивный свет', c.adaptive ? 'адаптивный' : 'обычный', src.adaptive);
  add(10, 'Штатный свет (ближний)',
    [c.low_beam || c.low_beam_raw, c.factory_lens ? `линза: ${c.factory_lens}` : ''].filter(Boolean).join(' · '), src.low_beam);
  add(11, 'Обманки / имитация штатного света',
    part('canbus') + (part('canbus') && c.needs_canbus === true ? ' · нужны при замене на ксенон/LED' : ''), src.canbus);
  const b = [];
  if (c.bulb_sockets && c.bulb_sockets.length) b.push(`цоколи: ${c.bulb_sockets.join(', ')}`);
  if (c.bulb_spots && c.bulb_spots.length) b.push(`места: ${c.bulb_spots.join(', ')}`);
  add(12, 'Типы ламп в штатных приборах', b.join(' · '), src.bulb);
  add(13, 'Фара оригинал', part('headlight_oem'), src.headlight_oem);
  add(14, 'Фара OEM (аналог оригинала)', part('headlight_analog'), src.headlight_analog);
  add(15, 'Штатные блоки розжига', part('ballast_oem'), src.ballast_oem);
  add(16, 'Штатные блоки управления', part('control'), src.control);
  add(17, 'Модули ДХО, поворота, боковой подсветки, колец', part('drl'), src.drl);
  add(18, 'Набор для модернизации фар', part('kit'), src.kit);
  return items;
}

// ── выпадающие списки: марка → модель → год ─────────────────────────────────
// Берём только машины, у которых есть карточка (vehicle_catalog). Модели считаем
// по базовому имени («Seltos I» и «Seltos» — одна), годы — объединением диапазонов.
let OPT = { at: 0, tree: null };

// Эталон моделей: имя считается настоящей моделью, если оно есть в каталоге
// vdf-light (страницы /catalog/<марка>_<модель>) или подтверждено страницами
// минимум двух разных сайтов. Так отсеиваются слова из заголовков («look», «use»),
// опечатки и чужие модели под чужой маркой; варианты «mdx 1g», «mdx mdx»
// схлопываются в кратчайший подтверждённый префикс («mdx»).
const MIN_SOURCES = 2;
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9а-я]+/g, ' ').trim().split(' ').filter(Boolean);

async function reference() {
  const [vdf, src] = await Promise.all([
    db.q(`SELECT DISTINCT regexp_replace(url, '^.*/catalog/', '') AS slug FROM documents
           WHERE url ~ 'vdf-light\\.ru/catalog/[a-z0-9]+_'`),
    db.q(`SELECT lower(v.make) AS make, lower(v.model) AS model, count(DISTINCT l.source_id)::int AS n
            FROM vehicle_links l JOIN vehicles v ON v.id = l.vehicle_id
           GROUP BY 1, 2`),
  ]);
  const slugs = vdf.map((r) => r.slug.replace(/^frame_/, '').replace(/\/$/, ''));
  const inVdf = (make, words) => {
    const k = `${key(make).join('_')}_${words.join('_')}`;
    return slugs.some((x) => x === k || x.startsWith(`${k}_`));
  };
  const multi = new Set(src.filter((r) => r.n >= MIN_SOURCES).map((r) => `${r.make}|${key(r.model).join(' ')}`));
  return (make, model) => {
    const words = key(model);
    if (words.some((w) => /[^a-z0-9]/.test(w))) return null;   // модели пишутся латиницей
    for (let i = 1; i <= words.length; i++) {
      const head = words.slice(0, i);
      if (multi.has(`${String(make).toLowerCase()}|${head.join(' ')}`) || inVdf(make, head)) return head.join(' ');
    }
    return null;
  };
}

async function options() {
  if (OPT.tree && Date.now() - OPT.at < 10 * 60_000) return OPT.tree;
  const [rows, canon] = await Promise.all([
    db.q('SELECT make, model, year_from, year_to FROM vehicle_catalog WHERE make IS NOT NULL AND model IS NOT NULL'),
    reference(),
  ]);
  const tree = new Map();                       // марка → модель → {years:Set}
  const thisYear = new Date().getFullYear();
  for (const r of rows) {
    const mk = String(r.make).toLowerCase();
    const bm = canon(mk, baseModel(r.model));
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

module.exports = { handle, lookup, options, findVehicles, mergeCards, baseModel, buildItems };
