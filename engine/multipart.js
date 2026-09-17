// Разбор multipart/form-data — форма заявки шлёт фото прямо с телефона.
// Пакетом ради этого обрастать не хотим: тут нужен один проход по буферу.
//
// Грабли, известные по другим проектам: Safari/WebKit любит присылать пустое
// тело, если форма отправлена до готовности файла, — поэтому пустые части
// просто выбрасываются, а не роняют запрос пятисоткой.
const MAX = Number(process.env.FORM_MAX_BYTES || 40 * 1024 * 1024);

function readBody(req, max = MAX) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { req.destroy(); reject(new Error('тело запроса слишком большое')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parse(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('не указана граница multipart');
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {};
  const files = [];
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    const start = pos + boundary.length;
    if (buf.slice(start, start + 2).toString() === '--') break;      // хвост формы
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd < 0) break;
    const head = buf.slice(start, headEnd).toString('utf8');
    const next = buf.indexOf(boundary, headEnd);
    const body = buf.slice(headEnd + 4, (next < 0 ? buf.length : next) - 2);
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    if (name && filename && body.length) files.push({ field: name, filename, buffer: body });
    else if (name && !filename) fields[name] = body.toString('utf8');
    pos = next;
  }
  return { fields, files };
}

// Один вход на обе формы: обычная и с файлами.
async function form(req) {
  const ct = req.headers['content-type'] || '';
  const buf = await readBody(req);
  if (/multipart\/form-data/i.test(ct)) return parse(buf, ct);
  if (/application\/json/i.test(ct)) {
    try { return { fields: JSON.parse(buf.toString('utf8') || '{}'), files: [] }; } catch { return { fields: {}, files: [] }; }
  }
  return { fields: Object.fromEntries(new URLSearchParams(buf.toString('utf8'))), files: [] };
}

module.exports = { form, parse, readBody, MAX };
