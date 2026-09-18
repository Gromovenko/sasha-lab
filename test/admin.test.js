// Раздел /admin: вход, роли, сессии и восстановление пароля.
//
// Базы тут нет намеренно (хранилище — в памяти): проверяется ровно то, что
// ломает доступ к системе и утекает наружу — подбор пароля, живучесть чужой
// сессии после смены пароля, одноразовость ссылки восстановления и то, что
// клиент не попадает в админку.
const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');

process.env.SASHALAB_PG_URL = process.env.SASHALAB_PG_URL || 'postgres://test/notused';
process.env.ADMIN_LOG_CONSOLE = '0';          // тесты не засоряют вывод журналом

const accounts = require('../admin/accounts');
const http = require('../admin/http');
const { memoryAdminStore } = require('../admin/memory-store');

const newStore = () => memoryAdminStore();
// Доставка ссылки подменяется: в тестах нет ни почты, ни СМС, а проверять надо
// саму ссылку, а не канал.
const catcher = () => { const box = {}; return { box, deliver: async ({ link }) => { box.link = link; return { ok: true, via: 'test' }; } }; };

// ── пароли ────────────────────────────────────────────────────────────────
test('пароль хранится хэшем и проверяется', () => {
  const h = accounts.hashPassword('коробка-передач-7');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(!h.includes('коробка'));
  assert.ok(accounts.verifyPassword('коробка-передач-7', h));
  assert.ok(!accounts.verifyPassword('коробка-передач-8', h));
  assert.ok(!accounts.verifyPassword('что угодно', null));
});

test('слабый пароль не принимается', () => {
  assert.ok(accounts.passwordProblem('1234567'));
  assert.ok(accounts.passwordProblem('12345678'));
  assert.ok(accounts.passwordProblem('987654321'));
  assert.equal(accounts.passwordProblem('фара-линза-2026'), null);
});

// ── вход ──────────────────────────────────────────────────────────────────
test('вход по почте и по телефону в любом написании', async () => {
  const store = newStore();
  await accounts.createUser({ email: 'Master@Sasha-Lab.ru', phone: '+7 (909) 888-75-75', name: 'Мастер', role: 'master', password: 'фара-линза-2026' }, { store });
  for (const login of ['master@sasha-lab.ru', '79098887575', '8 909 888 75 75']) {
    const r = await accounts.login({ login, password: 'фара-линза-2026' }, { store });
    assert.ok(r.ok, `не вошёл по ${login}`);
  }
  const bad = await accounts.login({ login: 'master@sasha-lab.ru', password: 'не тот' }, { store });
  assert.equal(bad.ok, false);
  // Ответ на несуществующий логин не отличается от ответа на неверный пароль:
  // иначе форма входа работает как справочник клиентов студии.
  const none = await accounts.login({ login: 'never@sasha-lab.ru', password: 'не тот' }, { store });
  assert.equal(none.error, bad.error);
});

test('перебор пароля упирается в блокировку', async () => {
  const store = newStore();
  const u = await accounts.createUser({ email: 'a@b.ru', role: 'master', password: 'фара-линза-2026' }, { store });
  for (let i = 0; i < accounts.MAX_FAILS; i++) await accounts.login({ login: 'a@b.ru', password: 'мимо' }, { store });
  const r = await accounts.login({ login: 'a@b.ru', password: 'фара-линза-2026' }, { store });
  assert.equal(r.ok, false, 'после серии промахов пускать нельзя даже с верным паролем');
  assert.match(r.error, /попыток/i);
  const row = await store.users.byId(u.id);
  assert.ok(row.locked_until);
});

test('заблокированную учётку не пускают', async () => {
  const store = newStore();
  await accounts.createUser({ email: 'ex@b.ru', role: 'master', password: 'фара-линза-2026' }, { store });
  const u = await store.users.byEmail('ex@b.ru');
  await store.users.update(u.id, { status: 'blocked' });
  assert.equal((await accounts.login({ login: 'ex@b.ru', password: 'фара-линза-2026' }, { store })).ok, false);
});

// ── сессии ────────────────────────────────────────────────────────────────
test('сессия живёт до выхода, смена пароля выбивает все', async () => {
  const store = newStore();
  const u = await accounts.createUser({ email: 'o@b.ru', role: 'owner', password: 'фара-линза-2026' }, { store });
  const a = await accounts.login({ login: 'o@b.ru', password: 'фара-линза-2026' }, { store });
  const b = await accounts.login({ login: 'o@b.ru', password: 'фара-линза-2026' }, { store });
  assert.equal((await accounts.session(a.token, { store })).id, u.id);

  await accounts.logout(a.token, { store });
  assert.equal(await accounts.session(a.token, { store }), null);
  assert.ok(await accounts.session(b.token, { store }), 'выход на одном устройстве не трогает другие');

  await accounts.setPassword(u.id, 'новый-пароль-2026', { store });
  assert.equal(await accounts.session(b.token, { store }), null, 'после смены пароля старые сессии обязаны умереть');
});

