// Тесты движка. Базы и сети не требуют: хранилище — в памяти, зрение и модель
// подменяются. Проверяется то, что ломает деньги и репутацию: состав сметы,
// цифры в тексте, ограничения по фото и то, что напоминание не уйдёт клиенту,
// который только что написал сам.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.PACKS_DIR = path.join(__dirname, '..', 'packs');
process.env.UPLOADS_DIR = path.join(__dirname, '..', '.test-uploads');
delete process.env.NEURALDEEP_API_KEY;   // модель в тестах не зовём

const packs = require('../engine/pack');
const rules = require('../engine/rules');
const quote = require('../engine/quote');
const offer = require('../engine/offer');
const render = require('../engine/render');
const extract = require('../engine/extract');
const vision = require('../engine/vision');
const pipeline = require('../engine/pipeline');
const { memoryStore } = require('../engine/memory-store');

const avtosvet = packs.load('avtosvet');
const hotels = packs.load('hotels');

test('пакеты проходят проверку', () => {
  for (const id of packs.list()) assert.deepEqual(packs.validate(packs.read(id)), [], `пакет ${id}`);
});

test('битый пакет ловится проверкой, а не клиентом', () => {
  const broken = packs.normalize({ id: 'x', title: 'x', subject: { fields: [{ key: 'a' }] },
    catalog: [{ sku: 'a', title: 'A', price: 1, kind: 'item' }],
    rules: [{ id: 'r', when: { text: ['x'] }, then: { addItem: 'нет-такого' } }], offer: { template: '{{title}}' } });
  assert.ok(packs.validate(broken).some((e) => e.includes('нет-такого')));
});

test('шаблонизатор: списки, флаги, точка', () => {
  const t = '{{a}}|{{#list}}[{{.}}]{{/list}}|{{#flag}}да{{/flag}}{{^flag}}нет{{/flag}}';
  assert.equal(render.render(t, { a: 'A', list: ['x', 'y'], flag: false }), 'A|[x][y]|нет');
  assert.equal(render.render(t, { a: '', list: [], flag: true }), '||да');
});

test('правила: мало места сужает каталог, обманки приходят из текста', () => {
  const plan = rules.evaluate(avtosvet, {
    text: 'нужны обманки штатной линзы, хочу би лед',
    findings: [{ code: 'tight_space', confidence: 0.8 }], photos: 2,
    subject: { make: 'Kia', model: 'Rio', year: 2015 },
  });
  assert.deepEqual(plan.requireTags, ['compact']);
  assert.ok(plan.addItems.includes('obmanka'));
  assert.deepEqual(plan.wants, ['lens']);
});

test('находка с низкой уверенностью не меняет смету', () => {
  const plan = rules.evaluate(avtosvet, { text: '', findings: [{ code: 'tight_space', confidence: 0.2 }], photos: 1, subject: {} });
  assert.deepEqual(plan.requireTags, []);
});

test('смета: ограничение по месту убирает крупную линзу и считает итог', () => {
  const plan = rules.evaluate(avtosvet, { text: 'хочу линзы, нужны обманки', findings: [{ code: 'tight_space', confidence: 0.9 }], photos: 1, subject: {} });
  const q = quote.build(avtosvet, { plan });
  assert.ok(!q.choices.some((c) => c.tags.includes('big')), 'крупная линза не должна попасть в подбор');
  assert.equal(q.choices.length, 2);
  assert.equal(q.total.min, 45000 + 5000);
  assert.equal(q.total.max, 45000 + 5000);
  assert.equal(q.totalText, '50 000 ₽');
});

test('смета: без ограничений итог — вилка от дешёвого к дорогому', () => {
  const plan = rules.evaluate(avtosvet, { text: 'хочу би лед линзы', findings: [], photos: 1, subject: {} });
  const q = quote.build(avtosvet, { plan });
  assert.equal(q.total.min, 45000);
  assert.equal(q.total.max, 45000);          // maxChoices=2, обе по 45 000
  assert.equal(q.includes.length > 3, true);
});

