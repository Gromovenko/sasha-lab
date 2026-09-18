// Ворота раздела /baza/otvety/ и тестового режима Wordstat.
//
// Сторожим три вещи, каждая из которых уже стоила бы дорого:
//   1. ответ ссылается на существующий разбор (битая ссылка внутри базы —
//      это то, по чему поисковик обходит раздел);
//   2. ответ не дублирует материал базы знаний по запросу (две свои страницы
//      на один запрос конкурируют между собой);
//   3. выдуманные цифры тестового Wordstat не имеют дороги на сайт.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const answers = require('../content/answers');
const { parseFile } = require('../content/parse');
const mem = require('../seo/lib/memory');
const jobs = require('../seo/lib/jobs');
const fixture = require('../seo/lib/wordstatFixture');

const KB = path.join(__dirname, '..', 'content', 'kb');
const kb = fs.readdirSync(KB).filter((f) => f.endsWith('.md')).map((f) => parseFile(path.join(KB, f)).meta);

test('у каждого ответа есть запрос и существующий разбор', () => {
  const docs = answers.load();
  assert.ok(docs.length >= 10, 'раздел пуст');
  for (const d of docs) {
    assert.ok(d.meta.query, `${d.meta.slug}: нет query`);
    assert.ok(kb.some((m) => m.slug === d.meta.material), `${d.meta.slug}: нет материала ${d.meta.material}`);
    assert.ok(d.meta.queries.includes(d.meta.query));
  }
});

test('ответ не дублирует материал базы знаний по запросу', () => {
  for (const d of answers.load()) {
    const clash = kb.find((m) => mem.coverage(d.meta.query, m) >= mem.COVERED);
    assert.equal(clash, undefined, `${d.meta.slug} дублирует «${clash && clash.title}»`);
  }
});

test('ответы не пересекаются между собой', () => {
  const seen = new Map();
  for (const d of answers.load()) {
    const key = mem.norm(d.meta.query);
    assert.ok(!seen.has(key), `${d.meta.slug} и ${seen.get(key)} отвечают на один запрос`);
    seen.set(key, d.meta.slug);
  }
});

test('тестовый Wordstat покрывает базовые сиды и не течёт на сайт', () => {
  for (const seed of jobs.SEEDS) {
    assert.ok(fixture.top(seed).results.length, `нет фикстуры для сида «${seed}»`);
  }
  // Неизвестный сид отдаёт пусто, а не выдуманные строки.
  assert.equal(fixture.top('чего в фикстуре нет').results.length, 0);
  // Генератор страниц о Wordstat не знает вообще — цифрам оттуда неоткуда взяться.
  for (const f of ['build.js', 'answers.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'content', f), 'utf8');
    assert.ok(!/require\(['"][^'"]*wordstat/i.test(src), `content/${f} тянет Wordstat`);
  }
});

test('тестовые фразы помечены отдельным источником', () => {
  assert.equal(jobs.TEST_SOURCE, 'wordstat-test');
});
