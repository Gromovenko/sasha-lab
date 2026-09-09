// Ассистент базы знаний: «форум с ИИ» из задачи владельца, но без выдуманных
// участников. Два режима, потому что это два разных человека с разной болью:
//
//   client — владелец машины: «фары тускло светят», «законно ли», «сколько стоит».
//            Отвечаем человеческим языком, без каталожных номеров, и всегда
//            оставляем дверь к живому мастеру.
//   pro    — установщик: марка/модель/год → что встаёт, со вскрытием или нет,
//            какие комплектующие и где, что ломается на этой фаре.
//
// Три правила, на которых всё держится:
//   1. Ассистент отвечает ТОЛЬКО тем, что есть в базе (материалы студии + факты,
//      собранные harvest/). Нечего сказать — так и говорит и зовёт мастера.
//      Придуманный ответ про чужую фару стоит клиенту разобранной оптики.
//   2. Каждый ответ несёт источники: материал базы знаний, ссылку на источник факта.
//   3. Вопрос, на который ассистент не смог ответить, попадает в очередь студии
//      (unanswered) — это и есть бесплатный поставщик тем для новых страниц.
const crypto = require('crypto');
const db = require('./lib/db');
const llm = require('./lib/llm');
const memory = require('./lib/memory');
const materialsRepo = require('../content/materials');
const vehiclesLib = require('../harvest/vehicles');

const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, list: [] };

async function materials() {
  if (Date.now() - cache.at < CACHE_MS) return cache.list;
  const list = (await materialsRepo.load()).map((m) => ({
    slug: m.meta.slug, title: m.meta.title, queries: m.meta.queries || [],
    description: m.meta.description || '', body: m.body,
  }));
  cache = { at: Date.now(), list };
  return list;
}

// Подбор материалов под вопрос. Та же метрика, что у сео-памяти: если она решает,
// какая страница отвечает за фразу, то и ассистент должен отвечать той же.
async function retrieve(text, k = 3) {
  const list = await materials();
  return list
    .map((m) => ({ m, score: Math.max(memory.coverage(text, m), memory.similarity(text, m.description)) }))
    .filter((r) => r.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => ({ ...r.m, score: Number(r.score.toFixed(2)) }));
}

// ── подбор для установщика ─────────────────────────────────────────────────
// Ищем машину по slug и по алиасам, год — необязательный уточнитель.
async function findVehicle({ make, model, year, text }) {
  if (!db.enabled) return null;
  if (text && !(make && model)) {
    const d = vehiclesLib.detect(text)[0];
    if (d) { make = d.make; model = d.model; year = year || d.yearFrom; }
  }
  if (!make || !model) return null;
  const slug = `${vehiclesLib.slugify(make)}-${vehiclesLib.slugify(model)}`;
  const rows = await db.q(
    `SELECT * FROM vehicles
      WHERE slug = $1 OR slug LIKE $1 || '-%' OR $2 = ANY (aliases)
      ORDER BY (slug = $1) DESC, mentions DESC LIMIT 5`,
    [slug, String(model).toLowerCase()]);
  if (!rows.length) return null;
  const y = Number(year) || null;
  // Год отсеивает поколения: у Tiggo 7 Pro 2020 и 2024 разная фара.
  return rows.find((r) => !y || !r.year_from || (y >= r.year_from - 1 && y <= (r.year_to || 2100) + 1)) || rows[0];
}

