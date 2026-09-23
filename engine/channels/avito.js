// Авито-мессенджер. Там живёт основной поток обращений у сервисов «в гараже»,
// и там же беда с ответом «сразу» — у крупных конкурентов сидит админ.
//
// Ключи (личный кабинет Авито → Настройки → API, developers.avito.ru):
//   AVITO_CLIENT_ID, AVITO_CLIENT_SECRET — обязательны;
//   AVITO_USER_ID — необязателен: если не задан, берём из /core/v1/accounts/self.
// ЛОГИН И ПАРОЛЬ ОТ КАБИНЕТА ЗДЕСЬ НЕ РАБОТАЮТ: у /token единственный способ —
// client_credentials с ключами приложения, пара «телефон/пароль» отвечает
// unauthorized_client (проверено 18.09.2026 на живом эндпоинте с RU).
//
// Про адреса: 18.09.2026 api.avito.ru с EU не отвечал вовсе (таймаут), поэтому
// правилом было «в Авито ходим только с RU». Перепроверено 23.09.2026: с EU
// (130.17.14.158) /token отвечает 200 за ~0,3 с, /core/v1/accounts/self без
// токена — 401, то есть API доступно и оттуда. Место запуска всё равно держим
// на сервере проекта — там лежат ключи.
//
// А вот ВЕБ Авито (www/m.avito.ru) закрыт со всех наших серверов: любая страница
// листинга/карточки — 429 «Доступ ограничен: проблема с IP» (тело 28 368 байт,
// одинаковое с EU, RU и sasha-lab; проверено 23.09.2026, headless-Chrome тоже).
// Это бан подсетей ЦОД, не антибот по поведению: аккаунт и паузы его не снимают.
// Живым остаётся только /sitemap/index.xml (200) — но страницы по его адресам
// всё те же 429. Веб-парсер возможен лишь через резидентный прокси РФ.
const files = require('../files');

const id = 'avito';
const title = 'Авито';
const configured = () => Boolean(process.env.AVITO_CLIENT_ID && process.env.AVITO_CLIENT_SECRET);

let token = { value: null, exp: 0 };
let selfId = null;

async function auth() {
  if (token.value && Date.now() < token.exp) return token.value;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.AVITO_CLIENT_ID,
    client_secret: process.env.AVITO_CLIENT_SECRET,
  });
  const res = await fetch('https://api.avito.ru/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  // Авито отвечает 200 и телом с ошибкой — на статус полагаться нельзя.
  if (!j.access_token) throw new Error(`avito token: ${res.status} ${j.error_description || j.error || ''}`.trim());
  token = { value: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000 };
  return token.value;
}

async function api(path, { method = 'GET', body } = {}) {
  const t = await auth();
  const res = await fetch(`https://api.avito.ru${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`avito ${path}: ${res.status} ${j.error?.message || j.error_description || ''}`.trim());
  return j;
}

// Профиль. Отдельная ручка нужна не ради красоты: без user_id не собрать ни
// один адрес мессенджера, а требовать его руками — лишний повод ошибиться.
async function self() {
  const r = await api('/core/v1/accounts/self');
  selfId = String(r.id);
  return r;
}

async function userId() {
  if (process.env.AVITO_USER_ID) return String(process.env.AVITO_USER_ID);
  if (selfId) return selfId;
  await self();
  return selfId;
}

async function send({ to, text }) {
  if (!configured()) return { ok: false, error: 'нет ключей Авито (AVITO_CLIENT_ID/AVITO_CLIENT_SECRET)' };
  try {
    const uid = await userId();
    const r = await api(`/messenger/v1/accounts/${uid}/chats/${to}/messages`,
      { method: 'POST', body: { message: { text }, type: 'text' } });
    return { ok: true, id: r.id ? String(r.id) : null };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Список чатов постранично. unreadOnly — вход для опроса в worker.js,
// без него — полный обход переписки для разбора (`avito-dialogs.js`).
async function chats({ unreadOnly = false, limit = 100, offset = 0 } = {}) {
  const uid = await userId();
  const qs = new URLSearchParams({ limit: String(Math.min(limit, 100)), offset: String(offset) });
  if (unreadOnly) qs.set('unread_only', 'true');
  const r = await api(`/messenger/v2/accounts/${uid}/chats?${qs}`);
  return r.chats || [];
}

// Все чаты, сколько бы их ни было: Авито отдаёт максимум 100 за раз.
async function allChats({ max = 1000, unreadOnly = false, onPage = null } = {}) {
  const out = [];
  for (let offset = 0; out.length < max; offset += 100) {
    const page = await chats({ unreadOnly, limit: 100, offset });
    out.push(...page);
    if (onPage) await onPage(page, out.length);
    if (page.length < 100) break;
  }
  return out.slice(0, max);
}

const unread = async () => (configured() ? chats({ unreadOnly: true, limit: 100 }) : []);

async function messages(chatId, { limit = 100, offset = 0 } = {}) {
  const uid = await userId();
  const r = await api(`/messenger/v3/accounts/${uid}/chats/${chatId}/messages/?limit=${Math.min(limit, 100)}&offset=${offset}`);
  return Array.isArray(r) ? r : (r.messages || []);
}

// Отмечаем чат прочитанным ТОЛЬКО после того, как сообщение разобрано и ответ
// отправлен: иначе сбой в середине проглотит обращение навсегда.
async function markRead(chatId) {
  const uid = await userId();
  try { await api(`/messenger/v1/accounts/${uid}/chats/${chatId}/read`, { method: 'POST' }); return true; }
  catch { return false; }
}

// Ссылка на картинку из сообщения: у Авито размеры лежат словарём, берём самый
// большой — зрению нужны детали (посадочное место за фарой видно только крупно).
function imageUrl(msg) {
  const sizes = msg?.content?.image?.sizes;
  if (!sizes || typeof sizes !== 'object') return null;
  const byWidth = Object.entries(sizes).sort((a, b) => (Number.parseInt(b[0], 10) || 0) - (Number.parseInt(a[0], 10) || 0));
  return byWidth[0]?.[1] || null;
}

// Текст любого сообщения одной строкой — для разбора и для отчёта по диалогам.
function messageText(msg) {
  const c = msg?.content || {};
  if (c.text) return String(c.text);
  if (c.item?.title) return `[объявление] ${c.item.title}`;
  if (c.call) return '[звонок]';
  if (c.image) return '[фото]';
  if (c.location?.title) return `[адрес] ${c.location.title}`;
  if (c.link?.url) return `[ссылка] ${c.link.url}`;
  return msg?.type ? `[${msg.type}]` : '';
}

// Картинку из чата забираем по прямой ссылке: она уже подписана токеном чата.
async function download(dealId, url, name = 'avito.jpg') {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`avito image: ${res.status}`);
  return files.save(dealId, name, Buffer.from(await res.arrayBuffer()));
}

module.exports = {
  id, title, configured, send, unread, chats, allChats, messages, markRead,
  download, api, self, userId, imageUrl, messageText, inbound: true, verified: false,
};
