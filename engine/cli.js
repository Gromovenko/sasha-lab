#!/usr/bin/env node
// Командная строка движка. Нужна для трёх вещей: проверить пакет до выката,
// прогнать конвейер руками по сделке и показать весь путь БЕЗ базы и ключей
// (`demo`) — чтобы было видно, что получает клиент, ещё до подключения каналов.
require('../server-env')(require('path').join(__dirname, '..', 'seo', '.env'));
const fs = require('fs');
const packs = require('./pack');
const pipeline = require('./pipeline');
const store = require('./store');
const channels = require('./channels');
const vision = require('./vision');
const quote = require('./quote');
const { memoryStore } = require('./memory-store');
const notify = require('./notify');
const dialogs = require('./avito-dialogs');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const HELP = `
sasha-lab · движок заявок

  packs                     список отраслевых пакетов и проверка
  sync [--pack id]          налить каталог пакета в базу (цены не перетираются)
  channels                  какие каналы подключены
  deals [--stage quoted]    список сделок
  show <id>                 карточка сделки в консоли
  think <id>                пересчитать: разбор + зрение + смета + черновик
  send <id>                 отправить готовый черновик в канал сделки
  lead --text "…" [--photo путь] [--channel web] [--pack id]
                            завести заявку руками (для проверки конвейера)
  followups                 разослать назревшие напоминания
  demo [--pack id] [--text "…"] [--finding код]
                            прогон всего пути в памяти: ни базы, ни ключей не нужно

  avito check               проверить ключи Авито: токен, профиль, доступ к чатам
  avito chats [--limit 20]  свежие диалоги Авито одной таблицей
  avito dialogs [--limit 500] [--file путь] [--report путь]
                            выкачать ВСЮ переписку и разобрать: кто что спрашивает,
                            сколько ушло без ответа, за сколько мы отвечаем
  avito report [--file путь]  пересобрать отчёт по уже сохранённому дампу (без сети)
  avito reply <chatId> --text "…"   отправить сообщение в чат Авито
  notify test [--text "…"]  проверить лестницу уведомления админа проекта

Окружение: SASHALAB_PG_URL, NEURALDEEP_API_KEY (разбор и зрение),
TELEGRAM_BOT_TOKEN, MASTER_CHAT_ID, RESEND_API_KEY/RESEND_FROM,
AVITO_CLIENT_ID/AVITO_CLIENT_SECRET, ENGINE_AUTOSEND=off|questions|all,
AVITO_AUTOSEND (автодиалог только в Авито), ADMIN_PHONE + SMSRU_API_ID
(уведомление админа проекта), ADMIN_NOTIFY=telegram,sms,whatsapp
`;

function printDraft(r) {
  console.log('\n──────── ответ клиенту ────────');
  console.log(r.draft.text);
  console.log('───────────────────────────────');
  console.log(`тип: ${r.draft.kind}, ревизия: ${r.draft.rev}${r.draft.reason ? `, ${r.draft.reason}` : ''}`);
  if (r.quote?.choices?.length) console.log(`итого: ${r.quote.totalText}`);
  if (r.plan?.questions?.length) console.log(`вопросы: ${r.plan.questions.join(' | ')}`);
  if (r.findings?.length) console.log(`по фото: ${r.findings.map((f) => `${f.code} ${Math.round(f.confidence * 100)}%`).join(', ')}`);
  if (r.visionErrors?.length) console.log(`зрение не сработало: ${r.visionErrors.map((e) => e.error).join('; ')}`);
}

