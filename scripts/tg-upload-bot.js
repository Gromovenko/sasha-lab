#!/usr/bin/env node
// Приём файлов и фото через Telegram-бота Sasha_Lab_Bot (long polling).
//
// Пишет ТОЛЬКО на диск RU в /opt/sasha-lab/uploads/<папка>/ и никуда не
// публикует. Принимает сообщения строго из чата TELEGRAM_CHAT_ID (владелец);
// всё остальное молча игнорируется. Ходит в Telegram через SSH-туннель
// sashalab-tgtunnel (127.0.0.1:8443 -> EU -> api.telegram.org:443): TLS
// сквозной, имя хоста для проверки сертификата остаётся api.telegram.org.
//
// Папка: хэштег в подписи (#feed, #образцы) или липкая папка из /cat <имя>,
// по умолчанию inbox. Альбом из нескольких фото наследует папку первого кадра.
// Лимит Bot API на скачивание — 20 МБ; фото Telegram сжимает, оригинал
// нужно слать как «файл».
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = process.env.UPLOAD_DIR || '/opt/sasha-lab/uploads';
const ENV_FILE = process.env.ENV_FILE || '/opt/sasha-lab/seo/.env';
const TG_PORT = Number(process.env.TG_PORT || 8443);
const MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_CAT = 'inbox';

// ── чистые помощники (покрыты тестом) ────────────────────────────────────────
function safeName(name, fallback) {
  const base = path.basename(String(name || '')).normalize('NFC')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^[.\s]+/, '').slice(-100);
  return base || fallback;
}
function safeCat(c) {
  const s = String(c || '').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '').slice(0, 40);
  return s || null;
}
function catFromCaption(caption) {
  const m = /(?:^|\s)#([\p{L}\p{N}_-]+)/u.exec(caption || '');
  return m ? safeCat(m[1]) : null;
}
function stamp(unix) {
  const d = new Date((unix || Date.now() / 1000) * 1000 + 3 * 3600 * 1000); // МСК
  return d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}
function human(n) {
  return n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ';
}
// Что именно в сообщении и как это назвать. null — нечего сохранять.
function pickMedia(m) {
  if (m.photo && m.photo.length) {
    const p = m.photo.reduce((a, b) => ((b.file_size || 0) >= (a.file_size || 0) ? b : a));
    return { id: p.file_id, size: p.file_size || 0, name: 'photo.jpg', kind: 'фото (сжато Telegram)' };
  }
  const d = m.document || m.video || m.audio || m.voice || m.video_note || m.animation;
  if (!d) return null;
  const ext = m.voice ? '.ogg' : (m.video || m.video_note || m.animation) ? '.mp4' : '';
  return { id: d.file_id, size: d.file_size || 0, name: d.file_name || ('file' + ext), kind: 'файл' };
}

module.exports = { safeName, safeCat, catFromCaption, stamp, pickMedia, human };
if (require.main !== module) return;

// ── рабочая часть ────────────────────────────────────────────────────────────
function readEnv() {
  const out = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const env = readEnv();
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const OWNER = String(env.TELEGRAM_CHAT_ID || '');
if (!TOKEN || !OWNER) { console.error('нет TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID в .env'); process.exit(1); }

process.umask(0o027);
fs.mkdirSync(ROOT, { recursive: true, mode: 0o750 });
const STATE = path.join(ROOT, '.bot-state.json');
let state = { offset: 0, cat: DEFAULT_CAT };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch { /* первый запуск */ }
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function req(pathname, { method = 'GET', body, timeout = 40000, sink } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: '127.0.0.1', port: TG_PORT, servername: 'api.telegram.org', method,
      path: pathname, headers: { Host: 'api.telegram.org', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      timeout,
    }, (res) => {
      if (sink) {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        let n = 0;
        res.on('data', (c) => { n += c.length; if (n > MAX_BYTES) res.destroy(new Error('слишком большой')); });
        res.on('error', reject); sink.on('error', reject);
        sink.on('finish', () => resolve(n)); res.pipe(sink);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('не JSON, HTTP ' + res.statusCode)); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('таймаут')));
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const api = (method, params, timeout) => req(`/bot${TOKEN}/${method}`, { method: 'POST', body: params || {}, timeout });

// ответы копим 2,5 с, чтобы альбом из 10 фото дал одно сообщение
const pending = [];
let flushTimer = null;
function reply(text) {
  pending.push(text);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    const text = pending.splice(0).join('\n').slice(0, 4000);
    try { await api('sendMessage', { chat_id: OWNER, text, disable_web_page_preview: true }); }
    catch (e) { log('sendMessage:', e.message); }
  }, 2500);
}

