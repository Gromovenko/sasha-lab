-- База авто со ссылками на ВСЕ ресурсы: одна строка = «эта машина упоминается
-- по этому адресу». Заполняется командой `harvest/run.js links` и пересобирается
-- целиком (это производная от documents/fitment, а не первичные данные).
--
-- basis — почему связали: evidence (из этой страницы вынут факт посадки — самая
-- надёжная связь), url (марка и модель есть в самом адресе), title (в заголовке).
-- http_status/checked_at — «активность» ссылки: статус на момент скачивания и
-- на момент последней проверки `links --check`.
CREATE TABLE IF NOT EXISTS vehicle_links (
  vehicle_id  integer NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  document_id bigint  NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  source_id   integer REFERENCES sources (id) ON DELETE CASCADE,
  url         text NOT NULL,
  title       text,
  basis       text NOT NULL,
  http_status integer,
  checked_at  timestamptz,
  PRIMARY KEY (vehicle_id, document_id)
);
CREATE INDEX IF NOT EXISTS vehicle_links_source_idx ON vehicle_links (source_id);

-- Карточка машины: сколько ресурсов и с каких сайтов.
CREATE OR REPLACE VIEW vehicle_resources AS
SELECT v.id AS vehicle_id, v.make, v.model, v.generation, v.year_from, v.year_to, v.slug,
       count(l.document_id)            AS links,
       count(DISTINCT l.source_id)     AS sources,
       (SELECT count(*) FROM fitment f WHERE f.vehicle_id = v.id) AS facts
FROM vehicles v LEFT JOIN vehicle_links l ON l.vehicle_id = v.id
GROUP BY v.id;
