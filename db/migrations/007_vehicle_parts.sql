-- Карточка машины для подбора: марка, модель, годы — и сразу ответ на четыре
-- вопроса, ради которых мастер лезет в базу (запрос владельца 24.09.2026):
--   * продаётся ли СТЕКЛО фары,
--   * продаётся ли КОРПУС фары,
--   * есть ли ПЕРЕХОДНАЯ РАМКА под би-лед модуль,
--   * чем грозит разбор: сложность/время и на чём фара собрана с завода
--     (полиуретан не переплавляется, бутил переплавляется — это разные работы).
--
-- Почему отдельная таблица, а не колонки в vehicles: «наличие запчасти» — это не
-- свойство машины, а найденное предложение конкретного магазина, со своей ценой,
-- адресом и датой. Одна строка = «эта деталь для этой машины лежит вот тут».
-- Таблица ПРОИЗВОДНАЯ, как vehicle_links: целиком пересобирается из parts и
-- vehicle_links командой `node harvest/run.js catalog`, руками её не правят.
CREATE TABLE IF NOT EXISTS vehicle_parts (
  vehicle_id integer NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  part_id    bigint  NOT NULL REFERENCES parts (id) ON DELETE CASCADE,
  kind       text NOT NULL,   -- glass | housing | adapter | lens | mask | bulb | …
  basis      text NOT NULL,   -- evidence | url | title — как связали (см. vehicle_links)
  PRIMARY KEY (vehicle_id, part_id)
);
CREATE INDEX IF NOT EXISTS vehicle_parts_kind_idx ON vehicle_parts (kind);
CREATE INDEX IF NOT EXISTS vehicle_parts_vehicle_idx ON vehicle_parts (vehicle_id, kind);

-- Одна строка на машину — то, что просил владелец, в готовом виде.
--
-- Про герметик. В базе он лежит так, как его называет источник, а называют его
-- вразнобой: «бутиловый», «битумный» (в мастерских так зовут ту же бутиловую
-- ленту) и «полиуретановый». Для работы важно ровно одно различие — греется и
-- переплавляется (бутил) или нет (полиуретан), поэтому sealant сведён к нему,
-- а сырые формулировки сохранены рядом в sealant_raw: сведение не теряет данные.
CREATE OR REPLACE VIEW vehicle_catalog AS
WITH offers AS (
  SELECT vp.vehicle_id, vp.kind,
         count(*)::int                                            AS offers,
         min(p.price_rub) FILTER (WHERE p.price_rub > 0)           AS price_min,
         count(*) FILTER (WHERE p.available IS TRUE)::int          AS in_stock,
         max(p.last_seen)                                          AS last_seen
    FROM vehicle_parts vp JOIN parts p ON p.id = vp.part_id
   GROUP BY 1, 2
), teardown AS (
  SELECT f.vehicle_id,
         mode() WITHIN GROUP (ORDER BY f.difficulty) FILTER (WHERE f.difficulty IS NOT NULL) AS difficulty,
         bool_or(f.needs_opening)                                  AS needs_opening,
         max(f.hours)                                              AS hours_max,
         count(*) FILTER (WHERE f.difficulty IS NOT NULL
                             OR f.needs_opening IS NOT NULL
                             OR f.hours IS NOT NULL)::int          AS teardown_facts,
         mode() WITHIN GROUP (ORDER BY f.sealant) FILTER (WHERE f.sealant IS NOT NULL) AS sealant_raw,
         count(*) FILTER (WHERE f.sealant IS NOT NULL)::int        AS sealant_facts,
         max(f.confidence)                                         AS confidence,
         bool_or(f.status = 'confirmed')                           AS confirmed
    FROM fitment f GROUP BY 1
)
SELECT v.id AS vehicle_id, v.make, v.model, v.generation, v.year_from, v.year_to, v.slug,
       coalesce(g.offers, 0)   AS glass_offers,   g.price_min AS glass_price_min,
       coalesce(g.in_stock, 0) > 0 AS glass_in_stock,
       coalesce(h.offers, 0)   AS housing_offers, h.price_min AS housing_price_min,
       coalesce(h.in_stock, 0) > 0 AS housing_in_stock,
       coalesce(a.offers, 0)   AS adapter_offers, a.price_min AS adapter_price_min,
       coalesce(a.in_stock, 0) > 0 AS adapter_in_stock,
       t.difficulty, t.needs_opening, t.hours_max, coalesce(t.teardown_facts, 0) AS teardown_facts,
       CASE
         WHEN t.sealant_raw ~* 'полиуретан|polyurethane'        THEN 'полиуретан'
         WHEN t.sealant_raw ~* 'бутил|butyl|битум|bitumen'      THEN 'бутил'
         WHEN t.sealant_raw ~* 'термоклей|hot'                  THEN 'термоклей'
         WHEN t.sealant_raw ~* 'силикон|silicone'               THEN 'силикон'
       END AS sealant,
       t.sealant_raw, coalesce(t.sealant_facts, 0) AS sealant_facts,
       t.confidence, coalesce(t.confirmed, false) AS confirmed
  FROM vehicles v
  LEFT JOIN teardown t ON t.vehicle_id = v.id
  LEFT JOIN offers g ON g.vehicle_id = v.id AND g.kind = 'glass'
  LEFT JOIN offers h ON h.vehicle_id = v.id AND h.kind = 'housing'
  LEFT JOIN offers a ON a.vehicle_id = v.id AND a.kind = 'adapter';
