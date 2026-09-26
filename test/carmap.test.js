const test = require('node:test');
const assert = require('node:assert');
const { mapVehicle, indexCars } = require('../harvest/carmap');
const { pick, toCsv, score, rowOf, COLS } = require('../harvest/title-check');
const { parseTitle } = require('../harvest/carbase');

const cars = indexCars([
  { id: 1, make: 'toyota', model: 'camry', year_from: 2006, year_to: 2011 },
  { id: 2, make: 'toyota', model: 'camry', year_from: 2011, year_to: 2014 },
  { id: 3, make: 'mazda', model: 'cx-5', year_from: 2011, year_to: 2017 },
  { id: 4, make: 'kia', model: 'seltos', year_from: 2019, year_to: 2026 },
]);
const v = (make, model, f, t) => ({ make, model, year_from: f, year_to: t });

test('carmap: точное совпадение по модели и годам', () => {
  assert.deepStrictEqual(mapVehicle(v('Toyota', 'Camry', 2012, 2014), cars), { car_id: 2, method: 'exact' });
});
test('carmap: «CX-5 II» и «cx5» → база модели, метод fuzzy при другом написании', () => {
  assert.strictEqual(mapVehicle(v('mazda', 'CX-5 II', 2012, 2016), cars).car_id, 3);
  assert.strictEqual(mapVehicle(v('mazda', 'cx5', 2012, 2016), cars).car_id, 3);
});
test('carmap: без годов и одна машина — берём; две — неоднозначно', () => {
  assert.strictEqual(mapVehicle(v('kia', 'Seltos SP2', null, null), cars).car_id, 4);
  assert.strictEqual(mapVehicle(v('toyota', 'camry', null, null), cars).unmatched, 'ambiguous');
});
test('carmap: запись «на модель в целом» (Camry 1981–2025) к поколению не крепим', () => {
  const r = mapVehicle(v('toyota', 'camry', 1981, 2025), cars);
  assert.strictEqual(r.unmatched, 'too_wide');
  assert.strictEqual(mapVehicle(v('toyota', 'camry', 2011, 2017), cars).car_id, 2);
});
test('carmap: нет машины / нет модели', () => {
  assert.strictEqual(mapVehicle(v('kia', 'seltos', 1990, 1995), cars).unmatched, 'no_car');
  assert.strictEqual(mapVehicle(v('kia', 'rio', 2015, 2017), cars).unmatched, 'no_model');
  assert.strictEqual(mapVehicle(v('audi', 'a6', 2015, 2017), cars).unmatched, 'no_car');
});

test('title-check: выборка равномерна по сайтам, AFS в файле нет', () => {
  const rows = [];
  for (const h of ['a.ru', 'b.ru', 'c.ru']) for (let i = 0; i < 30; i++) rows.push(rowOf(h, `Переходные рамки Toyota Camry V50 20${10 + (i % 5)}-2015 с AFS`));
  const list = pick(rows, 60);
  assert.strictEqual(list.length, 60);
  assert.ok(['a.ru', 'b.ru', 'c.ru'].every((h) => list.filter((r) => r.site === h).length === 20));
  assert.ok(!COLS.includes('afs') && !/afs/i.test(toCsv(list).split('\n')[0]));
});
test('title-check: подсчёт доли верных по маркам и сайтам', () => {
  const t = toCsv([
    { site: 'a.ru', title: 't', make: 'kia', 'верно': 'да' }, { site: 'a.ru', title: 't', make: 'kia', 'верно': 'нет' },
    { site: 'b.ru', title: 't', make: 'bmw', 'верно': 'Да' }, { site: 'b.ru', title: 't', make: 'bmw', 'верно': '' },
  ]);
  const r = score(t);
  assert.deepStrictEqual([r.total, r.ok, r.pct], [3, 2, 66.7]);
  assert.deepStrictEqual(r.byMake.kia, { n: 2, ok: 1 });
  assert.deepStrictEqual(r.byHost['b.ru'], { n: 1, ok: 1 });
});
