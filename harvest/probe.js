// Замер безопасной скорости сбора по каждому источнику.
//
// Зачем: до 19.09.2026 пауза между запросами у всех источников стояла «на глаз»
// (4000 мс почти везде), и цена этого — не вежливость, а СУТКИ простоя: полный
// обход electro-kot.ru (30 тыс. адресов) на такой паузе занимает ~33 часа, хотя
// сам сайт отвечает за 200 мс и спокойно держит запрос в секунду. Обратная
// ошибка тоже была: vdf-light.ru на 4000 мс поймал 429 на весь /catalog/.
// Вместо угадывания — измеряем КАЖДЫЙ источник и ставим паузу по замеру.
//
// Как замеряем (заход стоит источнику ~20 запросов, меньше одной минуты):
//   1) robots.txt: Crawl-delay площадки — потолок сверху, его не обгоняем;
//   2) берём до 4 реальных адресов из карты сайта (разрешённых robots);
//   3) лесенка пауз 4000 → 2000 → 1000 → 600 → 300 мс, на каждой ступени
//      несколько запросов; ступень «прошла», если ВСЕ ответы 200 и медиана
//      времени ответа не выросла в разы против самой медленной ступени.
//   4) первый же 429/403/503 или взлёт времени = стоп, дальше не давим.
// Рекомендация = последняя прошедшая пауза × запас 1.5, но не быстрее
// MIN_POLITE (1 запрос/с) и не быстрее Crawl-delay источника.
//
// Кэш страниц при замере НЕ используется (иначе мерили бы свой диск) и в кэш
// ничего не пишется: ходим через http.raw, robots проверяем сами.
const http = require('./http');
const crawl = require('./crawl');
const { SOURCES, byHost } = require('./sources');

const STEPS = [4000, 2000, 1000, 600, 300];
const PER_STEP = 4;
const MIN_POLITE = 1000;      // быстрее одного запроса в секунду к чужому сайту не ходим
const MAX_DELAY = 40000;
const SAFETY = 1.5;           // запас к последней прошедшей ступени

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };

// Адреса для замера: из карты сайта, вразбивку (не первые подряд — они часто
// лежат в одном разделе и кэшированы у источника лучше остальных).
async function sampleUrls(src, want = PER_STEP) {
  let entries = [];
  try {
    entries = await crawl.sitemapUrls(src.host, {
      ua: src.ua, delayMs: 1000, seeds: src.sitemaps,
      hostFix: src.sitemapHostFix, limit: 500,
    });
  } catch { /* карты нет — пойдём от сидов */ }
  const rules = await http.robots(src.host, src.ua);
  const ok = entries.map((e) => e.loc).filter((loc) => {
    let u; try { u = new URL(loc); } catch { return false; }
    return u.hostname === src.host && src.include.test(u.pathname)
      && http.allowedBy(rules, u.pathname + u.search);
  });
  if (ok.length < want) return [...new Set([...(src.seeds || []), ...ok])].slice(0, want);
  const step = Math.max(1, Math.floor(ok.length / want));
  const out = [];
  for (let i = 0; out.length < want && i < ok.length; i += step) out.push(ok[i]);
  return out;
}

async function timedGet(url, ua) {
  const t = Date.now();
  try {
    const r = await http.raw(url, { ua, timeout: 20000 });
    return { ms: Date.now() - t, status: r.status, bytes: r.body.length };
  } catch (e) {
    return { ms: Date.now() - t, status: 0, error: e.message };
  }
}

async function probeSource(src) {
  const res = { host: src.host, now: src.delayMs, sampled: 0, steps: [], robotsDelay: 0 };
  const rules = await http.robots(src.host, src.ua);
  res.robotsDelay = rules.delay;                 // парсер robots режет потолком 30 с
  if (src.robotsDelayHint) res.robotsDelay = Math.max(res.robotsDelay, src.robotsDelayHint);

  const urls = await sampleUrls(src);
  res.sampled = urls.length;
  if (!urls.length) { res.note = 'нет адресов для замера (пустая карта сайта и нет сидов)'; res.recommend = src.delayMs; return res; }

  let base = 0, lastGood = 0;
  for (const delay of STEPS) {
    if (res.robotsDelay && delay < res.robotsDelay) break;   // быстрее разрешённого не меряем
    const times = [];
    let bad = null;
    for (let i = 0; i < PER_STEP; i += 1) {
      const r = await timedGet(urls[i % urls.length], src.ua);
      if (r.status !== 200) { bad = r.status || `ошибка: ${r.error}`; break; }
      times.push(r.ms);
      if (i < PER_STEP - 1) await sleep(delay);
    }
    const med = median(times);
    const step = { delay, ok: !bad, med, bad };
    res.steps.push(step);
    if (bad) break;
    if (!base) base = med;
    // Взлёт времени ответа — тот же сигнал «хватит», что и 429, только вежливее:
    // источник ещё отвечает, но мы уже стоим у него в очереди.
    if (med > Math.max(base * 2.5, base + 1500)) { step.ok = false; step.bad = 'время ответа выросло'; break; }
    lastGood = delay;
  }

  res.latency = base;
  res.recommend = recommend({ lastGood, steps: res.steps, robotsDelay: res.robotsDelay, now: src.delayMs });
  // Скорость считаем честно: пауза И время самого ответа.
  res.perPageMs = res.recommend + (res.latency || 0);
  return res;
}

// Какую паузу ставим по итогам лесенки. Вынесено отдельной функцией, потому что
// это и есть вся политика замера — её сторожит тест, а не живой сайт.
//
// Ни одна ступень не прошла — два разных случая, и путать их нельзя:
//   * лесенка даже не начиналась (Crawl-delay источника медленнее самой медленной
//     ступени, как у hidplanet 10 с и bi-vision 40 с) — тогда правильный ответ
//     это и есть Crawl-delay, а не «вдвое медленнее, чем было»;
//   * первая же ступень упала в 429/403 — вот тут отходим от неё вдвое.
function recommend({ lastGood = 0, steps = [], robotsDelay = 0, now = 0 } = {}) {
  const raw = lastGood ? Math.round(lastGood * SAFETY)
    : steps.length ? steps[0].delay * 2
      : (robotsDelay || now);
  return Math.min(MAX_DELAY, Math.max(MIN_POLITE, robotsDelay || 0, raw));
}

async function run({ hosts } = {}) {
  const list = (hosts && hosts.length ? hosts.map(byHost).filter(Boolean) : SOURCES)
    .filter((s) => s.enabled !== false);
  const out = [];
  for (const s of list) {
    const r = await probeSource(s);
    out.push(r);
    const steps = r.steps.map((x) => `${x.delay}${x.ok ? '✓' : `✗(${x.bad})`}`).join(' ');
    console.log(`  ${r.host.padEnd(20)} ответ ${String(r.latency || '?').padStart(5)} мс  `
      + `robots ${String(r.robotsDelay / 1000 || 0)}с  было ${r.now} → СТАВИМ ${r.recommend} мс   ${steps}`
      + (r.note ? `\n${' '.repeat(22)}⚠ ${r.note}` : ''));
  }
  return out;
}

module.exports = { run, probeSource, sampleUrls, recommend, STEPS, MIN_POLITE, MAX_DELAY };
