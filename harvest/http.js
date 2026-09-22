// Вежливый загрузчик страниц. Без зависимостей: https + zlib.
//
// Правила, которые здесь зашиты, — не формальность, а условие, при котором сбор
// вообще может работать долго:
//   * robots.txt источника читается ОДИН раз на заход и соблюдается. Запрещённый
//     путь не качаем — это и требование площадки, и способ не получить бан по IP
//     на второй день сбора;
//   * пауза между запросами к одному хосту (по умолчанию 3 с) — мы снимаем сотни
//     страниц с чужого сервера и не должны быть заметны в его нагрузке;
//   * честный User-Agent с адресом сайта: администратор источника должен понимать,
//     кто ходит, и иметь возможность попросить перестать;
//   * дисковый кэш: повторный заход не дёргает источник заново.
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Только ASCII: заголовок с кириллицей node не отправляет вовсе — падает
// «Invalid character in header content» ещё до соединения.
const UA = process.env.HARVEST_UA ||
  'Mozilla/5.0 (compatible; SashaLabBot/1.0; +https://sasha-lab.ru/baza/)';
const CACHE = process.env.HARVEST_CACHE || path.join(__dirname, '..', '.harvest-cache');
// Очередь стартов по хосту. Храним не «когда был прошлый запрос», а «когда
// РАЗРЕШЁН следующий»: слот резервируется до ухода запроса, поэтому несколько
// параллельных вызовов к одному хосту выстраиваются строго через паузу и не
// могут стартовать вместе (старая схема «сейчас − lastHit» при конкурентных
// вызовах читала одно и то же lastHit и выпускала их залпом).
// Побочно это и есть ускорение: шаг перестаёт быть max(пауза, ответ) — пока
// ждёт медленный ответ (xenonshop отвечает 4,3 с при паузе 1 с), следующий
// запрос уходит по расписанию. Частота обращений к чужому серверу прежняя.
const nextFree = new Map();    // host → timestamp, когда можно отправить следующий запрос
const robotsCache = new Map(); // host → { rules, fetchedAt }
// Штраф за 429/503: пауза, которую источник ВЫПРОСИЛ сам, поверх заданной.
// Нужен потому, что замер скорости (harvest/probe.js) видит мгновенную
// нагрузку, а лимитер площадки часто накопительный: vdf-light.ru 18.09.2026
// отдавал 200 сотню страниц подряд и только потом закрыл весь /catalog/ на
// 429 — и держал его ещё 2,5 часа. Один такой ответ = удваиваем паузу этому
// хосту до конца захода, два подряд = ещё вдвое, потолок минута.
const penalty = new Map();     // host → добавочная пауза, мс
const PENALTY_MAX = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cachePath = (url) =>
  path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex').slice(0, 2),
    crypto.createHash('sha1').update(url).digest('hex') + '.html');

// Часть источников (Drive2 за DDoS-Guard) отвечает не страницей, а js-челленджем,
// если User-Agent не похож на браузер. Поэтому UA задаётся на источник.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Общие keep-alive агенты: не платим TLS-рукопожатием на каждой странице.
// Простаивающие сокеты node не держат процесс живым (unref в пуле).
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 4 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 4 }),
};

function raw(url, { redirects = 5, timeout = 20000, ua = UA, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      // Порт из адреса обязателен: без него node молча берёт 80/443, и запрос
      // к «http://127.0.0.1:41234/» уходит на чужой сервер, отвечающий по 80.
      // Живым источникам это не мешало (все они на 443), а тест загрузчика
      // поднимает свой сервер на случайном порту — и ловил чужой ответ.
      host: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET',
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      agent: agents[u.protocol] || agents['https:'],
      timeout,
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(raw(new URL(res.headers.location, url).toString(),
          { redirects: redirects - 1, timeout, ua, maxBytes }));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        // 4 МБ хватит любой статье, но не карте сайта: у форума с 60 тысячами тем
        // один кусок sitemap весит 7 МБ, и на обрыве мы получали не «большой файл»,
        // а ошибку соединения. Потолок задаётся вызовом (см. crawl.js → sitemapUrls).
        if (size > maxBytes) { req.destroy(new Error(`ответ больше ${Math.round(maxBytes / 1048576)} МБ`)); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '');
        try {
          if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
          else if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
        } catch { /* пришло без сжатия вопреки заголовку */ }
        resolve({ status: code, body: buf.toString('utf8'), type: String(res.headers['content-type'] || ''), headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('таймаут')));
    req.on('error', reject);
    req.end();
  });
}

