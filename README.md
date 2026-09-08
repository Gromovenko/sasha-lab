# sasha-lab — статическое зеркало сайта sasha-lab.ru

Полная копия публичного сайта студии автотюнинга «Дядя Саша» (Ростов-на-Дону),
снятая 08.09.2026 для анализа и дальнейшей работы. Оригинал — на Tilda за DDoS-Guard.

## Что внутри
- `mirror/sasha-lab.ru/` — 5 страниц сайта (весь сайт):
  `index.html`, `fara.html`, `remont-far.html`, `ustanovka-linz.html`, `privacypolicy.html`
- `mirror/cdn/` — все ассеты, снятые с внешних CDN и разложенные по хостам:
  `static.tildacdn.com` (99 файлов: стили/скрипты блоков, изображения),
  `neo.tildacdn.com`, `fonts.googleapis.com` + `fonts.gstatic.com` (шрифты Unbounded/Manrope)
- `mirror/stub/metrika-noop.js` — заглушка Яндекс.Метрики
- `server.js` — статик-сервер без зависимостей (порт из `PORT`, по умолчанию 3060)
- `grab-assets.sh` — итеративный догруз ассетов (если понадобится освежить зеркало)

## Что изменено относительно оригинала
Сырое зеркало «как есть» лежит в первом коммите (`23a8535`). Во втором коммите:
1. Все `https://static|neo.tildacdn.com/…`, `https://fonts.gstatic.com/…` переписаны
   на локальные `/cdn/<хост>/…`; ссылка на Google-Fonts CSS → `/cdn/fonts.googleapis.com/fonts.css`.
   Файлы, скачанные с `?t=…` в имени, переименованы без query (сервер query отбрасывает).
2. Абсолютные `https://sasha-lab.ru/` → относительные.
3. Яндекс.Метрика (счётчик 109777660) заменена заглушкой — копия не льёт хиты
   в реальную статистику владельца оригинала.

Формы Tilda (`ws.tildacdn.com`) в копии не работают — это внешний приёмник, не файл.

### Починка вёрстки 08.09.2026 (третий коммит)
Первая версия зеркала рисовала «кашу»: блоки налезали друг на друга, картинки не
подгружались. Причины и лечение:
4. **Все js/css приехали gzip-ом** (`curl` без `--compressed`, tildacdn отдаёт сжатое) и
   лежали в репо как бинарь — браузер их не исполнял, ни один скрипт Тильды не стартовал,
   а zero-блоки (t396) без JS не расставляются. 33 файла распакованы, в `grab-assets.sh`
   добавлен `--compressed`.
5. **Адреса картинок Тильда собирает на лету**: `static…/<tildXXXX>/f.png` →
   `optim…/<tildXXXX>/-/cover/284x358/…/format/webp/f.png.webp`, размеры зависят от
   вьюпорта — заранее скачать все варианты нельзя. Ходовые варианты лежат в
   `cdn/optim.tildacdn.com/`, на остальные `server.js` отдаёт исходник из
   `static.tildacdn.com` (обрезку и размер задаёт CSS блока).
6. **`wget --convert-links` переписал якоря** `href="#hsblock"` → `href="index.html#hsblock"`,
   из-за чего скрипт-аккордеон не находил кнопку и не сворачивал блок FAQ (страница была
   на 624 px длиннее оригинала). Якоря на свою же страницу возвращены к виду `#…`.
7. Сторонний скрипт вёрстки `cdn.postnikovmd.com/tilda@1.6/` (mods + accordion + css)
   тоже забран в зеркало — от него зависит поведение блоков.

Проверка после починки: поблочное сравнение высот всех `#rec…` копии и оригинала
(1440×1000 и 390×844) — расхождений 0 на всех 5 страницах; битых запросов 0.
Внешними остаются только виджеты Яндекс.Карт/отзывов (iframe) и приём форм.


## Где живёт
RU-сервер (80.249.150.234), `/opt/sasha-lab`, pm2-процесс `sasha-lab` на **127.0.0.1:3060**
(порт наружу НЕ открыт). Публичный вход — nginx-vhost:

**https://sashalab.80-249-150-234.sslip.io**

Своего домена нет, поэтому вход через sslip.io + сертификат Let's Encrypt — тот же приём,
что у letov. Конфиг: `/etc/nginx/sites-available/sasha-lab`.

## Обновить зеркало / выкатить правки
```bash
# освежить снимок с боевого сайта (на EU)
cd /root/gromovenko/sasha-lab/mirror && wget --mirror --page-requisites --adjust-extension \
  --convert-links --no-parent -e robots=off --domains=sasha-lab.ru https://sasha-lab.ru/
../grab-assets.sh      # затем повторить переписывание ссылок, см. историю коммита 42f46fa

# выкатить на RU
rsync -az --delete -e "ssh -i /root/.ssh/ru_key" --exclude '.git' \
  /root/gromovenko/sasha-lab/ root@10.10.0.2:/opt/sasha-lab/
ssh -i /root/.ssh/ru_key root@10.10.0.2 'pm2 restart sasha-lab'
```

## Проверка деплоя
Не «curl / == 200», а полная выборка ассетов: для каждой из 5 страниц выдернуть все
`src|href|data-original="/…"` и убедиться, что каждая ссылка отдаёт 200
(на 08.09.2026: 182 ссылки, битых 0), плюс скриншот главной.

## SEO-контур (08.09.2026)

Разбор задачи «держать первую строчку» и критика исходного плана — в
[SEO-PLAN.md](SEO-PLAN.md). Коротко про код:

- `seo/` — модуль работы с поисковиками. Панель собственника на `/seo` под
  паролем (`SEO_ADMIN_PASSWORD`), командная строка `node seo/cli.js`.
  Источники: Wordstat и Search API Яндекса (`YANDEX_SEARCH_API_KEY`,
  `YANDEX_FOLDER_ID`), Яндекс.Вебмастер (`YANDEX_WEBMASTER_TOKEN`),
  Google Search Console (`GSC_KEY_FILE`). Образец окружения — `seo/.env.example`,
  сам `seo/.env` в репозиторий не коммитится.
- `content/kb/*.md` + `node content/build.js` → `dist/` — статическая база
  знаний: страницы вопросов и обзоров с разметкой FAQPage/Article/LocalBusiness,
  перелинковкой, `sitemap-baza.xml` и картой покрытия `coverage.json`.
  Битая внутренняя ссылка роняет сборку.
- `server.js` отдаёт `/baza/` из `dist/`, монтирует панель и **закрывает всё
  зеркало от индексации** (`robots.txt` + `X-Robots-Tag: noindex`): копия
  клиентского сайта не должна конкурировать с оригиналом.

Сборка базы знаний обязательна после `git pull` на сервере — `dist/` в git не
хранится:

```bash
node content/build.js && pm2 restart sasha-lab --update-env
```