test('смета берёт цену из базы, а не из файла пакета', () => {
  const catalog = quote.mergeCatalog(avtosvet, [{ sku: 'lens-zorkiy-a50', price_rub: 47000 }]);
  const plan = rules.evaluate(avtosvet, { text: 'линзы', findings: [], photos: 1, subject: {} });
  const q = quote.build(avtosvet, { plan, catalog });
  assert.equal(q.total.min, 45000);          // дешевле остался Luxsar
  assert.equal(q.total.max, 47000);
  assert.ok(q.totalText.startsWith('от '));
});

test('текст КП содержит ровно посчитанные цифры', () => {
  const plan = rules.evaluate(avtosvet, { text: 'линзы, обманки, рамки', findings: [], photos: 1, subject: {} });
  const q = quote.build(avtosvet, { plan });
  const d = offer.compose(avtosvet, { quote: q, plan, subject: {} });
  assert.equal(d.kind, 'offer');
  assert.ok(d.text.includes('45 000 ₽') && d.text.includes('5 000 ₽') && d.text.includes('1 500 ₽'));
  assert.ok(d.text.includes(`ИТОГО: ${q.totalText}`));
  assert.deepEqual(offer.numbers(d.text), offer.numbers(d.text));
});

test('сторож причёсывания: правка с другой ценой или ужатая выбрасывается', () => {
  const plan = rules.evaluate(avtosvet, { text: 'линзы, обманки', findings: [], photos: 1, subject: {} });
  const base = offer.compose(avtosvet, { quote: quote.build(avtosvet, { plan }), plan, subject: {} }).text;
  // цифры целы, стиль другой — принимаем
  assert.ok(offer.guardPolish(base, `${base}\n\nЗаписываю на удобный день, обычно делаю за один день.`));
  // цена изменилась — выбрасываем
  assert.equal(offer.guardPolish(base, base.replace('45 000', '40 000')), null);
  // цифры те же, но от КП остался огрызок без состава работ — тоже выбрасываем
  assert.equal(offer.guardPolish(base, 'Линзы 45 000 ₽, обманки 5 000 ₽, итого 50 000 ₽.'), null);
});

test('зрение: коды не из пакета выбрасываются, мусор не роняет разбор', () => {
  const r = vision.parse(avtosvet, '```json\n{"findings":[{"code":"tight_space","confidence":0.8},{"code":"чушь","confidence":1}],"summary":"фара"}\n```');
  assert.deepEqual(r.findings.map((f) => f.code), ['tight_space']);
  assert.throws(() => vision.parse(avtosvet, 'извините, не могу'), /не JSON/);
});

test('разбор без модели: год и телефон берутся эвристикой', async () => {
  const got = await extract.extract(avtosvet, { text: 'Kia Rio 2015 года, телефон +7 999 123-45-67' });
  assert.equal(got.subject.year, 2015);
  assert.ok(got.contact.includes('999'));
  assert.equal(got.engine, 'rules');
});

test('значение из перечня принимается, только если человек его назвал', () => {
  // Замер на проде 17.09: по «хочу линзы на киа рио 2015» модель дописала тип
  // фары, которого в переписке не было. Угаданный факт дальше поехал бы в расчёт.
  assert.deepEqual(extract.sanitize(avtosvet, { subject: { make: 'Kia', headlight: 'галоген' } }, 'хочу линзы на киа рио 2015').subject,
    { make: 'Kia' });
  assert.deepEqual(extract.sanitize(avtosvet, { subject: { headlight: 'штатный ксенон' } }, 'у меня штатный ксенон').subject,
    { headlight: 'штатный ксенон' });
});

test('подтверждённое мастером не перетирается разбором', () => {
  assert.deepEqual(extract.merge({ year: 2015 }, { year: 2020, model: 'Rio' }), { year: 2015, model: 'Rio' });
});

