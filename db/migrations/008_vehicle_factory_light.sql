-- Карточка машины, часть вторая (запрос владельца 24.09.2026, пункты 9–12):
-- к «что продаётся и как разбирается» добавляем ШТАТНОЕ исполнение фары —
--   * адаптивный свет с завода или нет,
--   * чем светит ближний с завода: галоген / ксенон / лед / лазер,
--   * что понадобится при замене штатного света: обманки CAN-шины и имитация
--     штатной нагрузки (без них борткомпьютер пишет «неисправна лампа»),
--   * какие лампы стоят в штатных приборах: цоколь (H7, D2S, HB3 …) и сам
--     прибор («ближний свет», «противотуманки», «габариты»).
--
-- Новых таблиц нет намеренно: поля 9–10 уже лежат в fitment с миграции 004
-- (adaptive, low_beam_source, factory_lens), поля 11–12 выводятся из
-- vehicle_parts (kind = wire — обманки, kind = bulb — лампы). Это сведение уже
-- собранного, а не новый сбор: повторно ходить по сайтам не требуется.
--
-- needs_canbus — не факт из источника, а вывод: на штатном ксеноне и штатном
-- лед-свете блок следит за нагрузкой, поэтому замена источника почти всегда
-- тянет за собой обманку. Поле помечает «скорее всего понадобится», а
-- canbus_offers отвечает на второй вопрос мастера — есть ли она в продаже.
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
         bool_or(f.status = 'confirmed')                           AS confirmed,
         -- штатное исполнение (пункты 9–10)
         bool_or(f.adaptive)                                       AS adaptive,
         count(*) FILTER (WHERE f.adaptive IS NOT NULL)::int       AS adaptive_facts,
         mode() WITHIN GROUP (ORDER BY f.low_beam_source) FILTER (WHERE f.low_beam_source IS NOT NULL) AS low_beam_raw,
         count(*) FILTER (WHERE f.low_beam_source IS NOT NULL)::int AS low_beam_facts,
         mode() WITHIN GROUP (ORDER BY f.factory_lens) FILTER (WHERE f.factory_lens IS NOT NULL) AS factory_lens
    FROM fitment f GROUP BY 1
), bulbs AS (
  -- пункт 12: цоколь и сам прибор вытаскиваем из названия товара. Цоколь —
  -- по справочнику обозначений, прибор — по хвосту «… в Ближний свет тип 2».
  SELECT vp.vehicle_id,
         count(*)::int AS bulb_offers,
         array_agg(DISTINCT upper(b.socket)) FILTER (WHERE b.socket IS NOT NULL) AS bulb_sockets,
         array_agg(DISTINCT lower(btrim(b.spot))) FILTER (WHERE b.spot IS NOT NULL) AS bulb_spots
    FROM vehicle_parts vp
    JOIN parts p ON p.id = vp.part_id
    CROSS JOIN LATERAL (
      SELECT (regexp_match(p.name, '\m(HB[34]|H1[13]|H[134789]|D[1-4][SR])\M', 'i'))[1] AS socket,
             -- «… в Передние противотуманки тип 2» → «передние противотуманки»:
             -- хвост «тип N» — это номер исполнения у магазина, не отдельный прибор.
             regexp_replace((regexp_match(p.name, ' в ([А-ЯЁ][А-Яа-яё]+(?: [А-Яа-яё]+){0,2})'))[1],
                            '\s+тип$', '')                                            AS spot
    ) b
   WHERE vp.kind = 'bulb'
   GROUP BY 1
), canbus AS (
  -- пункт 11: обманки и имитаторы штатной нагрузки, которые нашлись в продаже.
  SELECT vp.vehicle_id,
         count(*)::int                                   AS canbus_offers,
         min(p.price_rub) FILTER (WHERE p.price_rub > 0)  AS canbus_price_min
    FROM vehicle_parts vp JOIN parts p ON p.id = vp.part_id
   WHERE vp.kind = 'wire' AND p.name ~* 'обманк|canbus|can-шин|имитатор'
   GROUP BY 1
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
       t.confidence, coalesce(t.confirmed, false) AS confirmed,
       -- 9. адаптивный свет с завода
       t.adaptive, coalesce(t.adaptive_facts, 0) AS adaptive_facts,
       -- 10. чем светит ближний с завода (сведено к четырём видам, сырое рядом)
       CASE
         WHEN t.low_beam_raw ~* 'лазер|laser'          THEN 'лазер'
         WHEN t.low_beam_raw ~* 'led|лед|светодиод'    THEN 'лед'
         WHEN t.low_beam_raw ~* 'ксенон|xenon|hid'     THEN 'ксенон'
         WHEN t.low_beam_raw ~* 'галоген|halogen'      THEN 'галоген'
       END AS low_beam,
       t.low_beam_raw, coalesce(t.low_beam_facts, 0) AS low_beam_facts, t.factory_lens,
       -- 11. что понадобится при замене штатного света
       (t.low_beam_raw ~* 'ксенон|xenon|hid|led|лед|светодиод|лазер|laser') AS needs_canbus,
       coalesce(c.canbus_offers, 0) AS canbus_offers, c.canbus_price_min,
       -- 12. лампы в штатных приборах
       coalesce(b.bulb_offers, 0) AS bulb_offers, b.bulb_sockets, b.bulb_spots
  FROM vehicles v
  LEFT JOIN teardown t ON t.vehicle_id = v.id
  LEFT JOIN offers g ON g.vehicle_id = v.id AND g.kind = 'glass'
  LEFT JOIN offers h ON h.vehicle_id = v.id AND h.kind = 'housing'
  LEFT JOIN offers a ON a.vehicle_id = v.id AND a.kind = 'adapter'
  LEFT JOIN bulbs  b ON b.vehicle_id = v.id
  LEFT JOIN canbus c ON c.vehicle_id = v.id;
