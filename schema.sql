-- Esquema de la base de datos (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS mesas (
  id         TEXT PRIMARY KEY,          -- pp-mmm-dd-sss-M  (provincia-municipio-distrito-sección-mesa)
  prov       TEXT NOT NULL,
  muni       TEXT NOT NULL,
  distrito   TEXT NOT NULL,
  seccion    TEXT NOT NULL,
  mesa       TEXT NOT NULL,
  municipio  TEXT,
  censo      INTEGER,                   -- censo de la mesa (referencia; puede variar ligeramente)
  local      TEXT,
  direccion  TEXT,
  lat        REAL,
  lon        REAL,
  nueva      INTEGER NOT NULL DEFAULT 0, -- 1 = pendiente de confirmar en el panel
  de_usuario INTEGER NOT NULL DEFAULT 0  -- 1 = creada por un usuario con "Mi mesa no aparece" (aunque ya esté confirmada)
);
CREATE INDEX IF NOT EXISTS mesas_prov ON mesas(prov);

CREATE TABLE IF NOT EXISTS candidaturas (
  prov         TEXT NOT NULL,
  codigo       TEXT NOT NULL,
  siglas       TEXT NOT NULL,
  denominacion TEXT,
  orden        INTEGER,
  PRIMARY KEY (prov, codigo)
);

CREATE TABLE IF NOT EXISTS envios (
  hash        TEXT PRIMARY KEY,         -- SHA-256 de la foto publicada (ya difuminada)
  mesa_id     TEXT NOT NULL,
  prov        TEXT NOT NULL,
  cifras      TEXT NOT NULL,            -- JSON {electores,votantes,nulos,blanco,cand:{codigo:votos}}
  firma       TEXT NOT NULL,            -- cifras normalizadas para agrupar coincidencias
  cuadra      INTEGER NOT NULL,         -- 1 si pasa las comprobaciones aritméticas
  errores     TEXT,
  dispositivo TEXT NOT NULL,            -- identificador anónimo del navegador
  ip_hash     TEXT NOT NULL,            -- hash con sal de la IP (nunca la IP en claro)
  geo_ok      INTEGER,                  -- 1 cerca del local, 0 lejos, NULL sin ubicación o sin coordenadas
  geo_dist    REAL,
  dhash       TEXT,                     -- huella perceptual para detectar fotos reutilizadas
  ts_foto     INTEGER,
  ts          INTEGER NOT NULL,
  estado      TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | valida | invalida
  motivo      TEXT,
  flags       TEXT,                     -- JSON con avisos automáticos
  publica     INTEGER NOT NULL DEFAULT 0, -- 1 = la foto se muestra al público (mesa verificada o validada a mano)
  denuncias   INTEGER NOT NULL DEFAULT 0, -- nº de redes distintas que la han denunciado
  ia          TEXT,                     -- lectura automática de la foto (JSON), si está activada
  ia_estado   TEXT,                     -- NULL (desactivada) | pendiente | leyendo | hecha | en_espera | forzada | error | omitida
  ia_intentos INTEGER NOT NULL DEFAULT 0, -- veces que se ha intentado leer la foto
  ia_ts       INTEGER                   -- hora del último intento (para recuperar las que se quedan a medio leer)
);
CREATE INDEX IF NOT EXISTS envios_ia ON envios(ia_estado);
CREATE INDEX IF NOT EXISTS envios_prov ON envios(prov);   -- para preparar los datos de cada provincia sin recorrer todos los envíos

-- Lecturas automáticas pedidas por el formulario antes de enviar (se reutilizan al guardar el envío)
CREATE TABLE IF NOT EXISTS lecturas (hash TEXT PRIMARY KEY, lectura TEXT NOT NULL, ip_hash TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS lecturas_ip ON lecturas(ip_hash, ts);
CREATE INDEX IF NOT EXISTS envios_mesa ON envios(mesa_id);
CREATE INDEX IF NOT EXISTS envios_ip ON envios(ip_hash, ts);
CREATE INDEX IF NOT EXISTS envios_disp ON envios(dispositivo, ts);
CREATE INDEX IF NOT EXISTS envios_dhash ON envios(dhash);

CREATE TABLE IF NOT EXISTS consenso (
  mesa_id     TEXT PRIMARY KEY,
  prov        TEXT NOT NULL,
  estado      TEXT NOT NULL,            -- verificada | validada | pendiente | conflicto | revision
  cifras      TEXT,
  n_envios    INTEGER NOT NULL,
  n_indep     INTEGER NOT NULL,
  actualizado INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS consenso_prov ON consenso(prov);
CREATE INDEX IF NOT EXISTS consenso_estado ON consenso(estado);

CREATE TABLE IF NOT EXISTS denuncias (hash TEXT NOT NULL, ip_hash TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (hash, ip_hash));
CREATE INDEX IF NOT EXISTS denuncias_ip ON denuncias(ip_hash, ts);

CREATE TABLE IF NOT EXISTS pendientes (mesa_id TEXT PRIMARY KEY, prov TEXT NOT NULL, ts INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS decisiones (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  hash     TEXT NOT NULL,
  mesa_id  TEXT NOT NULL,
  decision TEXT NOT NULL,
  motivo   TEXT
);

-- Número oficial de mesas por provincia (INE, listas de votación del 29N), para calcular la cobertura
CREATE TABLE IF NOT EXISTS provincias (
  prov       TEXT PRIMARY KEY,
  nombre     TEXT NOT NULL,
  mesas      INTEGER NOT NULL
);

-- Contadores (tope de gasto de la lectura automática)
CREATE TABLE IF NOT EXISTS contador (clave TEXT PRIMARY KEY, n INTEGER NOT NULL);
