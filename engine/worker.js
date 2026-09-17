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
const kv = require('../seo/lib/store').kv;

const PACK = () => process.env.PACK || packs.DEFAULT_ID;
const MASTER = () => process.env.MASTER_CHAT_ID || '';
const SITE = () => process.env.CRM_URL || 'http://127.0.0.1:3060';
const FOLLOWUP_EVERY_MS = Number(process.env.FOLLOWUP_EVERY_MS || 5 * 60 * 1000);
const AVITO_EVERY_MS = Number(process.env.AVITO_POLL_MS || 60 * 1000);

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function notifyMaster(deal, draft) {
  if (!MASTER() || !channels.telegram.configured()) return;
  const head = [deal.client_name, deal.client_contact].filter(Boolean).join(' · ') || deal.id;
  const text = `📥 ${channels.get(deal.channel).title}: ${head}\n\n`
    + `${draft ? draft.text : 'ответ ещё не собран'}\n\n`
    + `Открыть карточку: ${SITE()}/crm/d?id=${deal.id}`;
  await channels.telegram.send({ to: MASTER(), text });
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
  const r = await pipeline.think(deal.id, {});
  log(`telegram: сделка ${deal.id}, черновик ${r.draft?.kind} rev${r.draft?.rev}`);
  await notifyMaster(r.deal, r.draft);
}

// ── авито ──────────────────────────────────────────────────────────────────
async function pollAvito() {
  if (!channels.avito.configured()) return;
  for (;;) {
    try {
      const seen = new Set(await kv.get('engine_avito_seen', []));
      for (const chat of await channels.avito.unread()) {
        const msgs = await channels.avito.messages(chat.id);
        const fresh = msgs.filter((x) => x.direction === 'in' && !seen.has(String(x.id)));
        if (!fresh.length) continue;
        const deal = await store.deals.open({ pack: PACK(), channel: 'avito', externalId: String(chat.id), clientName: chat.users?.find((u) => String(u.id) !== String(process.env.AVITO_USER_ID))?.name || null });
        for (const x of fresh) {
          const attachments = [];
          const url = x.content?.image?.sizes ? Object.values(x.content.image.sizes).pop() : null;
          if (url) { try { attachments.push(await channels.avito.download(deal.id, url)); } catch (e) { log('avito: фото', e.message); } }
          await pipeline.ingest({ pack: deal.pack, channel: 'avito', externalId: String(chat.id), text: x.content?.text || '', attachments }, {});
          seen.add(String(x.id));
        }
        const r = await pipeline.think(deal.id, {});
        log(`avito: сделка ${deal.id}, черновик ${r.draft?.kind}`);
        await notifyMaster(r.deal, r.draft);
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
  // Три независимых цикла: упавший опрос канала не должен останавливать
  // напоминания, и наоборот.
  await Promise.all([pollTelegram(), pollAvito(), followupLoop()]);
}

if (require.main === module) main().catch((e) => { console.error('движок упал:', e.message); process.exit(1); });
module.exports = { onTelegramMessage, pollTelegram, pollAvito, followupLoop, notifyMaster };
