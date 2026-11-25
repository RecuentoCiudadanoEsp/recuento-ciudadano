# Recuento Ciudadano

Web para que cualquiera fotografíe el acta de escrutinio de su mesa y la suba. Las fotos son públicas,
las mesas se verifican cuando dos personas distintas envían las mismas cifras y los conflictos se
resuelven a mano desde un panel, con un registro público de cada decisión.

Todo corre en Cloudflare: Workers (API), D1 (base de datos), R2 (fotos) y la web estática.
Coste estimado del mes de las elecciones: plan Workers de pago (5 $) + R2 (1–2 $).

## Qué hay en el proyecto

| Ruta | Qué es |
|---|---|
| `public/index.html` | Web pública: inicio con cuenta atrás, envío del acta, resultados, ficha de cada mesa |
| `public/admin/index.html` | Panel de validación (en `/admin/`), protegido con contraseña |
| `public/data/` | Las 61.033 mesas del 29N con su colegio (lista definitiva del INE) y las candidaturas proclamadas del 29N por provincia |
| `src/worker.js` | API: recepción de envíos, antiabuso, consenso, JSON públicos y panel |
| `schema.sql` | Esquema de la base de datos |
| `sql/` | Datos para la base de datos: mesas (01), candidaturas del 29N (02) y mesas oficiales por provincia según el INE (03) |
| `scripts/mesas_desde_ine.py` | Convierte la relación definitiva de mesas y locales del INE (Excel) en `scripts/ref/mesas29n/` |
| `scripts/convertir_interior.py` | Genera `public/data/` y `sql/`: mesas del 29N, censo de referencia del 23J y candidaturas del 29N |
| `scripts/mesas_desde_bop.py` | Alternativa: convierte la relación de un boletín provincial, por si hiciera falta |
| `scripts/candidaturas_desde_boe.py` | Extrae las candidaturas proclamadas del PDF del BOE |
| `scripts/candidaturas_desde_csv.py` | Carga las candidaturas desde un CSV (`scripts/ref/candidaturas_29N.csv`) |
| `scripts/ref/` | Datos de referencia: candidaturas del 29N, mesas del 29N por provincia (`mesas29n/`), totales del INE, nombres de municipios |
| `test/` | Pruebas automáticas y prueba de carga |

## Dos versiones: pública y pruebas

| | Pública | Pruebas |
|---|---|---|
| Dirección | https://recuentociudadano.es | https://recuento-ciudadano-pruebas.recuentociudadanoesp.workers.dev |
| Worker | `recuento-ciudadano` | `recuento-ciudadano-pruebas` |
| Rama de GitHub | `main` | `pruebas` |
| Base de datos / fotos | `recuento` / `recuento-fotos` | `recuento-pruebas` / `recuento-fotos-pruebas` |
| Modo | Envíos cerrados hasta el 29N a las 20:00 (se puede practicar). Panel con Cloudflare Access | `MODO_PRUEBAS = "1"`: envíos abiertos, panel con contraseña, botón para vaciar datos |

Las dos se publican solas con Workers Builds al subir cambios a su rama (la pública con `npx wrangler deploy`, la de
pruebas con `npx wrangler deploy --env pruebas`). La base de datos, las fotos y los secretos no se tocan al publicar.

**Cómo se trabaja:** todo cambio se sube primero a la rama `pruebas` y se comprueba en la versión de pruebas. Cuando
se da por bueno, se pasa a la pública fusionando `pruebas` en `main`. Así la pública solo recibe lo ya probado.
Si un cambio necesitara tocar la estructura de la base de datos, habría que aplicarlo en las dos bases (se indica en el
propio cambio). El historial de publicaciones está en Cloudflare → Workers & Pages → (worker) → Deployments.

## Desplegar desde cero (unos 30 minutos)

Necesitas una cuenta de Cloudflare con un dominio (o usa el subdominio gratuito `*.workers.dev`) y Node.js 18+.

