// Телеграм-канал как источник. Два входа, оба без бота и без прав в канале.
//
//   1) fromWeb — публичное веб-превью t.me/s/<канал>. Работает только для
//      открытых каналов, отдаёт постранично назад по id (?before=). Это самый
//      дешёвый способ: ни ключей, ни аккаунта. Ограничение честное — превью
//      не отдаёт комментарии к постам, а в чате про ремонт фар половина смысла
//      именно в обсуждении.
//   2) fromExport — файл result.json из «Экспорт истории» Telegram Desktop.
//      Полнее (есть все сообщения и обсуждения), но выгрузку делает человек
//      руками. Для канала с двухлетней историей это правильный первый заход,
//      дальше догоняем через fromWeb.
const fs = require('fs');
const http = require('./http');
const html = require('./html');
const store = require('./store');

const MIN = 120;   // короче — «спасибо», «+», «где взять» без ответа; в базе бесполезно

async function ensure(channel) {
  return store.ensureSource({
    host: `t.me/${channel}`, kind: 'telegram', title: `Telegram @${channel}`,
    delayMs: 3000, maxPages: 1000,
    note: 'публичное превью t.me/s/ или экспорт Telegram Desktop; комментарии превью не отдаёт',
  });
}

// ── публичное превью ───────────────────────────────────────────────────────
function parsePreview(body, channel) {
  const out = [];
  for (const m of body.matchAll(/<div class="tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"([\s\S]*?)(?=<div class="tgme_widget_message\b|<\/section>)/g)) {
    const post = m[1];
    const chunk = m[2];
    const t = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!t) continue;
    const date = (chunk.match(/<time[^>]+datetime="([^"]+)"/) || [])[1];
    out.push({
      id: Number(post.split('/')[1]) || null,
      url: `https://t.me/${post}`,
      text: html.strip(t[1]),
      published_at: date ? new Date(date) : null,
    });
  }
  return out;
}

async function fromWeb(channel, { pages = 10, delayMs = 3000 } = {}) {
  const src = await ensure(channel);
  const stat = { channel, fetched: 0, saved: 0, short: 0 };
  let before = null;
  for (let i = 0; i < pages; i += 1) {
    const url = `https://t.me/s/${channel}${before ? `?before=${before}` : ''}`;
    const r = await http.get(url, { delayMs, ua: http.BROWSER_UA, maxAgeDays: 1 });
    if (r.status !== 200) break;
    const posts = parsePreview(r.body, channel);
    if (!posts.length) break;
    stat.fetched += posts.length;
    for (const p of posts) {
      if (p.text.length < MIN) { stat.short += 1; continue; }
      await store.saveDocument({
        source_id: src.id, url: p.url, http_status: 200,
        title: p.text.slice(0, 120), published_at: p.published_at, text: p.text,
        meta: { kind: 'telegram', channel },
      });
      stat.saved += 1;
    }
    before = Math.min(...posts.map((p) => p.id).filter(Boolean));
    if (!Number.isFinite(before) || before <= 1) break;
  }
  return stat;
}

// ── экспорт Telegram Desktop ───────────────────────────────────────────────
const flatten = (t) => Array.isArray(t)
  ? t.map((x) => (typeof x === 'string' ? x : x.text || '')).join('')
  : String(t || '');

async function fromExport(file, { channel } = {}) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const name = channel || data.name || 'export';
  const src = await ensure(name);
  const stat = { channel: name, messages: (data.messages || []).length, saved: 0, short: 0 };
  for (const m of data.messages || []) {
    const text = flatten(m.text).trim();
    if (text.length < MIN) { stat.short += 1; continue; }
    await store.saveDocument({
      source_id: src.id,
      url: `https://t.me/${name}/${m.id}`,
      http_status: 200,
      title: text.slice(0, 120),
      author: m.from || null,
      published_at: m.date ? new Date(m.date) : null,
      text,
      meta: { kind: 'telegram', channel: name, reply_to: m.reply_to_message_id || null },
    });
    stat.saved += 1;
  }
  return stat;
}

module.exports = { fromWeb, fromExport, parsePreview };