// ── robots.txt ─────────────────────────────────────────────────────────────
// Разбор минимальный, но честный: секция для нашего UA, иначе «*»;
// Disallow/Allow по префиксу, самое длинное правило выигрывает (как у поисковиков).
async function robots(host, ua = UA) {
  if (robotsCache.has(host)) return robotsCache.get(host);
  let rules = { allow: [], disallow: [], delay: 0, text: '' };
  try {
    const r = await raw(`https://${host}/robots.txt`, { timeout: 10000, ua });
    if (r.status === 200) rules = parseRobots(r.body);
  } catch { /* нет robots.txt — считаем, что запретов нет */ }
  robotsCache.set(host, rules);
  return rules;
}

function parseRobots(text) {
  const out = { allow: [], disallow: [], delay: 0, text: text.slice(0, 4000) };
  let applies = false;
  for (const line of text.split(/\r?\n/)) {
    const s = line.replace(/#.*/, '').trim();
    if (!s) continue;
    const [k, ...rest] = s.split(':');
    const key = k.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') {
      applies = val === '*' || /sashalab/i.test(val);
      continue;
    }
    if (!applies) continue;
    if (key === 'disallow' && val) out.disallow.push(val);
    if (key === 'allow' && val) out.allow.push(val);
    if (key === 'crawl-delay') out.delay = Math.min(30, Number(val) || 0) * 1000;
  }
  return out;
}

// Правило robots — это НЕ префикс: «Disallow: /*?sort=» запрещает не всё, что
// начинается с «/», а адреса с «?sort=» внутри. Первая версия резала звёздочку
// вместе с хвостом и получала префикс «/» — под запрет попадал весь сайт, включая
// sitemap.xml (проверено на legal-xenon.ru). Поэтому шаблон разворачивается
// в регулярку: * → любой кусок, $ на конце — конец адреса.
function toRe(pattern) {
  const end = pattern.endsWith('$');
  const body = (end ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${body}${end ? '$' : ''}`);
}

function allowedBy(rules, pathname) {
  // Побеждает самое длинное (самое конкретное) правило — так же считают Яндекс и Google.
  const match = (list) => list
    .filter((p) => toRe(p).test(pathname))
    .reduce((m, p) => Math.max(m, p.length), -1);
  return match(rules.allow) >= match(rules.disallow);
}

// ── публичный вызов ────────────────────────────────────────────────────────
// Возвращает { url, status, body, fromCache, skipped }.
// skipped='robots' — источник запретил этот путь, это не ошибка.
async function get(url, { delayMs = 3000, useCache = true, maxAgeDays = 30, ua = UA,
  maxBytes = 4 * 1024 * 1024 } = {}) {
  const u = new URL(url);
  const file = cachePath(url);
  if (useCache && fs.existsSync(file)) {
    const age = (Date.now() - fs.statSync(file).mtimeMs) / 86400000;
    if (age < maxAgeDays) return { url, status: 200, body: fs.readFileSync(file, 'utf8'), fromCache: true };
  }

  const rules = await robots(u.hostname, ua);
  // Правила вида «Disallow: /*?sort=» смотрят и на строку запроса, поэтому
  // проверяем путь вместе с ней.
  if (!allowedBy(rules, u.pathname + u.search)) return { url, status: 0, body: '', skipped: 'robots' };

  const pause = Math.max(delayMs, rules.delay, penalty.get(u.hostname) || 0);
  const slot = Math.max(Date.now(), nextFree.get(u.hostname) || 0);
  nextFree.set(u.hostname, slot + pause);
  const wait = slot - Date.now();
  if (wait > 0) await sleep(wait);

  const r = await raw(url, { ua, maxBytes });
  // «Слишком часто» / «мне сейчас тяжело» — единственный ответ источника, который
  // мы обязаны не просто записать в ошибки, а исполнить: дальше ходим реже.
  if (r.status === 429 || r.status === 503) {
    const next = Math.min(PENALTY_MAX, Math.max(pause * 2, (penalty.get(u.hostname) || 0) * 2));
    if (next > (penalty.get(u.hostname) || 0)) {
      penalty.set(u.hostname, next);
      // Штраф касается и уже зарезервированных слотов: иначе очередь из
      // нескольких параллельных запросов добьёт хост старой частотой.
      nextFree.set(u.hostname, Math.max(nextFree.get(u.hostname) || 0, Date.now() + next));
      console.warn(`  ⚠ ${u.hostname} ответил ${r.status} — пауза поднята до ${next} мс до конца захода`);
    }
    // Retry-After площадка присылает не всегда, но если прислала — слушаемся её,
    // а не своей арифметики.
    const ra = Number(String(r.headers?.['retry-after'] || '').trim());
    if (ra > 0) await sleep(Math.min(PENALTY_MAX * 5, ra * 1000));
  }
  if (r.status === 200 && /html|text/.test(r.type)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, r.body);
  }
  return { url, status: r.status, body: r.body, type: r.type, fromCache: false };
}

module.exports = { get, raw, robots, allowedBy, parseRobots, UA, BROWSER_UA, CACHE, penalty, nextFree };