```bash
npm install
npx wrangler login

# 1. Pasar al plan Workers de pago (5 $/mes) desde el panel de Cloudflare: el gratuito no aguanta la noche electoral.

# 2. Base de datos: crea la base y copia el database_id que te devuelve en wrangler.toml
npx wrangler d1 create recuento
npx wrangler d1 execute recuento --remote --file schema.sql
npx wrangler d1 execute recuento --remote --file sql/01_mesas.sql
npx wrangler d1 execute recuento --remote --file sql/02_candidaturas.sql
npx wrangler d1 execute recuento --remote --file sql/03_provincias.sql

# 3. Fotos
npx wrangler r2 bucket create recuento-fotos

# 4. Antibots: crea un widget Turnstile en el panel de Cloudflare (Turnstile > Add widget, modo "Managed"),
#    pon la clave pública en TURNSTILE_SITEKEY de wrangler.toml y la secreta así:
npx wrangler secret put TURNSTILE_SECRET

# 5. Secretos
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # contraseña aleatoria: guárdala en tu gestor
npx wrangler secret put ADMIN_TOKEN   # pega esa contraseña (mínimo 32 caracteres)
npx wrangler secret put SAL_IP        # cualquier texto aleatorio largo

# 6. Publicar
npx wrangler deploy

# 7. Lectura automática (Workers AI): para algunos modelos de Meta hay que aceptar su licencia una vez por cuenta. Desde el panel, en la consola
#    del navegador, o con curl (ver "Lectura automática" más abajo):
#    POST https://tu-dominio/admin/api/aceptar_licencia_ia
```

Después, en el panel de Cloudflare:
- **Cloudflare Access para el panel (obligatorio; sin esto el panel no abre fuera del modo pruebas):**
  1. Zero Trust > Settings: elige el nombre de tu equipo (por ejemplo `recuentociudadano`). Plan Free.
  2. Zero Trust > Access > Applications > Add an application > Self-hosted. Dominio `recuentociudadano.es`, ruta `admin`
     (cubre `/admin/` y `/admin/api/`). Política: Allow, Include > Emails > tu correo. Método de acceso: código por correo
     (One-time PIN).
  3. Copia el "Application Audience (AUD) Tag" de la aplicación y rellena en `wrangler.toml` `ACCESS_TEAM`
     (el nombre del equipo), `ACCESS_AUD` y `ACCESS_EMAIL`. Vuelve a publicar con `npx wrangler deploy`.
  4. Resultado: para entrar al panel hacen falta dos llaves, el código que llega a tu correo y la contraseña `ADMIN_TOKEN`.
     El Worker además comprueba la firma de Access, así que aunque alguien se saltara la pantalla de Access, no entra.
- **Dominio propio:** Workers > recuento-ciudadano > Settings > Domains & Routes.
- **Límite de peticiones (recomendado):** Security > WAF > Rate limiting rules: por ejemplo, 30 peticiones por minuto
  y por IP a `/api/envio`. Es una segunda barrera además de la del propio Worker.

## Antes del día D

1. **Candidaturas del 29N: ya cargadas.** Son las 534 proclamadas al Congreso (BOE núm. 273, de 3/11/2026, con la
   corrección del BOE núm. 278), en el orden en que aparecen en el acta. Las 21 no proclamadas están excluidas.
   Están en `scripts/ref/candidaturas_29N.csv`, y `convertir_interior.py` las usa automáticamente.
2. **Mesas: ya cargadas.** Es la relación definitiva de mesas y locales del 29N publicada por el INE
   (`elecgen2026_mesas_y_locales.xlsx`): 61.033 mesas de las 52 provincias, cada una con su colegio y su dirección. Cuadra
   provincia a provincia con la tabla del INE y no tiene ningún código repetido. Hay 2.969 mesas que no existían en el 23J.
   - El censo de referencia de cada mesa (solo para avisar si los electores del acta no cuadran) sale del 23J. Las mesas
     nuevas no lo tienen y no se avisa.
   - Si el INE publicara una versión corregida del Excel, regenera los datos:
     ```bash
     python3 scripts/mesas_desde_ine.py elecgen2026_mesas_y_locales.xlsx
     python3 scripts/convertir_interior.py 02202307_MESA.zip        # y vuelve a cargar sql/01_mesas.sql
     ```
   - Por si alguien no encuentra su mesa (un error suyo o un cambio de última hora), sigue existiendo **"Mi mesa no
     aparece"**: el envío entra como mesa nueva y no cuenta hasta que la revises en el panel.
3. **Simulacro y prueba de carga** con `MODO_PRUEBAS` activado (ver "Horarios" y "Pruebas").
4. **Antes de abrir, en este orden:**
   1. Con `MODO_PRUEBAS` todavía activado, entra en el panel y pulsa **Vaciar datos de prueba** (te pedirá escribir
      VACIAR). Borra envíos, fotos, mesas nuevas creadas en las pruebas, decisiones y resultados publicados.
   2. Quita `MODO_PRUEBAS` de `wrangler.toml` y vuelve a publicar con `npx wrangler deploy`. Desde ese momento el botón
      de vaciar deja de funcionar, para que nadie pueda borrar datos reales.
   3. Revisa que Turnstile usa tus claves reales (no las de prueba) y que `MAX_ENVIOS_IP_10MIN` ha vuelto a su valor.

