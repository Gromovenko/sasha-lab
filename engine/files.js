// Вложения клиентов. Лежат файлами в uploads/ рядом с кодом, в базе — только путь.
//
// Почему не в базе: фото фары весит 2–6 МБ, а их на сделку три-пять. Гонять их
// через postgres ради «всё в одном месте» — это распухший дамп и медленный бэкап.
// Почему не в git: это ЧУЖИЕ фотографии (двор, номер машины) — в репозиторий им
// нельзя ни при каких условиях, каталог закрыт .gitignore.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 12 * 1024 * 1024);
const IMAGE = /\.(jpe?g|png|webp|heic|gif)$/i;

const safe = (name) => String(name || 'file').replace(/[^\w.-]+/g, '_').slice(-60) || 'file';

function save(dealId, filename, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('пустой файл');
  if (buf.length > MAX_BYTES) throw new Error(`файл больше ${Math.round(MAX_BYTES / 1e6)} МБ`);
  const dir = path.join(DIR, safe(dealId));
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}_${safe(filename)}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return { name, path: path.join(safe(dealId), name), bytes: buf.length, kind: IMAGE.test(name) ? 'image' : 'file' };
}

// Путь к файлу по относительной ссылке из базы. Обязательно с проверкой выхода
// за корень: ссылка приходит из запроса панели, «../../seo/.env» тут не пройдёт.
function abs(rel) {
  const file = path.normalize(path.join(DIR, String(rel || '')));
  if (!file.startsWith(path.normalize(DIR))) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

const images = (attachments = []) => attachments.filter((a) => a.kind === 'image').map((a) => abs(a.path)).filter(Boolean);

module.exports = { DIR, save, abs, images, safe, MAX_BYTES };
