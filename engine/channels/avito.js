// Авито-мессенджер. Там живёт основной поток обращений у сервисов «в гараже»,
// и там же беда с ответом «сразу» — у крупных конкурентов сидит админ.
//
// Ключи: AVITO_CLIENT_ID, AVITO_CLIENT_SECRET, AVITO_USER_ID (профиль).
// Код написан по документации api.avito.ru и на живых ключах НЕ проверялся —
// пока их нет, канал сам говорит «не настроен», а ответ уходит через ручной
// канал (мастер копирует готовый текст кнопкой в панели). Именно поэтому
// интерфейс канала один на всех: подключение ключей ничего в движке не меняет.
const files = require('../files');

const id = 'avito';
const title = 'Авито';
const configured = () => Boolean(process.env.AVITO_CLIENT_ID && process.env.AVITO_CLIENT_SECRET && process.env.AVITO_USER_ID);

let token = { value: null, exp: 0 };

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
  if (!res.ok || !j.access_token) throw new Error(`avito token: ${res.status} ${j.error_description || ''}`.trim());
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
  if (!res.ok) throw new Error(`avito ${path}: ${res.status} ${j.error?.message || ''}`.trim());
  return j;
}

async function send({ to, text }) {
  if (!configured()) return { ok: false, error: 'нет ключей Авито (AVITO_CLIENT_ID/SECRET/USER_ID)' };
  try {
    const r = await api(`/messenger/v1/accounts/${process.env.AVITO_USER_ID}/chats/${to}/messages`,
      { method: 'POST', body: { message: { text }, type: 'text' } });
    return { ok: true, id: r.id ? String(r.id) : null };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Непрочитанные чаты — вход для опроса в worker.js.
async function unread() {
  if (!configured()) return [];
  const r = await api(`/messenger/v2/accounts/${process.env.AVITO_USER_ID}/chats?unread_only=true&limit=50`);
  return r.chats || [];
}

async function messages(chatId) {
  const r = await api(`/messenger/v3/accounts/${process.env.AVITO_USER_ID}/chats/${chatId}/messages/?limit=30`);
  return r.messages || [];
}

// Картинку из чата забираем по прямой ссылке: она уже подписана токеном чата.
async function download(dealId, url, name = 'avito.jpg') {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`avito image: ${res.status}`);
  return files.save(dealId, name, Buffer.from(await res.arrayBuffer()));
}

module.exports = { id, title, configured, send, unread, messages, download, api, inbound: true, verified: false };
