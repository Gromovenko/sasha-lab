// Фоновая служба движка: слушает каналы, гоняет конвейер, шлёт напоминания.
//
// Почему длинный опрос, а не вебхуки: у студии нет публичного адреса под
// колбэки (сайт за DDoS-Guard, порт наружу закрыт), а опрос переживает переезд
// сервера и не требует сертификата. Нагрузка — один висящий запрос на канал.
//
// Что делает при каждом входящем: заводит/находит сделку, прогоняет конвейер и
// СРАЗУ сообщает мастеру готовый ответ в личку. Это и есть ответ на «у них
// сидят админы и отвечают сразу»: клиент получает реакцию за секунды, а мастер
// решает из гаража одним касанием, не открывая ноутбук.
const packs = require('./pack');
const pipeline = require('./pipeline');
const store = require('./store');
const channels = require('./channels');
const files = require('./files');
const notify = require('./notify');
const kv = require('../seo/lib/store').kv;

const PACK = () => process.env.PACK || packs.DEFAULT_ID;
const MASTER = () => process.env.MASTER_CHAT_ID || '';
const FOLLOWUP_EVERY_MS = Number(process.env.FOLLOWUP_EVERY_MS || 5 * 60 * 1000);
const AVITO_EVERY_MS = Number(process.env.AVITO_POLL_MS || 60 * 1000);
// Автоответ можно включить отдельно по каналу: в Авито человек ждёт ответа
// «сейчас» и уходит к тому, кто ответил первым, а заявке с сайта нормально
// полежать до мастера. AVITO_AUTOSEND=off|questions|all, пусто — общий режим.
const autosendFor = (channel) => (process.env[`${channel.toUpperCase()}_AUTOSEND`] || process.env.ENGINE_AUTOSEND || 'off').toLowerCase();

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Уведомление админа проекта. Раньше уходило только в телеграм мастеру и при
// пустом MASTER_CHAT_ID молча пропадало; теперь идёт лестницей телеграм → СМС →
// WhatsApp (см. notify.js), а не сработало ничего — остаётся в журнале службы.
async function notifyMaster(deal, draft, sent = null) {
  return notify.deal(deal, draft, { sent });
}

// ── телеграм ───────────────────────────────────────────────────────────────
async function pollTelegram() {
  if (!channels.telegram.configured()) return;
  let offset = Number(await kv.get('engine_tg_offset', 0)) || 0;
  for (;;) {
    let updates = [];
    try {
      updates = await channels.telegram.getUpdates(offset ? offset + 1 : undefined);
    } catch (e) {
      log('telegram:', e.message);
      await new Promise((r) => setTimeout(r, 10000));
      continue;
    }
    for (const u of updates) {
      offset = Math.max(offset, u.update_id);
      const m = u.message;
      if (!m) continue;
      try { await onTelegramMessage(m); } catch (e) { log('telegram: обработка', e.message); }
    }
    if (updates.length) await kv.set('engine_tg_offset', offset);
  }
}

async function onTelegramMessage(m) {
  const chat = String(m.chat.id);
  // Сообщения самого мастера в бот — не заявка: это он смотрит, как оно
  // работает. Клиентская сделка на его чат не заводится.
  if (MASTER() && chat === String(MASTER())) return;
  const deal = await store.deals.open({
    pack: PACK(), channel: 'telegram', externalId: chat,
    clientName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || null,
    contact: m.from?.username ? `@${m.from.username}` : null,
  });
  const attachments = [];
  if (m.photo?.length) attachments.push(await channels.telegram.download(deal.id, m.photo));
  if (m.document && /image\//.test(m.document.mime_type || '')) {
    attachments.push(await channels.telegram.download(deal.id, [{ file_id: m.document.file_id, file_size: m.document.file_size }]));
  }
  await pipeline.ingest({ pack: deal.pack, channel: 'telegram', externalId: chat, text: m.text || m.caption || '', attachments }, {});
  const r = await pipeline.think(deal.id, { autosend: autosendFor('telegram') });
  log(`telegram: сделка ${deal.id}, черновик ${r.draft?.kind} rev${r.draft?.rev}`);
  await notifyMaster(r.deal, r.draft, r.sent);
}

