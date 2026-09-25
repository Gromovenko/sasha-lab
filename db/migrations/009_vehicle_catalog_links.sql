-- Карточка машины, часть третья: к КАЖДОМУ из двенадцати пунктов — рабочая
-- ссылка на страницу, где это продаётся или откуда взят факт (запрос владельца
-- 25.09.2026). До этой миграции карточка отвечала «стекло — есть, 4 300 ₽», но
-- куда ехать за стеклом, мастеру приходилось искать заново.
--
-- Что считается ссылкой для пункта:
--   1–3 (марка/модель/годы) — страница магазина комплектующих по этой модели
--       (shop_url): точка входа «всё для этой машины»;
--   4,5,6,11,12 (стекло, корпус, рамка, обманка, лампы) — конкретная карточка
--       товара: лучшее предложение из найденных;
--   7,8,9,10 (разбор, герметик, адаптив, штатный ближний) — страница, из
--       которой факт вынут (fitment.evidence): факт без ссылки на источник
--       проверить нечем, а «сложность разбора» в магазине не продаётся.
--
-- «Рабочая» — не на слово: берём только адреса, которые на момент скачивания
-- отдали 200, не помечены мёртвыми (skip_reason) и по которым проверка
-- `links --check` не сказала «не 200». Живость перепроверяется тем же
-- `harvest/run.js links --check N`, карточка подхватывает результат сама.
--
-- Лучшее предложение = в наличии → с ценой → дешевле → свежее. Дорогое «в
-- наличии» полезнее дешёвого «под заказ»: мастеру нужна деталь сегодня.
CREATE INDEX IF NOT EXISTS vehicle_links_url_idx ON vehicle_links (url);