async function main() {
  switch (cmd) {
    case 'packs': {
      for (const id of packs.list()) {
        const p = packs.read(id);
        const errs = packs.validate(p);
        console.log(`${errs.length ? '✗' : '✓'} ${id} — ${p.title}: ${p.catalog.length} позиций, ${p.rules.length} правил, ${p.vision.findings.length} находок`);
        for (const e of errs) console.log(`    ! ${e}`);
      }
      break;
    }
    case 'channels': {
      for (const c of channels.status()) {
        console.log(`${c.configured ? '✓' : '·'} ${c.id.padEnd(9)} ${c.title}${c.inbound ? ' (приём)' : ''}${c.verified ? '' : ' — код есть, на живых ключах не проверен'}`);
      }
      break;
    }
    case 'sync': {
      const p = packs.load(flag('pack', packs.DEFAULT_ID));
      const r = await store.catalog.sync(p);
      console.log(`каталог «${p.title}»: позиций ${r.total}, новых ${r.added}`);
      break;
    }
    case 'deals': {
      const rows = await store.deals.list({ stage: flag('stage', null), limit: Number(flag('limit', 40)) });
      for (const d of rows) {
        console.log(`  ${d.id}  ${String(d.stage).padEnd(8)} ${String(d.channel).padEnd(9)} ${(d.client_name || '—').padEnd(16)} ${d.total_rub ? quote.money(d.total_rub) : ''}`);
      }
      console.log(`всего: ${rows.length}`);
      break;
    }
    case 'show': {
      const d = await store.deals.byId(argv[1]);
      if (!d) return console.error('нет такой сделки');
      console.log(JSON.stringify({ ...d, quote: undefined }, null, 2));
      const draft = await store.drafts.latest(d.id);
      if (draft) { console.log('\n──── последний ответ ────'); console.log(draft.text); }
      break;
    }
    case 'think': { printDraft(await pipeline.think(argv[1], {})); break; }
    case 'send': {
      const r = await pipeline.send(argv[1], {});
      console.log(r.ok ? (r.manual ? 'записано как отправленное вручную' : 'отправлено') : `не ушло: ${r.error}`);
      break;
    }
    case 'lead': {
      const attachments = [];
      for (const f of [flag('photo'), flag('photo2')].filter(Boolean)) {
        attachments.push({ filename: require('path').basename(f), buffer: fs.readFileSync(f) });
      }
      const r = await pipeline.handleIncoming({
        pack: flag('pack', packs.DEFAULT_ID), channel: flag('channel', 'web'),
        externalId: flag('chat', null), text: flag('text', ''), attachments,
        client: { name: flag('name', null), contact: flag('contact', null) },
      }, {});
      console.log(`сделка: ${r.deal.id}`);
      printDraft(r);
      break;
    }
    case 'followups': {
      const r = await pipeline.runFollowups({});
      console.log(r.length ? JSON.stringify(r, null, 2) : 'назревших напоминаний нет');
      break;
    }
    // ── Авито ──────────────────────────────────────────────────────────────
    case 'avito': {
      const sub = argv[1] || 'check';
      if (!channels.avito.configured() && sub !== 'report') {
        console.error('нет ключей: AVITO_CLIENT_ID / AVITO_CLIENT_SECRET (кабинет Авито → Настройки → API).');
        console.error('Логин и пароль от кабинета к API не подходят — у /token только client_credentials.');
        process.exitCode = 1;
        break;
      }
      if (sub === 'check') {
        const me = await channels.avito.self();
        console.log(`✓ токен получен, профиль: ${me.name || me.email || me.id} (id ${me.id})`);
        const list = await channels.avito.chats({ limit: 10 });
        const un = await channels.avito.chats({ unreadOnly: true, limit: 100 });
        console.log(`✓ мессенджер доступен: видно ${list.length} диалогов на первой странице, непрочитанных ${un.length}`);
        break;
      }
      if (sub === 'chats') {
        const list = await channels.avito.chats({ limit: Number(flag('limit', 20)) });
        for (const c of list) {
          const me = String(await channels.avito.userId());
          const who = (c.users || []).find((u) => String(u.id) !== me)?.name || '—';
          const lastText = channels.avito.messageText(c.last_message || {});
          console.log(`  ${String(c.id).padEnd(24)} ${String(who).padEnd(18)} ${c.context?.value?.title || ''} · ${lastText.slice(0, 60)}`);
        }
        console.log(`всего показано: ${list.length}`);
        break;
      }
      if (sub === 'dialogs') {
        const max = Number(flag('limit', 500));
        process.stdout.write('качаю переписку: ');
        const all = await dialogs.fetchAll({ max, onProgress: (i, n) => { if (i % 10 === 0 || i === n) process.stdout.write(`${i}/${n} `); } });
        console.log('');
        const stat = dialogs.analyze(all);
        const file = dialogs.save(all, stat, flag('file', null));
        console.log(`\n${dialogs.report(stat)}\n`);
        console.log(`дамп переписки: ${file} (в git не едет — это личные данные клиентов)`);
        if (flag('report')) { fs.writeFileSync(flag('report'), dialogs.report(stat)); console.log(`отчёт: ${flag('report')}`); }
        break;
      }
      if (sub === 'report') {
        const file = flag('file', require('path').join(__dirname, '..', 'seo', 'data', 'avito-dialogs.json'));
        const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
        console.log(dialogs.report(dialogs.analyze(dump.dialogs || [])));
        break;
      }
      if (sub === 'reply') {
        const r = await channels.avito.send({ to: argv[2], text: flag('text', '') });
        console.log(r.ok ? `отправлено (${r.id || 'без id'})` : `не ушло: ${r.error}`);
        break;
      }
      console.log('avito: check | chats | dialogs | report | reply');
      break;
    }

    case 'notify': {
      const r = await notify.admin({
        text: flag('text', 'Проверка связи: движок заявок sasha-lab умеет достучаться до админа проекта.'),
        sms: flag('text', 'Проверка: движок sasha-lab на связи.'), force: true,
      });
      console.log(r.ok ? `ушло через ${r.via}` : `не ушло ни по одному маршруту: ${r.tried.join('; ') || 'маршруты не настроены'}`);
      break;
    }

    // Демонстрация без базы и без ключей: видно, что получит клиент.
    case 'demo': {
      const packId = flag('pack', packs.DEFAULT_ID);
      const pack = packs.load(packId);
      const st = memoryStore();
      await st.catalog.sync(pack);
      const finding = flag('finding', null);
      if (finding || !vision.enabled()) {
        vision.lookAll = async () => ({ ok: true, errors: [], summaries: [],
          findings: finding ? [{ code: finding, confidence: 0.9, note: 'демо' }] : [] });
      }
      const text = flag('text', 'Здравствуйте! Хочу би лед линзы на Киа Рио 2015. Нужны обманки штатной линзы');
      const r = await pipeline.handleIncoming({ pack: packId, channel: 'manual', externalId: 'demo',
        text, attachments: finding ? [{ filename: 'demo.jpg', buffer: Buffer.from('demo') }] : [],
        client: { name: 'Демо-клиент', contact: 'demo@example.com' } }, { store: st });
      printDraft(r);
      const sent = await pipeline.send(r.deal.id, { store: st });
      console.log(`\nотправка: ${sent.ok ? (sent.manual ? 'ручной канал (копипаста)' : 'ушло') : sent.error}`);
      const plan = await st.followups.byDeal(r.deal.id);
      console.log(`напоминания: ${plan.map((p) => `шаг ${p.step} через ${Math.round((p.due_at - Date.now()) / 36e5)} ч`).join(', ') || 'нет'}`);
      break;
    }
    default: console.log(HELP);
  }
}

main()
  .then(() => (store.db.enabled && cmd !== 'demo' ? store.db.close() : null))
  .catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
