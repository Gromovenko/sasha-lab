// Вопросы от живых посетителей: приём с формы /baza/vopros/ и очередь на ответ
// в панели собственника.
//
// Это осознанная замена «форуму с созданными юзерами» из исходной задачи.
// Форма «вопрос → ответ» сохранена целиком, подменён только источник вопросов:
// спрашивает реальный человек, отвечает студия своим именем, ответ уезжает в
// content/kb/*.md и становится обычной статической страницей. Массовой
// генерации страниц (scaled content abuse у Google, малополезный контент у
// Яндекса) тут не возникает по построению: без живого вопроса и живого ответа
// страница не появляется.
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');

const KB = path.join(__dirname, '..', 'content', 'kb');
const MAX_TEXT = 2000;
const RATE_MAX = 3;                 // вопросов с одного адреса
const RATE_WINDOW = 60 * 60 * 1000; // за час

const hits = new Map();             // ip → [метки времени]

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || '';
}

function rateOk(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  if (list.length >= RATE_MAX) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();   // память не копим: список чисто оперативный
  return true;
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

const all = () => store.read('questions', []);
const save = (rows) => store.write('questions', rows);
const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

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
  if (!rateOk(clientIp(req))) return redirect('/baza/vopros/oshibka/');

  const rows = all();
  rows.unshift({
    id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    name, contact, car: clean(body.car, 80), text,
    ip: clientIp(req), status: 'new',
  });
  save(rows.slice(0, 5000));
  redirect('/baza/vopros/spasibo/');
}

// ── очередь и публикация ───────────────────────────────────────────────────
const list = (status) => all().filter((q) => !status || q.status === status);

function setStatus(id, status, patch = {}) {
  const rows = all();
  const q = rows.find((r) => r.id === id);
  if (!q) throw new Error('вопрос не найден');
  Object.assign(q, patch, { status });
  save(rows);
  return q;
}

const TRANS = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'j',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'c',ч:'ch',ш:'sh',щ:'shh',ъ:'',ы:'y',ь:'',
  э:'e',ю:'yu',я:'ya' };

function slugify(s) {
  return String(s).toLowerCase().split('').map((c) => TRANS[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'vopros';
}

function freeSlug(base) {
  let slug = base;
  for (let i = 2; fs.existsSync(path.join(KB, `${slug}.md`)); i++) slug = `${base}-${i}`;
  return slug;
}

const today = () => new Date().toLocaleDateString('ru-RU');

// Публикация: пишем материал, пересобираем базу знаний и только тогда помечаем
// вопрос отвеченным. Сборка упала — файл удаляем и восстанавливаем прежний dist,
// чтобы кривой материал не оставил живой раздел лежащим.
function publish(id, { title, rubric, answer, asker, description, tags, queries }) {
  const q = all().find((r) => r.id === id);
  if (!q) throw new Error('вопрос не найден');
  if (!String(answer || '').trim()) throw new Error('пустой ответ');
  if (!String(title || '').trim()) throw new Error('пустой заголовок');

  const slug = freeSlug(slugify(title));
  const file = path.join(KB, `${slug}.md`);
  const head = [
    `slug: ${slug}`,
    `rubric: ${rubric}`,
    'type: question',
    `title: ${clean(title, 120)}`,
    description ? `description: ${clean(description, 200)}` : '',
    `updated: ${today()}`,
    asker ? `asker: ${clean(asker, 60)}` : '',
    `question: ${clean(q.text, 400)}`,
    tags ? `tags: [${clean(tags, 200)}]` : '',
    queries ? `queries: [${clean(queries, 300)}]` : '',
  ].filter(Boolean).join('\n');

  fs.writeFileSync(file, `---\n${head}\n---\n\n${String(answer).replace(/\r\n/g, '\n').trim()}\n`);
  try {
    delete require.cache[require.resolve('../content/build.js')];
    require('../content/build.js').build();
  } catch (e) {
    fs.unlinkSync(file);
    try { require('../content/build.js').build(); } catch { /* прежнее состояние уже на диске */ }
    throw new Error(`материал не собрался, публикация отменена: ${e.message}`);
  }
  return setStatus(id, 'published', { slug, publishedAt: new Date().toISOString() });
}

module.exports = { handleAsk, list, all, setStatus, publish, slugify, RUBRIC_HINT: 'linzy|remont|polirovka|zakon|vybor' };
