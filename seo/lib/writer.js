// Автостраницы базы знаний: спрос → обоснованный текст → статика.
//
// Задача владельца: несколько раз в день смотреть, что спрашивают у Яндекса, и
// выпускать новые страницы знаний. Опасность ровно одна и она смертельная для
// домена: тысяча пустых страниц «линзы в <модель>» — это scaled content abuse
// у Google и «малополезный контент» у Яндекса, санкция прилетает всему сайту.
// Поэтому здесь не «генератор текста», а конвейер с тремя воротами:
//
//   1. ОБОСНОВАНИЕ. Страница рождается, только если под фразу есть факты:
//      материалы студии, разобранные fitment-факты, отвеченные вопросы людей.
//      Нет фактов — фраза остаётся в очереди, а не превращается в воду.
//   2. ПРОВЕРКА. В тексте не должно быть НИ ОДНОГО числа (цены, сроки, ватты),
//      которого нет в обосновании: цифры модель придумывает охотнее всего,
//      а отвечать за них мастеру перед клиентом.
//   3. РЕШЕНИЕ. Слабо обоснованный текст уходит ЧЕРНОВИКОМ в панель владельца,
//      а не в индекс. Публикуется сам только тот, под кем два независимых факта.
const db = require('./db');
const llm = require('./llm');
const memory = require('./memory');
const materials = require('../../content/materials');
const questions = require('../questions');

const MIN_BODY = Number(process.env.AUTOPAGE_MIN_BODY || 1200);
const MAX_BODY = Number(process.env.AUTOPAGE_MAX_BODY || 9000);
const STRONG = Number(process.env.AUTOPAGE_STRONG_FACTS || 2);
const RUBRICS = ['linzy', 'remont', 'polirovka', 'zakon', 'vybor'];
const FLUFF = ['ни для кого не секрет', 'в наше время', 'как известно', 'в современном мире', 'trust me', 'в данной статье'];

const words = (s) => String(s).toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, ' ').split(/\s+/).filter((w) => w.length > 3);

