// WhatsApp Cloud API (Meta). Ключи: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID.
// Как и у Авито: код готов, живых ключей нет — до них ответ уходит вручную.
// Важное ограничение самой платформы (не наше): вне 24 часов после сообщения
// клиента отправить можно только утверждённый шаблон, поэтому догоняющие
// касания по этому каналу планировщик не шлёт — он их пометит как «вручную».
const id = 'whatsapp';
const title = 'WhatsApp';
const configured = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

async function send({ to, text }) {
  if (!configured()) return { ok: false, error: 'нет WHATSAPP_TOKEN / WHATSAPP_PHONE_ID' };
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to).replace(/\D/g, ''), type: 'text', text: { body: text } }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `whatsapp ${res.status}: ${j.error?.message || ''}`.trim() };
    return { ok: true, id: j.messages?.[0]?.id || null };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { id, title, configured, send, inbound: false, verified: false, sessionHours: 24 };
