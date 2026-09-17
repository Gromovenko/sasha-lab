// Вход в закрытые разделы (панель SEO и панель мастера). Одна дверь, один
// код: подписанная HMAC кука без хранилища сессий. Пароль сравнивается через
// timingSafeEqual по хэшу — иначе длина пароля утекает по времени ответа.
const crypto = require('crypto');

function make({ cookie, path = '/', password, secret, ttlMs = 14 * 24 * 3600 * 1000 }) {
  const pass = () => (typeof password === 'function' ? password() : password) || '';
  const key = () => (typeof secret === 'function' ? secret() : secret) || pass();

  const sign = (exp) => `${exp}.${crypto.createHmac('sha256', key()).update(String(exp)).digest('hex')}`;

  const valid = (token) => {
    if (!token || !key()) return false;
    const [exp, mac] = String(token).split('.');
    if (!exp || !mac || Number(exp) < Date.now()) return false;
    const want = crypto.createHmac('sha256', key()).update(exp).digest('hex');
    return want.length === mac.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac));
  };

  const passwordOk = (given) => {
    if (!pass()) return false;
    const a = Buffer.from(crypto.createHash('sha256').update(String(given)).digest('hex'));
    const b = Buffer.from(crypto.createHash('sha256').update(pass()).digest('hex'));
    return crypto.timingSafeEqual(a, b);
  };

  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';')
    .map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));

  return {
    cookie, path, sign, valid, passwordOk, cookies,
    enabled: () => Boolean(pass()),
    ok: (req) => valid(cookies(req)[cookie]),
    setCookie: () => {
      const exp = Date.now() + ttlMs;
      return `${cookie}=${sign(exp)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${ttlMs / 1000}`;
    },
    clearCookie: () => `${cookie}=; Path=${path}; Max-Age=0`,
  };
}

module.exports = { make };
