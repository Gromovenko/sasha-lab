// Статик-сервер для зеркала sasha-lab.ru. Без зависимостей.
// Страницы лежат в mirror/sasha-lab.ru, ассеты — в mirror/cdn и mirror/stub.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'mirror');
const PAGES = path.join(ROOT, 'sasha-lab.ru');
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
  const base = (p.startsWith('/cdn/') || p.startsWith('/stub/')) ? ROOT : PAGES;
  const file = path.normalize(path.join(base, p));
  if (!file.startsWith(base)) return null;            // защита от выхода за корень
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  if (!path.extname(file) && fs.existsSync(file + '.html')) return file + '.html';
  return null;
}

http.createServer((req, res) => {
  const file = resolve(req.url);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404: в зеркале sasha-lab.ru такой страницы нет');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, HOST, () => console.log(`sasha-lab mirror on http://${HOST}:${PORT}`));