## Horarios (wrangler.toml)

- `ABRE`: a partir de esta hora se aceptan envíos (20:00 del 29N, cierre en la península). Antes, la web
  muestra la cuenta atrás y un modo práctica que no envía nada.
- `TOTALES_DESDE`: a partir de esta hora se muestran totales de votos (21:00, cierre en Canarias).
- `MODO_PRUEBAS = "1"`: abre los envíos ya, muestra los totales y permite vaciar los datos desde el panel. En local va
  en `.dev.vars`; en el despliegue, añádelo dentro de `[vars]` en `wrangler.toml` y publica. **Quítalo antes del día D.**

## Reglas de verificación

Un acta que no cuadra (votantes ≠ candidaturas + blanco + nulos, o más votantes que electores) **no se puede enviar**:
la web no deja y el servidor la rechaza.

- **Verificada:** al menos dos envíos con las mismas cifras desde dispositivos distintos. No se exige
  que vengan de IP distintas, porque las operadoras móviles hacen que miles de personas compartan IP. Salvaguarda: si
  todas las fotos coincidentes vienen de la misma IP y esa IP ha enviado actas de muchas mesas en una hora
  (`MAX_MESAS_RED_HORA`, 8 por defecto), cuentan como una sola fuente.
- **Pendiente:** un solo envío. Se muestra, pero no cuenta en los totales.
- **En conflicto:** envíos válidos con cifras distintas. Va a la cola del panel.
- **En revisión:** la mesa es nueva ("Mi mesa no aparece") o el envío tiene alertas (foto repetida en otra mesa, foto
  anterior al cierre, muchas mesas desde el mismo dispositivo —`MAX_MESAS_DISPOSITIVO_30MIN`: a partir de la 9.ª mesa
  distinta en media hora—, o la lectura automática dice que no es un acta). No cuenta hasta que lo revises.
  (El servidor aún admite una comprobación de distancia al colegio, `DISTANCIA_MAX_METROS`, pero la lista oficial de
  mesas no trae coordenadas de los colegios y el formulario ya no pide la ubicación, así que no se aplica.)
- **Validada:** has marcado un envío como válido en el panel; manda sobre lo demás.

**Qué fotos son públicas.** Una foto solo se muestra cuando su mesa está verificada (y la foto coincide con la
versión verificada) o cuando la has validado tú. Las de mesas pendientes, en conflicto o en revisión no se ven: en la
ficha aparece el envío con sus cifras y el aviso "se publicará cuando otra persona envíe la misma acta". Así nadie puede
publicar una imagen cualquiera subiéndola una vez. Tú las ves todas en el panel.

**Comprobaciones de la foto.** Al recibirla, el servidor mira que la zona de nombres esté tapada (la web la tapa siempre;
esto pilla a quien se salta la web) y que la imagen parezca papel (sin mucho color ni tonos de piel). Si falla algo, la
foto queda en **cuarentena**: no se publica nunca aunque la mesa esté verificada, y va a la cola "Fotos sospechosas".

**Lectura automática (Workers AI, `LECTURA_IA = "1"`).** Un modelo de visión lee cada foto: cifras, si es un acta y si es
inapropiada. Sirve para tres cosas:
- En el formulario, en cuanto la persona elige la foto: debajo de cada casilla sale lo que se lee en la foto y su
  fiabilidad: **alta** si coinciden la cifra en letra y en número del acta, **media** si solo se lee una, **baja** si no
  coinciden. Si lo escrito no coincide, la casilla se pone en amarillo. No se escribe nada solo en las casillas: si dos
  personas aceptaran la misma lectura errónea, la verificación entre fuentes independientes dejaría de valer.
- En el panel: en cada versión de una mesa en conflicto te dice si sus cifras coinciden con lo que se lee en sus fotos.
- Si dice que no es un acta o que es inapropiada: cuarentena, y además el envío no cuenta para verificar.
**Solo se lee lo que aporta.** En cuanto una mesa está verificada (o validada por ti), las fotos nuevas de esa mesa no
se leen: quedan **en espera**, sin publicar, y sus cifras cuentan igual. Las revisas tú cuando quieras en la cola
**Fotos en espera** del panel (las más antiguas primero): Aprobar la publica, Retirar la quita, Leer con IA gasta una
lectura. Si llega una foto con otras cifras, la mesa pasa a conflicto y entonces sí se leen sus fotos. Antes de
verificarse, como mucho `FOTOS_LEIDAS_POR_VERSION` fotos (3) con las mismas cifras se leen, por si llegan muchas a la
vez. El formulario tampoco gasta lectura en mesas verificadas. Así todo el cupo va a mesas sin verificar.

