const test = require('node:test');
const assert = require('node:assert');
const { traceTitle, compare, REFERENCE } = require('../harvest/carbase-trace');
const { parseTitle } = require('../harvest/carbase');

test('эталон luxsar: Camry V50 2011–2015 с AFS', () => {
  const r = parseTitle(REFERENCE.title, REFERENCE.host);
  assert.deepStrictEqual([r.make, r.model, r.gen, r.year_from, r.year_to, r.afs], ['toyota', 'camry', 'v50', 2011, 2015, null]);
});
test('трассировка совпадает с боевым parseTitle', () => {
  for (const t of [REFERENCE.title, 'Переходные рамки Audi A6 C5 1997-2001 ксенон', 'Стекло фары Kia', 'Переходные рамки → Lynk & Co → 900']) {
    const d = traceTitle(t, 'x.ru');
    assert.ok(d.same, t);
    assert.ok(d.steps.length >= 2);
  }
});
test('сравнение: вид детали и назначение совпадают с эталоном', () => {
  const rows = compare(REFERENCE.human, parseTitle(REFERENCE.title, REFERENCE.host));
  assert.deepStrictEqual(rows.filter((x) => !x.ok).map((x) => x.label), []);
});
