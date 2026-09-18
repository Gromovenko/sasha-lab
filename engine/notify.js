// Уведомление админа проекта: «в Авито написали, вот что мы ответили».
//
// Смысл ровно один: автодиалог отвечает клиенту сам, но человек обязан ЗНАТЬ,
// что происходит от его имени, и успеть вмешаться. Поэтому уведомление идёт
// не «в канал», а по лестнице доступности:
//     телеграм (MASTER_CHAT_ID) → СМС на ADMIN_PHONE → WhatsApp на ADMIN_PHONE
// Первый сработавший останавливает перебор; не сработало ничего — строка в
// журнале службы (её видно в `pm2 logs sasha-lab-engine`), а не тишина.
//
// СМС платная и короткая, поэтому у каждого события два текста: длинный для
// мессенджера и короткий (`sms`) — для телефона.
const channels = require('./channels');

const ADMIN_PHONE = () => process.env.ADMIN_PHONE || '';
const MASTER = () => process.env.MASTER_CHAT_ID || '';
const SITE = () => process.env.CRM_URL || 'http://127.0.0.1:3060';
const ROUTES = () => (process.env.ADMIN_NOTIFY || 'telegram,sms,whatsapp').split(',').map((s) => s.trim()).filter(Boolean);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Защита от «звонка на каждое слово»: клиент в мессенджере часто пишет
// очередью из пяти коротких реплик — это одно событие, а не пять уведомлений.
const last = new Map();
const QUIET_MS = () => Number(process.env.ADMIN_NOTIFY_QUIET_MS || 10 * 60 * 1000);

function throttled(key, now = Date.now()) {
  if (!key) return false;
  const t = last.get(key);
  if (t && now - t < QUIET_MS()) return true;
  last.set(key, now);
  if (last.size > 500) for (const [k, v] of last) { if (now - v > QUIET_MS()) last.delete(k); }
  return false;
}

// text — полный, sms — короткий; key — ключ подавления повторов (обычно id сделки).
async function admin({ text, sms = null, key = null, force = false }) {
  const short = (sms || text).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!force && throttled(key)) return { ok: true, via: 'throttled', tried: [] };
  const tried = [];
  for (const route of ROUTES()) {
    const ch = channels.get(route);
    const to = route === 'telegram' ? MASTER() : ADMIN_PHONE();
    if (!to || !ch.configured()) { tried.push(`${route}: ${!to ? 'нет адреса' : 'нет ключей'}`); continue; }
    const r = await ch.send({ to, text: route === 'telegram' ? text : short, subject: 'Новое обращение' });
    if (r.ok && !r.manual) { log(`админ уведомлён через ${route}`); return { ok: true, via: route, tried }; }
    tried.push(`${route}: ${r.error || 'не ушло'}`);
  }
  log(`админ НЕ уведомлён (${tried.join('; ') || 'маршрутов нет'}):\n${short}`);
  return { ok: false, via: null, tried };
}

// Событие «пришло обращение и вот готовый/отправленный ответ».
function dealText(deal, draft, { sent = null, channelTitle = null } = {}) {
  const who = [deal.client_name, deal.client_contact].filter(Boolean).join(' · ') || deal.id;
  const head = `📥 ${channelTitle || channels.get(deal.channel).title}: ${who}`;
  const state = sent == null ? 'ответ готов, ждёт вас'
    : sent.ok && !sent.manual ? '✅ ответ клиенту УЖЕ отправлен автоматически'
    : `⚠️ автоответ не ушёл: ${sent.error || 'канал не настроен'} — ответьте сами`;
  const body = draft ? draft.text : 'ответ ещё не собран';
  const text = `${head}\n${state}\n\n${body}\n\nКарточка: ${SITE()}/crm/d?id=${deal.id}`;
  const money = deal.total_rub ? `, ${Math.round(deal.total_rub)} р` : '';
  const smsText = `${channelTitle || channels.get(deal.channel).title}: ${who}${money}. ${sent?.ok && !sent.manual ? 'Автоответ отправлен' : 'Нужен ваш ответ'}. ${SITE()}/crm`;
  return { text, sms: smsText };
}

const deal = (d, draft, opts = {}) => admin({ ...dealText(d, draft, opts), key: d.id, ...opts });

module.exports = { admin, deal, dealText, throttled, ADMIN_PHONE, ROUTES };
