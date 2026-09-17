// Понимание заявки: из переписки вынимается структура по схеме пакета.
//
// Два прохода, и порядок важен:
//   1) эвристики — год, телефон, почта, значения перечислений. Дёшево, без
//      сети, работают даже когда ключа модели нет (в dev-копии на EU его нет);
//   2) языковая модель — то, что эвристикой не берётся («джолион 21 года»,
//      «на киа рио третьего кузова»). Только Qwen на neuraldeep: переписка с
//      живым клиентом это персональные данные, за периметр РФ они не уезжают
//      (152-ФЗ). Нет ключа — работает только первый проход, и это честно
//      отражается в карточке («данных не хватает»), а не додумывается.
//
// Что уже подтвердил мастер — не перетирается НИКОГДА: модель дополняет пустые
// поля, а не спорит с человеком, который видел машину.
const llm = require('../seo/lib/llm');

const RE_PHONE = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/;
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const RE_YEAR = /\b(19[7-9]\d|20[0-4]\d)\b/;

function heuristics(pack, text) {
  const out = {};
  const hay = String(text || '');
  const low = hay.toLowerCase();
  for (const f of pack.subject.fields) {
    if (f.enum) {
      const hit = f.enum.find((v) => low.includes(String(v).toLowerCase()));
      if (hit) out[f.key] = hit;
      continue;
    }
    if (f.type === 'number' && /год|year/i.test(`${f.key} ${f.label}`)) {
      const m = hay.match(RE_YEAR);
      if (m) out[f.key] = Number(m[0]);
      continue;
    }
    if (f.match) {
      const m = hay.match(new RegExp(f.match, 'i'));
      if (m) out[f.key] = m[1] || m[0];
    }
  }
  const contact = (hay.match(RE_PHONE) || hay.match(RE_EMAIL) || [])[0] || null;
  return { subject: out, contact };
}

function schemaHint(pack) {
  const fields = pack.subject.fields
    .map((f) => `"${f.key}": ${f.enum ? `один из [${f.enum.join(', ')}] или null` : f.type === 'number' ? 'число или null' : 'строка или null'} — ${f.label}`)
    .join(',\n  ');
  const wants = pack.wants.map((w) => w.key);
  return `{\n  "subject": {\n  ${fields}\n  },\n  "wants": [подмножество из ${JSON.stringify(wants)}],\n`
    + '  "client_name": "строка или null",\n  "contact": "телефон/почта/ник или null",\n'
    + '  "deadline": "строка или null",\n  "budget": число или null,\n  "summary": "одна строка: что человек просит"\n}';
}

function parseJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('модель вернула не JSON');
  return JSON.parse(t.slice(s, e + 1));
}

// Оставляем только поля схемы: модель периодически изобретает свои ключи,
// и «color»: «серебристый» в карточке заявки никому не нужен.
function sanitize(pack, raw, text = '') {
  const hay = String(text).toLowerCase();
  const subject = {};
  for (const f of pack.subject.fields) {
    let v = raw?.subject?.[f.key];
    if (v == null || v === '' || v === 'null') continue;
    if (f.type === 'number') { v = Number(String(v).replace(/[^\d.]/g, '')); if (!Number.isFinite(v)) continue; }
    if (f.enum) {
      // Значение из перечня принимаем, только если человек его НАЗВАЛ. Замер на
      // проде 17.09: по фразе «хочу линзы на киа рио 2015» модель бодро дописала
      // «тип фары: галоген» — она его не знала, а угадала. Категориальный факт,
      // угаданный моделью, потом попадёт в расчёт как данность.
      if (!f.enum.includes(v) || !hay.includes(String(v).toLowerCase())) continue;
    }
    subject[f.key] = v;
  }
  const keys = pack.wants.map((w) => w.key);
  const wants = [].concat(raw?.wants || []).filter((w) => keys.includes(w));
  return {
    subject,
    wants,
    clientName: raw?.client_name || null,
    contact: raw?.contact || null,
    deadline: raw?.deadline || null,
    budget: Number.isFinite(Number(raw?.budget)) ? Number(raw.budget) : null,
    summary: raw?.summary ? String(raw.summary).slice(0, 300) : null,
  };
}

async function extract(pack, { text, known = {} } = {}) {
  const h = heuristics(pack, text);
  const base = { subject: { ...h.subject }, wants: [], clientName: null, contact: h.contact, deadline: null, budget: null, summary: null, engine: 'rules' };
  if (!llm.enabled() || !String(text || '').trim()) return base;
  try {
    const answer = await llm.chat([
      { role: 'system', content: 'Ты разбираешь переписку с клиентом сервиса и отвечаешь СТРОГО одним JSON-объектом без пояснений. Ничего не додумывай: чего в переписке нет — null.' },
      { role: 'user', content: `Отрасль: ${pack.title}.\nУже известно: ${JSON.stringify(known)}\n\nПереписка:\n"""\n${String(text).slice(0, 6000)}\n"""\n\nВерни JSON строго такой формы:\n${schemaHint(pack)}` },
    ], { maxTokens: 700, temperature: 0.1 });
    const got = sanitize(pack, parseJson(answer), text);
    return {
      ...got,
      subject: { ...got.subject, ...base.subject },   // эвристика точнее модели там, где сработала
      contact: base.contact || got.contact,
      engine: llm.MODEL,
    };
  } catch (e) {
    // Молча пустой разбор лучше выдуманного: карточка покажет «не хватает данных»,
    // мастер дозаполнит руками за пять секунд.
    return { ...base, error: e.message };
  }
}

// Слияние: то, что уже подтверждено, сильнее свежего разбора.
function merge(oldSubject = {}, patch = {}) {
  const out = { ...oldSubject };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') continue;
    if (out[k] == null || out[k] === '') out[k] = v;
  }
  return out;
}

function missing(pack, subject = {}) {
  return pack.subject.fields.filter((f) => f.required && (subject[f.key] == null || subject[f.key] === '')).map((f) => f.key);
}

module.exports = { extract, heuristics, merge, missing, sanitize, parseJson, schemaHint };
