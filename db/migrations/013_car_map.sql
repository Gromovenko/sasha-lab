-- Мост «справочник vehicles ↔ база авто cars» и привязка наблюдения к машине
-- (правки владельца 26.09.2026, H4/H3/H2).
--
--   car_obs.car_id     — в какую сведённую машину (поколение) село наблюдение.
--                        Через url наблюдения детали и факты страницы получают
--                        поколение, а не только текстовую догадку по названию.
--   car_obs.purpose_src— откуда взято назначение: 'title' (прямо в заголовке)
--                        или NULL. По виду детали назначение НЕ выводим.
--   vehicle_car_map    — сопоставление грязного справочника vehicles с cars:
--                        method = exact (марка+модель+пересечение годов)
--                                 fuzzy (марка+модель, годы не сошлись)
ALTER TABLE car_obs ADD COLUMN IF NOT EXISTS car_id integer REFERENCES cars (id) ON DELETE SET NULL;
ALTER TABLE car_obs ADD COLUMN IF NOT EXISTS purpose_src text;
CREATE INDEX IF NOT EXISTS car_obs_car_idx ON car_obs (car_id);
CREATE INDEX IF NOT EXISTS car_obs_url_idx ON car_obs (url);

CREATE TABLE IF NOT EXISTS vehicle_car_map (
  vehicle_id integer NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  car_id     integer NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
  method     text NOT NULL,                  -- exact | fuzzy
  built_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vehicle_id, car_id)
);
CREATE INDEX IF NOT EXISTS vehicle_car_map_car_idx ON vehicle_car_map (car_id);
