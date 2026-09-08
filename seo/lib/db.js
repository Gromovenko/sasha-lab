// Подключение к базе проекта. Адрес — SASHALAB_PG_URL (seo/.env на сервере).
//
// Базы может не быть: на EU это дерево используется как dev-копия без реальных
// данных (152-ФЗ — контакты живых людей только на RU). Тогда db.enabled === false,
// зеркало и сборка базы знаний из файлов работают, а панель и форма вопроса
// честно говорят, что хранилища нет, вместо того чтобы падать пятисоткой.
const { Pool } = require('pg');

const URL = process.env.SASHALAB_PG_URL || '';
let pool = null;

function get() {
  if (!URL) throw new Error('база не настроена: нет SASHALAB_PG_URL');
  if (!pool) {
    pool = new Pool({
      connectionString: URL,
      max: Number(process.env.SASHALAB_PG_POOL || 6),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (e) => console.error('pg pool:', e.message));
  }
  return pool;
}

async function q(sql, params = []) {
  const r = await get().query(sql, params);
  return r.rows;
}

async function one(sql, params = []) {
  return (await q(sql, params))[0] || null;
}

async function tx(fn) {
  const c = await get().connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* соединение уже мертво */ }
    throw e;
  } finally {
    c.release();
  }
}

async function close() { if (pool) await pool.end(); pool = null; }

module.exports = { q, one, tx, close, get, get enabled() { return Boolean(URL); } };
