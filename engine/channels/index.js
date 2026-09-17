// Реестр каналов. Один интерфейс на все площадки: id, configured(), send().
// Движок про каналы знает ровно это — поэтому «подключить WhatsApp» = положить
// ключи в окружение, а не править конвейер.
const telegram = require('./telegram');
const email = require('./email');
const avito = require('./avito');
const whatsapp = require('./whatsapp');
const manual = require('./manual');

const web = {
  id: 'web', title: 'Форма на сайте', inbound: true,
  configured: () => true,
  // Заявка с сайта приходит без обратного канала: отвечаем по тому контакту,
  // который человек оставил, — почтой (если это почта) или вручную.
  send: async ({ to, text, subject }) => (/@/.test(String(to || '')) ? email.send({ to, text, subject }) : manual.send()),
};

const ALL = [telegram, avito, whatsapp, email, web, manual];
const byId = Object.fromEntries(ALL.map((c) => [c.id, c]));

const get = (id) => byId[id] || manual;

async function send(channelId, args) {
  const ch = get(channelId);
  if (!ch.configured()) {
    // Не настроенный канал не «падает»: работа мастера не должна вставать из-за
    // отсутствующего ключа — текст уходит в ручной режим с честной пометкой.
    const r = await manual.send(args);
    return { ...r, fallback: 'manual', error: `канал ${ch.title} не настроен` };
  }
  return ch.send(args);
}

const status = () => ALL.map((c) => ({ id: c.id, title: c.title, configured: c.configured(), inbound: Boolean(c.inbound), verified: c.verified !== false }));

module.exports = { get, send, status, ALL, telegram, avito, whatsapp, email, web, manual };
