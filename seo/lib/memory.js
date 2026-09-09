// Сео-память: одна фраза — один адрес.
//
// Задача владельца звучала так: «не плодить тысячи страниц, а усиливать одну».
// Технически это значит: прежде чем родить страницу под новую фразу, надо
// спросить — а не отвечает ли за неё уже существующая? Если отвечает, фраза
// дописывается в ту страницу (заголовок H2, абзац, синоним в тексте), и её вес
// растёт. Если нет — заводится новая.
//
// Решение принимается ОДИН раз и хранится в таблице intents. Иначе каждый заход
// в Wordstat снова предлагает те же 300 фраз, и человек снова их разбирает.
// Память тут в буквальном смысле: «это мы уже решали, вот куда».
const db = require('./db');

// Стоп-слова и грубое отсечение окончаний. Нам не нужна морфология уровня
// mystem: нужно, чтобы «потеют фары», «фары потеют» и «запотевание фар»
// сошлись в один ключ — этого хватает лемматизация по первым буквам корня.
const STOP = new Set(['и', 'в', 'во', 'на', 'с', 'со', 'к', 'по', 'за', 'из', 'от', 'до', 'у',
  'о', 'об', 'а', 'но', 'или', 'же', 'ли', 'бы', 'что', 'как', 'это', 'для', 'при', 'не',
  'ли', 'мне', 'мой', 'моя', 'мои', 'мой', 'сколько', 'какой', 'какая', 'какие', 'можно',
  'ли', 'ru', 'www']);

const ENDINGS = /(ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ов|ев|ий|ый|ая|яя|ое|ее|ые|ие|ой|ей|ом|ем|ам|ям|у|ю|а|я|ы|и|е|о|ь)$/;

function stem(w) {
  const s = w.replace(/ё/g, 'е');
  if (s.length <= 4) return s;
  const cut = s.replace(ENDINGS, '');
  return cut.length >= 3 ? cut : s;
}

// Синонимы схлопываются к одному корню. Морфология этого не делает: «потеют»,
// «запотевание» и «конденсат» — три разных слова и один интент клиента.
// Список короткий и предметный, его правит человек по мере появления фраз.
const SYN = [
  [/^(потеј?|поте|запотев|конденсат|туман)/, 'потеют'],
  [/^(билед|bi|биксен|bixen)/, 'биled'],
  [/^(линз|модул)/, 'линз'],
  [/^(штраф|запрет|законн|легальн|гибдд|наказан)/, 'законн'],
  [/^(полиров|шлифов)/, 'полировк'],
  [/^(бронир|плёнк|пленк|ppf)/, 'бронирован'],
  [/^(треснул|трещин|скол|разбит)/, 'трещин'],
  [/^(тускл|плох|слаб|тёмн|темн)/, 'плох'],
];
const canon = (w) => (SYN.find(([re]) => re.test(w)) || [null, w])[1];

function tokens(phrase) {
  return String(phrase).toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .map((w) => canon(stem(w)));
}

// Ключ склейки: отсортированные основы. Порядок слов в запросе роли не играет —
// «фары потеют почему» и «почему потеют фары» это один интент, а не два.
const norm = (phrase) => [...new Set(tokens(phrase))].sort().join(' ');

function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / new Set([...A, ...B]).size;      // Жаккар
}

// Насколько материал закрывает фразу: максимум по своим запросам и заголовку.
function coverage(phrase, material) {
  const cands = [material.title, ...(material.queries || [])];
  return cands.reduce((m, c) => Math.max(m, similarity(phrase, c)), 0);
}

// Решение по фразе. Пороги подобраны так, чтобы «новая страница» была
// исключением, а не режимом по умолчанию:
//   ≥ 0.75 — та же мысль другими словами → covered, ничего делать не надо;
//   ≥ 0.45 — близкая мысль → strengthen, дописать в существующую;
//   иначе  — new.
const COVERED = 0.75;
const STRENGTHEN = 0.45;

function decide(phrase, materials, { demand = null } = {}) {
  let best = { slug: null, score: 0, title: null };
  for (const m of materials) {
    const score = coverage(phrase, m);
    if (score > best.score) best = { slug: m.slug, score, title: m.title };
  }
  const decision = best.score >= COVERED ? 'covered'
    : best.score >= STRENGTHEN ? 'strengthen' : 'new';
  return { phrase, phraseNorm: norm(phrase), decision, targetSlug: best.slug,
    score: Number(best.score.toFixed(2)), targetTitle: best.title, demand };
}

// ── хранение ───────────────────────────────────────────────────────────────
async function remember(rec, { by = 'auto' } = {}) {
  if (!db.enabled) return rec;
  await db.q(`
    INSERT INTO intents (phrase_norm, phrase, cluster, target_slug, decision, demand, decided_at, decided_by, note)
    VALUES ($1,$2,$3,$4,$5,$6, now(), $7, $8)
    ON CONFLICT (phrase_norm) DO UPDATE SET
      -- решение человека сильнее автоматического и не перетирается пересчётом
      decision    = CASE WHEN intents.decided_by = 'owner' THEN intents.decision ELSE EXCLUDED.decision END,
      target_slug = CASE WHEN intents.decided_by = 'owner' THEN intents.target_slug ELSE EXCLUDED.target_slug END,
      demand      = COALESCE(EXCLUDED.demand, intents.demand),
      updated_at  = now()`,
    [rec.phraseNorm, rec.phrase, rec.cluster || null, rec.targetSlug || null,
      rec.decision, rec.demand ?? null, by, rec.note || null]);
  return rec;
}

// Прогон всей семантики через память. Возвращает сводку по решениям.
async function sync(materials, keywords) {
  const seen = new Set();
  const out = { covered: 0, strengthen: 0, new: 0, skip: 0, items: [] };
  for (const k of keywords) {
    const key = norm(k.phrase);
    if (!key || seen.has(key)) continue;              // дубли фразы схлопываются здесь же
    seen.add(key);
    const rec = decide(k.phrase, materials, { demand: k.count ?? k.shows ?? k.impressions ?? null });
    await remember(rec);
    out[rec.decision] += 1;
    out.items.push(rec);
  }
  out.items.sort((a, b) => (b.demand || 0) - (a.demand || 0));
  return out;
}

// Что делать дальше: самые спросовые фразы, которым нужна новая страница,
// и самые спросовые, которые надо дописать в существующую.
async function queue({ limit = 40 } = {}) {
  if (!db.enabled) return { new: [], strengthen: [] };
  const rows = await db.q(
    `SELECT phrase, decision, target_slug, demand FROM intents
      WHERE decision IN ('new','strengthen')
      ORDER BY demand DESC NULLS LAST LIMIT $1`, [limit * 2]);
  return {
    new: rows.filter((r) => r.decision === 'new').slice(0, limit),
    strengthen: rows.filter((r) => r.decision === 'strengthen').slice(0, limit),
  };
}

module.exports = { norm, tokens, stem, similarity, coverage, decide, remember, sync, queue,
  COVERED, STRENGTHEN };
