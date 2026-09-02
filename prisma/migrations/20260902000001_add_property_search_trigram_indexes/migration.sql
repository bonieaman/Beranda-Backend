CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "properties_title_trgm_idx"
  ON "properties" USING gin (lower("title") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "properties_location_trgm_idx"
  ON "properties" USING gin (lower("location") gin_trgm_ops);
