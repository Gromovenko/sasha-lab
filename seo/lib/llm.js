// Языковая модель для ассистента базы знаний.
//
// Первым — Qwen на neuraldeep (GPU в РФ): вопросы посетителей это персональные
// обращения, и уезжать им за периметр РФ незачем (152-ФЗ). Ключ тот же, что у
// других проектов владельца, — NEURALDEEP_API_KEY.
// Если ключа нет, модуль НЕ падает и НЕ выдумывает: ассистент отвечает выдержками
// из базы знаний и честной строкой «мастер ответит лично». Пустой ответ лучше
// придуманного: цена ошибки здесь — разобранная фара клиента.
const https = require('https');

const HOST = process.env.LLM_HOST || 'api.neuraldeep.ru';
const MODEL = process.env.LLM_MODEL || 'qwen3.6-fp8-noreason';
const enabled = () => Boolean(process.env.NEURALDEEP_API_KEY);

function chat(messages, { maxTokens = 700, temperature = 0.3, timeout = 45000 } = {}) {
  if (!enabled()) return Promise.reject(new Error('нет NEURALDEEP_API_KEY'));
  const payload = JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, path: '/v1/chat/completions', method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NEURALDEEP_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout,
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        const t = Buffer.concat(c).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`llm HTTP ${res.statusCode}: ${t.slice(0, 300)}`));
        try {
          const j = JSON.parse(t);
          const text = j.choices?.[0]?.message?.content?.trim() || '';
          if (!text) return reject(new Error('llm вернула пустой ответ'));
          resolve(text);
        } catch (e) { reject(new Error('llm: не JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('llm: таймаут')));
    req.on('error', reject);
    req.end(payload);
  });
}

module.exports = { chat, enabled, MODEL };
