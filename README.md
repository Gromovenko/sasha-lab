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
