// Общая оболочка закрытых разделов: один стиль на /admin и /cabinet.
// Вынесена отдельно, потому что панелей у проекта уже четыре (seo, crm, admin,
// кабинет), и разъезжающаяся вёрстка в них — это лишние правки на каждый экран.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `*{box-sizing:border-box}
body{margin:0;background:#131313;color:#ededed;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:18px 16px 70px}
h1{font-size:23px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}
.sub{color:#9a9a9a;margin:0 0 16px;font-size:14px}
a{color:#78a0ec}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px;padding:0 0 14px;border-bottom:1px solid #242424}
nav a{display:inline-block;padding:6px 12px;border-radius:8px;background:#1a1a1a;border:1px solid #2b2b2b;text-decoration:none;color:#ededed;font-size:14px}
nav a.on{background:#78a0ec;color:#0f0f0f;font-weight:600;border-color:#78a0ec}
nav .who{margin-left:auto;color:#9a9a9a;font-size:13px;align-self:center}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 14px}
.tile{background:#1a1a1a;border:1px solid #2b2b2b;border-radius:10px;padding:12px 16px;min-width:110px;flex:1}
.tile b{display:block;font-size:25px;font-weight:600}.tile span{color:#9a9a9a;font-size:12px}
.tile.warn b{color:#f0c07a}.tile.bad b{color:#e08080}.tile.good b{color:#8ad79a}
.card{background:#1a1a1a;border:1px solid #2b2b2b;border-radius:12px;padding:14px;margin:0 0 12px}
.card .who{color:#9a9a9a;font-size:13px;margin:0 0 6px}
.badge{display:inline-block;background:#232323;border-radius:6px;padding:2px 8px;font-size:12px;color:#c9c9c9;margin:0 6px 4px 0}
.badge.hot{background:#48331f;color:#f0c07a}.badge.ok{background:#1f3a24;color:#8ad79a}.badge.bad{background:#3a1f1f;color:#e08080}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 8px;border-bottom:1px solid #222;vertical-align:top}
th{color:#9a9a9a;font-weight:500}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
input,select,textarea,button{font:inherit;padding:10px 13px;border-radius:9px;border:1px solid #2b2b2b;background:#1a1a1a;color:#ededed}
input,select,textarea{width:100%}
textarea{min-height:120px;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
button{background:#78a0ec;color:#0f0f0f;font-weight:700;border:0;cursor:pointer}
button.ghost{background:#232323;color:#ededed;font-weight:500}
button.small{padding:6px 10px;font-size:13px}
label{display:block;margin:0 0 12px;color:#9a9a9a;font-size:13px}
form.auth{max-width:340px;margin:10vh auto}
form.inline{display:inline}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.err{color:#e08080}.ok{color:#8ad79a}.muted{color:#9a9a9a}
.msg{border-left:3px solid #2b2b2b;padding:2px 0 2px 10px;margin:0 0 12px;white-space:pre-wrap;font-size:14px}
.msg.out{border-color:#78a0ec}.msg .t{color:#9a9a9a;font-size:12px;white-space:normal}
.log{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.log .lv{padding:1px 6px;border-radius:5px;background:#232323}
.log .lv.error{background:#3a1f1f;color:#e08080}.log .lv.warn{background:#48331f;color:#f0c07a}
.log .lv.security{background:#1f2a3a;color:#8ab4e0}`;

const page = (title, body, { css = '' } = {}) => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${CSS}${css}</style></head><body><div class="wrap">${body}</div></body></html>`;

const ADMIN_NAV = [
  ['/admin/', 'Сводка'], ['/admin/deals', 'Заявки'], ['/admin/clients', 'Клиенты'],
  ['/admin/questions', 'Вопросы'], ['/admin/knowledge', 'Знания и спрос'],
  ['/admin/parsers', 'Парсеры'], ['/admin/users', 'Доступы'], ['/admin/log', 'Журнал'], ['/admin/services', 'Службы'],
];
const CABINET_NAV = [['/cabinet/', 'Мои заявки'], ['/cabinet/profile', 'Профиль']];

function nav(items, active, user, { logout = '/admin/logout' } = {}) {
  const links = items.map(([href, label]) =>
    `<a href="${esc(href)}"${href === active || (href !== '/admin/' && href !== '/cabinet/' && active.startsWith(href)) ? ' class="on"' : ''}>${esc(label)}</a>`).join('');
  const who = user ? `<span class="who">${esc(user.name || user.email || user.phone)} · <a href="${esc(logout)}">выйти</a></span>` : '';
  return `<nav>${links}${who}</nav>`;
}

const tiles = (rows) => `<div class="tiles">${rows
  .map(([label, value, cls]) => `<div class="tile ${cls || ''}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('')}</div>`;

const MSK = { timeZone: 'Europe/Moscow' };
const when = (t) => (t ? new Date(t).toLocaleString('ru-RU', { ...MSK, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
function ago(t) {
  if (!t) return '—';
  const min = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

module.exports = { esc, page, nav, tiles, when, ago, ADMIN_NAV, CABINET_NAV, CSS };
