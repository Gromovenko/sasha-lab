-- База автомобилей «марка — модель — год» с перекрёстной сверкой источников
-- (запрос владельца 26.09.2026).
--   car_obs      — одно наблюдение: одна страница каталога переходных рамок,
--                  из заголовка вынуты марка, модель, поколение, годы и
--                  комплектация фары (свет: галоген/ксенон/LED, AFS, рестайл).
--   cars         — сведённая машина. Подтверждена (status='confirmed'), только
--                  когда марка, модель И годы совпали минимум у двух РАЗНЫХ сайтов.
--   car_variants — комплектации фары одной машины (свет × AFS × рестайл),
--                  у каждой свой счёт источников и свой статус.
-- Заголовки не содержат года у части сайтов (vdf-light, aozoom): они подтверждают
-- марку и модель (cars.mm_hosts), но не годы.
CREATE TABLE IF NOT EXISTS car_obs (
  id         bigserial PRIMARY KEY,
  host       text NOT NULL,
  url        text NOT NULL UNIQUE,
  title      text,
  make       text NOT NULL,
  model      text NOT NULL,          -- база модели: a6, camry, 3, land-cruiser
  gen        text,                   -- поколение/кузов: c6, v50, e91, 2
  year_from  integer,
  year_to    integer,
  restyle    text,                   -- pre | restyle | null
  light      text,                   -- halogen | xenon | led | null
  afs        boolean,
  built_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS car_obs_mm_idx ON car_obs (make, model);

CREATE TABLE IF NOT EXISTS cars (
  id         serial PRIMARY KEY,
  make       text NOT NULL,
  model      text NOT NULL,
  year_from  integer,
  year_to    integer,
  gens       text[] NOT NULL DEFAULT '{}',
  hosts      text[] NOT NULL DEFAULT '{}',   -- сайты, подтвердившие ИМЕННО эти годы
  n_hosts    integer NOT NULL DEFAULT 0,
  mm_hosts   text[] NOT NULL DEFAULT '{}',   -- сайты, знающие марку+модель (с годами или без)
  status     text NOT NULL,                  -- confirmed | single | no_year
  built_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cars_mm_idx ON cars (make, model);

CREATE TABLE IF NOT EXISTS car_variants (
  id      serial PRIMARY KEY,
  car_id  integer NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
  light   text,
  afs     boolean,
  restyle text,
  hosts   text[] NOT NULL DEFAULT '{}',
  n_hosts integer NOT NULL DEFAULT 0,
  status  text NOT NULL                       -- confirmed | single
);
CREATE INDEX IF NOT EXISTS car_variants_car_idx ON car_variants (car_id);