// ── авито ──────────────────────────────────────────────────────────────────
// Автодиалог: непрочитанный чат → сделка → разбор + зрение + смета → ответ
// (сам, если разрешено AVITO_AUTOSEND) → уведомление админа проекта.
//
// Порядок шагов неслучаен: «прочитано» ставим ПОСЛЕ разбора и отправки, иначе
// сбой в середине проглотит обращение навсегда — оно уже не непрочитанное.
async function handleAvitoChat(chat, seen) {
  const msgs = await channels.avito.messages(chat.id);
  const fresh = msgs.filter((x) => x.direction === 'in' && !seen.has(String(x.id)));
  if (!fresh.length) return null;
  const me = String(await channels.avito.userId().catch(() => process.env.AVITO_USER_ID || ''));
  const deal = await store.deals.open({
    pack: PACK(), channel: 'avito', externalId: String(chat.id),
    clientName: chat.users?.find((u) => String(u.id) !== me)?.name || null,
  });
  for (const x of fresh) {
    const attachments = [];
    const url = channels.avito.imageUrl(x);
    if (url) { try { attachments.push(await channels.avito.download(deal.id, url)); } catch (e) { log('avito: фото', e.message); } }
    await pipeline.ingest({
      pack: deal.pack, channel: 'avito', externalId: String(chat.id),
      text: channels.avito.messageText(x), attachments,
    }, {});
    seen.add(String(x.id));
  }
  const r = await pipeline.think(deal.id, { autosend: autosendFor('avito') });
  const state = r.sent ? (r.sent.ok && !r.sent.manual ? 'отправлен клиенту' : `НЕ ушёл: ${r.sent.error}`) : 'ждёт мастера';
  log(`avito: сделка ${deal.id}, черновик ${r.draft?.kind}, ответ ${state}`);
  await notifyMaster(r.deal, r.draft, r.sent);
  if (r.sent?.ok && !r.sent.manual) await channels.avito.markRead(chat.id);
  return r;
}

async function pollAvito() {
  if (!channels.avito.configured()) return;
  for (;;) {
    try {
      const seen = new Set(await kv.get('engine_avito_seen', []));
      for (const chat of await channels.avito.unread()) {
        try { await handleAvitoChat(chat, seen); }
        catch (e) { log(`avito: чат ${chat.id}:`, e.message); }
      }
      // Помним только последние идентификаторы: список не должен расти вечно.
      await kv.set('engine_avito_seen', [...seen].slice(-500));
    } catch (e) { log('avito:', e.message); }
    await new Promise((r) => setTimeout(r, AVITO_EVERY_MS));
  }
}

// ── напоминания ────────────────────────────────────────────────────────────
async function followupLoop() {
  for (;;) {
    try {
      const done = await pipeline.runFollowups({});
      if (done.length) log('напоминания:', JSON.stringify(done));
    } catch (e) { log('напоминания:', e.message); }
    await new Promise((r) => setTimeout(r, FOLLOWUP_EVERY_MS));
  }
}

async function main() {
  require('../server-env')(require('path').join(__dirname, '..', 'seo', '.env'));
  if (!store.db.enabled) { console.error('движку нужна база: нет SASHALAB_PG_URL'); process.exit(1); }
  const pack = packs.load(PACK());
  await store.catalog.sync(pack);
  log(`движок запущен: пакет «${pack.title}», каналы: ${channels.status().filter((c) => c.configured).map((c) => c.id).join(', ') || 'только ручной'}`);
  log(`каталог: ${pack.catalog.length} позиций, вложения: ${files.DIR}`);
  log(`автоответ: авито «${autosendFor('avito')}», телеграм «${autosendFor('telegram')}»; уведомление админа: ${notify.ROUTES().join(' → ')}${notify.ADMIN_PHONE() ? `, телефон ${notify.ADMIN_PHONE()}` : ''}`);
  // Три независимых цикла: упавший опрос канала не должен останавливать
  // напоминания, и наоборот.
  await Promise.all([pollTelegram(), pollAvito(), followupLoop()]);
}

if (require.main === module) main().catch((e) => { console.error('движок упал:', e.message); process.exit(1); });
module.exports = { onTelegramMessage, pollTelegram, pollAvito, handleAvitoChat, followupLoop, notifyMaster, autosendFor };
