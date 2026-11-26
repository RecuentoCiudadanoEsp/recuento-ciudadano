-- Tablas de «Me apunto» (personas que dicen que irán a fotografiar las actas de un colegio).
-- Se puede ejecutar más de una vez sin problema (solo crea lo que falta).
-- Ejecutar en recuento-pruebas y, antes de pasar estos cambios a la pública, en recuento.
CREATE TABLE IF NOT EXISTS apuntados (
  codigo      TEXT PRIMARY KEY,         -- código de 6 caracteres que recibe la persona (sirve para cancelar)
  colegio     TEXT NOT NULL,            -- código de la primera mesa del colegio
  prov        TEXT NOT NULL,
  dispositivo TEXT NOT NULL,            -- identificador anónimo del navegador
  ip_hash     TEXT NOT NULL,            -- huella con clave secreta de la conexión (nunca la IP)
  ts          INTEGER NOT NULL,
  cancelado   INTEGER                   -- hora de la cancelación (NULL = sigue apuntada)
);
CREATE INDEX IF NOT EXISTS apuntados_colegio ON apuntados(prov, colegio);
CREATE INDEX IF NOT EXISTS apuntados_disp ON apuntados(dispositivo, ts);
CREATE INDEX IF NOT EXISTS apuntados_ip ON apuntados(ip_hash, ts);
-- Provincias con reservas nuevas o canceladas desde la última vez que se publicaron sus cifras
CREATE TABLE IF NOT EXISTS apuntados_cambios (prov TEXT PRIMARY KEY, ts INTEGER NOT NULL);
-- Intentos de cancelar (para limitar los que se hacen desde una misma conexión)
CREATE TABLE IF NOT EXISTS intentos_cancelar (ip_hash TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS intentos_cancelar_ip ON intentos_cancelar(ip_hash, ts);
