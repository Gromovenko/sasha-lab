// Авито-автодиалог: разбор переписки, уведомление админа, СМС-канал.
// Сети не требует — Авито подменяется, отчёт считается на сохранённом дампе.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.PACKS_DIR = path.join(__dirname, '..', 'packs');

const dialogs = require('../engine/avito-dialogs');
const sms = require('../engine/channels/sms');
const avito = require('../engine/channels/avito');
const notify = require('../engine/notify');
const channels = require('../engine/channels');
const worker = require('../engine/worker');

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 8, 10, 6, 0, 0);

const sample = [
  { id: '1', item: 'Би-лед линзы', client: { id: '9', name: 'Иван' }, messages: [
    { direction: 'in', at: T0, text: 'Сколько стоит поставить линзы на Киа Рио 2015?', photo: false },
    { direction: 'out', at: T0 + 10 * 60000, text: '45 000 ₽', photo: false },
  ] },
  { id: '2', item: 'Би-лед линзы', client: { id: '8', name: 'Пётр' }, messages: [
    { direction: 'in', at: T0 + 2 * H, text: 'Фары потеют, можно отремонтировать? Какой адрес?', photo: true },
  ] },
  { id: '3', item: 'Ремонт фар', client: { id: '7', name: 'Ольга' }, messages: [
    { direction: 'in', at: T0 + 3 * H, text: 'Здравствуйте, гарантия есть?', photo: false },
    { direction: 'out', at: T0 + 8 * H, text: 'Год', photo: false },
    { direction: 'in', at: T0 + 9 * H, text: 'А когда можно записаться?', photo: false },
  ] },
];

test('разбор переписки: считает брошенные чаты, скорость ответа и темы', () => {
  const s = dialogs.analyze(sample);
  assert.equal(s.dialogs, 3);
  assert.equal(s.messages, 6);
  assert.equal(s.fromClient, 4);
  assert.equal(s.fromUs, 2);
  assert.equal(s.unanswered, 1);            // второй чат остался без ответа
  assert.equal(s.hanging, 2);               // во втором и третьем последним писал клиент
  assert.equal(s.withPhoto, 1);
  assert.equal(s.medianFirstReply, (10 * 60000 + 5 * H) / 2);
  assert.equal(s.within15m, 1);
  assert.equal(s.overHour, 1);
  const codes = s.topTopics.map((t) => t.code);
  for (const c of ['price', 'repair', 'place', 'warranty', 'time']) assert.ok(codes.includes(c), `тема ${c}`);
  assert.equal(s.topItems[0].title, 'Би-лед линзы');
});

test('брошенный чат попадает в примеры и в выводы отчёта', () => {
  const s = dialogs.analyze(sample);
  assert.match(s.noReplyExamples[0].text, /потеют/);
  const text = dialogs.report(s);
  assert.match(text, /Без нашего ответа вообще: 1/);
  assert.ok(dialogs.advice(s).some((a) => /без ответа/.test(a)));
});

test('пустая выборка не роняет отчёт', () => {
  const s = dialogs.analyze([]);
  assert.equal(s.dialogs, 0);
  assert.equal(s.medianFirstReply, null);
  assert.match(dialogs.report(s), /данных мало/);
});

test('телефон админа приводится к виду 79098887575', () => {
  for (const v of ['89098887575', '+7 (909) 888-75-75', '9098887575', '7-909-888-75-75']) {
    assert.equal(sms.normalize(v), '79098887575');
  }
});

test('сообщение Авито: текст любого типа и самая крупная картинка', () => {
  assert.equal(avito.messageText({ content: { text: 'привет' } }), 'привет');
  assert.equal(avito.messageText({ type: 'call', content: { call: { status: 'missed' } } }), '[звонок]');
  assert.equal(avito.messageText({ content: { item: { title: 'Линзы' } } }), '[объявление] Линзы');
  assert.equal(avito.imageUrl({ content: { image: { sizes: { '140x105': 'мало', '1280x960': 'много' } } } }), 'много');
  assert.equal(avito.imageUrl({ content: { text: 'без картинки' } }), null);
});

test('ключи Авито: логин с паролем каналом не считаются', () => {
  const save = { ...process.env };
  delete process.env.AVITO_CLIENT_ID; delete process.env.AVITO_CLIENT_SECRET;
  assert.equal(avito.configured(), false);
  process.env.AVITO_CLIENT_ID = 'id'; process.env.AVITO_CLIENT_SECRET = 'secret';
  assert.equal(avito.configured(), true);   // AVITO_USER_ID необязателен: берём из профиля
  Object.assign(process.env, save);
  delete process.env.AVITO_CLIENT_ID; delete process.env.AVITO_CLIENT_SECRET;
});

test('уведомление админа идёт лестницей: телеграм упал → СМС', async () => {
  const realGet = channels.get;
  const calls = [];
  process.env.ADMIN_NOTIFY = 'telegram,sms,whatsapp';
  process.env.MASTER_CHAT_ID = '111';
  process.env.ADMIN_PHONE = '89098887575';
  channels.get = (id) => ({
    telegram: { configured: () => true, send: async (a) => { calls.push(['telegram', a.to]); return { ok: false, error: 'бот заблокирован' }; } },
    sms: { configured: () => true, send: async (a) => { calls.push(['sms', a.to, a.text]); return { ok: true, id: '1' }; } },
    whatsapp: { configured: () => true, send: async () => { calls.push(['whatsapp']); return { ok: true }; } },
    avito: { title: 'Авито' },
  }[id] || realGet(id));
  const r = await notify.deal(
    { id: 'd1', channel: 'avito', client_name: 'Иван', total_rub: 45000 },
    { text: 'Расчёт: 45 000 ₽' },
    { sent: { ok: true }, force: true },
  );
  assert.equal(r.ok, true);
  assert.equal(r.via, 'sms');
  assert.deepEqual(calls.map((c) => c[0]), ['telegram', 'sms']);   // до whatsapp не дошло
  assert.match(calls[1][2], /Автоответ отправлен/);
  assert.ok(calls[1][2].length <= 300, 'СМС короткая');
  channels.get = realGet;
  delete process.env.MASTER_CHAT_ID; delete process.env.ADMIN_PHONE;
});

test('повторные сообщения подряд не будят админа второй раз', () => {
  const key = `k${Math.random()}`;
  assert.equal(notify.throttled(key), false);
  assert.equal(notify.throttled(key), true);
});

test('автоответ настраивается отдельно по каналу', () => {
  process.env.ENGINE_AUTOSEND = 'off';
  process.env.AVITO_AUTOSEND = 'all';
  assert.equal(worker.autosendFor('avito'), 'all');
  assert.equal(worker.autosendFor('telegram'), 'off');
  delete process.env.AVITO_AUTOSEND;
  assert.equal(worker.autosendFor('avito'), 'off');
  delete process.env.ENGINE_AUTOSEND;
});
