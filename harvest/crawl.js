// Обход источника: sitemap, если он есть, иначе обход по ссылкам от сидов.
//
// Sitemap предпочтителен не из вежливости, а из точности: он даёт список
// страниц, которые сам сайт считает содержательными, без служебных фильтров
// каталога и пагинации, на которых обычный краулер тратит сотни запросов.
const http = require('./http');
const html = require('./html');
const store = require('./store');
const vehicles = require('./vehicles');
const facts = require('./facts');

// Тематический фильтр: сайты источников торгуют не только светом. Страница без
// единого упоминания фар/линз/света в разбор не идёт — она только раздувает базу.
const TOPIC = /(фар|линз|свет|ксенон|галоген|би-?лед|bi-?led|модул|отражател|стекл|птф|ходов)/gi;
// Одного упоминания мало: слово «фары» есть и в политике конфиденциальности
// тюнинг-ателье. Содержательная страница возвращается к теме много раз.
const TOPIC_MIN = 3;

// Карта сайта → [{ loc, lastmod }].
//
// Три вещи, которых не было в первой версии и без которых крупный форум не берётся:
//   * адрес карты можно задать явно (`src.sitemaps`) — на hidplanet.com обычный
//     /sitemap.xml закрыт Cloudflare, а карта лежит по /core/xmlsitemap.php;
//   * `hostFix` — vBulletin печатает в карте своё ВНУТРЕННЕЕ имя хоста
//     (5da7a14b4a42-006150.vbulletin.net). Без подмены на хост источника мы бы
//     ушли ходить по чужому домену, которого в robots.txt даже нет;
//   * потолок на размер ответа: кусок карты форума с 60 тысячами тем весит 7 МБ,
//     а общий потолок загрузчика — 4 МБ.
async function sitemapUrls(host, { ua, delayMs, seeds, hostFix = false, limit = 20000 } = {}) {
  const out = [];
  const seen = new Set();
  const fix = (loc) => {
    let u;
    try { u = new URL(loc); } catch { return null; }
    if (u.hostname !== host) {
      if (!hostFix) return null;      // чужой хост без явного разрешения не трогаем
      u.hostname = host;
      u.protocol = 'https:';
    }
    return u.toString();
  };
  const queue = seeds && seeds.length ? [...seeds]
    : [`https://${host}/sitemap.xml`, `https://${host}/sitemap_index.xml`];
  while (queue.length && out.length < limit) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let r;
    try { r = await http.get(url, { delayMs, ua, maxAgeDays: 3, maxBytes: 32 * 1024 * 1024 }); }
    catch { continue; }
    if (r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.body)) continue;
    if (/<sitemapindex/i.test(r.body)) {
      for (const m of r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        // Потолок на дочерние карты: у крупного каталога их бывают десятки,
        // а каждая — ещё один поход к источнику с паузой.
        const loc = fix(html.decode(m[1]));
        if (loc && queue.length < 25) queue.push(loc);
      }
      continue;
    }
    for (const m of r.body.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
      const loc = fix(html.decode((m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1] || ''));
      if (!loc) continue;
      const lastmod = (m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i) || [])[1] || null;
      out.push({ loc, lastmod });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// Обход по ссылкам — когда sitemap нет или он пустой.
//
// Страницу отдаём вызывающему сразу (onPage), а не копим в массиве: тело
// страницы весит сотни килобайт, и «сначала всё скачать, потом всё разобрать»
// на большом источнике кончается heap limit (см. комментарий в crawlSource).
async function walk(src, limit, onPage) {
  const seen = new Set(src.seeds);
  const queue = [...src.seeds];
  const found = [];
  let taken = 0;
  while (queue.length && taken < limit) {
    const url = queue.shift();
    let r;
    try { r = await http.get(url, { delayMs: src.delayMs, ua: src.ua }); } catch { continue; }
    if (r.skipped || r.status !== 200) continue;
    taken += 1;
    if (onPage) await onPage(url, r.body); else found.push({ url, body: r.body });
    for (const l of html.links(r.body, url)) {
      if (seen.size > limit * 20) break;
      if (seen.has(l)) continue;
      seen.add(l);
      if (src.include.test(new URL(l).pathname)) queue.push(l);
    }
  }
  return found;
}

