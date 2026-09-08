// Статик-сервер для зеркала sasha-lab.ru. Без зависимостей.
// Страницы лежат в mirror/sasha-lab.ru, ассеты — в mirror/cdn и mirror/stub.
const http = require('http');
const fs = require('fs');
const path = require('path');

const admin = require('./seo/admin');

const ROOT = path.join(__dirname, 'mirror');
const PAGES = path.join(ROOT, 'sasha-lab.ru');
const DIST = path.join(__dirname, 'dist');   // база знаний, собирается content/build.js
const PORT = Number(process.env.PORT || 3060);
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.avif': 'image/avif',
};

function resolve(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p += 'index.html';
  // ассеты берём от корня зеркала, страницы — из каталога сайта
  // /baza и sitemap базы знаний — из dist, ассеты — от корня зеркала, остальное — страницы сайта
  const base = (p.startsWith('/baza/') || p.startsWith('/sitemap-baza')) ? DIST
    : (p.startsWith('/cdn/') || p.startsWith('/stub/')) ? ROOT : PAGES;
  const file = path.normalize(path.join(base, p));
  if (!file.startsWith(base)) return null;            // защита от выхода за корень
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  if (!path.extname(file) && fs.existsSync(file + '.html')) return file + '.html';
  return fallbackOptim(p);
}

// Тильда собирает адреса картинок на лету: static.tildacdn.com/<tildXXXX>/file.png
// превращается в optim.tildacdn.com/<tildXXXX>/-/cover/284x358/.../format/webp/file.png.webp,
// причём размеры зависят от вьюпорта — заранее скачать ВСЕ варианты нельзя.
// Отдаём исходник из static.tildacdn.com (обрезку и размер задаёт CSS блока).
function fallbackOptim(p) {
  const m = p.match(/^\/cdn\/(?:optim|static\d*)\.tildacdn\.[a-z]+\/(tild[^/]+)\/(?:.*\/)?([^/]+)$/);
  if (!m) return null;
  const file = path.join(ROOT, 'cdn', 'static.tildacdn.com', m[1], m[2].replace(/\.webp$/, ''));
  if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  return null;
}

http.createServer(async (req, res) => {
  if (await admin.handle(req, res)) return;

  // Это ЗЕРКАЛО живого сайта клиента. Индексировать его нельзя ни при каких
  // условиях: копия конкурирует с оригиналом за те же запросы и в лучшем случае
  // будет склеена, в худшем — утопит sasha-lab.ru как дубль. Отсюда robots.txt
  // и заголовок на каждый ответ.
  if (req.url.split('?')[0] === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' });
    return res.end('User-agent: *\nDisallow: /\n');
  }

  const file = resolve(req.url);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' });
    return res.end('404: в зеркале sasha-lab.ru такой страницы нет');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, HOST, () => console.log(`sasha-lab mirror on http://${HOST}:${PORT}`));
