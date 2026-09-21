// Экран «Парсеры»: запуск и остановка сбора через общий замок.
//
// Проверяется на настоящем flock во временном каталоге: держатели замка
// находятся через /proc, второй запуск поверх идущего не проходит, остановка
// гасит всю группу процессов очереди. И маршрут: мастер сбор не запускает,
// а мусор из формы не доезжает аргументом до очереди.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');

process.env.SASHALAB_PG_URL = process.env.SASHALAB_PG_URL || 'postgres://test/notused';
process.env.ADMIN_LOG_CONSOLE = '0';

const control = require('../harvest/control');
const accounts = require('../admin/accounts');
const http = require('../admin/http');
const { memoryAdminStore } = require('../admin/memory-store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now() + ms; while (Date.now() < t) { if (fn()) return true; await sleep(50); } return false; };

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parsers-'));
  const lockDir = path.join(dir, 'locks');
  fs.mkdirSync(lockDir);
  // Подставная очередь: берёт общий замок так же, как настоящая, и «качает» sleep.
  const queue = path.join(dir, 'queue.sh');
  fs.writeFileSync(queue, `#!/bin/bash\nexec flock -E 99 -n "${lockDir}/sashalab-harvest.lock" sleep 30\n`, { mode: 0o755 });
  return { dir, lockDir, queue, logDir: path.join(dir, 'log') };
}

test('держатель общего замка виден и гасится', async () => {
  const o = sandbox();
  const child = spawn('flock', ['-n', path.join(o.lockDir, 'sashalab-harvest.lock'), 'sleep', '30'], { detached: true, stdio: 'ignore' });
  child.unref();
  assert.ok(await until(() => control.status(o).busy), 'замок не увиден');
  const st = control.status(o);
  assert.equal(st.locks[0].main, true);
  assert.ok(st.locks[0].pids.length >= 2, 'flock и его sleep держат один замок');

  const r = await control.stop(control.MAIN, { ...o, graceMs: 3000 });
  assert.equal(r.ok, true);
  assert.equal(r.still, 0);
  assert.equal(control.status(o).busy, false);
});

test('запуск идёт через очередь, второй поверх идущего не проходит', async () => {
  const o = sandbox();
  const first = await control.start(['a.ru'], { ...o, waitMs: 2000 });
  assert.equal(first.ok, true, first.error);
  assert.ok(await until(() => control.status(o).busy));
  const second = await control.start(['b.ru'], { ...o, waitMs: 400 });
  assert.equal(second.ok, false);
  assert.match(second.error, /уже идёт/);
  assert.match(fs.readFileSync(path.join(o.logDir, 'queue-admin.log'), 'utf8'), /запуск из админки: a\.ru/);
  const r = await control.stop(control.MAIN, { ...o, graceMs: 3000 });
  assert.equal(r.still, 0);
});

test('очередь, упавшая сразу, отдаёт свою причину, а не «запущено»', async () => {
  const o = sandbox();
  fs.writeFileSync(o.queue, '#!/bin/bash\necho "нет плана"; exit 2\n', { mode: 0o755 });
  const r = await control.start(['a.ru'], { ...o, waitMs: 800 });
  assert.equal(r.ok, false);
  assert.match(r.error, /нет плана/);
});

test('запущенная очередь не потомок сайта: рестарт pm2 её не заденет', async () => {
  const o = sandbox();
  assert.equal((await control.start(['a.ru'], { ...o, waitMs: 2000 })).ok, true);
  const pid = control.status(o).locks[0].pids[0];
  const ppid = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
  assert.notEqual(ppid, process.pid);
  await control.stop(control.MAIN, { ...o, graceMs: 3000 });
});

test('остановить можно только замок сбора', async () => {
  const r = await control.stop('../../etc/passwd', { lockDir: fs.mkdtempSync(path.join(os.tmpdir(), 'parsers-')) });
  assert.equal(r.ok, false);
});

test('источник «идёт» и по хосту, и по этапу недельного крона', () => {
  const st = { locks: [{ name: 'sashalab-harvest.lock', crawling: [{ what: 'parts', pid: 1 }] }] };
  assert.ok(control.runningFor({ host: 'luxsar.ru', kind: 'parts' }, st));
  assert.equal(control.runningFor({ host: 'hltuning.ru', kind: 'works' }, st), null);
});

// ── маршрут ───────────────────────────────────────────────────────────────
function fakeReq({ method = 'GET', url = '/admin/', body = '', cookie = null } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(req, { method, url, socket: { remoteAddress: '10.0.0.1' },
    headers: { host: 'sasha-lab.ru', 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) } });
  return req;
}
function fakeRes() {
  const res = { code: null, headers: {}, body: '', headersSent: false };
  res.writeHead = (c, h = {}) => { res.code = c; res.headers = h; res.headersSent = true; return res; };
  res.end = (b = '') => { res.body += b; };
  return res;
}
const call = async (store, opts) => { const res = fakeRes(); await http.handle(fakeReq(opts), res, { store }); return res; };
async function loginAs(store, role) {
  await accounts.createUser({ email: `${role}@b.ru`, role, password: 'фара-линза-2026' }, { store });
  const r = await call(store, { method: 'POST', url: '/admin/login',
    body: new URLSearchParams({ login: `${role}@b.ru`, password: 'фара-линза-2026' }).toString() });
  return String(r.headers['Set-Cookie']).split(';')[0];
}
const msgOf = (res) => new URL(res.headers.Location, 'http://x').searchParams.get('msg') || '';

test('мастер сбор не запускает и не останавливает', async () => {
  const store = memoryAdminStore();
  await loginAs(store, 'owner');
  const cookie = await loginAs(store, 'master');
  for (const url of ['/admin/parsers/start', '/admin/parsers/stop']) {
    const r = await call(store, { method: 'POST', url, cookie, body: 'one=luxsar.ru' });
    assert.equal(r.code, 302);
    assert.match(msgOf(r), /доступов не хватает/);
  }
});

test('хост не из реестра до очереди не доезжает', async () => {
  const store = memoryAdminStore();
  const cookie = await loginAs(store, 'owner');
  const r = await call(store, { method: 'POST', url: '/admin/parsers/start', cookie,
    body: new URLSearchParams([['host', '$(reboot)'], ['host', 'www.drive2.ru']]).toString() });
  assert.match(msgOf(r), /не выбран ни один источник/, 'чужой хост и выключенный Drive2 отсеяны');
  const log = await call(store, { url: '/admin/parsers/log?host=../../etc/passwd', cookie });
  assert.match(msgOf(log), /нет такого источника/);
});
