// Управление сбором из админки: кто сейчас идёт, запустить, остановить.
//
// Правда о том, «идёт ли сбор», — не флажок в базе и не pid-файл, а ЗАМОК:
// очередь (scripts/harvest-queue.sh) и недельный крон (scripts/harvest-cron.sh)
// берут `flock /tmp/sashalab-harvest.lock`, а дочерние процессы (bash-подоболочки,
// сами `node harvest/run.js crawl`) наследуют его дескриптор. Поэтому держатели
// замка находятся честно через /proc/*/fd — и так же честно гасятся, без
// угадывания по имени процесса (pkill по шаблону уже однажды убил всё подряд).
//
// Запуск идёт ТОЛЬКО через ту же очередь под общим замком: память, nice/ionice,
// потолок кучи и «не больше одного сбора на сервер» остаются в одном месте.
// Отдельные замки /tmp/sashalab-harvest-<имя>.lock (вынесенный медленный
// источник) видны и гасятся тут же, но новые админка не заводит.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const cfg = (o = {}) => ({
  lockDir: o.lockDir || process.env.HARVEST_LOCK_DIR || '/tmp',
  lockPrefix: 'sashalab-harvest',
  queue: o.queue || path.join(ROOT, 'scripts', 'harvest-queue.sh'),
  logDir: o.logDir || process.env.HARVEST_LOGDIR || '/var/log/sashalab-harvest',
  proc: o.proc || '/proc',
});
const MAIN = 'sashalab-harvest.lock';

const readSafe = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const cmdline = (proc, pid) => (readSafe(`${proc}/${pid}/cmdline`) || '').split('\0').filter(Boolean);

// Время старта процесса: поле 22 /proc/<pid>/stat в тиках от загрузки.
let bootMs = null;
function startedAt(proc, pid) {
  const stat = readSafe(`${proc}/${pid}/stat`);
  if (!stat) return null;
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (bootMs == null) {
    const btime = /^btime (\d+)/m.exec(readSafe(`${proc}/stat`) || '');
    bootMs = btime ? Number(btime[1]) * 1000 : 0;
  }
  return bootMs ? new Date(bootMs + (Number(f[19]) / 100) * 1000) : null;
}
const pgidOf = (proc, pid) => {
  const stat = readSafe(`${proc}/${pid}/stat`);
  return stat ? Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) : null;
};

const isLock = (c, name) => name.startsWith(c.lockPrefix) && name.endsWith('.lock');

