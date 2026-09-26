-- H4: мост «старая запись справочника vehicles → машина из cars» + car_id в слоях.
-- H2: откуда взято назначение детали (purpose_src).
CREATE TABLE IF NOT EXISTS vehicle_car_map (
  vehicle_id integer PRIMARY KEY REFERENCES vehicles (id) ON DELETE CASCADE,
  car_id     integer NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
  method     text NOT NULL CHECK (method IN ('exact', 'fuzzy')),
  built_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_car_map_car_idx ON vehicle_car_map (car_id);
ALTER TABLE fitment       ADD COLUMN IF NOT EXISTS car_id integer;
ALTER TABLE vehicle_parts ADD COLUMN IF NOT EXISTS car_id integer;
ALTER TABLE vehicle_links ADD COLUMN IF NOT EXISTS car_id integer;
ALTER TABLE car_obs       ADD COLUMN IF NOT EXISTS purpose_src text;   -- title | null