async function guide({ make, model, year, text }) {
  const v = await findVehicle({ make, model, year, text });
  if (!v) return { vehicle: null, fitment: [], parts: [], note: 'такой машины в базе ещё нет' };
  const fit = await db.q(
    `SELECT f.*, array_remove(array_agg(d.url), NULL) AS sources
       FROM fitment f LEFT JOIN documents d ON d.id = ANY (f.evidence)
      WHERE f.vehicle_id = $1
      GROUP BY f.id
      ORDER BY (f.status = 'confirmed') DESC, f.confidence DESC LIMIT 12`, [v.id]);
  // Комплектующие подбираем по названию линзы из совместимости: точного
  // артикульного справочника у нас нет и не будет — сайты его не отдают.
  const lenses = [...new Set(fit.map((f) => (f.lens || '').split(' ')[0]).filter(Boolean))];
  const parts = lenses.length ? await db.q(
    `SELECT name, kind, vendor, price_rub, url FROM parts
      WHERE lower(name) ~ $1 ORDER BY price_rub NULLS LAST LIMIT 20`,
    [lenses.map((l) => l.replace(/[^a-zа-яё0-9]/gi, '')).join('|')]) : [];
  return { vehicle: v, fitment: fit, parts };
}

// ── ответ ──────────────────────────────────────────────────────────────────
const PROMPT = {
  client: `Ты — консультант студии автосвета «Дядя Саша» (Ростов-на-Дону).
Отвечай коротко и по-человечески, на «вы», без маркетинга и без каталожных номеров.
Опирайся ТОЛЬКО на приведённые материалы. Если в них нет ответа — так и скажи
одной фразой и предложи задать вопрос мастеру. Ничего не выдумывай:
неверный совет по фаре стоит человеку денег. Не обещай сроков и цен, которых нет
в материалах.`,
  pro: `Ты — технический помощник установщика автосвета. Собеседник — мастер,
говори на его языке, без объяснения базовых вещей.
Опирайся ТОЛЬКО на приведённые факты о совместимости и комплектующих.
Если факта нет — скажи прямо «в базе нет», не достраивай по аналогии:
аналогия между поколениями одной модели — самая частая причина испорченной фары.
Отмечай уверенность: факты собраны из открытых источников и подтверждены не все.`,
};

function contextBlock(found, g) {
  const parts = [];
  for (const m of found) {
    parts.push(`# Материал студии: ${m.title} (/baza/${m.slug}/)\n${m.body.slice(0, 2500)}`);
  }
  if (g && g.vehicle) {
    parts.push(`# Машина: ${g.vehicle.make} ${g.vehicle.model} ${g.vehicle.year_from || ''}-${g.vehicle.year_to || ''}`);
    for (const f of g.fitment.slice(0, 8)) {
      parts.push(`- линза «${f.lens}», ${f.approach || 'способ не указан'}`
        + `${f.headlight ? `, штатно: ${f.headlight}` : ''}`
        + `${f.hours ? `, работа ~${f.hours} ч` : ''}`
        + `, уверенность ${f.confidence}${f.status === 'confirmed' ? ' (подтверждено студией)' : ''}`);
    }
    for (const p of (g.parts || []).slice(0, 8)) {
      parts.push(`- комплектующее: ${p.name} — ${p.price_rub ? `${p.price_rub} ₽` : 'цена не снята'} (${p.url})`);
    }
  }
  return parts.join('\n\n');
}

// Ответ без модели: выдержки из материалов. Это не заглушка, а рабочий режим —
// он честнее пустой страницы и не зависит от лимитов и ключей.
function fallbackAnswer(found, g) {
  if (g && g.vehicle && g.fitment.length) {
    const lines = g.fitment.slice(0, 5).map((f) =>
      `• ${f.lens}${f.approach ? `, ${f.approach}` : ''}${f.hours ? `, ~${f.hours} ч` : ''}`);
    return `По ${g.vehicle.make} ${g.vehicle.model} в базе есть:\n${lines.join('\n')}\n`
      + 'Данные собраны из открытых источников, перед работой сверьтесь с мастером.';
  }
  if (found.length) {
    return `В базе знаний об этом есть материал: «${found[0].title}» — /baza/${found[0].slug}/\n`
      + (found[1] ? `Смежное: «${found[1].title}» — /baza/${found[1].slug}/` : '');
  }
  return '';
}

