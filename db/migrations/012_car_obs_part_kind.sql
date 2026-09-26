-- Вид детали и назначение в наблюдении базы авто (решение владельца 26.09.2026).
-- part_kind: frame | glass | housing | kit | module | lamp | null
-- purpose:   install_lens | null
-- afs теперь только true/false: слова про AFS в заголовке нет = без AFS.
ALTER TABLE car_obs ADD COLUMN IF NOT EXISTS part_kind text;
ALTER TABLE car_obs ADD COLUMN IF NOT EXISTS purpose text;
