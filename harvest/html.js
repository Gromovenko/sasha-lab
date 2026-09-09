// HTML → текст, заголовок, дата, ссылки. Регулярками, без парсера в зависимостях:
// нам нужен не точный DOM, а связный текст для разбора фактов и список ссылок.
const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', laquo: '«', raquo: '»',
  mdash: '—', ndash: '–', hellip: '…', deg: '°', times: '×', rsquo: '’', apos: "'",
};

function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function strip(html) {
  return decode(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // блочные теги превращаем в перевод строки: иначе абзацы слипаются в кашу
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

const meta = (html, name) => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
  const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i');
  const m = html.match(re) || html.match(alt);
  return m ? decode(m[1]).trim() : null;
};

function title(html) {
  const og = meta(html, 'og:title');
  if (og) return og;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return strip(h1[1]).slice(0, 300);
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? decode(t[1]).trim().slice(0, 300) : null;
}

function published(html) {
  const raw = meta(html, 'article:published_time') || meta(html, 'datePublished')
    || (html.match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1]
    || (html.match(/"datePublished"\s*:\s*"([^"]+)"/) || [])[1];
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function author(html) {
  return meta(html, 'author') || (html.match(/"author"\s*:\s*{[^}]*"name"\s*:\s*"([^"]+)"/) || [])[1] || null;
}

// Ссылки в пределах хоста (или разрешённых хостов), уже абсолютные и без якорей.
function links(html, baseUrl, { sameHost = true, hosts = [] } = {}) {
  const base = new URL(baseUrl);
  const out = new Set();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    let u;
    try { u = new URL(decode(m[1]), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (sameHost && u.hostname !== base.hostname && !hosts.includes(u.hostname)) continue;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|avi)$/i.test(u.pathname)) continue;
    u.hash = '';
    out.add(u.toString());
  }
  return [...out];
}

// Цена рублями со страницы товара: сперва разметка, потом текст.
function price(html) {
  const micro = (html.match(/itemprop=["']price["'][^>]*content=["']([\d.]+)["']/i)
    || html.match(/"price"\s*:\s*"?(\d[\d\s.]*)"?/i) || [])[1];
  if (micro) return Math.round(Number(String(micro).replace(/\s/g, '')));
  const t = strip(html);
  const m = t.match(/(\d[\d\s]{2,8})\s*(?:₽|руб)/i);
  return m ? Number(m[1].replace(/\s/g, '')) : null;
}

module.exports = { strip, title, published, author, links, meta, decode, price };
