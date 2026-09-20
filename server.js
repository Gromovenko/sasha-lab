// Веб-сервер sasha-lab.ru: страницы сайта, база знаний, /admin, /cabinet, /crm. Без зависимостей.
// Страницы лежат в mirror/sasha-lab.ru, ассеты — в mirror/cdn и mirror/stub.
const http = require('http');
const fs = require('fs');
const path = require('path');

// Доступы SEO-модуля лежат в seo/.env (в git его нет). pm2 такие файлы сам не
// читает, поэтому подхватываем до подключения панели — иначе она поднимется
// без пароля и просто скажет «выключена».
require('./server-env')(path.join(__dirname, 'seo', '.env'));

// Раздел /admin и кабинет клиента /cabinet: люди, доступы, журнал, сводка по
// всем контурам. Стоит первым — его сессия служит дверью и для /crm, и для /seo.
const adminSection = require('./admin/http');
const admin = require('./seo/admin');
const questions = require('./seo/questions');
const assistant = require('./seo/assistant-http');
// Панель мастера и приём заявок (/crm, /zayavka, /api/lead) — тот же процесс:
// отдельный веб-сервер ради двух экранов плодить незачем, фоновая работа
// движка вынесена в engine/worker.js.
const crm = require('./engine/crm');

const ROOT = path.join(__dirname, 'mirror');
const PAGES = path.join(ROOT, 'sasha-lab.ru');
const DIST = path.join(__dirname, 'dist');   // база знаний, собирается content/build.js
const PORT = Number(process.env.PORT || 3060);
const HOST = process.env.HOST || '127.0.0.1';
const SITE = process.env.SITE_ORIGIN || 'https://sasha-lab.ru';
const NOINDEX_ALL = process.env.SITE_NOINDEX === '1';
const PRIVATE = ['/admin', '/cabinet', '/crm', '/seo', '/api'];

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
  // Админка и кабинет клиента.
  if (await adminSection.handle(req, res)) return;

  if (await admin.handle(req, res)) return;

  // Заявки: панель мастера, публичная форма и ручка приёма.
  if (await crm.handle(req, res)) return;

  // Ассистент базы знаний: страница «Помощник», ручка вопроса и подбор по машине.
  if (await assistant.handle(req, res)) return;

  // Приём вопроса с формы базы знаний.
  if (req.method === 'POST' && req.url.split('?')[0] === '/baza/ask') {
    return questions.handleAsk(req, res);
  }

  // Публичный сайт индексируется; закрыты только служебные разделы.
  // SITE_NOINDEX=1 возвращает полное закрытие (тестовый контур).
  const urlPath = req.url.split('?')[0];
  const priv = NOINDEX_ALL || PRIVATE.some(x => urlPath === x || urlPath.startsWith(x + '/'));
  const robotsHdr = priv ? { 'X-Robots-Tag': 'noindex, nofollow' } : {};
  if (urlPath === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...robotsHdr });
    return res.end(NOINDEX_ALL ? 'User-agent: *\nDisallow: /\n'
      : `User-agent: *\n${PRIVATE.map(x => 'Disallow: ' + x + '/').join('\n')}\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\nSitemap: ${SITE}/sitemap-baza.xml\n`);
  }
  if (urlPath === '/sitemap.xml') {
    const now = new Date().toISOString().slice(0, 10);
    const pages = ['/', '/fara', '/remont-far', '/ustanovka-linz', '/privacypolicy']
      .map(u => `<url><loc>${SITE}${u}</loc><lastmod>${now}</lastmod></url>`).join('');
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages}</urlset>`);
  }

  const file = resolve(req.url);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...robotsHdr });
    return res.end('404: страница не найдена');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    ...robotsHdr,
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, HOST, () => console.log(`sasha-lab on http://${HOST}:${PORT}`));