// Все процессы, у которых открыт какой-нибудь из наших замков. Чужие процессы
// (другой пользователь) не читаются — и не нужны: сбор идёт от sashaweb, как и сайт.
function holders(o = {}) {
  const c = cfg(o);
  const out = new Map();   // путь замка → [pid]
  let pids = [];
  try { pids = fs.readdirSync(c.proc).filter((d) => /^\d+$/.test(d)); } catch { return out; }
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`${c.proc}/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target;
      try { target = fs.readlinkSync(`${c.proc}/${pid}/fd/${fd}`); } catch { continue; }
      if (path.dirname(target) !== c.lockDir || !isLock(c, path.basename(target))) continue;
      if (!out.has(target)) out.set(target, []);
      if (!out.get(target).includes(Number(pid))) out.get(target).push(Number(pid));
    }
  }
  return out;
}

// Что идёт сейчас: по замку — его процессы и какие источники они качают.
function status(o = {}) {
  const c = cfg(o);
  const locks = [];
  for (const [file, pids] of holders(o)) {
    const procs = pids.map((pid) => ({ pid, argv: cmdline(c.proc, pid), started: startedAt(c.proc, pid) }));
    const crawling = procs.map((p) => {
      const i = p.argv.findIndex((a) => /harvest\/run\.js$/.test(a));
      return i >= 0 && p.argv[i + 1] === 'crawl' ? { what: p.argv[i + 2], pid: p.pid, started: p.started } : null;
    }).filter(Boolean);
    const since = procs.map((p) => p.started).filter(Boolean).sort((a, b) => a - b)[0] || null;
    locks.push({ file, name: path.basename(file), main: path.basename(file) === MAIN, pids, since, crawling });
  }
  locks.sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name));
  return { busy: locks.some((l) => l.main), locks };
}

// Состояние источника по тому, что сейчас качается: имя хоста или этап
// (недельный крон идёт по `crawl works|parts|community`).
function runningFor(src, st) {
  for (const l of st.locks) {
    for (const c of l.crawling) {
      if (c.what === src.host || c.what === src.kind) return { ...c, lock: l.name };
    }
  }
  return null;
}

function logFile(c) {
  for (const dir of [c.logDir, path.join(ROOT, '.harvest-out')]) {
    try { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'queue-admin.log'); fs.appendFileSync(f, ''); return f; } catch { /* дальше */ }
  }
  return null;
}

// Запуск очереди по перечисленным хостам. Хосты — только из реестра (проверяет
// вызывающий); замок берёт сама очередь, здесь — ранний отказ с понятным текстом.
//
// Очередь отвязывается двойным форком (`setsid -f`): pm2 на рестарте сайта гасит
// всё дерево потомков (treekill), и сбор, запущенный из админки, умирал бы при
// каждом выкате. Цена — кода выхода мы не видим, поэтому «запустилось» = очередь
// взяла общий замок за waitMs; не взяла — отдаём хвост её вывода.
async function start(hosts, { waitMs = 3000, env = {}, ...o } = {}) {
  const c = cfg(o);
  if (!hosts.length) return { ok: false, error: 'не выбран ни один источник' };
  if (status(o).busy) return { ok: false, error: 'сбор уже идёт (общий замок занят) — сначала остановите его' };
  const log = logFile(c);
  const fd = log ? fs.openSync(log, 'a') : 'ignore';
  const from = log ? fs.statSync(log).size : 0;
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.HARVEST_LOCKED;   // иначе очередь решит, что замок уже взят
  delete cleanEnv.HARVEST_LOCK;     // админка ходит только через общий замок
  if (log) fs.writeSync(fd, `\n=== ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК запуск из админки: ${hosts.join(' ')}\n`);
  const child = spawn('setsid', ['-f', c.queue, ...hosts], { cwd: ROOT, env: cleanEnv, detached: true, stdio: ['ignore', fd, fd] });
  if (typeof fd === 'number') fs.closeSync(fd);
  child.on('error', () => {});
  child.unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (status(o).busy) return { ok: true, log };
    await new Promise((r) => setTimeout(r, 150));
  }
  let said = '';
  if (log) { try { said = fs.readFileSync(log, 'utf8').slice(from).trim().split('\n').filter((l) => !/^===/.test(l)).slice(-3).join(' / '); } catch { /* пусто */ } }
  if (/уже идёт/.test(said)) return { ok: false, error: 'сбор уже идёт (общий замок занят)', log };
  return { ok: false, error: `очередь не взяла замок${said ? `: ${said}` : ' — см. лог очереди'}`, log };
}

// Остановка: TERM всем держателям замка и их группам процессов (очередь живёт
// своей группой), через graceMs — KILL тем, кто не вышел. Сбор инкрементальный:
// собранное уже в базе, следующий запуск продолжит с места обрыва.
async function stop(lockName = MAIN, { graceMs = 10000, ...o } = {}) {
  const c = cfg(o);
  const file = path.join(c.lockDir, path.basename(lockName));
  if (!isLock(c, path.basename(file))) return { ok: false, error: 'это не замок сбора' };
  const pids = holders(o).get(file) || [];
  if (!pids.length) return { ok: true, stopped: 0, note: 'сбор под этим замком не идёт' };
  const own = new Set([process.pid, pgidOf(c.proc, process.pid)]);
  const groups = new Set(pids.map((p) => pgidOf(c.proc, p)).filter((g) => g > 1 && !own.has(g)));
  const kill = (sig) => {
    for (const g of groups) { try { process.kill(-g, sig); } catch { /* уже нет */ } }
    for (const p of pids) { if (!own.has(p)) { try { process.kill(p, sig); } catch { /* уже нет */ } } }
  };
  kill('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && (holders(o).get(file) || []).length) await new Promise((r) => setTimeout(r, 250));
  const left = holders(o).get(file) || [];
  if (left.length) {
    for (const p of left) { if (!own.has(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* уже нет */ } } }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: true, stopped: pids.length, killed: left.length, still: (holders(o).get(file) || []).length };
}

// Хвост лога источника (очередь пишет каждый сбор в <logDir>/<host>.log).
function tail(name, { lines = 80, ...o } = {}) {
  const c = cfg(o);
  const f = path.join(c.logDir, `${path.basename(name)}.log`);
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { file: f, text: buf.toString('utf8').split('\n').slice(-lines - 1).join('\n') };
  } catch { return { file: f, text: null }; } finally { if (fd != null) fs.closeSync(fd); }
}

module.exports = { status, holders, runningFor, start, stop, tail, MAIN };
