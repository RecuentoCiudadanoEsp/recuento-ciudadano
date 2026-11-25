-- Cambio para bases de datos creadas antes del 25/11/2026 (las nuevas ya lo llevan en schema.sql).
-- Se ejecuta UNA sola vez en cada base (pruebas y pública), desde la consola de D1 de Cloudflare o con:
--   npx wrangler d1 execute NOMBRE_DE_LA_BASE --remote --file sql/cambios/2026-11-25_lectura_ia.sql
-- Añade el control de reintentos de la lectura automática y un índice para preparar los datos por provincia.
ALTER TABLE envios ADD COLUMN ia_intentos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE envios ADD COLUMN ia_ts INTEGER;
CREATE INDEX IF NOT EXISTS envios_prov ON envios(prov);