Mientras una foto no se ha leído, no se publica (el cron lee hasta 150 por minuto). Modelo: Llama 4 Scout
(`@cf/meta/llama-4-scout-17b-16e-instruct`), elegido tras compararlo con otros modelos de visión de Workers AI sobre actas
reales: es el que mejor lee las cifras manuscritas. Coste: Workers AI regala 10.000 "neuronas" al día (unas 120 fotos) y
después cobra unos 0,0009 $ por foto (unas 80 neuronas; reducir la foto no lo abarata con este modelo). **Red de seguridad:**
`MAX_LECTURAS_IA` (100.000 por defecto, unos 88 $ como máximo; con 40.000 mesas se esperan unas 88.000 lecturas, ≈ 77 $). Al llegar, se dejan de hacer lecturas: la web sigue
igual, sin sugerencias, y las fotos se publican con el filtro sin IA. Con `LECTURA_IA = "0"` el coste es cero. El panel
muestra cuántas lecturas se llevan. Workers AI tiene límites de peticiones por minuto: en el pico, algunas personas no
verán el amarillo y sus fotos tardarán unos minutos más en publicarse; las cifras cuentan igual.
La lectura de manuscritos no es perfecta: es una ayuda, no decide nada. Hay que probarla con actas reales nada más desplegar.

**Denuncias.** Las fotos públicas tienen un botón "Denunciar foto". Si la denuncian desde `DENUNCIAS_OCULTAR` redes
distintas (2 por defecto), se oculta al momento (en menos de 5 minutos deja de verse en todas partes) y pasa a la cola
"Fotos sospechosas". Apruébala para volver a publicarla (después ya no se oculta por denuncias) o retírala.

Nada se borra: las invalidadas siguen en la ficha con el motivo, sin imagen, y cada decisión queda en
`/api/public/decisiones.json`.

**Registro encadenado.** Cada decisión del registro lleva una `huella` (SHA-256) calculada con la huella de la decisión
anterior y sus propios datos, y la `huella` de arriba del archivo resume el registro completo. Si alguien cambiara o
borrara una decisión antigua en la base de datos, cambiarían todas las huellas desde ese punto y ya no coincidirían con
las publicadas antes.

Esto solo protege si existen copias del registro guardadas fuera de esta web, con su fecha. No hace falta pedir permiso
a nadie para hacerlas: cualquiera puede descargar `https://recuentociudadano.es/api/public/decisiones.json` cuando quiera,
o archivarlo en la Wayback Machine (`https://web.archive.org/save/https://recuentociudadano.es/api/public/decisiones.json`),
donde queda una copia fechada que nadie del proyecto puede modificar. Más adelante, el programa de comprobación dice si
todo lo que había en esa copia sigue igual:

```
python3 scripts/verificar_registro.py                                   # descarga el registro y recalcula las huellas
python3 scripts/verificar_registro.py decisiones.json --huella HUELLA   # comprueba que una huella publicada sigue ahí
python3 scripts/verificar_registro.py URL_O_ARCHIVO --anterior COPIA    # compara con una copia guardada antes
```

El archivo solo se regenera cuando hay decisiones nuevas. Los envíos de cada mesa (huella de la foto, cifras, hora y
estado) están en `/api/public/prov/PP.json`, así que cualquiera puede rehacer los totales sin depender de esta web.

## Panel de validación

Entra en `https://tu-dominio/admin/`: primero el código de Cloudflare Access que llega a tu correo, después la contraseña
`ADMIN_TOKEN`. Hay varias colas:

- **Mesas por revisar** (conflictos y avisos), revisión **por mesa**: las fotos de la mesa agrupadas por versión de
  cifras, una tabla que compara las versiones (las diferencias en naranja) y la **versión sugerida**: la que envían más
  personas distintas; si empatan, la que mejor coincide con lo que se lee en sus fotos. Si en las fotos de una versión
  se lee otra cosa, te lo dice campo por campo. Un clic en **Esta es la buena** valida esa versión e invalida el resto.
  Las opciones por foto (validar, invalidar, reasignar) siguen disponibles dentro de cada versión.
- **Fotos en espera** (sin prioridad): fotos de mesas ya verificadas que no se han leído, para revisar a mano en las
  horas o días siguientes.
