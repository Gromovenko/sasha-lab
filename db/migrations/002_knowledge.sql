-- База знаний: сбор внешних источников, разбор в факты, память по интентам.
--
-- Зачем отдельный слой, а не «сложить статьи конкурентов в materials»:
--   * documents — РАБОЧИЙ материал, а не контент сайта. Чужой текст здесь лежит
--     для разбора (какие машины, какие линзы, какие узлы), публикуется он НИКОГДА.
--     На сайт идёт только то, что написала студия, со ссылкой на источник факта.
--     Копипаста чужих статей = дубль в индексе и претензия по 1259/1270 ГК.
--   * facts (vehicles/parts/fitment) — то, ради чего всё затевалось: связка
--     «марка-модель-год → что туда встаёт → какие нюансы». Это переживает
--     перевыкладку источников и работает и для гайда установщика, и для страниц.
--   * intents — «сео-память»: одна фраза = один адрес. Решение «усилить
--     существующую страницу» принимается один раз и хранится, а не пересочиняется.

-- ── Источники ──────────────────────────────────────────────────────────────
-- kind: works    — сайты с примерами работ (что и на что ставят)
--       parts    — каталоги комплектующих (что вообще продаётся)
--       community— Drive2 и т.п. (живой опыт, ошибки, нюансы)
--       telegram — экспорт канала
CREATE TABLE IF NOT EXISTS sources (
  id          serial PRIMARY KEY,
  host        text UNIQUE NOT NULL,
  kind        text NOT NULL,
  title       text,
  enabled     boolean NOT NULL DEFAULT true,
  delay_ms    integer NOT NULL DEFAULT 3000,   -- пауза между запросами к этому хосту
  max_pages   integer NOT NULL DEFAULT 300,    -- потолок за один заход
  robots_note text,                            -- что разрешает robots.txt на момент проверки
  last_run_at timestamptz,
  note        text,
  added_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Документы (сырьё) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id           bigserial PRIMARY KEY,
  source_id    integer REFERENCES sources (id) ON DELETE CASCADE,
  url          text UNIQUE NOT NULL,
  http_status  integer,
  title        text,
  author       text,
  published_at timestamptz,
  text         text,                 -- очищенный текст: ТОЛЬКО для разбора
  text_hash    text,                 -- sha1: не перезаписываем и не переразбираем одно и то же
  words        integer,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  parsed_at    timestamptz,          -- когда из него вынули факты
  skip_reason  text                  -- почему не разбираем (короткий, не по теме, платный)
);
CREATE INDEX IF NOT EXISTS documents_source_idx ON documents (source_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS documents_unparsed_idx ON documents (parsed_at) WHERE parsed_at IS NULL;

-- ── Машины ─────────────────────────────────────────────────────────────────
-- Год важен: рынок сейчас едет в китайские марки, и у одной модели за три года
-- меняется тип фары. Поколение держим отдельным полем, а не в модели.
CREATE TABLE IF NOT EXISTS vehicles (
  id         serial PRIMARY KEY,
  make       text NOT NULL,
  model      text NOT NULL,
  generation text,
  year_from  integer,
  year_to    integer,
  slug       text UNIQUE NOT NULL,          -- haval-jolion, chery-tiggo-7-pro
  aliases    text[] NOT NULL DEFAULT '{}',  -- «джолион», «tiggo 7 pro max»
  mentions   integer NOT NULL DEFAULT 0,    -- сколько раз встретилась в источниках
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (make, model, generation)
);
CREATE INDEX IF NOT EXISTS vehicles_mentions_idx ON vehicles (mentions DESC);

-- ── Комплектующие ──────────────────────────────────────────────────────────
-- kind: lens | adapter | ballast | bulb | mask | glass | sealant | wire | tool | other
CREATE TABLE IF NOT EXISTS parts (
  id         bigserial PRIMARY KEY,
  source_id  integer REFERENCES sources (id) ON DELETE SET NULL,
  url        text UNIQUE NOT NULL,
  kind       text NOT NULL DEFAULT 'other',
  vendor     text,
  name       text NOT NULL,
  price_rub  integer,
  specs      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- диаметр, посадка, цоколь, температура
  available  boolean,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parts_kind_idx ON parts (kind, vendor);

-- ── Совместимость: главный результат всей затеи ────────────────────────────
-- Одна строка = «в такую-то фару такой-то машины ставят вот это, вот так».
-- evidence — id документов, из которых факт собран: без ссылки на источник
-- строка бесполезна, проверить нечем.
CREATE TABLE IF NOT EXISTS fitment (
  id            bigserial PRIMARY KEY,
  vehicle_id    integer NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  headlight     text,               -- галоген | линзованный галоген | штатный ксенон | led
  lens          text,               -- модель линзы/комплекта
  approach      text,               -- со вскрытием | без вскрытия | замена модуля
  needs_opening boolean,
  difficulty    text,               -- лёгкая | средняя | сложная
  hours         numeric(4,1),
  notes         text,
  confidence    numeric(3,2) NOT NULL DEFAULT 0.5,
  evidence      bigint[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'draft',  -- draft | confirmed (подтверждено студией)
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, lens, approach)
);
CREATE INDEX IF NOT EXISTS fitment_vehicle_idx ON fitment (vehicle_id);

-- ── Сео-память ─────────────────────────────────────────────────────────────
-- Смысл: НЕ плодить страницу под каждую фразу. Фраза нормализуется, склеивается
-- с кластером, и решение «куда её вести» принимается один раз и живёт здесь.
-- decision: covered   — уже закрыта страницей target_slug
--           strengthen— дописать в существующую (её же и усиливаем)
--           new       — заслуживает своей страницы (уникальный интент)
--           skip      — коммерческий/чужой/мусорный интент
CREATE TABLE IF NOT EXISTS intents (
  id          bigserial PRIMARY KEY,
  phrase_norm text UNIQUE NOT NULL,     -- нормализованная фраза (ключ склейки)
  phrase      text NOT NULL,            -- как её пишет человек
  cluster     text,                     -- смысловая группа
  vehicle_id  integer REFERENCES vehicles (id) ON DELETE SET NULL,
  target_slug text,                     -- страница, которая за неё отвечает
  decision    text NOT NULL DEFAULT 'new',
  demand      integer,                  -- частотность на момент решения
  decided_at  timestamptz,
  decided_by  text,                     -- auto | owner
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intents_decision_idx ON intents (decision, demand DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS intents_target_idx ON intents (target_slug);

-- ── Ассистент базы знаний ──────────────────────────────────────────────────
-- Два режима: client — человеку с его болью; pro — установщику подбор и нюансы.
-- Диалоги храним не ради архива, а ради очереди вопросов: то, на что ассистент
-- ответил плохо или не смог, — это и есть темы следующих материалов.
CREATE TABLE IF NOT EXISTS assistant_threads (
  id         text PRIMARY KEY,
  mode       text NOT NULL DEFAULT 'client',
  vehicle_id integer REFERENCES vehicles (id) ON DELETE SET NULL,
  ip         text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS assistant_messages (
  id         bigserial PRIMARY KEY,
  thread_id  text NOT NULL REFERENCES assistant_threads (id) ON DELETE CASCADE,
  role       text NOT NULL,             -- user | assistant
  text       text NOT NULL,
  used       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- чем отвечал: slug-и материалов, id фактов
  engine     text,
  unanswered boolean NOT NULL DEFAULT false,       -- ассистент не нашёл ответа → в очередь студии
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistant_messages_thread_idx ON assistant_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS assistant_unanswered_idx ON assistant_messages (created_at DESC) WHERE unanswered;
