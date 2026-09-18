#!/usr/bin/env node
// Раздел /admin с сервера: завести человека, выдать ссылку на пароль, посмотреть
// журнал, почистить старое. Нужен ровно тогда, когда в панель не войти:
// первый выкат, потерянный доступ, не настроенный ни один канал доставки.
require('../server-env')(require('path').join(__dirname, '..', 'seo', '.env'));
const accounts = require('./accounts');
const store = require('./store');
const log = require('./log');
const db = require('../seo/lib/db');

const args = process.argv.slice(3);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '1') : def;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const when = (t) => (t ? new Date(t).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—');
const title = (u) => `${u.name || '—'} <${u.email || u.phone}> ${u.role}${u.status === 'blocked' ? ' ЗАБЛОКИРОВАН' : ''}${u.password_hash ? '' : ' (пароль не задан)'}`;

async function findUser(login) {
  const u = await store.users.byLogin(login);
  if (!u) throw new Error(`не найден: ${login}`);
  return u;
}

const commands = {
  async create() {
    const password = flag('password') || accounts.token().slice(0, 14);
    const u = await accounts.createUser({
      email: flag('email'), phone: flag('phone'), name: flag('name'),
      role: flag('role', 'master'), password,
    }, { actor: 'cli' });
    console.log(`создан: ${title(u)}`);
    if (!flag('password')) console.log(`пароль (покажите один раз и смените): ${password}`);
  },

  async list() {
    const rows = await store.users.list({ role: flag('role'), limit: Number(flag('limit', 100)) });
    for (const u of rows) console.log(`#${u.id}\t${title(u)}\tвход: ${when(u.last_login_at)}`);
    const s = await store.users.stats();
    console.log(`\nвсего ${s.total}: сотрудников ${s.staff}, клиентов ${s.clients}, заблокировано ${s.blocked}, без пароля ${s.invited}`);
  },

  // Ссылка печатается в консоль и НЕ уходит ни в какой канал: это ручной путь
  // владельца на случай, когда почта и СМС не настроены.
  async 'reset-link'() {
    const u = await findUser(positional[0]);
    const base = flag('url', process.env.CRM_URL || 'https://sasha-lab.ru');
    const t = accounts.token();
    await store.resets.create({ userId: u.id, tokenHash: accounts.fingerprint(t),
      expiresAt: new Date(Date.now() + accounts.RESET_MINUTES() * 60000), sentVia: 'cli' });
    await log.security({ area: 'admin', action: 'reset.cli', userId: u.id, actor: 'cli' });
    console.log(`${base}/admin/reset?token=${t}`);
    console.log(`действует ${accounts.RESET_MINUTES()} мин, сработает один раз`);
  },

  async passwd() {
    const u = await findUser(positional[0]);
    const password = positional[1] || flag('password') || accounts.token().slice(0, 14);
    await accounts.setPassword(u.id, password, { actor: 'cli' });
    console.log(`пароль сменён: ${title(u)}`);
    if (!positional[1] && !flag('password')) console.log(`новый пароль: ${password}`);
  },

  async kick() {
    const u = await findUser(positional[0]);
    await store.sessions.revokeAllFor(u.id);
    await log.security({ area: 'admin', action: 'user.kick', userId: u.id, actor: 'cli' });
    console.log(`сессии закрыты: ${title(u)}`);
  },

  async log() {
    const rows = await store.events.list({ area: flag('area'), level: flag('level'), limit: Number(flag('limit', 50)) });
    for (const e of rows.reverse()) {
      console.log(`${when(e.at)}\t${e.level}\t${e.area}\t${e.action}\t${e.actor || ''}\t${e.message || ''}`);
    }
  },

  async purge() {
    const days = Number(flag('days', process.env.ADMIN_LOG_DAYS || 180));
    await store.events.purge(days);
    await store.sessions.purge();
    console.log(`журнал старше ${days} дн и протухшие сессии удалены`);
  },
};

async function main() {
  const cmd = process.argv[2];
  if (!cmd || !commands[cmd]) {
    console.log(`Раздел /admin с сервера:
  node admin/cli.js create --name Имя --email a@b.ru --phone 79098887575 --role owner|admin|master|client [--password ...]
  node admin/cli.js list [--role client] [--limit 100]
  node admin/cli.js reset-link <почта|телефон> [--url https://sasha-lab.ru]   ссылка на смену пароля в консоль
  node admin/cli.js passwd <почта|телефон> [новый пароль]
  node admin/cli.js kick <почта|телефон>                                      закрыть все его сессии
  node admin/cli.js log [--area auth] [--level error] [--limit 50]
  node admin/cli.js purge [--days 180]                                        чистка журнала и сессий`);
    process.exit(cmd ? 1 : 0);
  }
  if (!db.enabled) throw new Error('не задан SASHALAB_PG_URL (seo/.env)');
  await commands[cmd]();
}

main().then(() => db.close()).catch((e) => { console.error('ошибка:', e.message); db.close(); process.exit(1); });
