// Разбор ВСЕЙ переписки в Авито: что у нас спрашивают, как быстро мы отвечаем
// и сколько обращений ушло в пустоту.
//
// Зачем это отдельным файлом, а не «посмотреть глазами»: автодиалог должен
// отвечать на то, что спрашивают на самом деле, а не на то, что кажется. Отчёт
// даёт три вещи: доля брошенных чатов (цена бездействия), медиана первого
// ответа (с чем сравнивать движок) и список повторяющихся вопросов —
// готовый материал для `packs/<id>.json` (wants, photos.checklist, правила).
//
// Сбор (сеть) и разбор (чистые функции) разведены: отчёт считается и
// проверяется тестом на сохранённом дампе, без ключей и без Авито.
const fs = require('fs');
const path = require('path');
const avito = require('./channels/avito');

const HOUR = 3600 * 1000;
const MSK = 3 * HOUR;

// Повторяющиеся темы клиентских вопросов. Список короткий и явный: это то, что
// человек читает и правит, а не «кластеризация», в которую нельзя ткнуть пальцем.
const TOPICS = [
  { code: 'price', label: 'цена / сколько стоит', re: /(сколько|цена|стоит|стоимость|прайс|почём|почем|дорого|ценник)/i },
  { code: 'model', label: 'подойдёт ли на мою машину', re: /(подойд|встанет|под мою|на мою|совместим|какие линзы|что посовет)/i },
  { code: 'time', label: 'сроки и запись', re: /(когда|сколько по времени|за сколько|успе|запис|очеред|свободн|завтра|сегодня|график|во сколько)/i },
  { code: 'place', label: 'адрес и как доехать', re: /(адрес|где вы|как проехать|как доехать|навигат|район|улиц)/i },
  { code: 'warranty', label: 'гарантия и качество', re: /(гаранти|сгор|брак|отзыв|надолго|ресурс)/i },
  { code: 'legal', label: 'законность и техосмотр', re: /(закон|гибдд|штраф|лишен|техосмотр|сертификат|разреш)/i },
  { code: 'photo', label: 'просьба/присылка фото', re: /(фото|фотк|скинь|пришл|покаж)/i },
  { code: 'parts', label: 'что именно ставим (линзы, лампы, обманки)', re: /(линз|биксенон|bi-?led|модул|лампы?|обманк|блок розжига|стекл|маск)/i },
  { code: 'repair', label: 'ремонт: запотевание, полировка, корпус', re: /(полиров|поте(е|ю|л)|запотев|влаг|конденсат|треснул|восстанов|замена стекл|клей|герметик|мутн|желт)/i },
  { code: 'delivery', label: 'иногородние и пересылка', re: /(отправ|доставк|транспортн|сдэк|почт|из друг|иногородн)/i },
];

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const ms = (v) => {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000; // Авито отдаёт секунды
  const d = Date.parse(v);
  return Number.isFinite(d) ? d : null;
};

