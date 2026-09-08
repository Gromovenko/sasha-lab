// Вопросы от живых посетителей: приём с формы /baza/vopros/ и очередь на ответ
// в панели собственника. Хранятся в базе (таблица questions) — там же, где всё
// остальное, что переживает выкат.
//
// Это осознанная замена «форуму с созданными юзерами» из исходной задачи.
// Форма «вопрос → ответ» сохранена целиком, подменён только источник вопросов:
// спрашивает реальный человек, отвечает студия своим именем, ответ становится
// материалом базы знаний. Массовой генерации страниц (scaled content abuse у
// Google, малополезный контент у Яндекса) тут не возникает по построению: без
// живого вопроса и живого ответа страница не появляется.
const db = require('./lib/db');
const materials = require('../content/materials');

const MAX_TEXT = 2000;
const RATE_MAX = 3;                 // вопросов с одного адреса
const RATE_WINDOW = '1 hour';

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || '';
}

// Считаем по базе, а не по памяти процесса: рестарт не должен обнулять счётчик.
async function rateOk(ip) {
  if (!ip) return true;
  const r = await db.one(
    `SELECT count(*)::int AS n FROM questions WHERE ip = $1 AND created_at > now() - interval '${RATE_WINDOW}'`, [ip]);
  return r.n < RATE_MAX;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size > limit) return req.destroy(); chunks.push(d); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', () => resolve({}));
  });
}

const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const newId = () => `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ── приём формы ────────────────────────────────────────────────────────────
async function handleAsk(req, res) {
  const body = await readBody(req);
  const redirect = (to) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };

  // Ловушка для ботов: поле спрятано стилями, человек его не видит и не заполнит.
  // Ответ при этом обычный — бот не должен понять, что его отсеяли.
  if (body.fax) return redirect('/baza/vopros/spasibo/');

  const text = String(body.text || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
  const name = clean(body.name, 60);
  const contact = clean(body.contact, 80);
  if (text.length < 20 || !name || !contact || body.agree !== '1') return redirect('/baza/vopros/oshibka/');

  const ip = clientIp(req);
  try {
    if (!await rateOk(ip)) return redirect('/baza/vopros/oshibka/');
    await db.q(
      `INSERT INTO questions (id, name, contact, car, text, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId(), name, contact, clean(body.car, 80), text, ip, clean(req.headers['user-agent'], 300)]);
  } catch (e) {
    // Вопрос человека терять нельзя молча: пишем в лог и честно уводим на
    // страницу ошибки, где есть телефон студии.
    console.error('вопрос не сохранён:', e.message);
    return redirect('/baza/vopros/oshibka/');
  }
  redirect('/baza/vopros/spasibo/');
}

// ── очередь и публикация ───────────────────────────────────────────────────
const rowToQ = (r) => ({
  id: r.id, at: r.created_at.toISOString(), name: r.name, contact: r.contact,
  car: r.car || '', text: r.text, ip: r.ip, status: r.status, slug: r.slug,
});

async function list(status) {
  const rows = status
    ? await db.q('SELECT * FROM questions WHERE status=$1 ORDER BY created_at DESC', [status])
    : await db.q('SELECT * FROM questions ORDER BY created_at DESC');
  return rows.map(rowToQ);
}

const all = () => list();

async function countNew() {
  const r = await db.one(`SELECT count(*)::int AS n FROM questions WHERE status='new'`);
  return r.n;
}

async function get(id) {
  const r = await db.one('SELECT * FROM questions WHERE id=$1', [id]);
  return r ? rowToQ(r) : null;
}

async function setStatus(id, status, patch = {}) {
  const r = await db.one(
    `UPDATE questions SET status=$2, slug=COALESCE($3, slug), published_at=COALESCE($4, published_at),
            note=COALESCE($5, note) WHERE id=$1 RETURNING *`,
    [id, status, patch.slug || null, patch.publishedAt || null, patch.note || null]);
  if (!r) throw new Error('вопрос не найден');
  return rowToQ(r);
}

const TRANS = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'j',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'c',ч:'ch',ш:'sh',щ:'shh',ъ:'',ы:'y',ь:'',
  э:'e',ю:'yu',я:'ya' };

function slugify(s) {
  return String(s).toLowerCase().split('').map((c) => TRANS[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'vopros';
}

async function freeSlug(base) {
  let slug = base;
  for (let i = 2; await materials.taken(slug); i++) slug = `${base}-${i}`;
  return slug;
}

const today = () => new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

// Публикация: пишем материал, пересобираем базу знаний и только тогда помечаем
// вопрос отвеченным. Сборка упала — материал удаляем и восстанавливаем прежний
// dist, чтобы кривой текст не оставил живой раздел лежащим.
async function publish(id, { title, rubric, answer, asker, description, tags, queries }) {
  if (!db.enabled) throw new Error('публикация требует базы: не задан SASHALAB_PG_URL');
  const q = await get(id);
  if (!q) throw new Error('вопрос не найден');
  if (!String(answer || '').trim()) throw new Error('пустой ответ');
  if (!String(title || '').trim()) throw new Error('пустой заголовок');

  const slug = await freeSlug(slugify(title));
  const meta = {
    slug, rubric, type: 'question', title: clean(title, 120),
    description: description ? clean(description, 200) : '',
    updated: today(), asker: asker ? clean(asker, 60) : '',
    question: clean(q.text, 400),
    tags: clean(tags, 200).split(',').map((s) => s.trim()).filter(Boolean),
    queries: clean(queries, 300).split(',').map((s) => s.trim()).filter(Boolean),
  };

  await materials.upsert(meta, String(answer).replace(/\r\n/g, '\n').trim(), { questionId: id });
  try {
    await require('../content/build.js').build();
  } catch (e) {
    await materials.remove(slug);
    try { await require('../content/build.js').build(); } catch { /* прежнее состояние уже на диске */ }
    throw new Error(`материал не собрался, публикация отменена: ${e.message}`);
  }
  return setStatus(id, 'published', { slug, publishedAt: new Date().toISOString() });
}

module.exports = { handleAsk, list, all, get, countNew, setStatus, publish, slugify,
  RUBRIC_HINT: 'linzy|remont|polirovka|zakon|vybor' };