test('подделанный токен сессии не работает', async () => {
  const store = newStore();
  await accounts.createUser({ email: 'o@b.ru', role: 'owner', password: 'фара-линза-2026' }, { store });
  const a = await accounts.login({ login: 'o@b.ru', password: 'фара-линза-2026' }, { store });
  assert.equal(await accounts.session(`${a.token}x`, { store }), null);
  assert.equal(await accounts.session('', { store }), null);
});

// ── восстановление пароля ─────────────────────────────────────────────────
test('ссылка восстановления одноразовая и меняет пароль', async () => {
  const store = newStore();
  const { box, deliver } = catcher();
  await accounts.createUser({ email: 'lost@b.ru', role: 'master', password: 'фара-линза-2026' }, { store });
  const r = await accounts.requestReset({ login: 'lost@b.ru', origin: 'https://sasha-lab.ru', deliver }, { store });
  assert.equal(r.sent, true);
  const token = new URL(box.link).searchParams.get('token');

  assert.equal((await accounts.resetPassword({ token, password: '1234' }, { store })).ok, false, 'слабый пароль не проходит');
  const ok = await accounts.resetPassword({ token, password: 'другой-пароль-2026' }, { store });
  assert.equal(ok.ok, true);
  assert.equal((await accounts.login({ login: 'lost@b.ru', password: 'другой-пароль-2026' }, { store })).ok, true);
  // Повторный переход по той же ссылке не должен менять пароль второй раз.
  const again = await accounts.resetPassword({ token, password: 'третий-пароль-2026' }, { store });
  assert.equal(again.ok, false);
  assert.equal((await accounts.login({ login: 'lost@b.ru', password: 'третий-пароль-2026' }, { store })).ok, false);
});

test('восстановление по неизвестному контакту отвечает так же, но ничего не делает', async () => {
  const store = newStore();
  const { box, deliver } = catcher();
  const r = await accounts.requestReset({ login: 'никого@нет.ру', origin: 'https://sasha-lab.ru', deliver }, { store });
  assert.equal(r.ok, true);
  assert.equal(r.sent, false);
  assert.equal(box.link, undefined);
});

test('форму восстановления нельзя превратить в рассылку', async () => {
  const store = newStore();
  const { deliver } = catcher();
  await accounts.createUser({ email: 'spam@b.ru', role: 'client', password: 'фара-линза-2026' }, { store });
  const sent = [];
  for (let i = 0; i < 5; i++) sent.push((await accounts.requestReset({ login: 'spam@b.ru', deliver }, { store })).sent);
  assert.deepEqual(sent, [true, true, true, false, false]);
});

// ── роли ──────────────────────────────────────────────────────────────────
test('роли: клиент не сотрудник, мастер не владелец', () => {
  assert.equal(accounts.isStaff({ role: 'client' }), false);
  assert.equal(accounts.isStaff({ role: 'master' }), true);
  assert.equal(accounts.atLeast({ role: 'master' }, 'owner'), false);
  assert.equal(accounts.atLeast({ role: 'owner' }, 'admin'), true);
  assert.equal(accounts.isStaff(null), false);
});

// ── журнал ────────────────────────────────────────────────────────────────
test('журнал пишет события и не падает на мёртвом хранилище', async () => {
  const store = newStore();
  await accounts.createUser({ email: 'j@b.ru', role: 'master', password: 'фара-линза-2026' }, { store });
  await accounts.login({ login: 'j@b.ru', password: 'мимо' }, { store });
  await accounts.login({ login: 'j@b.ru', password: 'фара-линза-2026' }, { store });
  const rows = await store.events.list({ area: 'auth' });
  assert.ok(rows.some((e) => e.action === 'login.ok'));
  assert.ok(rows.some((e) => e.action === 'login.fail'));

  const broken = { events: { add: async () => { throw new Error('база легла'); } } };
  await require('../admin/log').info({ area: 'system', action: 'проверка' }, { store: broken });  // не должно бросить
});

