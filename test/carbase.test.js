const test = require('node:test');
const assert = require('node:assert');
const { parseTitle, consolidate } = require('../harvest/carbase');

test('разбор заголовков разных сайтов', () => {
  const a = parseTitle('Переходные рамки для BMW 3 серии Е91 (2008-2012) рестайлинг', 'legal-xenon.ru');
  assert.deepStrictEqual([a.make, a.model, a.year_from, a.year_to, a.restyle], ['bmw', '3', 2008, 2012, 'restyle']);
  const b = parseTitle('Переходные рамки Mazda 6 III (GJ) рестайл [2015-2018] EU LED AFS под линзы Hella 3r/5r, Би-Лед', 'criline.ru');
  assert.deepStrictEqual([b.make, b.year_from, b.light, b.afs], ['mazda', 2015, 'led', null]);
  const c = parseTitle('Переходные рамки для линз TOYOTA CAMRY V50 БЕЗ AFS 2011-2014', 'luxsar.ru');
  assert.deepStrictEqual([c.model, c.gen, c.afs, c.year_to], ['camry', 'v50', null, 2014]);
  const d = parseTitle('Переходные рамки → Skoda → Kamiq: цены, большой каталог', 'vdf-light.ru');
  assert.deepStrictEqual([d.make, d.model, d.year_from], ['skoda', 'kamiq', null]);
});

test('Bi-LED — тип линзы, а не штатный свет', () => {
  const a = parseTitle('Переходные рамки для MINI Countryman 1 (2010-2016) для BI-LED купить', 'legal-xenon.ru');
  assert.strictEqual(a.light, null);
});

test('подтверждение: два сайта и годы в допуске ±1', () => {
  const o = (host, f, t, light) => ({ host, make: 'toyota', model: 'camry', gen: null, year_from: f, year_to: t, restyle: null, light, afs: null });
  const cars = consolidate([o('a.ru', 2011, 2014, 'led'), o('b.ru', 2011, 2015, 'led'), o('c.ru', 2006, 2011, 'xenon')]);
  const v50 = cars.find((c) => c.year_from === 2011);
  assert.strictEqual(v50.status, 'confirmed');
  assert.strictEqual(v50.variants[0].status, 'confirmed');
  assert.strictEqual(cars.find((c) => c.year_from === 2006).status, 'single');
});

test('разные комплектации не плодят машины', () => {
  const o = (host, light) => ({ host, make: 'kia', model: 'sportage', gen: null, year_from: 2010, year_to: 2016, restyle: null, light, afs: null });
  const cars = consolidate([o('a.ru', 'xenon'), o('b.ru', 'halogen')]);
  assert.strictEqual(cars.length, 1);
  assert.strictEqual(cars[0].variants.length, 2);
  assert.ok(cars[0].variants.every((v) => v.status === 'single'));
});

test('модели с номером не слипаются', () => {
  assert.strictEqual(parseTitle('Переходные рамки для линз MAZDA CX-5 2011-2017', 'a.ru').model, 'cx-5');
  assert.strictEqual(parseTitle('Рамки для biled линз chery tiggo 7 pro 2020-2023 купить', 'b.ru').model, 'tiggo-7');
  assert.strictEqual(parseTitle('Переходные рамки Saab 9-3 (2002-2007)', 'c.ru').model, '9-3');
});

test('AFS не определяется; вид детали и назначение хранятся', () => {
  const a = parseTitle('Переходные рамки для линз TOYOTA CAMRY V50 2011-2015 с AFS', 'luxsar.ru');
  assert.deepStrictEqual([a.afs, a.part_kind, a.purpose], [null, 'frame', 'install_lens']);
  const b = parseTitle('Переходные рамки для линз TOYOTA CAMRY V50 2011-2015', 'luxsar.ru');
  assert.strictEqual(b.afs, null);
  assert.strictEqual(require('../harvest/carbase').partOf('Стекло фары Toyota Camry').part_kind, 'glass');
});

test('V50 и XV50 — одно поколение, диапазоны 2011–2014 и 2011–2015 склеиваются', () => {
  const { consolidate, bodyOf } = require('../harvest/carbase');
  assert.strictEqual(bodyOf('xv50'), 'v50');
  const o = (t, h) => parseTitle(t, h);
  const cars = consolidate([
    o('Переходные рамки для линз TOYOTA CAMRY V50 2011-2017', 'a.ru'),
    o('Переходные рамки Toyota Camry XV50 2011-2014', 'b.ru'),
  ]);
  const withY = cars.filter((c) => c.year_from);
  assert.strictEqual(withY.length, 1);
  assert.strictEqual(withY[0].n_hosts, 2);
});

test('стёкла и корпуса тоже дают свидетельства, лампы — без света/AFS', () => {
  const g = parseTitle('Стекло фары Toyota Camry V50 2011-2014 левое', 'x.ru');
  assert.strictEqual(g.part_kind, 'glass');
  assert.strictEqual(g.model, 'camry');
  const l = parseTitle('Светодиодные лампы для фар Toyota Camry V50 2011-2014 LED', 'y.ru');
  assert.strictEqual(l.light, null);
  assert.strictEqual(l.afs, null);
  assert.strictEqual(parseTitle('Лобовое стекло Toyota Camry 2011-2014', 'z.ru'), null);
});

test('Mark X 120 и Pajero Sport 3 — составные модели', () => {
  assert.strictEqual(parseTitle('Переходные рамки Toyota Mark X 120 2004-2009', 'a.ru').model, 'mark-x');
  assert.strictEqual(parseTitle('Переходные рамки Mitsubishi Pajero Sport 3 2015-2020', 'a.ru').model, 'pajero-sport');
});

test('H2: purpose_src = title только при прямом указании, по виду детали не выводится', () => {
  const a = parseTitle('Переходные рамки для линз TOYOTA CAMRY V50 2011-2015', 'luxsar.ru');
  assert.deepStrictEqual([a.purpose, a.purpose_src], ['install_lens', 'title']);
  const b = parseTitle('Переходные рамки TOYOTA CAMRY V50 2011-2015', 'luxsar.ru');
  assert.deepStrictEqual([b.part_kind, b.purpose, b.purpose_src], ['frame', null, null]);
});
