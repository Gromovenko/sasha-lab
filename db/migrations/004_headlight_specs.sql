-- Расширение fitment: конструктив штатной фары, а не только что в неё доустановили.
-- Просьба владельца 18.09.2026 — собрать по маркам/моделям завод. герметик, наличие
-- адаптивного света (AFS/поворотный модуль), тип источника ближнего света с завода
-- и модель заводской линзы. Поля отдельные от lens/headlight: те описывают РЕТРОФИТ
-- (что доустановили), эти — что стоит С ЗАВОДА, разбор путается, если смешать.
ALTER TABLE fitment ADD COLUMN IF NOT EXISTS sealant          text; -- герметик сборки фары: полиуретановый | битумный | термоклей | силиконовый
ALTER TABLE fitment ADD COLUMN IF NOT EXISTS adaptive         boolean; -- адаптивный свет (AFS/поворотный модуль) с завода
ALTER TABLE fitment ADD COLUMN IF NOT EXISTS low_beam_source  text; -- источник ближнего света с завода: галоген | штатный ксенон | биксенон | штатный led | лазерный
ALTER TABLE fitment ADD COLUMN IF NOT EXISTS factory_lens     text; -- модель/производитель заводской линзы (Hella, Valeo, Koito, ...)
