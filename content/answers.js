// Раздел «Ответы на поисковые запросы» (/baza/otvety/).
//
// Что это. База знаний отвечает на вопросы, которые задают в мастерской.
// Этот раздел отвечает на вопросы, которые люди набирают в поиске: одна
// страница — один запрос, ответ прямой, сверху и без прелюдий.
//
// Почему файлы, а не таблица materials. Материалы базы знаний владелец
// публикует из панели на проде — они обязаны лежать в базе, иначе их сносит
// rsync --delete (см. content/materials.js). Ответы раздела пишутся в
// репозитории вместе с кодом и приезжают выкатом, поэтому источник правды для
// них — файлы content/otvety/*.md. Смешивать два потока в одной таблице незачем.
//
// Гарантия от дублей. Спрос в keywords живёт отдельно от текста: Wordstat
// говорит, ЧТО спрашивают, а страницу рождает написанный человеком ответ.
// Кластер без ответа попадает в очередь (`node seo/cli.js answers`), но
// страницы не получает — иначе это ровно тот scaled content abuse, из-за
// которого санкция прилетает на весь домен.
const fs = require('fs');
const path = require('path');
const { parseFile } = require('./parse');

const DIR = path.join(__dirname, 'otvety');

function load() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const doc = parseFile(path.join(DIR, f));
    if (!doc.meta.query) throw new Error(`${f}: нет query — под какой запрос написан ответ`);
    if (!doc.meta.material) throw new Error(`${f}: нет material — на какой разбор ссылаться`);
    doc.meta.type = 'answer';
    // Главный запрос всегда входит в список — по нему считается покрытие.
    doc.meta.queries = [...new Set([doc.meta.query, ...(doc.meta.queries || [])])];
    return doc;
  });
}

const url = (slug) => `/baza/otvety/${slug}/`;

module.exports = { load, url, DIR };