const human = (msec) => {
  if (msec == null) return '—';
  const m = Math.round(msec / 60000);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} ч ${m % 60} мин` : `${Math.round(h / 24)} сут`;
};

// ── сбор ───────────────────────────────────────────────────────────────────
async function fetchAll({ max = 500, perChat = 100, onProgress = null } = {}) {
  const uid = await avito.userId();
  const chats = await avito.allChats({ max });
  const dialogs = [];
  for (const [i, c] of chats.entries()) {
    let msgs = [];
    try { msgs = await avito.messages(c.id, { limit: perChat }); }
    catch (e) { msgs = []; dialogs.error = e.message; }
    const client = (c.users || []).find((u) => String(u.id) !== String(uid)) || null;
    dialogs.push({
      id: String(c.id),
      item: c.context?.value?.title || c.context?.value?.id || null,
      itemUrl: c.context?.value?.url || null,
      client: client ? { id: String(client.id), name: client.name || null } : null,
      updated: ms(c.updated) || null,
      messages: msgs.map((m) => ({
        id: String(m.id),
        direction: m.direction === 'out' ? 'out' : 'in',
        at: ms(m.created),
        text: avito.messageText(m),
        photo: Boolean(avito.imageUrl(m)),
        type: m.type || null,
      })).sort((a, b) => (a.at || 0) - (b.at || 0)),
    });
    if (onProgress) onProgress(i + 1, chats.length);
  }
  return dialogs;
}

// ── разбор ─────────────────────────────────────────────────────────────────
function analyze(dialogs) {
  const stat = {
    dialogs: dialogs.length,
    messages: 0, fromClient: 0, fromUs: 0,
    withPhoto: 0, answered: 0, unanswered: 0, hanging: 0,
    firstReplyMs: [], byHour: Array(24).fill(0), byTopic: {}, items: {},
    firstQuestions: [], noReplyExamples: [], period: { from: null, to: null },
  };
  for (const t of TOPICS) stat.byTopic[t.code] = { code: t.code, label: t.label, dialogs: 0, messages: 0 };

  for (const d of dialogs) {
    const msgs = d.messages || [];
    const inbound = msgs.filter((m) => m.direction === 'in');
    const outbound = msgs.filter((m) => m.direction === 'out');
    stat.messages += msgs.length;
    stat.fromClient += inbound.length;
    stat.fromUs += outbound.length;
    if (msgs.some((m) => m.photo)) stat.withPhoto += 1;
    if (d.item) stat.items[d.item] = (stat.items[d.item] || 0) + 1;

    const first = inbound[0];
    if (first?.at) {
      stat.byHour[new Date(first.at + MSK).getUTCHours()] += 1;
      stat.period.from = stat.period.from ? Math.min(stat.period.from, first.at) : first.at;
      const reply = outbound.find((m) => m.at && m.at >= first.at);
      if (reply) { stat.answered += 1; stat.firstReplyMs.push(reply.at - first.at); }
      else { stat.unanswered += 1; if (stat.noReplyExamples.length < 10) stat.noReplyExamples.push({ id: d.id, item: d.item, text: first.text.slice(0, 160) }); }
      if (first.text) stat.firstQuestions.push(first.text.slice(0, 200));
    }
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg?.at) stat.period.to = stat.period.to ? Math.max(stat.period.to, lastMsg.at) : lastMsg.at;
    if (lastMsg && lastMsg.direction === 'in') stat.hanging += 1;

    const seen = new Set();
    for (const m of inbound) {
      for (const t of TOPICS) {
        if (!t.re.test(m.text || '')) continue;
        stat.byTopic[t.code].messages += 1;
        if (!seen.has(t.code)) { stat.byTopic[t.code].dialogs += 1; seen.add(t.code); }
      }
    }
  }

  const replies = stat.firstReplyMs;
  stat.medianFirstReply = median(replies);
  stat.avgFirstReply = replies.length ? Math.round(replies.reduce((a, b) => a + b, 0) / replies.length) : null;
  stat.within15m = replies.filter((x) => x <= 15 * 60000).length;
  stat.overHour = replies.filter((x) => x > HOUR).length;
  stat.topTopics = Object.values(stat.byTopic).filter((t) => t.dialogs).sort((a, b) => b.dialogs - a.dialogs);
  stat.topItems = Object.entries(stat.items).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([title, n]) => ({ title, n }));
  stat.peakHours = stat.byHour.map((n, h) => ({ h, n })).filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 5);
  return stat;
}

const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : '—');

function report(stat) {
  const L = [];
  const date = (t) => (t ? new Date(t + MSK).toISOString().slice(0, 10) : '—');
  L.push(`Диалогов: ${stat.dialogs} (${date(stat.period.from)} — ${date(stat.period.to)}), сообщений ${stat.messages}: от клиентов ${stat.fromClient}, от нас ${stat.fromUs}`);
  L.push(`С фотографиями: ${stat.withPhoto} (${pct(stat.withPhoto, stat.dialogs)})`);
  L.push(`Без нашего ответа вообще: ${stat.unanswered} (${pct(stat.unanswered, stat.dialogs)}) · последним писал клиент: ${stat.hanging} (${pct(stat.hanging, stat.dialogs)})`);
  L.push(`Первый ответ: медиана ${human(stat.medianFirstReply)}, среднее ${human(stat.avgFirstReply)}; за 15 минут ${stat.within15m} (${pct(stat.within15m, stat.answered)}), дольше часа ${stat.overHour} (${pct(stat.overHour, stat.answered)})`);
  if (stat.peakHours.length) L.push(`Часы обращений (МСК): ${stat.peakHours.map((x) => `${x.h}:00 — ${x.n}`).join(', ')}`);
  L.push('');
  L.push('О чём спрашивают:');
  for (const t of stat.topTopics) L.push(`  ${String(t.dialogs).padStart(4)} диал. (${pct(t.dialogs, stat.dialogs)})  ${t.label}`);
  if (stat.topItems.length) {
    L.push('');
    L.push('Объявления, по которым пишут:');
    for (const it of stat.topItems) L.push(`  ${String(it.n).padStart(4)}  ${it.title}`);
  }
  if (stat.noReplyExamples.length) {
    L.push('');
    L.push('Обращения, оставшиеся без ответа (первые 10):');
    for (const e of stat.noReplyExamples) L.push(`  • ${e.text}`);
  }
  L.push('');
  L.push('Что из этого следует для автодиалога:');
  for (const line of advice(stat)) L.push(`  • ${line}`);
  return L.join('\n');
}

// Выводы считаются, а не сочиняются: каждая строка привязана к числу выше.
function advice(stat) {
  const out = [];
  if (stat.unanswered) out.push(`${stat.unanswered} обращений (${pct(stat.unanswered, stat.dialogs)}) остались без ответа — это прямая потеря, автодиалог закрывает её первым касанием.`);
  if (stat.medianFirstReply != null && stat.medianFirstReply > 15 * 60000) out.push(`медиана первого ответа ${human(stat.medianFirstReply)} — движок отвечает за секунды, разница и есть выигрыш.`);
  const t = Object.fromEntries(stat.topTopics.map((x) => [x.code, x]));
  if (t.price) out.push(`про цену спрашивают в ${pct(t.price.dialogs, stat.dialogs)} диалогов — расчёт должен уходить в первом же ответе (ENGINE_AUTOSEND=all), иначе смысла в автодиалоге мало.`);
  if (t.model) out.push('почти всегда нужна марка/модель/год — это обязательное поле пакета, спрашиваем сразу, если не назвали.');
  if (t.photo || stat.withPhoto) out.push(`фото приходят в ${pct(stat.withPhoto, stat.dialogs)} диалогов — зрение по кадру включено, в ответ просим недостающие ракурсы из photos.checklist.`);
  if (t.time) out.push('спрашивают сроки и запись — держать в шаблоне КП строку о времени работ и свободных днях.');
  if (t.place) out.push('спрашивают адрес — вынести адрес и ориентир в шаблон ответа, чтобы не гонять человека вторым вопросом.');
  if (t.warranty) out.push('спрашивают про гарантию — фраза про гарантию должна быть в шаблоне пакета.');
  if (t.legal) out.push('спрашивают про законность/техосмотр — заготовить честный абзац, это частый повод отказа.');
  if (stat.peakHours.some((x) => x.h >= 21 || x.h <= 7)) out.push('пишут ночью и рано утром — как раз те часы, когда человек ответить не может, а движок может.');
  if (!out.length) out.push('данных мало: собрать переписку ещё раз, когда накопится хотя бы пара десятков диалогов.');
  return out;
}

function save(dialogs, stat, file) {
  const out = file || path.join(__dirname, '..', 'seo', 'data', 'avito-dialogs.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), stat, dialogs }, null, 1));
  return out;
}

module.exports = { fetchAll, analyze, report, advice, save, TOPICS, human, median };
