// Телеграм: приём сообщений и фото + отправка ответа. Длинным опросом
// (getUpdates), а не вебхуком — так канал поднимается без публичного адреса и
// сертификата и переживает переезд сервера. Токен — TELEGRAM_BOT_TOKEN.
const files = require('../files');

const API = (m) => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${m}`;
const FILE = (p) => `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${p}`;

const id = 'telegram';
const title = 'Телеграм';
const configured = () => Boolean(process.env.TELEGRAM_BOT_TOKEN);

async function call(method, body) {
  const res = await fetch(API(method), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.TELEGRAM_TIMEOUT_MS || 65000)),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(`telegram ${method}: ${j.description || res.status}`);
  return j.result;
}

async function send({ to, text }) {
  if (!configured()) return { ok: false, error: 'нет TELEGRAM_BOT_TOKEN' };
  try {
    const r = await call('sendMessage', { chat_id: to, text, disable_web_page_preview: true });
    return { ok: true, id: String(r.message_id) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Скачивание фото: телеграм отдаёт несколько размеров, берём самый большой —
// зрению нужны детали (посадочное место за фарой видно только на крупном кадре).
async function download(dealId, photoSizes) {
  const best = [...photoSizes].sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
  const f = await call('getFile', { file_id: best.file_id });
  const res = await fetch(FILE(f.file_path), { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`telegram file: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return files.save(dealId, f.file_path.split('/').pop(), buf);
}

const getUpdates = (offset) => call('getUpdates', { offset, timeout: Number(process.env.TELEGRAM_POLL_SEC || 50), allowed_updates: ['message'] });

module.exports = { id, title, configured, send, download, getUpdates, call, inbound: true };
