// Обход источника: sitemap, если он есть, иначе обход по ссылкам от сидов.
//
// Sitemap предпочтителен не из вежливости, а из точности: он даёт список
// страниц, которые сам сайт считает содержательными, без служебных фильтров
// каталога и пагинации, на которых обычный краулер тратит сотни запросов.
const http = require('./http');
const html = require('./html');
const store = require('./store');

// Тематический фильтр: сайты источников торгуют не только светом. Страница без
// единого упоминания фар/линз/света в разбор не идёт — она только раздувает базу.
const TOPIC = /(фар|линз|свет|ксенон|галоген|би-?лед|bi-?led|модул|отражател|стекл|птф|ходов)/gi;
// Одного упоминания мало: слово «фары» есть и в политике конфиденциальности
// тюнинг-ателье. Содержательная страница возвращается к теме много раз.
const TOPIC_MIN = 3;

async function sitemapUrls(host, ua, delayMs, seen = new Set()) {
  const out = [];
  const queue = [`https://${host}/sitemap.xml`, `https://${host}/sitemap_index.xml`];
  while (queue.length && out.length < 20000) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let r;
    try { r = await http.get(url, { delayMs, ua, maxAgeDays: 3 }); } catch { continue; }
    if (r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.body)) continue;
    const isIndex = /<sitemapindex/i.test(r.body);
    for (const m of r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const loc = html.decode(m[1]);
      if (isIndex) { if (queue.length < 60) queue.push(loc); }
      else out.push(loc);
    }
  }
  return out;
}

// Обход по ссылкам — когда sitemap нет или он пустой.
async function walk(src, limit) {
  const seen = new Set(src.seeds);
  const queue = [...src.seeds];
  const found = [];
  while (queue.length && found.length < limit) {
    const url = queue.shift();
    let r;
    try { r = await http.get(url, { delayMs: src.delayMs, ua: src.ua }); } catch { continue; }
    if (r.skipped || r.status !== 200) continue;
    found.push({ url, body: r.body });
    for (const l of html.links(r.body, url)) {
      if (seen.size > limit * 20) break;
      if (seen.has(l)) continue;
      seen.add(l);
      if (src.include.test(new URL(l).pathname)) queue.push(l);
    }
  }
  return found;
}

// Основной заход по одному источнику.
// Возвращает { host, fetched, saved, skipped, robots, errors }.
async function crawlSource(src, { limit, refetch = false, onDoc } = {}) {
  const row = await store.ensureSource(src);
  const max = Math.min(limit || src.maxPages || 200, src.maxPages || 200);
  const stat = { host: src.host, fetched: 0, saved: 0, offtopic: 0, robots: 0, errors: 0, listed: 0 };

  let urls = (await sitemapUrls(src.host, src.ua, src.delayMs))
    .filter((u) => { try { return src.include.test(new URL(u).pathname); } catch { return false; } });
  stat.listed = urls.length;

  const known = refetch ? new Set() : await store.knownUrls(row.id);
  urls = urls.filter((u) => !known.has(u));

  const pages = [];
  if (urls.length) {
    for (const url of urls.slice(0, max)) {
      let r;
      try { r = await http.get(url, { delayMs: src.delayMs, ua: src.ua }); }
      catch (e) { stat.errors += 1; continue; }
      if (r.skipped === 'robots') { stat.robots += 1; continue; }
      if (r.status !== 200) { stat.errors += 1; continue; }
      pages.push({ url, body: r.body });
    }
  } else if (stat.listed === 0) {
    for (const p of await walk(src, max)) if (!known.has(p.url)) pages.push(p);
  }

  for (const p of pages) {
    stat.fetched += 1;
    const text = html.strip(p.body);
    const doc = {
      source_id: row.id, url: p.url, http_status: 200,
      title: html.title(p.body), author: html.author(p.body),
      published_at: html.published(p.body), text,
      meta: { kind: src.kind, price: src.kind === 'parts' ? html.price(p.body) : undefined },
      skip_reason: (text.match(TOPIC) || []).length < TOPIC_MIN ? 'не про свет'
        : text.length < 400 ? 'слишком короткая' : null,
    };
    if (doc.skip_reason) stat.offtopic += 1;
    const saved = await store.saveDocument(doc);
    stat.saved += 1;
    if (onDoc) await onDoc(doc, saved);
  }
  await store.touchSource(row.id);
  return stat;
}

module.exports = { crawlSource, sitemapUrls, walk, TOPIC };
