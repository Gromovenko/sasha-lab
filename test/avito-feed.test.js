// Фид автозагрузки Авито: обязательные параметры ветки «Автосервис» и требования
// правил к названию. Сторожит разбор отчёта автозагрузки от 20.09.2026, где
// Авито отклонило все пять объявлений по Guarantee / WorkExperience / Make /
// OwnSpareParts, а также запрет латиницы и цены в названии.
const test = require('node:test');
const assert = require('node:assert');
const feed = require('../engine/avito-feed');

const base = () => ({
  studio: {
    address: 'Ростов-на-Дону, пр-т Стачки, 68',
    imageBase: 'https://example.test/img',
    managerName: 'Александр',
    defaults: {
      guarantee: 'Есть', workExperience: 5, ownSpareParts: 'Можно',
      carServiceType: 'Сервисный центр', vehicleType: 'Легковые авто', make: ['BMW'],
    },
  },
  ads: [{ id: 'a1', title: 'Установка би-лед линз в фары', price: 18000, images: ['1.jpg'], description: 'о'.repeat(200) }],
});

test('полный фид проходит проверку и содержит обязательные параметры', () => {
  const cfg = base();
  assert.deepStrictEqual(feed.validate(cfg), []);
  const xml = feed.build(cfg);
  for (const t of ['Guarantee', 'WorkExperience', 'OwnSpareParts', 'Make', 'CarServiceType', 'CarServiceVehicleType']) {
    assert.ok(xml.includes(`<${t}>`), `нет ${t}`);
  }
  assert.ok(xml.includes('<ServiceType>Автосервис, аренда</ServiceType>'));
});

test('каждый обязательный параметр по отдельности валит проверку', () => {
  for (const key of ['guarantee', 'workExperience', 'ownSpareParts', 'make', 'carServiceType', 'vehicleType']) {
    const cfg = base();
    delete cfg.studio.defaults[key];
    assert.ok(feed.validate(cfg).length > 0, `${key} должен быть обязательным`);
  }
});

test('название: латиница, цена и капслок запрещены', () => {
  assert.ok(feed.titleProblems('Установка bi-LED линз').some((p) => p.includes('латиница')));
  assert.ok(feed.titleProblems('Линзы в фары за 20.000').some((p) => p.includes('цена')));
  assert.ok(feed.titleProblems('Линзы в фары НЕДОРОГО').some((p) => p.includes('заглавными')));
  assert.deepStrictEqual(feed.titleProblems('Установка би-лед линз в фары'), []);
});

test('ссылка в описании и больше десяти фото не проходят', () => {
  const cfg = base();
  cfg.ads[0].description = 'подробности на https://sasha-lab.ru ' + 'о'.repeat(200);
  assert.ok(feed.validate(cfg).some((p) => p.includes('ссылка')));
  const cfg2 = base();
  cfg2.ads[0].images = Array.from({ length: 12 }, (_, i) => `${i}.jpg`);
  assert.ok(feed.validate(cfg2).some((p) => p.includes('фото')));
});

test('черновики в фид не попадают', () => {
  const cfg = base();
  cfg.ads.push({ ...cfg.ads[0], id: 'a2', draft: true });
  assert.ok(!feed.build(cfg).includes('<Id>a2</Id>'));
});

test('боевой конфиг проекта проходит проверку', () => {
  assert.deepStrictEqual(feed.validate(feed.load()), []);
});