// Заголовок темы из адреса. У vBulletin заголовок лежит прямо в адресе:
// /forum/general-discussion/specific-questions/60453-tsx-r-vs-black-series-clear-lens
const titleFromUrl = (url) => {
  const seg = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean).pop() || '';
  return seg.replace(/^\d+-/, '')                       // номер темы
    .replace(/[-_]+/g, ' ')
    .replace(/[^\p{L}\p{N}+.,'" -]/gu, ' ')            // мусор кодировки вроде %C2%92
    .replace(/\s+/g, ' ').trim();
};
const sectionOf = (url) => decodeURIComponent(new URL(url).pathname)
  .split('/').filter(Boolean).slice(0, -1).join('/');

// Режим «только заголовки» (src.mode = 'titles').
//
// Бывает, что текст страниц источник не отдаёт вовсе — hidplanet.com держит весь
// html за Cloudflare-челленджем, — а карту сайта отдаёт свободно. У форума на
// vBulletin в адресе темы лежит её заголовок, и этого хватает на главный факт:
// «в такую-то машину ставили такую-то линзу». Текста источника мы при этом не
// берём ни строки — только то, что сам сайт напечатал в адресе для поисковиков.
//
// Заголовки без единой зацепки (ни машины, ни линзы) не сохраняем: разобрать из
// них нечего, а база от них распухла бы на десятки тысяч пустых строк.
async function crawlTitles(src, { row, entries, max, onDoc, stat }) {
  for (const { loc, lastmod } of entries) {
    if (stat.saved >= max) break;
    const title = titleFromUrl(loc);
    if (title.length < 6) { stat.offtopic += 1; continue; }
    const lang = src.lang || 'ru';
    const hasLead = vehicles.detect(title, { lang }).length > 0 || facts.lenses(title).length > 0;
    if (!hasLead) { stat.offtopic += 1; continue; }
    stat.fetched += 1;
    const doc = {
      source_id: row.id, url: loc, http_status: null,
      title, author: null,
      published_at: lastmod ? new Date(lastmod) : null,
      text: title,                       // разбирать нечего, кроме заголовка
      meta: { kind: src.kind, lang, from: 'sitemap-title', section: sectionOf(loc) },
      skip_reason: null,
    };
    const saved = await store.saveDocument(doc);
    stat.saved += 1;
    if (onDoc) await onDoc(doc, saved);
  }
  return stat;
}

// Основной заход по одному источнику.
// Возвращает { host, fetched, saved, skipped, robots, errors }.
async function crawlSource(src, { limit, refetch = false, onDoc } = {}) {
  const row = await store.ensureSource(src);
  const max = Math.min(limit || src.maxPages || 200, src.maxPages || 200);
  const stat = { host: src.host, fetched: 0, saved: 0, offtopic: 0, robots: 0, errors: 0, listed: 0 };

  const rules = await http.robots(src.host, src.ua);
  let entries = (await sitemapUrls(src.host, {
    ua: src.ua, delayMs: src.delayMs, seeds: src.sitemaps,
    // maxUrls — потолок на РАЗБОР карты (у форума она на 64 тысячи адресов),
    // max — потолок на сохранение за заход; это разные числа.
    hostFix: src.sitemapHostFix, limit: src.maxUrls || Math.max(20000, max),
  })).filter(({ loc }) => {
    let u;
    try { u = new URL(loc); } catch { return false; }
    if (!src.include.test(u.pathname)) return false;
    // В режиме заголовков страницу мы не открываем, но запреты источника
    // всё равно наши: адрес из запрещённого раздела не берём и в базу.
    if (!http.allowedBy(rules, u.pathname + u.search)) { stat.robots += 1; return false; }
    return true;
  });
  stat.listed = entries.length;

  const known = refetch ? new Set() : await store.knownUrls(row.id);
  entries = entries.filter((e) => !known.has(e.loc));

  if (src.mode === 'titles') {
    await crawlTitles(src, { row, entries, max, onDoc, stat });
    await store.touchSource(row.id);
    return stat;
  }

  // Страница разбирается и сохраняется СРАЗУ, а не копится в памяти.
  //
  // Раньше здесь был массив pages: сначала скачивались все страницы захода,
  // потом разбирались. При потолке в полторы тысячи адресов это полтора
  // гигабайта html в куче — 19.09.2026 steklafar.ru так и упал, «FATAL ERROR:
  // Reached heap limit», не сохранив НИ ОДНОЙ страницы за 4 минуты работы.
  // Потолок кучи тут не лечение: расход рос вместе с maxPages, а самый крупный
  // источник — 30 тысяч адресов. Инкрементальная обработка держит в памяти одну
  // страницу и заодно делает заход прерываемым: убитый на середине сбор
  // оставляет всё, что успел, а не ноль.
  const handle = async (url, body) => {
    stat.fetched += 1;
    const text = html.strip(body);
    const doc = {
      source_id: row.id, url, http_status: 200,
      title: html.title(body), author: html.author(body),
      published_at: html.published(body), text,
      meta: { kind: src.kind, lang: src.lang || 'ru',
        price: src.kind === 'parts' ? html.price(body) : undefined },
      skip_reason: (text.match(TOPIC) || []).length < TOPIC_MIN ? 'не про свет'
        : text.length < 400 ? 'слишком короткая' : null,
    };
    if (doc.skip_reason) stat.offtopic += 1;
    const saved = await store.saveDocument(doc);
    stat.saved += 1;
    if (onDoc) await onDoc(doc, saved);
  };

  if (entries.length) {
    for (const { loc: url } of entries.slice(0, max)) {
      let r;
      try { r = await http.get(url, { delayMs: src.delayMs, ua: src.ua }); }
      catch (e) { stat.errors += 1; continue; }
      if (r.skipped === 'robots') { stat.robots += 1; continue; }
      if (r.status !== 200) { stat.errors += 1; continue; }
      await handle(url, r.body);
    }
  } else if (stat.listed === 0) {
    await walk(src, max, async (url, body) => { if (!known.has(url)) await handle(url, body); });
  }

  await store.touchSource(row.id);
  return stat;
}

module.exports = { crawlSource, sitemapUrls, walk, titleFromUrl, TOPIC };
