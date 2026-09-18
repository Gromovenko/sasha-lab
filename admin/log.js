// Единый журнал. Одна дверь для всех контуров: вход в панель, действие мастера,
// прогон сбора, ошибка канала — всё ложится в app_events и видно на /admin/log.
//
// Два правила, ради которых модуль вообще существует:
//   1. Журналирование НИКОГДА не роняет вызывающего. Упавшая запись события —
//      это строка в stderr, а не пятисотка клиенту и не оборванная отправка.
//   2. Всё дублируется в stdout процесса. Базы может не быть (dev-копия на EU),
//      а событие «кто-то подобрал пароль» обязано остаться хотя бы в pm2-логах.
const defaultStore = require('./store');

const LEVELS = ['debug', 'info', 'warn', 'error', 'security'];
const MIRROR = () => (process.env.ADMIN_LOG_CONSOLE || '1') !== '0';

// Ip и агент — из запроса, одинаково для всех панелей. За nginx реальный адрес
// приезжает в X-Forwarded-For, иначе в журнале будет 127.0.0.1 у всех подряд.
function web(req) {
  if (!req) return {};
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return { ip: xff || req.socket?.remoteAddress || null, ua: req.headers?.['user-agent'] || null };
}

async function event(e, { store = defaultStore } = {}) {
  const row = { ...e, level: LEVELS.includes(e.level) ? e.level : 'info' };
  if (MIRROR()) {
    const line = [new Date().toISOString(), `[${row.level}]`, row.area || 'app', row.action,
      row.actor ? `(${row.actor})` : '', row.entity ? `${row.entity}:${row.entityId ?? ''}` : '',
      row.message || ''].filter(Boolean).join(' ');
    (row.level === 'error' ? console.error : console.log)(line);
  }
  try {
    await store.events.add(row);
  } catch (err) {
    console.error('журнал недоступен:', err.message);
  }
  return row;
}

// Сахар под частые случаи — чтобы в коде вызовов было видно намерение.
const info = (e, o) => event({ ...e, level: 'info' }, o);
const warn = (e, o) => event({ ...e, level: 'warn' }, o);
const error = (e, o) => event({ ...e, level: 'error' }, o);
// security — вход, выход, смена пароля, блокировка: то, что смотрят после
// инцидента. Отдельный уровень, чтобы не искать это среди «пересчитал смету».
const security = (e, o) => event({ ...e, level: 'security' }, o);

// Обёртка вокруг работы: успех и падение попадают в журнал с длительностью.
// Ошибка пробрасывается дальше — журнал не проглатывает исключения.
async function around({ area, action, actor = null, entity = null, entityId = null, meta = {} }, fn, opts) {
  const t0 = Date.now();
  try {
    const r = await fn();
    await info({ area, action, actor, entity, entityId, meta: { ...meta, ms: Date.now() - t0, ok: true } }, opts);
    return r;
  } catch (e) {
    await error({ area, action, actor, entity, entityId, message: e.message, meta: { ...meta, ms: Date.now() - t0, ok: false } }, opts);
    throw e;
  }
}

const list = (filter, { store = defaultStore } = {}) => store.events.list(filter);
const stats = (hours, { store = defaultStore } = {}) => store.events.stats(hours);

module.exports = { event, info, warn, error, security, around, web, list, stats, LEVELS };
