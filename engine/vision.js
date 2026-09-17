// Зрение: фото клиента → находки из списка пакета.
//
// Движок ОДИН — Qwen на neuraldeep (GPU в РФ). Второго звонка нет и не будет:
// фото клиента (а на них бывает и номер машины, и двор, и лицо) за периметр РФ
// не уезжают (152-ФЗ) — та же доктрина, что в lifeprotocol. Нет ключа или
// модель не ответила — честная ошибка и пометка «нужен взгляд мастера»,
// а не тихая подмена другим сервисом и не выдуманная находка.
//
// Ключевое для бизнеса: именно этот шаг переписывает ответ. В живой переписке
// мастер сначала написал цену, потом посмотрел фото и переделал КП («там места
// мало под новую линзу»). Движок смотрит фото ДО составления ответа — и тот же
// вывод попадает в первое же сообщение клиенту.
const fs = require('fs');
const path = require('path');
const llm = require('../seo/lib/llm');

const MODEL = process.env.VISION_MODEL || process.env.NEURALDEEP_VISION_MODEL || llm.MODEL;
const TIMEOUT = Number(process.env.VISION_TIMEOUT_MS || 45000);
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic' };

const enabled = () => llm.enabled() && process.env.VISION_OFF !== '1';

function prompt(pack) {
  const codes = pack.vision.findings.map((f) => `  "${f.code}" — ${f.label}`).join('\n');
  return `${pack.vision.instruction}\n\nВерни СТРОГО JSON:\n`
    + '{ "findings": [ { "code": "код из списка", "confidence": 0.0–1.0, "note": "что именно видно" } ], "summary": "одна строка" }\n\n'
    + `Коды, и НИКАКИХ других:\n${codes}\n\n`
    + 'Не выдумывай: если признака на кадре не видно — не называй его. Если кадр не по теме или нечитаемый — верни единственную находку "unclear".';
}

function parse(pack, text) {
  const t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('зрение вернуло не JSON');
  const raw = JSON.parse(t.slice(s, e + 1));
  const known = new Set(pack.vision.findings.map((f) => f.code));
  const seen = new Set();
  const findings = [].concat(raw.findings || [])
    // Код не из пакета = модель сочиняет. Такие находки не «примерно подходят»,
    // они просто не имеют решения в правилах — выбрасываем.
    .filter((f) => f && known.has(f.code) && !seen.has(f.code) && seen.add(f.code))
    .map((f) => ({
      code: f.code,
      confidence: Math.max(0, Math.min(1, Number(f.confidence ?? 0.7))),
      note: f.note ? String(f.note).slice(0, 300) : null,
    }));
  return { findings, summary: raw.summary ? String(raw.summary).slice(0, 300) : null };
}

function dataUrl(file) {
  const buf = fs.readFileSync(file);
  const mime = MIME[path.extname(file).toLowerCase()] || 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Один кадр. Повтор ровно один и только на сетевом сбое: neuraldeep изредка
// отдаёт таймаут на ровном месте, повтор проходит с первой попытки (замер
// lifeprotocol 31.07). На «нет ключа»/«нет модели» повторять бессмысленно.
async function look(pack, file, { timeout = TIMEOUT } = {}) {
  if (!enabled()) return { ok: false, findings: [], error: 'зрение выключено: нет NEURALDEEP_API_KEY' };
  if (!fs.existsSync(file)) return { ok: false, findings: [], error: `нет файла ${file}` };
  const messages = [
    { role: 'system', content: 'Отвечай СТРОГО одним JSON-объектом, без markdown и пояснений.' },
    { role: 'user', content: [{ type: 'text', text: prompt(pack) }, { type: 'image_url', image_url: { url: dataUrl(file) } }] },
  ];
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      const answer = await llm.chat(messages, { maxTokens: 900, temperature: 0.1, timeout, model: MODEL });
      return { ok: true, ...parse(pack, answer), engine: MODEL, ms: Date.now() - t0 };
    } catch (e) {
      last = e;
      if (!/таймаут|timeout|HTTP 5|ECONN|socket/i.test(e.message)) break;
    }
  }
  return { ok: false, findings: [], error: last ? last.message : 'зрение не ответило' };
}

// Несколько кадров: находки объединяются по коду, остаётся самая уверенная.
// Смотрим последовательно — у мастера обычно 1–3 фото, а параллельные запросы
// к общему на все проекты ключу neuraldeep не нужны никому.
async function lookAll(pack, files, opts = {}) {
  const byCode = new Map();
  const errors = [];
  const summaries = [];
  for (const f of files) {
    const r = await look(pack, f, opts);
    if (!r.ok) { errors.push({ file: path.basename(f), error: r.error }); continue; }
    if (r.summary) summaries.push(r.summary);
    for (const x of r.findings) {
      const prev = byCode.get(x.code);
      if (!prev || x.confidence > prev.confidence) byCode.set(x.code, { ...x, file: path.basename(f) });
    }
  }
  return {
    ok: errors.length < files.length || !files.length,
    findings: [...byCode.values()].sort((a, b) => b.confidence - a.confidence),
    summaries, errors, engine: MODEL,
  };
}

module.exports = { look, lookAll, parse, prompt, enabled, MODEL };
