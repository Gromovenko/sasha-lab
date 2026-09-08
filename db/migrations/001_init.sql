-- Хранилище проекта sasha-lab. Отдельная база, отдельная роль: правило владельца
-- «каждый проект — своя независимая БД» (RESTORE-STATE.md, целевая архитектура).
--
-- Что здесь лежит и почему именно в базе, а не в JSON рядом с кодом:
--   * вопросы живых людей — контакт и IP, их нельзя ни коммитить, ни терять при
--     rsync --delete с EU;
--   * материалы базы знаний — источник правды для сборки статики; до этого они
--     жили файлами на проде и сносились выкатом;
--   * позиции — временной ряд, по нему нужны запросы «что изменилось».

CREATE TABLE IF NOT EXISTS questions (
  id            text PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  name          text NOT NULL,
  contact       text NOT NULL,          -- телефон/почта: НА САЙТ НЕ ПОПАДАЕТ
  car           text,
  text          text NOT NULL,
  ip            text,                   -- для антиспама, тоже не публикуется
  user_agent    text,
  status        text NOT NULL DEFAULT 'new',   -- new | published | rejected
  slug          text,                   -- материал, которым ответили
  published_at  timestamptz,
  note          text
);
CREATE INDEX IF NOT EXISTS questions_status_idx ON questions (status, created_at DESC);

-- Материалы базы знаний. Раньше — content/kb/*.md, теперь файлы это только вход
-- для ручного наполнения (db/import.js), правда — здесь.
CREATE TABLE IF NOT EXISTS materials (
  slug          text PRIMARY KEY,
  rubric        text NOT NULL,          -- linzy | remont | polirovka | zakon | vybor
  type          text NOT NULL DEFAULT 'question',  -- question | guide
  title         text NOT NULL,
  description   text,
  body          text NOT NULL,          -- markdown
  tags          text[] NOT NULL DEFAULT '{}',
  queries       text[] NOT NULL DEFAULT '{}',      -- какие запросы закрывает
  asker         text,                   -- имя спросившего, публикуется
  question      text,                   -- цитата вопроса на странице
  updated_label text,                   -- «08.09.2026» — то, что видит человек
  question_id   text REFERENCES questions (id) ON DELETE SET NULL,
  published     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS materials_rubric_idx ON materials (rubric);

-- Семантика: одна строка на фразу, источники дописывают свои поля.
CREATE TABLE IF NOT EXISTS keywords (
  phrase        text PRIMARY KEY,       -- в нижнем регистре
  display       text,                   -- как пришла от источника
  count         integer,                -- частотность Wordstat
  shows         integer,                -- показы Вебмастера
  impressions   integer,                -- показы GSC
  clicks        integer,
  yandex_pos    numeric(6,2),
  google_pos    numeric(6,2),
  source        text,                   -- wordstat | webmaster | gsc | manual
  seed          text,                   -- от какой корневой фразы развернулась
  cluster       text,
  checked_at    date,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS keywords_count_idx ON keywords (count DESC NULLS LAST);

-- Снимки выдачи. Историю не перетираем: смысл ряда — в изменении.
CREATE TABLE IF NOT EXISTS positions (
  id            bigserial PRIMARY KEY,
  checked_on    date NOT NULL,
  engine        text NOT NULL DEFAULT 'yandex',
  phrase        text NOT NULL,
  region        text,
  pos           integer,                -- NULL = сайта в выдаче нет
  url           text,
  top           jsonb,                  -- топ-10 конкурентов на момент замера
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS positions_phrase_idx ON positions (engine, phrase, checked_on DESC);

-- Журнал запусков сбора: панель должна показывать не «данных нет», а что именно
-- не получилось и когда.
CREATE TABLE IF NOT EXISTS job_runs (
  id            bigserial PRIMARY KEY,
  job           text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  ok            boolean,
  error         text,
  stats         jsonb
);
CREATE INDEX IF NOT EXISTS job_runs_job_idx ON job_runs (job, started_at DESC);

-- Мелкое состояние панели (выгрузки, последняя ошибка). Отдельная таблица под
-- каждую такую мелочь — лишняя сущность.
CREATE TABLE IF NOT EXISTS kv (
  key           text PRIMARY KEY,
  value         jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
