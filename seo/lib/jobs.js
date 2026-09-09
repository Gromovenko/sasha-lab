// Рабочие операции SEO: сбор частотности, снятие позиций, выгрузка фактических
// запросов из Вебмастера/Search Console и сверка «спрос ↔ покрытие».
// Один и тот же код зовут и командная строка, и панель собственника.
const fs = require('fs');
const path = require('path');
const yandex = require('./yandex');
const serp = require('./serp');
const store = require('./store');
const gsc = require('./gsc');
const webmaster = require('./webmaster');

const DOMAIN = process.env.SEO_DOMAIN || 'sasha-lab.ru';

// Счётчик очереди вопросов нужен и панели, и отчёту cli; берём его отсюда,
// чтобы jobs не тянул на себя весь модуль вопросов.
const questionsCount = () => require('../questions').countNew().catch(() => 0);
const COVERAGE = path.join(__dirname, '..', '..', 'dist', 'coverage.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

// Базовые фразы, от которых разворачивается семантика. Сюда добавляют руками —
// это тематические корни бизнеса, а не автоподбор.
const SEEDS = [
  'установка би лед линз',
  'ремонт фар',
  'полировка фар',
  'бронирование фар',
  'замена стекла фары',
  'запотевают фары',
  'тюнинг фар',
  'светодиодные лампы в фары',
];

// ── частотность ────────────────────────────────────────────────────────────
// Wordstat платный: GetTop = 20 ₽ за КАЖДЫЙ вызов (тариф AI Studio, 09.09.2026),
// квота 100 вызовов в час. Кнопка «Собрать частотность» в панели дёргает все
// сиды разом — поэтому три предохранителя:
//   1. сид, собранный меньше WORDSTAT_TTL_DAYS назад, не запрашивается снова
//      (Wordstat и так отдаёт срез за последние 30 дней — раньше цифры не сменятся);
//   2. не больше WORDSTAT_MAX_CALLS вызовов за один прогон;
//   3. каждый вызов пишется в kv «wordstat_spend» — панель и cli показывают,
//      сколько рублей уже ушло, а не только «собрано фраз».
const WORDSTAT_RUB_PER_CALL = 20;
const WORDSTAT_TTL_DAYS = Number(process.env.WORDSTAT_TTL_DAYS || 30);
const WORDSTAT_MAX_CALLS = Number(process.env.WORDSTAT_MAX_CALLS || 10);

async function wordstatFreshSeeds(ttlDays) {
  const rs = await store.db.q(
    `SELECT seed FROM keywords WHERE source='wordstat' AND seed IS NOT NULL
       GROUP BY seed HAVING max(checked_at) > current_date - $1::int`, [ttlDays]);
  return new Set(rs.map((r) => r.seed));
}

async function noteWordstatSpend(calls) {
  const cur = (await store.kv.get('wordstat_spend', null)) || { calls: 0, rub: 0 };
  cur.calls += calls;
  cur.rub += calls * WORDSTAT_RUB_PER_CALL;
  cur.last = new Date().toISOString();
  await store.kv.set('wordstat_spend', cur);
  return cur;
}

async function collectWordstat(phrases = SEEDS, { regions, force = false, maxCalls = WORDSTAT_MAX_CALLS } = {}) {
  const collected = [];
  const errors = [];
  const skipped = [];
  const fresh = force ? new Set() : await wordstatFreshSeeds(WORDSTAT_TTL_DAYS);
  let calls = 0;    // попыток (для потолка за прогон)
  let billed = 0;   // удачных ответов — только они стоят денег
  for (const phrase of phrases) {
    if (fresh.has(phrase)) { skipped.push({ seed: phrase, why: `собрано < ${WORDSTAT_TTL_DAYS} дн. назад` }); continue; }
    if (calls >= maxCalls) { skipped.push({ seed: phrase, why: `потолок ${maxCalls} вызовов за прогон` }); continue; }
    try {
      calls += 1;
      const r = await yandex.wordstatTop(phrase, regions ? { regions } : {});
      const rows = [...r.results, ...r.associations].map((x) => ({
        phrase: x.phrase, count: x.count, seed: phrase, checkedAt: today(),
      }));
      billed += 1;
      await store.keywords.upsert(rows, 'wordstat');
      collected.push({ seed: phrase, total: r.totalCount, got: rows.length });
      await sleep(1100);                       // синхронный лимит — 1 запрос/с
    } catch (e) {
      // Ошибки авторизации и сервера Яндекс не тарифицирует (тариф AI Studio) —
      // ответа не было, в расход не идёт.
      errors.push({ seed: phrase, error: e.message });
    }
  }
  const spend = billed ? await noteWordstatSpend(billed) : await store.kv.get('wordstat_spend', { calls: 0, rub: 0 });
  return { collected, errors, skipped, calls, billed, rub: billed * WORDSTAT_RUB_PER_CALL, spend };
}

// ── позиции ────────────────────────────────────────────────────────────────
// Снимаем через Search API: это выдача Яндекса, а не «примерно как у людей».
// Персонализации и геозависимости на уровне пользователя тут нет — регион задаём явно.
async function checkPositions(phrases, { region = '39', domain = DOMAIN } = {}) {
  const out = [];
  const errors = [];
  for (const phrase of phrases) {
    try {
      const xml = await yandex.webSearch(phrase, { region });
      const err = serp.parseError(xml);
      if (err) throw new Error(err);
      const results = serp.parseResults(xml);
      const hit = serp.positionOf(results, domain);
      out.push({
        date: today(), engine: 'yandex', phrase, region,
        pos: hit ? hit.pos : null, url: hit ? hit.url : null,
        top: results.slice(0, 10).map((r) => ({ pos: r.pos, domain: r.domain, url: r.url })),
      });
      await sleep(1100);
    } catch (e) {
      errors.push({ phrase, error: e.message });
    }
  }
  if (out.length) await store.positions.add(out);
  return { checked: out, errors };
}

// ── факт: что уже приносит показы ─────────────────────────────────────────
async function pullWebmaster({ dateFrom, dateTo } = {}) {
  const to = dateTo || today();
  const from = dateFrom || new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
  const rows = await webmaster.searchQueries({ domain: DOMAIN, dateFrom: from, dateTo: to });
  await store.keywords.upsert(rows.map((r) => ({
    phrase: r.query, shows: r.shows, clicks: r.clicks, yandexPos: r.position, checkedAt: today(),
  })), 'webmaster');
  await store.kv.set('webmaster-queries', { from, to, rows });
  return rows;
}

async function pullGsc({ dateFrom, dateTo } = {}) {
  const to = dateTo || today();
  const from = dateFrom || new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
  const rows = await gsc.searchAnalytics({ startDate: from, endDate: to });
  await store.keywords.upsert(rows.map((r) => ({
    phrase: r.query, impressions: r.impressions, clicks: r.clicks,
    googlePos: r.position, checkedAt: today(),
  })), 'gsc');
  await store.kv.set('gsc-queries', { from, to, rows });
  return rows;
}

// ── сверка спроса и покрытия ──────────────────────────────────────────────
function coverage() {
  try { return JSON.parse(fs.readFileSync(COVERAGE, 'utf8')); } catch { return []; }
}

const words = (s) => String(s).toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, ' ').split(/\s+/).filter((w) => w.length > 2);

