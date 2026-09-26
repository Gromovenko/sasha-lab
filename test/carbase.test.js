const test = require('node:test');
const assert = require('node:assert');
const { parseTitle, consolidate } = require('../harvest/carbase');

test('разбор заголовков разных сайтов', () => {
  const a = parseTitle('Переходные рамки для BMW 3 серии Е91 (2008-2012) рестайлинг', 'legal-xenon.ru');
  assert.deepStrictEqual([a.make, a.model, a.year_from, a.year_to, a.restyle], ['bmw', '3', 2008, 2012, 'restyle']);
  const b = parseTitle('Переходные рамки Mazda 6 III (GJ) рестайл [2015-2018] EU LED AFS под линзы Hella 3r/5r, Би-Лед', 'criline.ru');
  assert.deepStrictEqual([b.make, b.year_from, b.light, b.afs], ['mazda', 2015, 'led', true]);
  const c = parseTitle('Переходные рамки для линз TOYOTA CAMRY V50 БЕЗ AFS 2011-2014', 'luxsar.ru');
  assert.deepStrictEqual([c.model, c.gen, c.afs, c.year_to], ['camry', 'v50', false, 2014]);
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
