const test = require('node:test');
const assert = require('node:assert');
const karta = require('../seo/karta');

const fakeRes = () => ({ head: null, body: '', writeHead(c, h) { this.head = [c, h]; }, end(b) { this.body = b; } });

test('чужие адреса не трогает', async () => {
  assert.strictEqual(await karta.handle({ url: '/baza/x', method: 'GET', headers: {}, socket: {} }, fakeRes()), false);
});

test('страница отдаётся закрытой от индексации и с голосовым вводом', async () => {
  const res = fakeRes();
  assert.strictEqual(await karta.handle({ url: '/karta', method: 'GET', headers: {}, socket: {} }, res), true);
  assert.strictEqual(res.head[0], 200);
  assert.match(res.head[1]['X-Robots-Tag'], /noindex/);
  assert.match(res.body, /ru-RU/);
  assert.match(res.body, /\/karta\/api/);
});

test('записи одной машины склеиваются в одну карточку', () => {
  const mk = (id, model, yf, yt, extra = {}) => ({ vehicle_id: id, make: 'kia', model, year_from: yf, year_to: yt, glass_offers: 0, ...extra });
  const out = karta.mergeCards([
    mk(1, 'seltos', 2018, 2022, { glass_offers: 3, glass_url: 'https://a.ru/x' }),
    mk(2, 'Seltos I', 2019, 2025, { housing_offers: 2, housing_url: 'https://b.ru/y' }),
    mk(3, 'Seltos SP2', null, null),
    mk(4, 'Sportage', 2018, 2022),
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].glass_url, 'https://a.ru/x');
  assert.strictEqual(out[0].housing_url, 'https://b.ru/y');
  assert.strictEqual(out[0].year_to, 2025);
});

test('разные годы и хвосты модели — всё равно одна карточка, а пустые пункты не показываются', () => {
  const mk = (id, model, yf, yt, extra = {}) => ({ vehicle_id: id, make: 'kia', model, year_from: yf, year_to: yt, ...extra });
  const out = karta.mergeCards([
    mk(1, 'seltos', 2018, 2019, { glass_offers: 2, glass_price_min: 5000 }),
    mk(2, 'SELTOS HALOGEN', 2023, 2025, { housing_offers: 1 }),
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].year_from, 2018);
  assert.strictEqual(out[0].year_to, 2025);
  const items = karta.buildItems(out[0], { glassCols: { left: [{ url: 'https://a.ru/1', host: 'a.ru', title: 'Стекло' }], right: [], other: [] } });
  assert.deepStrictEqual(items.map((i) => i.n), [4, 5]);
  assert.strictEqual(items[0].cols.left.length, 1);
});

test('имя модели из базы автомобилей выигрывает у обрезков справочника', () => {
  const cb = { byMake: new Map([['mazda', ['cx-5', 'cx-9', 'cx']], ['toyota', ['land-cruiser-prado', 'land-cruiser', 'camry']]]) };
  assert.strictEqual(karta.cbNameIn(cb, 'mazda', 'cx-5-ii'), 'cx-5');
  assert.strictEqual(karta.cbNameIn(cb, 'mazda', 'cx5'), 'cx-5');          // «cx5» из справочника — та же модель
  assert.strictEqual(karta.cbNameIn(cb, 'mazda', 'cx9-ii'), 'cx-9');
  assert.strictEqual(karta.cbNameIn(cb, 'toyota', 'landcruiser-200'), 'land-cruiser');
  assert.strictEqual(karta.cbNameIn(cb, 'toyota', 'land-cruiser-prado-150'), 'land-cruiser-prado');
  assert.strictEqual(karta.cbNameIn(cb, 'toyota', 'camry-v50'), 'camry');
  assert.strictEqual(karta.cbNameIn(cb, 'toyota', 'foglights'), undefined); // чего нет в базе — не модель
  const cb2 = { byMake: new Map([['toyota', ['pri']]]) };
  assert.strictEqual(karta.cbNameIn(cb2, 'toyota', 'prius'), undefined);   // «prius» ≠ «pri» + хвост
});

test('год выбирает поколение: чужие годы и коды кузова отсекаются', () => {
  const list = [
    { year_from: 2009, year_to: 2011, gens: ['v40', 'xv40'], match: false },
    { year_from: 2011, year_to: 2014, gens: ['v50', 'xv50'], match: true },
    { year_from: 2014, year_to: 2017, gens: ['xv55'], match: false },
  ];
  const sc = karta.genScope(list, 2012);
  assert.ok(sc.ok('Стекло фары Camry V50 (2011-2014)'));
  assert.ok(sc.ok('Стекла фар Toyota Camry'));                 // без года и кода — на модель в целом
  assert.ok(!sc.ok('Стекло фары Camry V40 (2009-2011)'));
  assert.ok(!sc.ok('Лампы Camry V50 restyling 2014-2018'));    // год важнее кода
  assert.ok(!sc.ok('Стекла Camry XV30'));                      // чужой код той же серии
  assert.ok(sc.ok('Лампа H11 для Camry'));                     // цоколь ≠ код кузова
  assert.strictEqual(karta.genScope(list, null), null);
});

test('H3: пункты 4–18 привязаны к поколению по car_id, без car_id — «на модель в целом»', () => {
  const { carFilter, carIdsOf } = require('../seo/karta');
  assert.deepStrictEqual(carIdsOf([{ id: 2, match: true }, { id: 1, match: false }, { match: true }]), [2]);
  const rows = [{ n: 'v50', car_id: 2 }, { n: 'v40', car_id: 1 }, { n: 'общая', car_id: null }, { n: 'xv30 общая', car_id: null }];
  const r = carFilter(rows, [2], (x) => !/xv30/.test(x.n));
  assert.deepStrictEqual(r.rows.map((x) => x.n), ['v50', 'общая']);
  assert.strictEqual(r.general, 1);
});
