-- Учётные записи, сессии, восстановление пароля и единый журнал событий.
--
-- Зачем это появилось: до сих пор во все закрытые разделы пускал ОДИН пароль из
-- окружения (SEO_ADMIN_PASSWORD / CRM_PASSWORD). Пока людей двое — терпимо, но
-- у такой двери нет ни имени того, кто вошёл, ни отзыва доступа, ни истории
-- действий, ни кабинета клиента. Раздел /admin сводит данные всех контуров
-- (заявки, вопросы, спрос, знания, службы) в одно место, и ему нужен нормальный
-- вход: люди, роли, сессии, восстановление пароля и журнал «кто что сделал».
--
-- Пароли лежат только хэшем (scrypt, соль на запись) — база утекает целиком или
-- не утекает вовсе, и во втором случае из неё нечего доставать.
-- Токены сессий и восстановления тоже хранятся ХЭШЕМ: в базе нет значения,
-- которым можно войти, — только отпечаток того, что у человека в куке/письме.

CREATE TABLE IF NOT EXISTS app_users (
  id            bigserial PRIMARY KEY,
  email         text UNIQUE,                     -- всегда в нижнем регистре
  phone         text UNIQUE,                     -- только цифры, 11 знаков (7…)
  name          text,
  role          text NOT NULL DEFAULT 'client',  -- owner | admin | master | client
  password_hash text,                            -- NULL = приглашён, пароля ещё нет
  status        text NOT NULL DEFAULT 'active',  -- active | blocked
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,                     -- защита от перебора пароля
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CONSTRAINT app_users_contact_ck CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS app_users_role_idx ON app_users (role, status);

-- Сессия — строка в базе, а не подписанная кука без хранилища: только так
-- «выйти на всех устройствах» и «заблокировать человека» работают немедленно.
CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash   text PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  ua           text,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON app_sessions (user_id, expires_at DESC);

-- Восстановление пароля: токен одноразовый и короткоживущий, в базе — хэш.
-- sent_via честно пишет, чем ушла ссылка (или что не ушла ничем).
CREATE TABLE IF NOT EXISTS app_password_resets (
  token_hash text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  ip         text,
  sent_via   text
);
CREATE INDEX IF NOT EXISTS app_password_resets_user_idx ON app_password_resets (user_id, created_at DESC);

-- Единый журнал. Раньше события расползались по трём местам: job_runs (только
-- сео-задачи), console.log процесса (умирает с ротацией pm2) и нигде (вход в
-- панель не писался вообще). Здесь одна таблица на все контуры: area говорит,
-- чей это слой, action — что произошло, meta — подробности.
CREATE TABLE IF NOT EXISTS app_events (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  level     text NOT NULL DEFAULT 'info',   -- debug | info | warn | error | security
  area      text NOT NULL DEFAULT 'app',    -- auth | admin | crm | engine | seo | harvest | cabinet | system
  action    text NOT NULL,
  message   text,
  user_id   bigint REFERENCES app_users(id) ON DELETE SET NULL,
  actor     text,                           -- как подписался (почта/имя/служба)
  entity    text,                           -- deal | question | user | material…
  entity_id text,
  ip        text,
  ua        text,
  meta      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS app_events_at_idx ON app_events (at DESC);
CREATE INDEX IF NOT EXISTS app_events_area_idx ON app_events (area, at DESC);
CREATE INDEX IF NOT EXISTS app_events_level_idx ON app_events (level, at DESC);
CREATE INDEX IF NOT EXISTS app_events_entity_idx ON app_events (entity, entity_id, at DESC);

-- Заявка теперь может принадлежать клиенту: он видит свои расчёты в кабинете.
-- Колонка необязательная — заявка с улицы приходит раньше любой учётки.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS client_user_id bigint REFERENCES app_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS deals_client_user_idx ON deals (client_user_id, updated_at DESC);