async function ask({ text, mode = 'client', make, model, year, threadId, ip, ua }) {
  const question = String(text || '').trim().slice(0, 1000);
  if (question.length < 5) return { error: 'слишком короткий вопрос' };

  const found = await retrieve(question, mode === 'pro' ? 2 : 3);
  const g = mode === 'pro' ? await guide({ make, model, year, text: question }).catch(() => null) : null;

  let answer = '';
  let engine = 'база';
  const ctx = contextBlock(found, g);
  if (llm.enabled() && ctx) {
    try {
      answer = await llm.chat([
        { role: 'system', content: PROMPT[mode] || PROMPT.client },
        { role: 'user', content: `Вопрос: ${question}\n\nМатериалы базы:\n${ctx}` },
      ], { maxTokens: mode === 'pro' ? 800 : 550 });
      engine = llm.MODEL;
    } catch (e) {
      console.error('ассистент, модель недоступна:', e.message);
    }
  }
  if (!answer) answer = fallbackAnswer(found, g);
  const unanswered = !answer;
  if (unanswered) {
    answer = mode === 'pro'
      ? 'В базе такого нет. Напишите нам — разберём и добавим: это как раз то, чего базе не хватает.'
      : 'Точного ответа в базе пока нет. Задайте вопрос мастеру — ответим лично и добавим в базу знаний.';
  }

  const thread = await logThread({ threadId, mode, ip, ua, vehicleId: g && g.vehicle ? g.vehicle.id : null });
  await logMessages(thread, question, answer, {
    used: { materials: found.map((m) => m.slug), vehicle: g && g.vehicle ? g.vehicle.slug : null },
    engine, unanswered,
  });

  return {
    threadId: thread, mode, answer, engine,
    sources: found.map((m) => ({ title: m.title, url: `/baza/${m.slug}/` })),
    vehicle: g && g.vehicle ? { slug: g.vehicle.slug, make: g.vehicle.make, model: g.vehicle.model } : null,
    fitment: g ? g.fitment.map((f) => ({ lens: f.lens, approach: f.approach, headlight: f.headlight,
      hours: f.hours, confidence: Number(f.confidence), confirmed: f.status === 'confirmed',
      sources: (f.sources || []).slice(0, 3) })) : [],
    parts: g ? (g.parts || []).slice(0, 10) : [],
  };
}

const newId = () => `t${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

async function logThread({ threadId, mode, ip, ua, vehicleId }) {
  if (!db.enabled) return threadId || newId();
  const id = threadId && /^t[a-z0-9]{6,20}$/.test(threadId) ? threadId : newId();
  await db.q(`INSERT INTO assistant_threads (id, mode, vehicle_id, ip, user_agent)
              VALUES ($1,$2,$3,$4,$5)
              ON CONFLICT (id) DO UPDATE SET last_at = now(),
                vehicle_id = COALESCE(EXCLUDED.vehicle_id, assistant_threads.vehicle_id)`,
    [id, mode, vehicleId, ip || null, (ua || '').slice(0, 300)]);
  return id;
}

async function logMessages(threadId, question, answer, { used, engine, unanswered }) {
  if (!db.enabled) return;
  await db.q(`INSERT INTO assistant_messages (thread_id, role, text) VALUES ($1,'user',$2)`, [threadId, question]);
  await db.q(`INSERT INTO assistant_messages (thread_id, role, text, used, engine, unanswered)
              VALUES ($1,'assistant',$2,$3,$4,$5)`,
    [threadId, answer, JSON.stringify(used || {}), engine, Boolean(unanswered)]);
}

// Вопросы без ответа — очередь тем для студии.
async function unanswered(limit = 50) {
  if (!db.enabled) return [];
  return db.q(
    `SELECT u.text, u.created_at, t.mode
       FROM assistant_messages a
       JOIN assistant_threads t ON t.id = a.thread_id
       JOIN LATERAL (SELECT text, created_at FROM assistant_messages
                      WHERE thread_id = a.thread_id AND role = 'user' AND id < a.id
                      ORDER BY id DESC LIMIT 1) u ON true
      WHERE a.unanswered ORDER BY a.created_at DESC LIMIT $1`, [limit]);
}

module.exports = { ask, guide, retrieve, unanswered, findVehicle };