// ── маршруты ──────────────────────────────────────────────────────────────
function fakeReq({ method = 'GET', url = '/admin/', body = '', cookie = null } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: 'sasha-lab.ru', 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) };
  req.socket = { remoteAddress: '10.0.0.1' };
  return req;
}
function fakeRes() {
  const res = { code: null, headers: {}, body: '', headersSent: false };
  res.writeHead = (c, h = {}) => { res.code = c; res.headers = h; res.headersSent = true; return res; };
  res.end = (b = '') => { res.body += b; };
  return res;
}
const call = async (store, opts) => { const res = fakeRes(); await http.handle(fakeReq(opts), res, { store }); return res; };
const cookieOf = (res) => String(res.headers['Set-Cookie'] || '').split(';')[0];

test('пустой контур просит завести владельца, потом форма исчезает', async () => {
  const store = newStore();
  const first = await call(store, { url: '/admin/' });
  assert.match(first.body, /Первый вход/);

  const made = await call(store, { method: 'POST', url: '/admin/setup',
    body: new URLSearchParams({ name: 'Саша', email: 'owner@sasha-lab.ru', password: 'фара-линза-2026' }).toString() });
  assert.equal(made.code, 302);
  assert.equal(made.headers.Location, '/admin/');
  assert.ok(cookieOf(made).startsWith('sasha_admin='));

  const after = await call(store, { url: '/admin/login' });
  assert.doesNotMatch(after.body, /Первый вход/, 'второй владелец с улицы заводиться не должен');
});

test('в админку без входа не пускают, клиента уводят в кабинет', async () => {
  const store = newStore();
  await accounts.createUser({ email: 'owner@b.ru', role: 'owner', password: 'фара-линза-2026' }, { store });
  const closed = await call(store, { url: '/admin/deals' });
  assert.equal(closed.code, 302);
  assert.equal(closed.headers.Location, '/admin/login');

  await accounts.createUser({ email: 'client@b.ru', role: 'client', password: 'фара-линза-2026' }, { store });
  const logged = await call(store, { method: 'POST', url: '/admin/login',
    body: new URLSearchParams({ login: 'client@b.ru', password: 'фара-линза-2026' }).toString() });
  assert.equal(logged.headers.Location, '/cabinet/', 'клиенту в админке делать нечего');

  const sneak = await call(store, { url: '/admin/users', cookie: cookieOf(logged) });
  assert.equal(sneak.headers.Location, '/cabinet/');
});

test('сессия админки годится как пропуск в старые панели', async () => {
  const store = newStore();
  await accounts.createUser({ email: 'm@b.ru', role: 'master', password: 'фара-линза-2026' }, { store });
  const logged = await call(store, { method: 'POST', url: '/admin/login',
    body: new URLSearchParams({ login: 'm@b.ru', password: 'фара-линза-2026' }).toString() });
  assert.equal(await http.staffOk(fakeReq({ cookie: cookieOf(logged) }), { store }), true);
  assert.equal(await http.staffOk(fakeReq({ cookie: 'sasha_admin=подделка' }), { store }), false);
  assert.equal(await http.staffOk(fakeReq({}), { store }), false);
});

test('форма восстановления не выдаёт, есть ли такой человек', async () => {
  const store = newStore();
  await accounts.createUser({ email: 'real@b.ru', role: 'master', password: 'фара-линза-2026' }, { store });
  const a = await call(store, { method: 'POST', url: '/admin/forgot', body: new URLSearchParams({ login: 'real@b.ru' }).toString() });
  const b = await call(store, { method: 'POST', url: '/admin/forgot', body: new URLSearchParams({ login: 'fake@b.ru' }).toString() });
  assert.equal(a.body, b.body);
});

test('строковый id из postgres не превращает «это я» в «это не я»', async () => {
  // bigint приезжает из pg строкой, а тот же id из row_to_json — числом.
  // На строгом равенстве владелец однажды заблокировал сам себя; здесь эта
  // разница воспроизводится нарочно.
  const base = newStore();
  const store = { ...base, users: { ...base.users, byId: async (id) => {
    const u = await base.users.byId(id);
    return u ? { ...u, id: String(u.id) } : null;
  } } };
  const owner = await accounts.createUser({ email: 'owner@b.ru', role: 'owner', password: 'фара-линза-2026' }, { store: base });
  const logged = await call(store, { method: 'POST', url: '/admin/login',
    body: new URLSearchParams({ login: 'owner@b.ru', password: 'фара-линза-2026' }).toString() });
  const res = await call(store, { method: 'POST', url: '/admin/users/status', cookie: cookieOf(logged),
    body: new URLSearchParams({ id: String(owner.id), status: 'blocked' }).toString() });
  assert.match(decodeURIComponent(res.headers.Location), /себя блокировать нельзя/);
  assert.equal((await base.users.byId(owner.id)).status, 'active');
});
