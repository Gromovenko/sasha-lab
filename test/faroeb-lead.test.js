const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const db = require('../seo/lib/db');
const pipeline = require('../engine/pipeline');
const clients = require('../admin/clients');
const log = require('../admin/log');
const crm = require('../engine/crm');
const valid = { source: 'faroeb', name: 'Тест', contact: '+7 (999) 123-45-67', service: 'Ремонт фар', consent: 'yes', text: 'Тестовая заявка' };

async function submit(fields, accept = 'application/json') {
  const req = Readable.from([Buffer.from(new URLSearchParams(fields).toString())]);
  Object.assign(req, { method: 'POST', url: '/api/lead', headers: { 'content-type': 'application/x-www-form-urlencoded', accept }, socket: {} });
  const response = { writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; } };
  assert.equal(await crm.handle(req, response), true);
  return response;
}

test('Faroeb: validation, persisted request, JSON acknowledgement and HTML fallback', async (t) => {
  t.mock.method(pipeline, 'think', async () => {});
  t.mock.method(clients, 'ensureForDeal', async () => {});
  t.mock.method(log, 'info', async () => {});
  const ingest = t.mock.method(pipeline, 'ingest', async () => ({ deal: { id: 42 } }));
  let enabled = true;
  t.mock.getter(db, 'enabled', () => enabled);
  for (const patch of [{ name: '' }, { contact: 'abc123' }, { consent: '' }, { service: 'unknown' }]) {
    const res = await submit({ ...valid, ...patch });
    assert.equal(res.code, 400);
    assert.equal(JSON.parse(res.body).ok, false);
  }
  assert.equal(ingest.mock.callCount(), 0);
  const res = await submit(valid);
  assert.equal(res.code, 201);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  const lead = ingest.mock.calls[0].arguments[0];
  assert.equal(lead.channel, 'web');
  assert.equal(lead.pack, 'avtosvet');
  assert.equal(lead.client.contact, valid.contact);
  assert.match(lead.text, /Услуга: Ремонт фар/);
  assert.match(lead.text, /Тестовая заявка/);
  const html = await submit(valid, 'text/html');
  assert.equal(html.code, 302);
  assert.equal(html.headers.Location, '/zayavka/?ok=1');
  enabled = false;
  const unavailable = await submit(valid);
  assert.equal(unavailable.code, 503);
  assert.equal(JSON.parse(unavailable.body).ok, false);
  assert.equal(ingest.mock.callCount(), 2);
});

test('Faroeb: storage failure never acknowledges successful submission', async (t) => {
  let enabled = true;
  t.mock.getter(db, 'enabled', () => enabled);
  t.mock.method(pipeline, 'ingest', async () => { throw new Error('test storage unavailable'); });
  t.mock.method(console, 'error', () => {});
  const res = await submit(valid);
  assert.equal(res.code, 500);
  assert.ok(!res.body.includes('"ok":true'));
});
