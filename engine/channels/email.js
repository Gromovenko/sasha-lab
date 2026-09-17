// Почта через Resend (уже используется в других проектах владельца).
// Ключи: RESEND_API_KEY, RESEND_FROM («Дядя Саша <mail@домен>»).
//
// Грабли, оплаченные в lifeprotocol: ответ 200 от Resend — это «принято к
// отправке», а не «доставлено» (sending-only ключ молча роняет письма).
// Поэтому id письма кладётся в meta сообщения: по нему видно, что ушло.
const id = 'email';
const title = 'Почта';
const configured = () => Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);

async function send({ to, text, subject = 'Ваш расчёт' }) {
  if (!configured()) return { ok: false, error: 'нет RESEND_API_KEY / RESEND_FROM' };
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(to || ''))) return { ok: false, error: 'адресат не похож на почту' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `resend ${res.status}: ${j.message || ''}`.trim() };
    return { ok: true, id: j.id || null };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { id, title, configured, send, inbound: false };