// ── обоснование ────────────────────────────────────────────────────────────
// Всё, что студия уже знает по этой фразе. Чужой текст сюда не попадает:
// documents (сырьё конкурентов) не читаем — только разобранные из них ФАКТЫ.
async function grounding(phrase) {
  const w = words(phrase);
  const overlap = (text) => {
    const hay = words(text);
    return w.length ? w.filter((x) => hay.includes(x)).length / w.length : 0;
  };

  const mats = (await materials.load())
    .map((m) => ({ ...m, score: overlap(`${m.meta.title} ${(m.meta.queries || []).join(' ')} ${m.meta.tags.join(' ')}`) }))
    .filter((m) => m.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  let facts = [];
  try {
    facts = await db.q(
      `SELECT v.make, v.model, v.generation, v.year_from, v.year_to,
              f.headlight, f.lens, f.approach, f.needs_opening, f.difficulty, f.hours, f.notes, f.status
         FROM fitment f JOIN vehicles v ON v.id = f.vehicle_id
        WHERE lower(v.make || ' ' || v.model) = ANY($1) OR lower(v.model) = ANY($1)
        ORDER BY (f.status='confirmed') DESC, f.confidence DESC LIMIT 12`,
      [w]);
  } catch { facts = []; }

  let asked = [];
  try {
    asked = (await questions.all('published')).filter((q) => overlap(q.text) >= 0.3).slice(0, 5);
  } catch { asked = []; }

  const score = mats.length + facts.length + asked.length;
  return { phrase, materials: mats, facts, questions: asked, score, strong: score >= STRONG };
}

// Текст обоснования для модели И для проверки цифр — один и тот же. Так
// гарантируется: что не приехало в обосновании, того в странице быть не может.
function groundingText(g) {
  const parts = [];
  for (const m of g.materials) parts.push(`МАТЕРИАЛ СТУДИИ «${m.meta.title}»:\n${m.body.slice(0, 1800)}`);
  for (const f of g.facts) {
    parts.push(`ФАКТ: ${[f.make, f.model, f.generation].filter(Boolean).join(' ')}`
      + `${f.year_from ? ` ${f.year_from}${f.year_to ? `–${f.year_to}` : '+'}` : ''}`
      + `${f.headlight ? `, фара: ${f.headlight}` : ''}${f.lens ? `, ставили: ${f.lens}` : ''}`
      + `${f.approach ? `, способ: ${f.approach}` : ''}${f.hours ? `, работа ${f.hours} ч` : ''}`
      + `${f.notes ? `. ${f.notes}` : ''} (${f.status === 'confirmed' ? 'подтверждено студией' : 'из источников'})`);
  }
  for (const q of g.questions) parts.push(`ВОПРОС ЧЕЛОВЕКА: ${q.text}`);
  return parts.join('\n\n');
}

// ── проверка написанного ───────────────────────────────────────────────────
const bigNumbers = (s) => [...new Set((String(s).match(/\d[\d\s ]*\d|\d+/g) || [])
  .map((x) => Number(x.replace(/[\s ]/g, ''))).filter((n) => n >= 1000))];

function validate(page, g) {
  const errors = [];
  const body = String(page.body || '');
  if (!page.title || page.title.length < 10) errors.push('нет заголовка');
  if (body.length < MIN_BODY) errors.push(`текст короче ${MIN_BODY} знаков (${body.length})`);
  if (body.length > MAX_BODY) errors.push(`текст длиннее ${MAX_BODY} знаков`);
  if (!RUBRICS.includes(page.rubric)) errors.push(`рубрика «${page.rubric}» не из списка`);
  const ground = `${groundingText(g)} ${g.phrase}`;
  const allowed = new Set(bigNumbers(ground));
  // Год в тексте — не факт о товаре, его пропускаем; всё остальное обязано
  // иметь основание. Именно так ловятся выдуманные цены и «300 000 часов».
  const invented = bigNumbers(body).filter((n) => !allowed.has(n) && !(n >= 1990 && n <= 2035));
  if (invented.length) errors.push(`числа без основания: ${invented.join(', ')}`);
  const fluff = FLUFF.filter((f) => body.toLowerCase().includes(f));
  if (fluff.length) errors.push(`вода: «${fluff.join('», «')}»`);
  if (!/##/.test(body)) errors.push('нет ни одного подзаголовка');
  return errors;
}

// ── сочинение ──────────────────────────────────────────────────────────────
async function write(phrase, g) {
  if (!llm.enabled()) throw new Error('нет NEURALDEEP_API_KEY: страницы писать нечем');
  const answer = await llm.chat([
    { role: 'system', content: 'Ты — мастер студии автосвета, пишешь в свою базу знаний. Пишешь коротко, по делу, от первого лица единственного числа. Отвечаешь СТРОГО одним JSON-объектом.' },
    { role: 'user', content:
`Запрос человека из поиска: «${phrase}».

Напиши страницу базы знаний, которая честно отвечает на этот запрос.

ЖЁСТКИЕ ПРАВИЛА:
1. Опирайся ТОЛЬКО на обоснование ниже. Чего в нём нет — того не пиши.
2. НИ ОДНОЙ цифры, которой нет в обосновании: ни цен, ни сроков, ни характеристик.
3. Никакой воды и вступлений «в наше время». Первый абзац — сразу ответ.
4. Не переписывай чужие статьи, пиши своими словами как мастер.
5. Если по обоснованию ответа не хватает — так и напиши в поле "gaps".
6. Объём: ${MIN_BODY}–4000 знаков, 3–5 подзаголовков, разбор по шагам и по случаям.
   Фактов на такой объём не хватает — НЕ надувай водой: пиши коротко и опиши нехватку в "gaps"
   (такая страница не выйдет в свет, и это правильнее пустой статьи).

ОБОСНОВАНИЕ:
"""
${groundingText(g).slice(0, 9000)}
"""

Верни JSON:
{
  "title": "заголовок страницы с заглавной буквы, как спрашивает человек",
  "description": "1 предложение для выдачи",
  "rubric": "одна из: ${RUBRICS.join(' | ')}",
  "queries": ["2–5 поисковых фраз, которые закрывает страница"],
  "body": "текст в markdown: короткий ответ, затем ## подзаголовки с деталями, затем ## когда так делать нельзя",
  "gaps": "чего не хватило в обосновании или пустая строка"
}` },
  ], { maxTokens: 2500, temperature: 0.4 });
  const t = answer.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const page = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  page.body = String(page.body || '').replace(/\r\n/g, '\n').trim();
  // Модель охотно возвращает заголовок ровно так, как звучит запрос, — строчными.
  // Заголовок страницы с маленькой буквы выглядит как недоделка, чиним на месте.
  page.title = String(page.title || '').trim().replace(/^./, (c) => c.toUpperCase());
  page.queries = [].concat(page.queries || []).map(String).slice(0, 6);
  if (!page.queries.includes(phrase)) page.queries.unshift(phrase);
  return page;
}

// ── сохранение ─────────────────────────────────────────────────────────────
const today = () => new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

async function save(page, g, { publish }) {
  const slug = await freeSlug(questions.slugify(page.title));
  const meta = {
    slug, rubric: page.rubric, type: 'guide', title: page.title.slice(0, 120),
    description: String(page.description || '').slice(0, 200), updated: today(),
    tags: [], queries: page.queries,
  };
  await materials.upsert(meta, page.body);
  await db.q(
    `UPDATE materials SET published=$2, origin='auto', auto_note=$3, grounding=$4::jsonb WHERE slug=$1`,
    [slug, publish, page.gaps ? String(page.gaps).slice(0, 400) : null,
      JSON.stringify({ phrase: g.phrase, score: g.score,
        materials: g.materials.map((m) => m.meta.slug), facts: g.facts.length, questions: g.questions.length })]);
  return { slug, meta };
}

async function freeSlug(base) {
  let slug = base;
  for (let i = 2; await materials.taken(slug); i++) slug = `${base}-${i}`;
  return slug;
}

// ── прогон ─────────────────────────────────────────────────────────────────
// Вызывается из cron несколько раз в день. Берёт верх очереди «нужна своя
// страница», пишет по несколько штук за заход и пересобирает статику ОДИН раз
// в конце: сборка перекладывает каталог dist целиком.
async function run({ limit = 2, dry = false, autopublish = process.env.SEO_AUTOPUBLISH !== '0' } = {}) {
  if (!db.enabled) throw new Error('нужна база: не задан SASHALAB_PG_URL');
  const q = await memory.queue({ limit: 40 });
  const out = { written: [], skipped: [], errors: [] };
  const taken = await require('../../content/materials').coverageMetas();
  for (const row of q.new) {
    if (out.written.length >= limit) break;
    // Очередь могла устареть: фразу уже закрыл ответ или прежний черновик.
    const dup = memory.decide(row.phrase, taken);
    if (dup.decision === 'covered') {
      await memory.remember({ ...dup, demand: row.demand ?? null, note: 'уже закрыто' });
      out.skipped.push({ phrase: row.phrase, why: `уже закрыто: ${dup.targetSlug}` });
      continue;
    }
    const g = await grounding(row.phrase);
    if (!g.score) { out.skipped.push({ phrase: row.phrase, why: 'нет фактов под запрос' }); continue; }
    let page;
    try { page = await write(row.phrase, g); }
    catch (e) { out.errors.push({ phrase: row.phrase, error: e.message }); continue; }
    const errs = validate(page, g);
    if (errs.length) { out.skipped.push({ phrase: row.phrase, why: errs.join('; ') }); continue; }
    if (dry) { out.written.push({ phrase: row.phrase, title: page.title, published: false, dry: true }); continue; }
    const publish = autopublish && g.strong;
    const { slug } = await save(page, g, { publish });
    // Фраза закрыта этой страницей — в следующий заход она не всплывёт снова.
    await memory.remember({
      phraseNorm: memory.norm(row.phrase), phrase: row.phrase, decision: 'covered',
      targetSlug: slug, demand: row.demand ?? null, note: publish ? 'автостраница' : 'автостраница, черновик',
    });
    taken.push({ slug, title: page.title, queries: page.queries });
    out.written.push({ phrase: row.phrase, slug, title: page.title, published: publish, grounding: g.score });
  }
  if (!dry && out.written.length) {
    try { await require('../../content/build.js').build(); }
    catch (e) { out.errors.push({ phrase: '(сборка)', error: e.message }); }
  }
  return out;
}

// Черновики для панели владельца: что движок написал, но не решился опубликовать.
const drafts = () => db.q(
  `SELECT slug, title, description, rubric, auto_note, grounding, updated_at
     FROM materials WHERE origin='auto' AND NOT published ORDER BY updated_at DESC LIMIT 30`);

const publishDraft = async (slug) => {
  await db.q('UPDATE materials SET published=true, updated_at=now() WHERE slug=$1', [slug]);
  await require('../../content/build.js').build();
  return slug;
};

module.exports = { run, grounding, groundingText, write, validate, save, drafts, publishDraft, bigNumbers, MIN_BODY };
