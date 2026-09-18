// СМС — канал уведомления ВЛАДЕЛЬЦА/АДМИНА, а не клиента. Нужен потому, что
// у админа проекта есть телефон (ADMIN_PHONE) и нет обязанности держать
// открытым телеграм: «в Авито написали» должно доехать даже в гараже.
//
// Две площадки на выбор, обе российские и обе без внешних зависимостей:
//   SMSRU_API_ID                  — sms.ru
//   SMSC_LOGIN + SMSC_PASSWORD    — smsc.ru
// Нет ни одной — канал честно говорит «не настроен», и уведомление уходит
// тем, что есть (телеграм), либо остаётся в журнале службы.
const id = 'sms';
const title = 'СМС админу';

const smsru = () => process.env.SMSRU_API_ID || '';
const smsc = () => (process.env.SMSC_LOGIN && process.env.SMSC_PASSWORD ? [process.env.SMSC_LOGIN, process.env.SMSC_PASSWORD] : null);
const configured = () => Boolean(smsru() || smsc());

// 79098887575 — то, что понимают обе площадки. «8 (909) …» и «+7 909 …» тоже.
function normalize(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = `7${d.slice(1)}`;
  if (d.length === 10) d = `7${d}`;
  return d;
}

async function send({ to, text }) {
  const phone = normalize(to);
  if (!configured()) return { ok: false, error: 'нет SMSRU_API_ID или SMSC_LOGIN/SMSC_PASSWORD' };
  if (phone.length !== 11) return { ok: false, error: `не похоже на телефон: ${to}` };
  // Кириллица — 70 знаков на сообщение; режем сами, чтобы не платить за «хвост».
  const msg = String(text || '').slice(0, Number(process.env.SMS_MAX_CHARS || 320));
  try {
    if (smsru()) {
      const u = new URL('https://sms.ru/sms/send');
      u.searchParams.set('api_id', smsru());
      u.searchParams.set('to', phone);
      u.searchParams.set('msg', msg);
      u.searchParams.set('json', '1');
      if (process.env.SMS_FROM) u.searchParams.set('from', process.env.SMS_FROM);
      const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
      const j = await res.json().catch(() => ({}));
      const st = j.sms?.[phone];
      if (j.status !== 'OK' || (st && st.status !== 'OK')) {
        return { ok: false, error: `sms.ru: ${st?.status_text || j.status_text || res.status}` };
      }
      return { ok: true, id: st?.sms_id ? String(st.sms_id) : null };
    }
    const [login, pass] = smsc();
    const u = new URL('https://smsc.ru/sys/send.php');
    u.searchParams.set('login', login);
    u.searchParams.set('psw', pass);
    u.searchParams.set('phones', phone);
    u.searchParams.set('mes', msg);
    u.searchParams.set('fmt', '3');
    if (process.env.SMS_FROM) u.searchParams.set('sender', process.env.SMS_FROM);
    const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
    const j = await res.json().catch(() => ({}));
    if (j.error || j.error_code) return { ok: false, error: `smsc.ru: ${j.error || j.error_code}` };
    return { ok: true, id: j.id ? String(j.id) : null };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { id, title, configured, send, normalize, inbound: false, verified: false };
