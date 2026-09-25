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