- **Fotos sospechosas**, revisión **por foto**: cuarentena (nombres sin tapar, no parece un acta, la IA la marca) y
  denunciadas. **Aprobar foto** la publica sin tocar las cifras; **Retirar** la quita de la web y de las cuentas.
  Si el único problema es que se ven nombres, **Tapar nombres y aprobar** abre la foto para taparlos con el ratón: se
  publica la versión tapada (la original se sobrescribe) y la nueva huella queda en el registro público de decisiones.
  El botón **Tapar nombres** está también en cualquier foto de la vista por mesa (incluidas las ya publicadas) y en las
  fotos en espera. Una foto con nombres sin tapar no cuenta para verificar la mesa hasta que se tapa.

- **Mesas nuevas por confirmar:** las que alguien ha enviado con "Mi mesa no aparece". Mira la cabecera del acta en
  la foto y elige:
  - **Confirmar como mesa real**, si la mesa existe tal cual (es una de las nuevas del 29N). Sus fotos pasan a contar.
  - **Reasignar** cada foto a la mesa correcta, si la persona se equivocó. Tienes la lista de mesas del municipio
    como ayuda. Si la mesa nueva se queda sin fotos, desaparece.

La reasignación sirve para cualquier foto, no solo para mesas nuevas, pero solo dentro de la misma provincia, porque
las candidaturas cambian de una a otra. Cada reasignación y confirmación queda en el registro público de decisiones.

## Mapa y resultados

En Resultados hay un mapa de España por provincias y, dentro de cada provincia, uno por municipios, con dos modos:
**Cobertura** (porcentaje de mesas verificadas) y **Más votado** (partido con más votos en las mesas verificadas, que se
activa a la vez que los totales, cuando cierran los colegios de Canarias). Cada provincia muestra sus votos provisionales
con el número de mesas en que se basan y el aviso de que no es una estimación. No se calculan escaños: con pocas mesas
el reparto saldría sesgado y se leería como una predicción. Los contornos salen de `es-atlas` (IGN, códigos INE);
para regenerarlos: `node scripts/mapas.mjs`.

## Privacidad

No se guarda la IP en claro (solo un hash con sal), ni nombre, correo o teléfono. La columna de nombres y firmas
del acta se tapa automáticamente en el móvil antes de subir (zona calibrada con actas del Congreso del 23J en
`ZONAS_DIFUMINADO`), y la persona puede tapar más zonas a mano. La foto con nombres nunca llega al servidor.

## Pruebas

```bash
# En local: copia .dev.vars.example como .dev.vars y pon una foto de un acta real en test/acta.jpg (no se incluye)
npx wrangler d1 execute recuento --local --file schema.sql   # y después los tres ficheros de sql/, en orden
test/servidor_local.sh          # Workers AI no funciona en local: simula la lectura automática
python3 test/api_test.py        # 63 comprobaciones de extremo a extremo con un acta real
python3 test/poblar_demo.py     # opcional: llena varias provincias de envíos para ver el mapa
python3 test/ui_test.py         # recorre la web en el móvil con "Mi mesa no aparece" y un acta real
python3 test/panel_test.py      # recorre el panel: colas, registro de decisiones, abrir y reabrir una mesa (después de api_test)
```

**Prueba de carga contra el despliegue real** (antes del día D, con `MODO_PRUEBAS = "1"`):
- Pon temporalmente la clave secreta de prueba de Turnstile, que siempre acepta: `1x0000000000000000000000000000000AA`.
- Sube temporalmente `MAX_ENVIOS_IP_10MIN` a `1000000`, porque todo el tráfico de k6 sale de tu IP (el valor normal es 300).
- Copia una foto de acta como `test/acta_prueba.jpg` y ejecuta `k6 run -e BASE=https://tu-dominio test/carga_k6.js`.
- Después, vacía los datos desde el panel y deja todo como estaba (ver "Antes de abrir").

## Vista «Por zonas» del panal de mesas

Al abrir un municipio en Resultados se ve un panal con un hexágono por mesa. En la vista «Por zonas» el panal tiene la
forma del municipio y cada mesa está en la zona de su sección censal; en «Agrupadas», las verificadas se juntan en el
centro. Las posiciones de «Por zonas» están precalculadas en `public/data/zonas/PP.json` con
`scripts/zonas.py`, a partir de la cartografía de secciones censales del INE (no incluida por su tamaño; se descarga en
https://ine.es/dyngs/DAB/index.htm?cid=1389). Si cambian las listas de mesas, hay que volver a ejecutarlo:

```
pip install pyshp shapely numpy
python3 scripts/zonas.py RUTA/SECC_CE_20260101
```