// Фраза считается закрытой, если у какой-то страницы она заявлена в queries
// или её значимые слова целиком встречаются в заголовке/запросах страницы.
function matchPage(phrase, pages) {
  const w = words(phrase);
  let best = null;
  for (const p of pages) {
    const hay = words([p.title, ...(p.queries || [])].join(' '));
    const hit = w.filter((x) => hay.includes(x)).length;
    const score = w.length ? hit / w.length : 0;
    if (!best || score > best.score) best = { page: p, score };
  }
  return best && best.score >= 0.7 ? best : null;
}

// Незакрытый спрос: частотные фразы, под которые нет ни одной страницы.
async function gaps({ minCount = 30, limit = 60 } = {}) {
  const pages = coverage();
  const rows = (await store.keywords.rows())
    .filter((k) => (k.count || k.shows || k.impressions || 0) >= minCount)
    .sort((a, b) => (b.count || b.shows || 0) - (a.count || a.shows || 0));
  const out = [];
  for (const k of rows) {
    if (matchPage(k.phrase, pages)) continue;
    out.push({ phrase: k.phrase, count: k.count || 0, shows: k.shows || 0, source: k.source });
    if (out.length >= limit) break;
  }
  return out;
}

// Сводка для панели: спрос, факт по позициям, покрытие.
async function summary() {
  const kw = await store.keywords.rows();
  const pos = await store.positions.latest();
  const pages = coverage();
  const inTop = (n) => pos.filter((p) => p.pos && p.pos <= n).length;
  return {
    keywords: kw.length,
    pages: pages.length,
    tracked: pos.length,
    top3: inTop(3), top10: inTop(10), top30: inTop(30),
    notFound: pos.filter((p) => !p.pos).length,
    gaps: (await gaps({ limit: 1000 })).length,
    updated: kw.reduce((a, k) => (k.checkedAt && k.checkedAt > a ? k.checkedAt : a), ''),
    questionsNew: await questionsCount(),
  };
}

module.exports = { SEEDS, WORDSTAT_RUB_PER_CALL, WORDSTAT_MAX_CALLS, collectWordstat, checkPositions, pullWebmaster, pullGsc, gaps, summary, coverage, DOMAIN };
