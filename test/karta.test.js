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