const albumCat = new Map(); // media_group_id -> папка первого кадра

function listUploads() {
  const rows = [];
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const files = fs.readdirSync(path.join(ROOT, d.name), { withFileTypes: true }).filter((f) => f.isFile());
    const bytes = files.reduce((s, f) => s + fs.statSync(path.join(ROOT, d.name, f.name)).size, 0);
    rows.push(`${d.name}: ${files.length} шт., ${human(bytes)}`);
  }
  return rows.length ? rows.join('\n') : 'Пока ничего не загружено.';
}

async function saveMedia(m, media, cat) {
  if (media.size > MAX_BYTES) {
    return reply(`✗ ${safeName(media.name, 'файл')}: ${human(media.size)} — больше лимита Telegram-бота (20 МБ). Для больших файлов нужен другой канал.`);
  }
  const info = await api('getFile', { file_id: media.id });
  if (!info.ok) {
    return reply(`✗ ${safeName(media.name, 'файл')}: ${info.description || 'Telegram не отдал файл'}`);
  }
  const dir = path.join(ROOT, cat);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const fname = `${stamp(m.date)}_${m.message_id}_${safeName(media.name, 'file')}`;
  const dest = path.join(dir, fname);
  const tmp = dest + '.part';
  try {
    const n = await req(`/file/bot${TOKEN}/${info.result.file_path}`, { sink: fs.createWriteStream(tmp, { mode: 0o640 }), timeout: 120000 });
    fs.renameSync(tmp, dest);
    log('сохранён', path.join(cat, fname), n);
    reply(`✓ ${cat}/${fname} (${human(n)})${media.kind.startsWith('фото') ? ' — фото сжато Telegram, оригинал шлите как «файл»' : ''}`);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    log('ошибка загрузки', fname, e.message);
    reply(`✗ ${fname}: ${e.message}`);
  }
}

async function handle(u) {
  const m = u.message;
  if (!m) return;
  if (String(m.chat.id) !== OWNER || String(m.from && m.from.id) !== OWNER) return; // чужие — молча
  const text = m.text || '';
  const media = pickMedia(m);

  if (!media) {
    if (/^\/(start|help)\b/.test(text)) {
      return reply('Пришлите фото или файл — сохраню на сервер. Папка: хэштег в подписи (#feed, #образцы) или команда /cat <имя> (запоминается). Без неё — inbox.\n' +
        'Фото Telegram сжимает: оригиналы шлите как «файл». Лимит 20 МБ.\nКоманды: /cat <имя> — папка по умолчанию, /list — что загружено. Обычный текст сохраняю как заметку (.txt).');
    }
    if (/^\/list\b/.test(text)) return reply(listUploads());
    const c = /^\/cat(?:@\w+)?(?:\s+(\S+))?/.exec(text);
    if (c) {
      const cat = safeCat(c[1]);
      if (!cat) return reply(`Сейчас папка по умолчанию: ${state.cat}. Сменить: /cat feed`);
      state.cat = cat; saveState();
      return reply(`Папка по умолчанию: ${cat}`);
    }
    if (text && !text.startsWith('/')) {
      const cat = catFromCaption(text) || state.cat;
      const dir = path.join(ROOT, cat);
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      const fname = `${stamp(m.date)}_${m.message_id}_note.txt`;
      fs.writeFileSync(path.join(dir, fname), text, { mode: 0o640 });
      log('заметка', path.join(cat, fname));
      return reply(`✓ заметка ${cat}/${fname}`);
    }
    return;
  }

  let cat = catFromCaption(m.caption);
  if (m.media_group_id) {
    if (cat) albumCat.set(m.media_group_id, cat);
    else cat = albumCat.get(m.media_group_id) || null;
    if (albumCat.size > 200) albumCat.delete(albumCat.keys().next().value);
  }
  await saveMedia(m, media, cat || state.cat);
}

async function main() {
  log('старт, папка по умолчанию', state.cat, ', offset', state.offset);
  for (;;) {
    let r;
    try {
      r = await api('getUpdates', { offset: state.offset, timeout: 30, allowed_updates: ['message'] }, 45000);
    } catch (e) {
      log('getUpdates:', e.message);
      await new Promise((ok) => setTimeout(ok, 10000));
      continue;
    }
    if (!r.ok) { log('getUpdates:', r.description); await new Promise((ok) => setTimeout(ok, 15000)); continue; }
    for (const u of r.result) {
      try { await handle(u); } catch (e) { log('handle:', e.message); }
      state.offset = u.update_id + 1; saveState();
    }
  }
}
main();