DROP VIEW IF EXISTS vehicle_catalog;
CREATE VIEW vehicle_catalog AS
WITH dead_url AS (
  -- адреса, про которые проверка живости сказала «не 200»
  SELECT DISTINCT url FROM vehicle_links WHERE http_status IS NOT NULL AND http_status <> 200
), offers AS (
  SELECT vp.vehicle_id, vp.kind,
         count(*)::int                                            AS offers,
         min(p.price_rub) FILTER (WHERE p.price_rub > 0)           AS price_min,
         count(*) FILTER (WHERE p.available IS TRUE)::int          AS in_stock,
         max(p.last_seen)                                          AS last_seen
    FROM vehicle_parts vp JOIN parts p ON p.id = vp.part_id
   GROUP BY 1, 2
), best AS (
  -- одна лучшая живая карточка товара на машину и вид детали
  SELECT DISTINCT ON (vp.vehicle_id, vp.kind) vp.vehicle_id, vp.kind, p.url, p.name
    FROM vehicle_parts vp
    JOIN parts p ON p.id = vp.part_id
    LEFT JOIN documents d ON d.url = p.url
   WHERE (d.id IS NULL OR (d.skip_reason IS NULL AND (d.http_status IS NULL OR d.http_status = 200)))
     AND NOT EXISTS (SELECT 1 FROM dead_url x WHERE x.url = p.url)
   ORDER BY vp.vehicle_id, vp.kind,
            (p.available IS TRUE) DESC, (p.price_rub > 0) DESC, p.price_rub, p.last_seen DESC
), best_canbus AS (
  -- пункт 11: та же логика, но только обманки и имитаторы нагрузки
  SELECT DISTINCT ON (vp.vehicle_id) vp.vehicle_id, p.url
    FROM vehicle_parts vp
    JOIN parts p ON p.id = vp.part_id
    LEFT JOIN documents d ON d.url = p.url
   WHERE vp.kind = 'wire' AND p.name ~* 'обманк|canbus|can-шин|имитатор'
     AND (d.id IS NULL OR (d.skip_reason IS NULL AND (d.http_status IS NULL OR d.http_status = 200)))
     AND NOT EXISTS (SELECT 1 FROM dead_url x WHERE x.url = p.url)
   ORDER BY vp.vehicle_id, (p.available IS TRUE) DESC, (p.price_rub > 0) DESC, p.price_rub, p.last_seen DESC
), shop AS (
  -- пункты 1–3: страница магазина комплектующих по этой модели. Связь по адресу
  -- или заголовку надёжнее факта: это и есть «раздел про эту машину».
  SELECT DISTINCT ON (l.vehicle_id) l.vehicle_id, l.url
    FROM vehicle_links l JOIN sources s ON s.id = l.source_id
   WHERE s.kind = 'parts' AND (l.http_status IS NULL OR l.http_status = 200)
   ORDER BY l.vehicle_id, CASE l.basis WHEN 'url' THEN 0 WHEN 'title' THEN 1 ELSE 2 END, l.url
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
         bool_or(f.adaptive)                                       AS adaptive,
         count(*) FILTER (WHERE f.adaptive IS NOT NULL)::int       AS adaptive_facts,
         mode() WITHIN GROUP (ORDER BY f.low_beam_source) FILTER (WHERE f.low_beam_source IS NOT NULL) AS low_beam_raw,
         count(*) FILTER (WHERE f.low_beam_source IS NOT NULL)::int AS low_beam_facts,
         mode() WITHIN GROUP (ORDER BY f.factory_lens) FILTER (WHERE f.factory_lens IS NOT NULL) AS factory_lens
    FROM fitment f GROUP BY 1
), fact_url AS (
  -- пункты 7–10: страница-источник факта. Сначала уверенные факты, среди равных
  -- — свежая страница; берём первый живой адрес.
  SELECT f.vehicle_id,
         (array_agg(d.url ORDER BY f.confidence DESC, d.fetched_at DESC)
            FILTER (WHERE f.difficulty IS NOT NULL OR f.needs_opening IS NOT NULL OR f.hours IS NOT NULL))[1] AS teardown_url,
         (array_agg(d.url ORDER BY f.confidence DESC, d.fetched_at DESC)
            FILTER (WHERE f.sealant IS NOT NULL))[1]         AS sealant_url,
         (array_agg(d.url ORDER BY f.confidence DESC, d.fetched_at DESC)
            FILTER (WHERE f.adaptive IS NOT NULL))[1]        AS adaptive_url,
         (array_agg(d.url ORDER BY f.confidence DESC, d.fetched_at DESC)
            FILTER (WHERE f.low_beam_source IS NOT NULL))[1] AS low_beam_url
    FROM fitment f, unnest(f.evidence) e
    JOIN documents d ON d.id = e
   WHERE d.skip_reason IS NULL AND (d.http_status IS NULL OR d.http_status = 200)
     AND NOT EXISTS (SELECT 1 FROM dead_url x WHERE x.url = d.url)
   GROUP BY 1
), bulbs AS (
  SELECT vp.vehicle_id,
         count(*)::int AS bulb_offers,
         array_agg(DISTINCT upper(b.socket)) FILTER (WHERE b.socket IS NOT NULL) AS bulb_sockets,
         array_agg(DISTINCT lower(btrim(b.spot))) FILTER (WHERE b.spot IS NOT NULL) AS bulb_spots
    FROM vehicle_parts vp
    JOIN parts p ON p.id = vp.part_id
    CROSS JOIN LATERAL (
      SELECT (regexp_match(p.name, '\m(HB[34]|H1[13]|H[134789]|D[1-4][SR])\M', 'i'))[1] AS socket,
             regexp_replace((regexp_match(p.name, ' в ([А-ЯЁ][А-Яа-яё]+(?: [А-Яа-яё]+){0,2})'))[1],
                            '\s+тип$', '')                                            AS spot
    ) b
   WHERE vp.kind = 'bulb'
   GROUP BY 1
), canbus AS (
  SELECT vp.vehicle_id,
         count(*)::int                                   AS canbus_offers,
         min(p.price_rub) FILTER (WHERE p.price_rub > 0)  AS canbus_price_min
    FROM vehicle_parts vp JOIN parts p ON p.id = vp.part_id
   WHERE vp.kind = 'wire' AND p.name ~* 'обманк|canbus|can-шин|имитатор'
   GROUP BY 1
)
SELECT v.id AS vehicle_id, v.make, v.model, v.generation, v.year_from, v.year_to, v.slug,
       -- 1–3: куда ехать за всем для этой машины
       sh.url AS shop_url,
       coalesce(g.offers, 0)   AS glass_offers,   g.price_min AS glass_price_min,
       coalesce(g.in_stock, 0) > 0 AS glass_in_stock,   bg.url AS glass_url,
       coalesce(h.offers, 0)   AS housing_offers, h.price_min AS housing_price_min,
       coalesce(h.in_stock, 0) > 0 AS housing_in_stock, bh.url AS housing_url,
       coalesce(a.offers, 0)   AS adapter_offers, a.price_min AS adapter_price_min,
       coalesce(a.in_stock, 0) > 0 AS adapter_in_stock, ba.url AS adapter_url,
       t.difficulty, t.needs_opening, t.hours_max, coalesce(t.teardown_facts, 0) AS teardown_facts,
       fu.teardown_url,
       CASE
         WHEN t.sealant_raw ~* 'полиуретан|polyurethane'        THEN 'полиуретан'
         WHEN t.sealant_raw ~* 'бутил|butyl|битум|bitumen'      THEN 'бутил'
         WHEN t.sealant_raw ~* 'термоклей|hot'                  THEN 'термоклей'
         WHEN t.sealant_raw ~* 'силикон|silicone'               THEN 'силикон'
       END AS sealant,
       t.sealant_raw, coalesce(t.sealant_facts, 0) AS sealant_facts, fu.sealant_url,
       t.confidence, coalesce(t.confirmed, false) AS confirmed,
       t.adaptive, coalesce(t.adaptive_facts, 0) AS adaptive_facts, fu.adaptive_url,
       CASE
         WHEN t.low_beam_raw ~* 'лазер|laser'          THEN 'лазер'
         WHEN t.low_beam_raw ~* 'led|лед|светодиод'    THEN 'лед'
         WHEN t.low_beam_raw ~* 'ксенон|xenon|hid'     THEN 'ксенон'
         WHEN t.low_beam_raw ~* 'галоген|halogen'      THEN 'галоген'
       END AS low_beam,
       t.low_beam_raw, coalesce(t.low_beam_facts, 0) AS low_beam_facts, fu.low_beam_url,
       t.factory_lens,
       (t.low_beam_raw ~* 'ксенон|xenon|hid|led|лед|светодиод|лазер|laser') AS needs_canbus,
       coalesce(c.canbus_offers, 0) AS canbus_offers, c.canbus_price_min, bc.url AS canbus_url,
       coalesce(b.bulb_offers, 0) AS bulb_offers, b.bulb_sockets, b.bulb_spots, bb.url AS bulb_url
  FROM vehicles v
  LEFT JOIN teardown t ON t.vehicle_id = v.id
  LEFT JOIN fact_url fu ON fu.vehicle_id = v.id
  LEFT JOIN shop sh ON sh.vehicle_id = v.id
  LEFT JOIN offers g ON g.vehicle_id = v.id AND g.kind = 'glass'
  LEFT JOIN offers h ON h.vehicle_id = v.id AND h.kind = 'housing'
  LEFT JOIN offers a ON a.vehicle_id = v.id AND a.kind = 'adapter'
  LEFT JOIN best bg ON bg.vehicle_id = v.id AND bg.kind = 'glass'
  LEFT JOIN best bh ON bh.vehicle_id = v.id AND bh.kind = 'housing'
  LEFT JOIN best ba ON ba.vehicle_id = v.id AND ba.kind = 'adapter'
  LEFT JOIN best bb ON bb.vehicle_id = v.id AND bb.kind = 'bulb'
  LEFT JOIN best_canbus bc ON bc.vehicle_id = v.id
  LEFT JOIN bulbs  b ON b.vehicle_id = v.id
  LEFT JOIN canbus c ON c.vehicle_id = v.id;
