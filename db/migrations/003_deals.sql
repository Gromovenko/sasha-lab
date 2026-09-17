-- Сделки: универсальный конвейер обращений «вопрос клиента → готовый ответ с ценой».
--
-- Почему это отдельный слой, а не «ещё одна форма на сайте»:
--   * questions — публичная очередь «вопрос → материал базы знаний» (контент);
--     deals — работа: переписка, фото, смета, отправка, догоняющие касания.
--   * ни одна колонка здесь не знает про фары и линзы. Отрасль задаёт ПАКЕТ
--     (packs/*.json): поля объекта, чек-лист фото, каталог, правила, шаблон КП.
--     Тот же движок обслуживает отели (letov) или ремонт техники — меняется файл пакета.
--   * всё, что модель «поняла», лежит в jsonb рядом с сырой перепиской: решение
--     мастера всегда можно сверить с исходником и переиграть (pipeline пересчитывает).

CREATE TABLE IF NOT EXISTS deals (
  id            text PRIMARY KEY,                 -- d_<hex>
  pack          text NOT NULL,                    -- какой отраслевой пакет обслуживает
  channel       text NOT NULL,                    -- web | telegram | email | avito | whatsapp | manual
  external_id   text,                             -- id чата/треда в канале (для ответа туда же)
  client_name   text,
  client_contact text,                            -- телефон/почта/ник: ПЕРСДАННЫЕ, на сайт не попадают
  subject       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- объект заявки по схеме пакета (машина/номер/техника)
  request       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- что хочет: услуги, сроки, бюджет, город
  findings      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- что увидело зрение на фото (коды из пакета)
  missing       text[] NOT NULL DEFAULT '{}',        -- чего не хватает для сметы
  stage         text NOT NULL DEFAULT 'new',      -- new | clarify | quoted | sent | won | lost | spam
  quote         jsonb,                            -- последняя смета (строки, итог)
  total_rub     integer,
  note          text,                             -- заметка мастера
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_in_at    timestamptz,                      -- последнее сообщение клиента (по нему SLA)
  last_out_at   timestamptz
);
CREATE INDEX IF NOT EXISTS deals_stage_idx ON deals (stage, updated_at DESC);
-- Канал + внешний id: второе сообщение из того же чата должно попасть в ТУ ЖЕ сделку,
-- иначе на каждое «а сколько стоит?» заводится новая карточка. external_id может быть
-- пустым (заявка с сайта) — поэтому индекс частичный.
CREATE UNIQUE INDEX IF NOT EXISTS deals_channel_external_idx
  ON deals (channel, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS deal_messages (
  id          bigserial PRIMARY KEY,
  deal_id     text NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  direction   text NOT NULL,                      -- in | out
  channel     text NOT NULL,
  author      text,                               -- client | master | assistant
  text        text NOT NULL DEFAULT '',
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{name,kind,path,bytes}] — файлы лежат в uploads/
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,                        -- для исходящих: когда ушло в канал
  error       text
);
CREATE INDEX IF NOT EXISTS deal_messages_deal_idx ON deal_messages (deal_id, created_at);

-- Черновик ответа. Хранится ОТДЕЛЬНО от переписки: пока мастер не нажал «отправить»,
-- клиент этого текста не видел. Цифры в quote — расчёт движка, text — то, что уйдёт.
CREATE TABLE IF NOT EXISTS deal_drafts (
  id          bigserial PRIMARY KEY,
  deal_id     text NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'offer',      -- offer | question | followup
  rev         integer NOT NULL DEFAULT 1,         -- пересчёт после нового фото — новая ревизия
  text        text NOT NULL,
  quote       jsonb,
  reason      text,                               -- «уточнено по фото: мало места за фарой»
  engine      text,                               -- template | llm
  status      text NOT NULL DEFAULT 'pending',    -- pending | sent | dropped
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS deal_drafts_deal_idx ON deal_drafts (deal_id, created_at DESC);

-- Догоняющие касания: «из моих ответов 80% в пустоту» лечится не текстом ответа,
-- а тем, что через N часов уходит короткое напоминание. План строится пакетом.
CREATE TABLE IF NOT EXISTS deal_followups (
  id         bigserial PRIMARY KEY,
  deal_id    text NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  step       integer NOT NULL DEFAULT 1,
  due_at     timestamptz NOT NULL,
  text       text NOT NULL,
  status     text NOT NULL DEFAULT 'planned',     -- planned | sent | cancelled
  sent_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, step)
);
CREATE INDEX IF NOT EXISTS deal_followups_due_idx ON deal_followups (status, due_at);

-- Каталог. Пакет несёт эталон (цены «как в прайсе»), а живые цены мастер правит
-- из панели — поэтому строки лежат в базе, а файл пакета только наливает их.
CREATE TABLE IF NOT EXISTS catalog (
  pack       text NOT NULL,
  sku        text NOT NULL,
  kind       text NOT NULL DEFAULT 'item',        -- item | option | work | fee
  title      text NOT NULL,
  price_rub  integer NOT NULL DEFAULT 0,
  unit       text,
  tags       text[] NOT NULL DEFAULT '{}',
  includes   text[] NOT NULL DEFAULT '{}',        -- что входит в стоимость (печатается в КП)
  enabled    boolean NOT NULL DEFAULT true,
  sort       integer NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack, sku)
);

-- Автостраницы базы знаний: откуда материал взялся и чем он обоснован.
-- origin=auto + published=false — черновик, ждёт кнопки владельца.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual';
ALTER TABLE materials ADD COLUMN IF NOT EXISTS auto_note text;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS grounding jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS materials_origin_idx ON materials (origin, published);