// ── конвейер целиком: тот самый живой диалог из переписки мастера ──────────
test('полный путь: вопрос без фото → фото меняет ответ → отправка → напоминания', async () => {
  const store = memoryStore();
  await store.catalog.sync(avtosvet);
  const real = vision.lookAll;

  // 1. Клиент пишет без фото: движок не молчит и не выдумывает — спрашивает.
  vision.lookAll = async () => ({ ok: true, findings: [], summaries: [], errors: [] });
  const first = await pipeline.handleIncoming({
    pack: 'avtosvet', channel: 'manual', externalId: 'chat-1',
    text: 'Здравствуйте! Хочу би лед линзы на Киа Рио. В описании написано, нужны обманки штатной линзы',
    client: { name: 'Игорь', contact: '+79991234567' },
  }, { store });
  assert.equal(first.draft.kind, 'offer');
  assert.ok(first.draft.text.includes('Чтобы посчитать точно'), 'вопросы должны быть в том же сообщении с ценой');
  assert.ok(first.plan.questions.some((q) => q.includes('фото')), 'без фото обязан попросить фото');
  assert.ok(first.plan.questions.some((q) => q.includes('год')));
  assert.equal(first.deal.total_rub, 50000);

  // 2. Приходит фото, на котором мало места: ответ переписывается сам.
  vision.lookAll = async () => ({ ok: true, errors: [], summaries: ['штатный галоген, места мало'],
    findings: [{ code: 'tight_space', confidence: 0.86, note: 'глубина посадочного места мала' }] });
  const second = await pipeline.handleIncoming({
    pack: 'avtosvet', channel: 'manual', externalId: 'chat-1', text: 'вот фото фары, машина 2015 года',
    attachments: [{ filename: 'fara.jpg', buffer: Buffer.from('fake-jpeg-bytes') }],
  }, { store });
  vision.lookAll = real;

  assert.equal(second.deal.id, first.deal.id, 'второе сообщение — та же сделка');
  assert.equal(second.deal.subject.year, 2015);
  assert.ok(second.draft.reason.includes('уточнено по фото'));
  assert.equal(second.draft.rev, 2);
  assert.ok(second.draft.text.includes('мало места в фаре'));
  assert.ok(!second.draft.text.includes('Aozoom'), 'крупная линза исчезает из предложения');
  assert.ok(!second.plan.questions.some((q) => q.includes('год')), 'год уже известен — не переспрашиваем');
  assert.equal(second.deal.stage, 'quoted');

  // 3. Мастер отправляет ответ — план напоминаний строится от момента отправки.
  const sent = await pipeline.send(second.deal.id, { store });
  assert.ok(sent.ok);
  const deal = await store.deals.byId(second.deal.id);
  assert.equal(deal.stage, 'sent');
  const plans = await store.followups.byDeal(deal.id);
  assert.equal(plans.length, avtosvet.followups.length);

  // 4. Срок подошёл — напоминание уходит.
  const later = new Date(Date.now() + 5 * 3600e3);
  const ran = await pipeline.runFollowups({ store, now: later });
  assert.equal(ran.length, 1);
  assert.equal(ran[0].step, 1);

  // 5. Клиент ответил — оставшиеся напоминания снимаются.
  vision.lookAll = async () => ({ ok: true, findings: [], summaries: [], errors: [] });
  await pipeline.ingest({ pack: 'avtosvet', channel: 'manual', externalId: 'chat-1', text: 'ок, записывайте' }, { store });
  vision.lookAll = real;
  const after = await store.followups.byDeal(deal.id);
  assert.equal(after.filter((f) => f.status === 'planned').length, 0);
  const due = await store.followups.due(new Date(Date.now() + 90 * 3600e3));
  assert.equal(due.length, 0, 'ответившему клиенту напоминание уходить не должно');
});

test('движок не знает про фары: тот же путь на пакете отелей', async () => {
  const store = memoryStore();
  await store.catalog.sync(hotels);
  const real = vision.lookAll;
  vision.lookAll = async () => ({ ok: true, findings: [], summaries: [], errors: [] });
  const r = await pipeline.handleIncoming({
    pack: 'hotels', channel: 'web', text: 'Нужен отель у моря с детьми, нужен трансфер из аэропорта',
    client: { name: 'Ольга', contact: 'olga@example.com' },
  }, { store });
  vision.lookAll = real;
  assert.ok(r.draft.text.includes('Семейный номер'), 'правило «с детьми» должно сузить подбор');
  assert.ok(r.draft.text.includes('Трансфер'));
  assert.ok(r.plan.questions.some((q) => q.includes('даты')));
  assert.equal(r.quote.currency, 'RUB');
  assert.ok(r.deal.total_rub > 0);
});
