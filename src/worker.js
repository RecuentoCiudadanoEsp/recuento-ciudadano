// Recuento Ciudadano — Worker de Cloudflare
// Atiende: /api/* (envíos, fotos, JSON públicos, configuración) y /admin/api/* (panel de validación).
// Cada minuto (cron) recalcula el consenso de las mesas con envíos nuevos y regenera los JSON públicos en R2.

import { analizarJPEG, avisosImagen } from "./imagen.js";
const JSONH = { "content-type": "application/json; charset=utf-8" };
// Avisos que impiden que un envío cuente para verificar la mesa (va a revisión).
// Una foto con nombres sin tapar tampoco cuenta hasta que la tapes en el panel («Tapar nombres»).
const EXCLUYENTES = ["foto_reutilizada", "foto_antes_apertura", "muchas_mesas", "lejos", "mesa_nueva", "ia_no_acta", "ia_inapropiada", "nombres_sin_tapar"];
// Avisos que dejan la FOTO en cuarentena: no se publica nunca hasta que la valides tú (las cifras pueden contar igual).
export const CUARENTENA = ["nombres_sin_tapar", "no_parece_acta", "ia_no_acta", "ia_inapropiada"];
const MODELO_IA = "@cf/meta/llama-4-scout-17b-16e-instruct";   // el que mejor lee las actas en las pruebas con fotos reales
const iaSimulada = (env) => env.MODO_PRUEBAS === "1" && env.IA_SIMULADA === "1";
const iaActiva = (env) => env.LECTURA_IA === "1" && (!!env.AI || iaSimulada(env));
// Solo para pruebas locales (Workers AI no funciona sin cuenta): "lee" el JSON que el test esconde en un comentario del JPEG.
function iaDePrueba(buf) {
  const u = new Uint8Array(buf); let i = 2;
  while (i + 4 < u.length && u[i] === 0xff) {
    const tipo = u[i + 1], len = (u[i + 2] << 8) | u[i + 3];
    if (tipo === 0xfe) return { response: new TextDecoder().decode(u.slice(i + 4, i + 2 + len)) };
    if (tipo === 0xda) break; i += 2 + len;
  }
  return { response: '{"es_acta": true, "inapropiada": false, "electores": null, "votantes": null, "nulos": null, "blanco": null, "votos": []}' };
}
// Estados de la lectura automática con los que una foto aún no se puede publicar sola (ver la cola «sin_leer» del panel)
const SIN_LEER = ["pendiente", "leyendo", "forzada", "error", "omitida"];
// Intentos de lectura automática de una misma foto antes de dejarla para la revisión manual
const MAX_INTENTOS_IA = 6;
const RE_MESA = /^(\d{2})-(\d{3})-(\d{2})-(\d{3,4})-([A-Z])$/;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/admin/api/")) return await admin(req, env, url);
      if (url.pathname === "/api/config") return json(config(env), 200, { "cache-control": "public, max-age=60" });
      if (url.pathname === "/api/envio" && req.method === "POST") return await recibirEnvio(req, env);
      if (url.pathname === "/api/denuncia" && req.method === "POST") return await recibirDenuncia(req, env);
      if (url.pathname === "/api/leer" && req.method === "POST") return await leerParaFormulario(req, env);
      if (url.pathname === "/api/apuntarme" && req.method === "POST") return await recibirApuntado(req, env);
      if (url.pathname === "/api/cancelar" && req.method === "POST") return await cancelarApuntado(req, env);
      let m;
      if ((m = url.pathname.match(/^\/api\/(foto|mini)\/([a-f0-9]{64})\.jpg$/))) return await servirFoto(req, env, ctx, m[1], m[2]);
      if ((m = url.pathname.match(/^\/api\/public\/(resumen|decisiones|apuntados|apuntados\/\d{2}|prov\/\d{2}|oficial\/\d{2})\.json$/))) return await servirPublico(req, env, ctx, m[1]);
      return json({ error: "no_encontrado" }, 404);
    } catch (e) {
      console.error(e && e.stack || e);
      return json({ error: "error_interno" }, 500);
    }
  },
  async scheduled(evt, env, ctx) {
    // Dos tareas independientes: rehacer los datos del mapa no espera a que termine la lectura automática de fotos
    // Las cifras de «Me apunto» también van aparte: son independientes de las actas.
    ctx.waitUntil(Promise.all([recalcular(env), iaActiva(env) ? leerPendientesIA(env) : null, publicarApuntados(env)]));
  },
};

// ---------------------------------------------------------------- utilidades
function json(obj, status = 200, extra = {}) { return new Response(JSON.stringify(obj), { status, headers: { ...JSONH, ...extra } }); }
// Identificador seudonimizado de la conexión: SHA-256 de la clave secreta SAL_IP seguida de la IP, recortado a 32
// caracteres. La IP nunca se guarda. Sin la clave no se puede saber de qué IP viene (con ella, sí: no debe salir de Cloudflare).
async function huellaIP(env, ip) { return (await sha256hex(new TextEncoder().encode((env.SAL_IP || "sal") + ip))).slice(0, 32); }
async function sha256hex(buf) { const d = await crypto.subtle.digest("SHA-256", buf); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
const num = (v) => Number.isInteger(v) && v >= 0;
function distanciaM(a, b, c, d) { const R = 6371000, r = Math.PI / 180; const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
const ahora = () => Date.now();
function config(env) {
  let zonas = []; try { zonas = JSON.parse(env.ZONAS_DIFUMINADO || "[]"); } catch {}
  return { nombre: env.NOMBRE || "Recuento Ciudadano", abre: env.ABRE, totales_desde: env.TOTALES_DESDE || env.ABRE,
    turnstile_sitekey: env.TURNSTILE_SITEKEY || "", zonas_difuminado: zonas, modo_pruebas: env.MODO_PRUEBAS === "1", lectura_ia: iaActiva(env),
    apuntarse_hasta: env.APUNTARSE_HASTA || env.ABRE, minutos_entre_apuntados: Number(env.MINUTOS_ENTRE_APUNTADOS || 15) };
}
const abierto = (env) => env.MODO_PRUEBAS === "1" || ahora() >= Date.parse(env.ABRE);
// Las cifras de votos y las fotos de las actas no se publican hasta que cierran todos los colegios (también en
// Canarias, a las 21:00 peninsulares), para no difundir resultados mientras todavía se vota en algún sitio.
// Antes de esa hora solo se ve cuántas mesas tienen foto y cuántas están verificadas.
// En la versión de pruebas se ven siempre, salvo que OCULTAR_TOTALES_PRUEBAS = "1" (para comprobar este comportamiento).
const totalesVisibles = (env) => env.MODO_PRUEBAS === "1" ? env.OCULTAR_TOTALES_PRUEBAS !== "1" : ahora() >= Date.parse(env.TOTALES_DESDE || env.ABRE);

// Comprobaciones aritméticas del acta. cods = códigos de candidatura de la provincia.
export function validarCifras(c, cods, censo) {
  const errores = [], avisos = [];
  if (!c || typeof c !== "object" || !c.cand || typeof c.cand !== "object") return { ok: false, errores: ["formato"], avisos };
  for (const k of ["electores", "votantes", "nulos", "blanco"]) if (!num(c[k])) errores.push(`falta_${k}`);
  for (const cod of cods) if (!num(c.cand[cod])) errores.push(`falta_cand_${cod}`);
  for (const cod of Object.keys(c.cand)) if (!cods.includes(cod)) errores.push(`cand_desconocida_${cod}`);
  if (errores.length) return { ok: false, errores, avisos };
  const sumaCand = cods.reduce((a, k) => a + c.cand[k], 0);
  if (c.votantes > c.electores) errores.push("mas_votantes_que_electores");
  if (c.votantes !== sumaCand + c.blanco + c.nulos) errores.push("no_cuadra");
  if (censo && Math.abs(c.electores - censo) > Math.max(15, censo * 0.08)) avisos.push("censo_distinto");
  return { ok: errores.length === 0, errores, avisos };
}
export function firmaCifras(c, cods) { return [c.electores, c.votantes, c.nulos, c.blanco, ...[...cods].sort().map(k => `${k}:${c.cand[k]}`)].join("|"); }

let ultimoFalloTurnstile = "";
async function turnstileOK(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true; // sin configurar (desarrollo)
  // Solo en la versión de pruebas: los envíos simulados (ensayo del panel, prueba de carga) llevan esta marca en vez de un token real
  if (env.MODO_PRUEBAS === "1" && token === "envio-simulado-de-pruebas") return true;
  if (!token) return false;
  const f = new FormData(); f.append("secret", env.TURNSTILE_SECRET); f.append("response", token); if (ip) f.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: f });
  const d = await r.json().catch(() => ({}));
  // En pruebas se apunta el motivo del rechazo, para poder diagnosticarlo (la respuesta lo devuelve como «detalle»)
  if (!d.success) { ultimoFalloTurnstile = (d["error-codes"] || []).join(",") || "sin_respuesta"; console.log("Turnstile rechazado:", ultimoFalloTurnstile); }
  return !!d.success;
}

// ---------------------------------------------------------------- envío
async function recibirEnvio(req, env) {
  if (!abierto(env)) return json({ error: "cerrado", mensaje: "Los envíos se abren al cerrar los colegios." }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
  let form; try { form = await req.formData(); } catch { return json({ error: "formato" }, 400); }
  const foto = form.get("foto"), mini = form.get("mini");
  let d; try { d = JSON.parse(form.get("datos") || "{}"); } catch { return json({ error: "formato" }, 400); }
  if (!(foto instanceof File) || !(mini instanceof File)) return json({ error: "falta_foto" }, 400);
  if (foto.size > 2_500_000 || mini.size > 250_000 || foto.size < 5_000) return json({ error: "tamano_foto" }, 400);

  const fotoBuf = await foto.arrayBuffer(); const miniBuf = await mini.arrayBuffer();
  const u8 = new Uint8Array(fotoBuf); if (u8[0] !== 0xff || u8[1] !== 0xd8) return json({ error: "formato_foto" }, 400);
  const hash = await sha256hex(fotoBuf);
  if (d.hash && d.hash !== hash) return json({ error: "huella_distinta" }, 400);
  // Si esta misma foto (mismo archivo exacto) ya había entrado, es un reintento: por ejemplo, se cortó la conexión
  // justo después de enviarla y la persona no vio la respuesta. Se contesta como un envío correcto, sin guardar nada.
  // Se comprueba antes que la verificación antibots porque el reintento reutiliza el mismo «pase», que ya no vale.
  const yaEstaba = await env.DB.prepare("SELECT mesa_id FROM envios WHERE hash = ?").bind(hash).first();
  if (yaEstaba) return json({ ok: true, ya_enviada: true, hash, mesa_id: yaEstaba.mesa_id, avisos: [], foto_en_revision: false });

  if (!(await turnstileOK(env, form.get("turnstile"), ip))) return json({ error: "verificacion", mensaje: "No se ha podido completar la verificación antirrobots. Vuelve a pulsar Enviar." }, 403);

  const mesaId = String(d.mesa_id || "").toUpperCase();
  let mesa = await env.DB.prepare("SELECT id, prov, censo, lat, lon, nueva FROM mesas WHERE id = ?").bind(mesaId).first();
  if (!mesa) {
    // "Mi mesa no aparece": se acepta si el municipio existe en esa provincia, y queda pendiente de confirmar a mano
    const m = mesaId.match(RE_MESA);
    if (!d.mesa_nueva || !m) return json({ error: "mesa_desconocida" }, 400);
    const muni = await env.DB.prepare("SELECT municipio FROM mesas WHERE prov = ? AND muni = ? LIMIT 1").bind(m[1], m[2]).first();
    if (!muni) return json({ error: "mesa_desconocida" }, 400);
    await env.DB.prepare("INSERT OR IGNORE INTO mesas (id, prov, muni, distrito, seccion, mesa, municipio, censo, nueva, de_usuario) VALUES (?,?,?,?,?,?,?,NULL,1,1)")
      .bind(mesaId, m[1], m[2], m[3], m[4], m[5], muni.municipio).run();
    mesa = { id: mesaId, prov: m[1], censo: null, lat: null, lon: null, nueva: 1 };
  }
  const cods = (await env.DB.prepare("SELECT codigo FROM candidaturas WHERE prov = ?").bind(mesa.prov).all()).results.map(r => r.codigo);
  const val = validarCifras(d.cifras, cods, mesa.censo);
  if (val.errores.some(e => e.startsWith("falta") || e.startsWith("cand_desconocida") || e === "formato")) return json({ error: "cifras_incompletas", detalle: val.errores }, 400);
  if (!val.ok) return json({ error: "no_cuadra", detalle: val.errores, mensaje: "Las cuentas no cuadran. Revisa las cifras. Si están bien copiadas, puede que haya un error en el propio acta: coméntaselo a la presidencia de la mesa." }, 400);

  // Comprobaciones de la imagen (foto grande y miniatura): zona de nombres tapada y aspecto de documento
  let zonas = []; try { zonas = JSON.parse(env.ZONAS_DIFUMINADO || "[]"); } catch {}
  const anaFoto = analizarJPEG(fotoBuf, zonas), anaMini = analizarJPEG(miniBuf, zonas);
  if (!anaFoto.ok || !anaMini.ok) return json({ error: "formato_foto" }, 400);
  const avisosFoto = [...new Set([...avisosImagen(anaFoto), ...avisosImagen(anaMini)])];

  const t = ahora(); const desde = t - 10 * 60 * 1000;
  const ipHash = await huellaIP(env, ip);
  const disp = String(d.dispositivo || "").slice(0, 64) || "sin-id";
  const [dup, nIp, nDisp, mesasDisp, mesasRed] = await env.DB.batch([
    env.DB.prepare("SELECT 1 AS x FROM envios WHERE hash = ?").bind(hash),
    env.DB.prepare("SELECT COUNT(*) AS n FROM envios WHERE ip_hash = ? AND ts > ?").bind(ipHash, desde),
    env.DB.prepare("SELECT COUNT(*) AS n FROM envios WHERE dispositivo = ? AND ts > ?").bind(disp, desde),
    env.DB.prepare("SELECT COUNT(DISTINCT mesa_id) AS n FROM envios WHERE dispositivo = ? AND ts > ?").bind(disp, t - 30 * 60 * 1000),
    env.DB.prepare("SELECT COUNT(DISTINCT mesa_id) AS n FROM envios WHERE ip_hash = ? AND ts > ?").bind(ipHash, t - 60 * 60 * 1000),
  ]);
  if (dup.results.length) return json({ ok: true, ya_enviada: true, hash, mesa_id: mesa.id, avisos: [], foto_en_revision: false });
  if (nIp.results[0].n >= Number(env.MAX_ENVIOS_IP_10MIN || 300) || nDisp.results[0].n >= Number(env.MAX_ENVIOS_DISPOSITIVO_10MIN || 10))
    return json({ error: "demasiados_envios", mensaje: "Demasiados envíos seguidos. Espera unos minutos." }, 429);

  const flags = [...val.avisos, ...avisosFoto];
  if (mesa.nueva) flags.push("mesa_nueva");
  // Un mismo navegador con actas de más de MAX_MESAS_DISPOSITIVO_30MIN mesas distintas en media hora: se acepta, pero va
  // a revisión. Con 8, se puede fotografiar hasta 8 mesas (un colegio grande) sin aviso; la 9.ª ya se revisa.
  if (mesasDisp.results[0].n >= Number(env.MAX_MESAS_DISPOSITIVO_30MIN || 8)) flags.push("muchas_mesas");
  // Muchas IP son compartidas (las operadoras móviles agrupan a miles de clientes): esto no bloquea ni excluye,
  // solo impide que varios "dispositivos" detrás de una misma red muy activa cuenten como fuentes independientes.
  if (mesasRed.results[0].n >= Number(env.MAX_MESAS_RED_HORA || 8)) flags.push("red_muchas_mesas");
  // No se compara la huella visual (dhash) con las fotos de otras mesas. Esa huella es una miniatura de 9×8 puntos en la
  // que las cifras no se ven: todas las actas tienen la misma maqueta, así que fotos distintas de mesas distintas salían
  // iguales y se descartaban envíos buenos. La misma foto exacta ya se reconoce por su huella completa (arriba), y una
  // copia en otra mesa no basta para verificarla: hacen falta dos navegadores con las mismas cifras, y la foto publicada
  // muestra la cabecera del acta. La huella visual se sigue guardando por si hiciera falta revisar algo después.
  if (Number.isFinite(d.ts_foto) && env.MODO_PRUEBAS !== "1" && d.ts_foto < Date.parse(env.ABRE) - 5 * 60 * 1000) flags.push("foto_antes_apertura");
  let geoOk = null, geoDist = null;
  if (d.geo && Number.isFinite(d.geo.lat) && Number.isFinite(d.geo.lon) && mesa.lat != null && mesa.lon != null) {
    geoDist = Math.round(distanciaM(d.geo.lat, d.geo.lon, mesa.lat, mesa.lon));
    geoOk = geoDist <= Number(env.DISTANCIA_MAX_METROS || 400) + Math.min(500, Number(d.geo.acc) || 0) ? 1 : 0;
    if (!geoOk) flags.push("lejos");
  }

  // Lectura automática: si el formulario ya la pidió para esta misma foto, se reutiliza; si no, la hace el cron.
  let ia = null, iaEstado = null;
  if (iaActiva(env)) {
    const l = await env.DB.prepare("SELECT lectura FROM lecturas WHERE hash = ?").bind(hash).first();
    if (l) { ia = l.lectura; iaEstado = "hecha"; flags.push(...flagsLectura(JSON.parse(l.lectura))); } else iaEstado = "pendiente";
  }
  await env.FOTOS.put(`foto/${hash}.jpg`, fotoBuf, { httpMetadata: { contentType: "image/jpeg" } });
  await env.FOTOS.put(`mini/${hash}.jpg`, miniBuf, { httpMetadata: { contentType: "image/jpeg" } });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO envios (hash, mesa_id, prov, cifras, firma, cuadra, errores, dispositivo, ip_hash, geo_ok, geo_dist, dhash, ts_foto, ts, flags, ia, ia_estado)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(hash, mesa.id, mesa.prov, JSON.stringify(d.cifras), firmaCifras(d.cifras, cods), val.ok ? 1 : 0, JSON.stringify(val.errores), disp, ipHash,
            geoOk, geoDist, d.dhash ? String(d.dhash).slice(0, 32) : null, Number.isFinite(d.ts_foto) ? d.ts_foto : null, t, JSON.stringify([...new Set(flags)]), ia, iaEstado),
    env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(mesa.id, mesa.prov, t),
  ]);
  return json({ ok: true, hash, mesa_id: mesa.id, cuadra: val.ok, errores: val.errores, avisos: [...new Set(flags)], foto_en_revision: flags.some(f => CUARENTENA.includes(f)) });
}

// ---------------------------------------------------------------- lectura pública (con caché en el borde)
async function conCache(req, ctx, segundos, producir) {
  const u = new URL(req.url); u.search = ""; // la clave ignora parámetros: nadie puede saltarse la caché
  const cache = caches.default; const clave = new Request(u.toString(), { method: "GET" });
  // Lo que sale de la caché de Cloudflare puede traer otra duración (el ajuste «Browser Cache TTL» de la zona la sube a
  // 4 horas). Por eso se vuelve a poner la duración buena antes de entregarlo: si no, el navegador guardaría las cifras
  // durante horas y no vería a la gente que se apunta ni las mesas nuevas.
  const alNavegador = (resp) => { const s = new Response(resp.body, resp); s.headers.set("cache-control", `public, max-age=${segundos}`); s.headers.delete("expires"); return s; };
  const hit = await cache.match(clave); if (hit) return alNavegador(hit);
  const res = await producir(); if (!res.ok) return res;
  const r = new Response(res.body, res); r.headers.set("cache-control", `public, max-age=${segundos}`);
  ctx.waitUntil(cache.put(clave, r.clone())); return alNavegador(r);
}
// Una foto solo se sirve al público si es "publica" (mesa verificada por fuentes independientes o validada a mano).
// Caché corta (5 min): si se oculta una foto, deja de verse en minutos en todo el mundo.
// Antes de que cierren todos los colegios no se sirve ninguna foto (la foto del acta ya muestra los votos).
// En pruebas, las actas inventadas con «Rellenar datos de demostración» no tienen foto: se muestra un cartel en su lugar.
const FOTO_DEMO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><rect width="300" height="400" fill="#f6f2ea"/><rect x="40" y="40" width="220" height="320" rx="8" fill="#fffdf9" stroke="#d9d3c7" stroke-width="3"/><g fill="#d9d3c7"><rect x="70" y="90" width="160" height="10" rx="5"/><rect x="70" y="120" width="120" height="10" rx="5"/><rect x="70" y="150" width="150" height="10" rx="5"/><rect x="70" y="180" width="100" height="10" rx="5"/></g><text x="150" y="260" font-family="Arial,sans-serif" font-size="20" font-weight="700" fill="#23626a" text-anchor="middle">ACTA INVENTADA</text><text x="150" y="290" font-family="Arial,sans-serif" font-size="14" fill="#5e6b73" text-anchor="middle">datos de demostración</text></svg>`;
const fotoDemo = () => new Response(FOTO_DEMO, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=300" } });

async function servirFoto(req, env, ctx, tipo, hash) {
  if (!totalesVisibles(env)) return json({ error: "aun_no_publico" }, 404);
  return conCache(req, ctx, 300, async () => {
    const e = await env.DB.prepare("SELECT publica FROM envios WHERE hash = ?").bind(hash).first();
    if (!e || e.publica !== 1) return json({ error: "no_publica" }, 404);
    const o = await env.FOTOS.get(`${tipo}/${hash}.jpg`); if (!o) return env.MODO_PRUEBAS === "1" ? fotoDemo() : json({ error: "no_encontrada" }, 404);
    return new Response(o.body, { headers: { "content-type": "image/jpeg" } });
  });
}
async function servirFotoAdmin(env, tipo, hash) {
  const o = await env.FOTOS.get(`${tipo}/${hash}.jpg`); if (!o) return env.MODO_PRUEBAS === "1" ? fotoDemo() : json({ error: "no_encontrada" }, 404);
  return new Response(o.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } });
}

// ---------------------------------------------------------------- denuncias
// Cualquiera puede denunciar una foto publicada. Con DENUNCIAS_OCULTAR redes distintas, se oculta sola
// y pasa a la cola "Fotos sospechosas" del panel. Una foto aprobada en el panel ya no se oculta por denuncias.
async function recibirDenuncia(req, env) {
  const b = await req.json().catch(() => ({}));
  if (!/^[a-f0-9]{64}$/.test(b.hash || "")) return json({ error: "parametros" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (!(await turnstileOK(env, b.turnstile, ip))) return json({ error: "verificacion" }, 403);
  const ipHash = await huellaIP(env, ip);
  const t = ahora();
  const rec = await env.DB.prepare("SELECT COUNT(*) AS n FROM denuncias WHERE ip_hash = ? AND ts > ?").bind(ipHash, t - 600000).first();
  if (rec.n >= 20) return json({ error: "demasiadas_denuncias" }, 429);
  const e = await env.DB.prepare("SELECT mesa_id, prov FROM envios WHERE hash = ?").bind(b.hash).first(); if (!e) return json({ error: "no_encontrado" }, 404);
  await env.DB.prepare("INSERT OR IGNORE INTO denuncias (hash, ip_hash, ts) VALUES (?,?,?)").bind(b.hash, ipHash, t).run();
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM denuncias WHERE hash = ?").bind(b.hash).first()).n;
  const umbral = Number(env.DENUNCIAS_OCULTAR || 2);
  await env.DB.batch([
    env.DB.prepare("UPDATE envios SET denuncias = ? WHERE hash = ?").bind(n, b.hash),
    // se oculta al momento, sin esperar al recálculo
    env.DB.prepare("UPDATE envios SET publica = 0 WHERE hash = ? AND flags NOT LIKE '%foto_aprobada%' AND ? >= ?").bind(b.hash, n, umbral),
    env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(e.mesa_id, e.prov, t),
  ]);
  return json({ ok: true });
}
// ---------------------------------------------------------------- «Me apunto»: personas que irán a fotografiar un colegio
// Cualquiera puede apuntarse a un colegio electoral (un local de votación, con todas sus mesas) para decir que irá a
// fotografiar sus actas. No se pide ningún dato: se guardan el colegio, la hora, el identificador del navegador y la
// huella de la conexión (los mismos que en los envíos), solo para frenar abusos. A cambio se entrega un código de
// 6 caracteres que sirve para cancelar. La web muestra cuántas personas hay apuntadas en cada colegio.
//
// Un colegio se identifica por el código de su primera mesa (la de código más bajo entre las mesas del mismo municipio
// con el mismo local y la misma dirección). scripts/colegios.py prepara la lista de la web con la misma regla.
const ALFABETO_CODIGO = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";   // sin 0/O ni 1/I, que se confunden al copiarlos
// Clave de un colegio: nombre del local y calle (sin número ni código postal), en mayúsculas y con espacios simples.
// Así un mismo local que figura con dos portales de la misma calle («C/ MAYOR 151» y «C/ MAYOR 153») es un solo colegio.
const textoSimple = (s) => String(s || "").trim().replace(/\s+/g, " ").toUpperCase();
export const claveColegio = (local, direccion) => textoSimple(local) + "|" + textoSimple(direccion).replace(/\s*\d+[A-Z]?\s*(,.*)?$/, "");
function nuevoCodigo() { const b = crypto.getRandomValues(new Uint8Array(6)); return [...b].map(x => ALFABETO_CODIGO[x % 32]).join(""); }   // 32⁶ ≈ 1.070 millones de códigos
export const limpiarCodigo = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// Las reservas se cierran cuando se abren los envíos (domingo a las 20:00). En pruebas, siempre abiertas.
const apuntarseAbierto = (env) => env.MODO_PRUEBAS === "1" || ahora() < Date.parse(env.APUNTARSE_HASTA || env.ABRE);
// Mesas de un municipio, leídas por el índice del código (todas empiezan por «PP-MMM-»)
const mesasDeMunicipio = (env, prov, muni) => env.DB.prepare("SELECT id, local, direccion FROM mesas WHERE id >= ? AND id < ? AND nueva = 0")
  .bind(`${prov}-${muni}-`, `${prov}-${muni}-~`).all().then(r => r.results);
// Código del colegio de una mesa: el de la primera mesa del mismo local
function colegioDe(mesas, id) {
  const m = mesas.find(x => x.id === id); if (!m) return null; const k = claveColegio(m.local, m.direccion);
  return mesas.filter(x => claveColegio(x.local, x.direccion) === k).map(x => x.id).sort()[0];
}
// Las tablas de «Me apunto» se crean solas la primera vez que hacen falta (una vez por instancia del Worker), para no
// depender de ejecutar a mano una migración. Son las mismas de schema.sql y sql/cambios/2026-11-26_apuntados.sql.
let tablasApuntados = null;
function asegurarTablasApuntados(env) {
  if (!tablasApuntados) tablasApuntados = env.DB.batch([
    "CREATE TABLE IF NOT EXISTS apuntados (codigo TEXT PRIMARY KEY, colegio TEXT NOT NULL, prov TEXT NOT NULL, dispositivo TEXT NOT NULL, ip_hash TEXT NOT NULL, ts INTEGER NOT NULL, cancelado INTEGER)",
    "CREATE INDEX IF NOT EXISTS apuntados_colegio ON apuntados(prov, colegio)",
    "CREATE INDEX IF NOT EXISTS apuntados_disp ON apuntados(dispositivo, ts)",
    "CREATE INDEX IF NOT EXISTS apuntados_ip ON apuntados(ip_hash, ts)",
    "CREATE TABLE IF NOT EXISTS apuntados_cambios (prov TEXT PRIMARY KEY, ts INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS intentos_cancelar (ip_hash TEXT NOT NULL, ts INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS intentos_cancelar_ip ON intentos_cancelar(ip_hash, ts)",
  ].map(q => env.DB.prepare(q))).catch(e => { tablasApuntados = null; throw e; });
  return tablasApuntados;
}
async function recibirApuntado(req, env) {
  await asegurarTablasApuntados(env);
  if (!apuntarseAbierto(env)) return json({ error: "cerrado", mensaje: "Ya no se puede apuntar: los colegios han cerrado. Si estás cerca de uno, fotografía sus actas y súbelas." }, 403);
  const b = await req.json().catch(() => ({}));
  const pedido = String(b.colegio || "").toUpperCase(); const m = pedido.match(RE_MESA);
  if (!m) return json({ error: "colegio_desconocido" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (!(await turnstileOK(env, b.turnstile, ip))) return json({ error: "verificacion", ...(env.MODO_PRUEBAS === "1" ? { detalle: b.turnstile ? ultimoFalloTurnstile : "sin_pase" } : {}) }, 403);
  const colegio = colegioDe(await mesasDeMunicipio(env, m[1], m[2]), pedido);
  if (!colegio) return json({ error: "colegio_desconocido" }, 400);
  const disp = String(b.dispositivo || "").slice(0, 64) || "sin-id";
  const ipHash = await huellaIP(env, ip); const t = ahora();
  const minutos = Number(env.MINUTOS_ENTRE_APUNTADOS || 15);
  const [ya, ultimo, nIp] = await env.DB.batch([
    env.DB.prepare("SELECT codigo FROM apuntados WHERE dispositivo = ? AND colegio = ? AND cancelado IS NULL").bind(disp, colegio),
    env.DB.prepare("SELECT MAX(ts) AS ts FROM apuntados WHERE dispositivo = ? AND ts > ?").bind(disp, t - minutos * 60000),
    env.DB.prepare("SELECT COUNT(*) AS n FROM apuntados WHERE ip_hash = ? AND ts > ?").bind(ipHash, t - 3600000),
  ]);
  // Si este navegador ya estaba apuntado a este colegio, se le recuerda su código en vez de crear otro
  if (ya.results.length) return json({ ok: true, ya_apuntado: true, codigo: ya.results[0].codigo, colegio });
  if (ultimo.results[0].ts) {
    const faltan = Math.max(1, Math.ceil((ultimo.results[0].ts + minutos * 60000 - t) / 60000));
    return json({ error: "espera", minutos: faltan, mensaje: `Para que nadie pueda apuntarse a colegios a los que no va a ir, cada navegador solo puede apuntarse a un colegio cada ${minutos} minutos. Podrás apuntarte a otro dentro de ${faltan} minuto${faltan === 1 ? "" : "s"}. Disculpa las molestias.` }, 429);
  }
  if (nIp.results[0].n >= Number(env.MAX_APUNTADOS_IP_HORA || 30)) return json({ error: "demasiados", mensaje: "Se han hecho muchas reservas seguidas desde tu conexión. Vuelve a intentarlo dentro de un rato." }, 429);
  for (let i = 0; i < 5; i++) {   // si el código ya existiera (casi imposible), se prueba con otro
    const codigo = nuevoCodigo();
    const r = await env.DB.prepare("INSERT OR IGNORE INTO apuntados (codigo, colegio, prov, dispositivo, ip_hash, ts) VALUES (?,?,?,?,?,?)").bind(codigo, colegio, m[1], disp, ipHash, t).run();
    if (r.meta.changes) { await marcarApuntados(env, m[1], t); return json({ ok: true, codigo, colegio }); }
  }
  return json({ error: "error_interno" }, 500);
}
async function cancelarApuntado(req, env) {
  await asegurarTablasApuntados(env);
  const b = await req.json().catch(() => ({})); const codigo = limpiarCodigo(b.codigo);
  if (codigo.length !== 6) return json({ error: "codigo", mensaje: "El código tiene 6 caracteres." }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (!(await turnstileOK(env, b.turnstile, ip))) return json({ error: "verificacion", ...(env.MODO_PRUEBAS === "1" ? { detalle: b.turnstile ? ultimoFalloTurnstile : "sin_pase" } : {}) }, 403);
  // Límite de intentos por conexión, para que nadie pueda ir probando códigos al azar
  const ipHash = await huellaIP(env, ip); const t = ahora();
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM intentos_cancelar WHERE ip_hash = ? AND ts > ?").bind(ipHash, t - 600000).first();
  if (n.n >= Number(env.MAX_CANCELAR_IP_10MIN || 20)) return json({ error: "demasiados", mensaje: "Demasiados intentos seguidos. Espera unos minutos." }, 429);
  await env.DB.prepare("INSERT INTO intentos_cancelar (ip_hash, ts) VALUES (?,?)").bind(ipHash, t).run();
  const a = await env.DB.prepare("SELECT colegio, prov, cancelado FROM apuntados WHERE codigo = ?").bind(codigo).first();
  if (!a) return json({ error: "no_encontrado", mensaje: "No hay ninguna reserva con ese código. Revisa que esté bien copiado." }, 404);
  if (a.cancelado) return json({ ok: true, ya_cancelado: true, colegio: a.colegio });
  await env.DB.prepare("UPDATE apuntados SET cancelado = ? WHERE codigo = ?").bind(t, codigo).run();
  await marcarApuntados(env, a.prov, t);
  return json({ ok: true, colegio: a.colegio });
}
// Apunta que una provincia ha cambiado, para que el cron rehaga sus cifras de apuntados
const marcarApuntados = (env, prov, t) => env.DB.prepare("INSERT INTO apuntados_cambios (prov, ts) VALUES (?,?) ON CONFLICT(prov) DO UPDATE SET ts = excluded.ts").bind(prov, t).run();
// Cada minuto (cron): personas apuntadas por colegio en las provincias que han cambiado, y el resumen de toda España.
// public/apuntados/PP.json: { prov, generado, mesas, colegios: { id_colegio: personas } }
// public/apuntados.json:    { generado, personas, colegios, mesas, provincias: { PP: { personas, colegios, mesas } } }
//   («colegios» = colegios con al menos una persona; el total de colegios de cada provincia está en public/data/colegios/)
//   («mesas» = mesas de esos colegios: quien se apunta a un colegio puede fotografiar las actas de todas sus mesas)
const VERSION_APUNTADOS = "2";   // se sube cuando cambia el formato, para que el cron rehaga los archivos aunque no haya cambios
export async function publicarApuntados(env) {
  await asegurarTablasApuntados(env);
  const cambios = (await env.DB.prepare("SELECT prov, ts FROM apuntados_cambios").all()).results;
  const resumen = await env.FOTOS.head("public/apuntados.json");
  const alDia = resumen && resumen.customMetadata && resumen.customMetadata.v === VERSION_APUNTADOS;
  if (!cambios.length && alDia) return { provincias: 0 };
  const mesasProv = {};
  for (const c of cambios) {
    mesasProv[c.prov] = await publicarApuntadosProvincia(env, c.prov);
    await env.DB.prepare("DELETE FROM apuntados_cambios WHERE prov = ? AND ts <= ?").bind(c.prov, c.ts).run();
  }
  const pr = (await env.DB.prepare("SELECT prov, COUNT(*) AS personas, COUNT(DISTINCT colegio) AS colegios FROM apuntados WHERE cancelado IS NULL GROUP BY prov").all()).results;
  // Las mesas de las provincias que no han cambiado se leen de su archivo; si es del formato antiguo (sin «mesas»), se rehace
  for (const x of pr) if (mesasProv[x.prov] === undefined) {
    const o = await env.FOTOS.get(`public/apuntados/${x.prov}.json`);
    const d = o ? await o.json().catch(() => null) : null;
    mesasProv[x.prov] = d && typeof d.mesas === "number" ? d.mesas : await publicarApuntadosProvincia(env, x.prov);
  }
  const provincias = Object.fromEntries(pr.map(x => [x.prov, { personas: x.personas, colegios: x.colegios, mesas: mesasProv[x.prov] || 0 }]));
  await env.FOTOS.put("public/apuntados.json", JSON.stringify({ generado: ahora(), abierto: apuntarseAbierto(env), personas: pr.reduce((a, x) => a + x.personas, 0),
    colegios: pr.reduce((a, x) => a + x.colegios, 0), mesas: pr.reduce((a, x) => a + (mesasProv[x.prov] || 0), 0), provincias }),
    { httpMetadata: { contentType: "application/json" }, customMetadata: { v: VERSION_APUNTADOS } });
  return { provincias: cambios.length };
}
// Rehace public/apuntados/PP.json de una provincia y devuelve cuántas mesas suman sus colegios con alguien apuntado
async function publicarApuntadosProvincia(env, prov) {
  const r = (await env.DB.prepare("SELECT colegio, COUNT(*) AS n FROM apuntados WHERE prov = ? AND cancelado IS NULL GROUP BY colegio").bind(prov).all()).results;
  const porColegio = await mesasPorColegio(env, prov);
  const mesas = r.reduce((a, x) => a + (porColegio[x.colegio] || 1), 0);
  await env.FOTOS.put(`public/apuntados/${prov}.json`, JSON.stringify({ prov, generado: ahora(), mesas, colegios: Object.fromEntries(r.map(x => [x.colegio, x.n])) }), { httpMetadata: { contentType: "application/json" } });
  return mesas;
}
// Número de mesas de cada colegio de una provincia, sacado de la lista de colegios que ya publica la web
// (public/data/colegios/PP.json, cuarto dato de cada colegio). Leerla no consulta la base de datos ni cuesta.
async function mesasPorColegio(env, prov) {
  try {
    const r = await env.ASSETS.fetch(new Request(`https://recuento.local/data/colegios/${prov}.json`));
    if (!r.ok) return {};
    const d = await r.json(), m = {};
    for (const lista of Object.values(d.municipios || {})) for (const c of lista) m[c[0]] = c[3];
    return m;
  } catch (e) { return {}; }
}
// Solo en pruebas: apunta personas inventadas en una parte de los colegios de una provincia, para ver el mapa con datos
async function apuntadosDemo(env, prov, fraccion) {
  await asegurarTablasApuntados(env);
  const mesas = (await env.DB.prepare("SELECT id, muni, local, direccion FROM mesas WHERE prov = ? AND nueva = 0 ORDER BY id").bind(prov).all()).results;
  const colegios = new Map(); for (const m of mesas) { const k = m.muni + "|" + claveColegio(m.local, m.direccion); if (!colegios.has(k)) colegios.set(k, m.id); }
  const ganas = Math.random() ** 1.5;          // unas provincias se animan más que otras
  const st = [], t = ahora();
  for (const id of colegios.values()) {
    if (Math.random() > fraccion * 2 * ganas) continue;
    const n = 1 + Math.floor(Math.random() ** 3 * 6);
    for (let i = 0; i < n; i++) st.push(env.DB.prepare("INSERT OR IGNORE INTO apuntados (codigo, colegio, prov, dispositivo, ip_hash, ts) VALUES (?,?,?,?,?,?)").bind(nuevoCodigo(), id, prov, "demo", "demo", t));
  }
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  await marcarApuntados(env, prov, t);
  return { ok: true, prov, personas: st.length };
}

async function servirPublico(req, env, ctx, nombre) {
  return conCache(req, ctx, env.MODO_PRUEBAS === "1" ? 1 : 30, async () => {
    const o = await env.FOTOS.get(`public/${nombre}.json`);
    if (!o) return json(nombre === "resumen" ? { generado: null, provincias: [], nacional: null } : nombre === "decisiones" ? { decisiones: [] }
      : nombre === "apuntados" ? { generado: null, personas: 0, colegios: 0, provincias: {} } : nombre.startsWith("apuntados/") ? { prov: nombre.slice(10), colegios: {} }
      : nombre.startsWith("oficial/") ? { prov: nombre.slice(8), municipios: {}, mesas: {} } : { mesas: [] }, 200);
    return new Response(o.body, { headers: JSONH });
  });
}

// ---------------------------------------------------------------- consenso
export function calcularConsenso(envios, umbralDenuncias = 2) {
  const visibles = envios.filter(e => e.estado !== "invalida");
  if (!envios.length) return null;
  const validadas = visibles.filter(e => e.estado === "valida").sort((a, b) => b.ts - a.ts);
  // Fotos públicas: las validadas a mano y, en mesas verificadas, las del grupo coincidente sin denuncias suficientes.
  // Ninguna foto se publica sin lectura automática o revisión manual: hace falta que la lectura automática esté hecha
  // (y no la haya marcado) o que la foto se haya aprobado en el panel. Mientras tanto, sus cifras cuentan igual.
  const sinDenuncia = (e) => { const fl = JSON.parse(e.flags || "[]");
    if (fl.includes("foto_aprobada")) return true; // revisada en el panel: se publica aunque tenga avisos o denuncias
    return (e.denuncias || 0) < umbralDenuncias && e.ia_estado === "hecha" && !fl.some(f => CUARENTENA.includes(f)); };
  if (validadas.length) {
    const ref = validadas[0].firma;
    const pub = visibles.filter(e => (e.firma === ref && e.cuadra === 1 && sinDenuncia(e)) || (e.estado === "valida" && sinDenuncia(e))).map(e => e.hash);
    return { estado: "validada", cifras: validadas[0].cifras, n_indep: 0, publicas: pub };
  }
  const cuentan = visibles.filter(e => e.cuadra === 1 && !JSON.parse(e.flags || "[]").some(f => EXCLUYENTES.includes(f)));
  if (!cuentan.length) return { estado: visibles.length ? "revision" : "invalidada", cifras: null, n_indep: 0, publicas: [] };
  const grupos = new Map(); for (const e of cuentan) { if (!grupos.has(e.firma)) grupos.set(e.firma, []); grupos.get(e.firma).push(e); }
  const orden = [...grupos.values()].sort((a, b) => b.length - a.length);
  const g = orden[0]; const redes = new Set(g.map(e => e.ip_hash));
  const redSospechosa = redes.size === 1 && g.some(e => JSON.parse(e.flags || "[]").includes("red_muchas_mesas"));
  const indep = redSospechosa ? 1 : new Set(g.map(e => e.dispositivo)).size;
  if (orden.length > 1) return { estado: "conflicto", cifras: g[0].cifras, n_indep: indep, publicas: [] };
  const ver = indep >= 2;
  return { estado: ver ? "verificada" : "pendiente", cifras: g[0].cifras, n_indep: indep, publicas: ver ? g.filter(sinDenuncia).map(e => e.hash) : [] };
}

// ---------------------------------------------------------------- datos de demostración (solo pruebas)
// Elige más o menos `fraccion` de las mesas de la provincia, con más participación en unos distritos que en otros (como
// pasaría en la realidad), e inventa sus envíos: la mayoría verificadas (dos personas con las mismas cifras), y algunas
// con una sola foto, en conflicto o en revisión. Los votos se reparten al azar entre las candidaturas, sin ningún patrón
// real. No se suben fotos ni se piden lecturas automáticas: la web muestra un cartel de «acta inventada».
async function rellenarDemo(env, prov, fraccion) {
  const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, "0")).join("");
  const mesas = (await env.DB.prepare("SELECT id, muni, distrito, censo FROM mesas WHERE prov = ? AND nueva = 0").bind(prov).all()).results;
  const cods = (await env.DB.prepare("SELECT codigo FROM candidaturas WHERE prov = ?").bind(prov).all()).results.map(r => r.codigo);
  if (!mesas.length || !cods.length) return { ok: true, prov, mesas: 0 };
  const pesos = cods.map(() => Math.random() ** 3);                 // reparto al azar, distinto en cada provincia
  const actividad = new Map();                                       // ganas de participar en cada distrito (0 a 1)
  const cifras = (censo) => {
    const electores = censo || 300 + Math.floor(Math.random() * 500), votantes = Math.floor(electores * (0.55 + Math.random() * 0.25));
    const nulos = Math.floor(Math.random() * 8), blanco = Math.floor(Math.random() * 12), resto = votantes - nulos - blanco;
    const w = pesos.map(p => p * (0.6 + Math.random() * 0.8)), tot = w.reduce((a, x) => a + x, 0);
    const v = w.map(x => Math.floor(resto * x / tot)); v[0] += resto - v.reduce((a, x) => a + x, 0);
    return { electores, votantes, nulos, blanco, cand: Object.fromEntries(cods.map((c, i) => [c, v[i]])) };
  };
  const t = ahora(), filas = [], tocadas = [];
  const envio = (mesa, c, flags = []) => filas.push([hex(32), mesa.id, prov, JSON.stringify(c), firmaCifras(c, cods), 1, "[]", "demo-" + hex(8), hex(16),
    null, t - Math.floor(Math.random() * 7200000), t - Math.floor(Math.random() * 7200000), JSON.stringify(flags)]);
  for (const m of mesas) {
    const d = m.muni + m.distrito; if (!actividad.has(d)) actividad.set(d, Math.random() ** 1.5);
    if (Math.random() >= Math.min(0.9, fraccion * 2.5 * actividad.get(d))) continue;   // media ≈ fraccion
    const u = Math.random(), c = cifras(m.censo); tocadas.push(m.id);
    if (u < 0.78) { envio(m, c); envio(m, c); }                                        // verificada
    else if (u < 0.93) envio(m, c);                                                    // una sola foto
    else if (u < 0.98) { envio(m, c); const c2 = cifras(m.censo); envio(m, c2); }      // conflicto
    else envio(m, c, ["muchas_mesas"]);                                                // en revisión
  }
  // D1 admite hasta 100 valores por consulta: 7 filas de 13 columnas por INSERT, 33 mesas por INSERT de pendientes
  const st = [];
  for (let i = 0; i < filas.length; i += 7) { const l = filas.slice(i, i + 7);
    st.push(env.DB.prepare(`INSERT INTO envios (hash, mesa_id, prov, cifras, firma, cuadra, errores, dispositivo, ip_hash, dhash, ts_foto, ts, flags, ia_estado) VALUES ${l.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,'hecha')").join(",")}`).bind(...l.flat())); }
  for (let i = 0; i < tocadas.length; i += 33) { const l = tocadas.slice(i, i + 33);
    st.push(env.DB.prepare(`INSERT INTO pendientes (mesa_id, prov, ts) VALUES ${l.map(() => "(?,?,?)").join(",")} ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts`).bind(...l.flatMap(id => [id, prov, t]))); }
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  return { ok: true, prov, mesas: tocadas.length, envios: filas.length };
}

export async function recalcular(env) {
  const t0 = ahora();
  const pend = (await env.DB.prepare("SELECT mesa_id, prov, ts FROM pendientes ORDER BY ts LIMIT 2000").all()).results;
  const provs = new Set(pend.map(p => p.prov));
  for (let i = 0; i < pend.length; i += 100) {
    const lote = pend.slice(i, i + 100); const ids = lote.map(p => p.mesa_id);
    const envs = (await env.DB.prepare(`SELECT hash, mesa_id, cifras, firma, cuadra, dispositivo, ip_hash, ts, estado, flags, denuncias, ia_estado FROM envios WHERE mesa_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results;
    const porMesa = new Map(); for (const e of envs) { if (!porMesa.has(e.mesa_id)) porMesa.set(e.mesa_id, []); porMesa.get(e.mesa_id).push(e); }
    const stmts = [];
    for (const p of lote) {
      const es = porMesa.get(p.mesa_id) || []; const c = calcularConsenso(es, Number(env.DENUNCIAS_OCULTAR || 2));
      stmts.push(env.DB.prepare("UPDATE envios SET publica = 0 WHERE mesa_id = ?").bind(p.mesa_id));
      if (c && c.publicas.length) stmts.push(env.DB.prepare(`UPDATE envios SET publica = 1 WHERE hash IN (${c.publicas.map(() => "?").join(",")})`).bind(...c.publicas));
      if (c) stmts.push(env.DB.prepare(`INSERT INTO consenso (mesa_id, prov, estado, cifras, n_envios, n_indep, actualizado) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(mesa_id) DO UPDATE SET estado=excluded.estado, cifras=excluded.cifras, n_envios=excluded.n_envios, n_indep=excluded.n_indep, actualizado=excluded.actualizado`)
        .bind(p.mesa_id, p.prov, c.estado, c.cifras, es.length, c.n_indep, t0));
      else stmts.push(env.DB.prepare("DELETE FROM consenso WHERE mesa_id = ?").bind(p.mesa_id));
      stmts.push(env.DB.prepare("DELETE FROM pendientes WHERE mesa_id = ? AND ts <= ?").bind(p.mesa_id, p.ts));
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
  // Al llegar la hora de publicar cifras, se regeneran todas las provincias (no solo las que tienen envíos nuevos),
  // porque hasta entonces sus JSON se guardaron sin votos ni fotos. El resumen guarda en sus metadatos si ya los mostraba.
  const resumen = await env.FOTOS.head("public/resumen.json");
  const visible = totalesVisibles(env);
  const cambioHora = !!resumen && (resumen.customMetadata?.totales === "1") !== visible;
  if (cambioHora) for (const r of (await env.DB.prepare("SELECT DISTINCT prov FROM consenso").all()).results) provs.add(r.prov);
  for (const prov of provs) await publicarProvincia(env, prov);
  if (provs.size || !resumen) { await publicarResumen(env); await publicarDecisiones(env); }
  return { mesas: pend.length, provincias: [...provs], ms: ahora() - t0 };
}

async function publicarProvincia(env, prov) {
  const visible = totalesVisibles(env);
  const [cons, envs, cands] = await env.DB.batch([
    env.DB.prepare("SELECT c.mesa_id, c.estado, c.cifras, c.n_envios, c.n_indep, m.municipio, m.censo, m.local, m.nueva FROM consenso c JOIN mesas m ON m.id = c.mesa_id WHERE c.prov = ?").bind(prov),
    env.DB.prepare("SELECT hash, mesa_id, cifras, cuadra, geo_ok, ts, estado, motivo, flags, publica, denuncias FROM envios WHERE prov = ? ORDER BY ts").bind(prov),
    env.DB.prepare("SELECT codigo, siglas, orden FROM candidaturas WHERE prov = ? ORDER BY orden").bind(prov),
  ]);
  const porMesa = new Map(); for (const e of envs.results) { if (!porMesa.has(e.mesa_id)) porMesa.set(e.mesa_id, []);
    // Antes de la hora de publicar: ni cifras ni foto de cada envío (solo su estado y la hora).
    porMesa.get(e.mesa_id).push({ h: e.hash, c: visible ? JSON.parse(e.cifras) : null, ok: e.cuadra, geo: e.geo_ok, ts: e.ts, est: e.estado, mot: e.motivo, f: JSON.parse(e.flags || "[]"), pub: visible ? e.publica : 0, den: e.denuncias >= Number(env.DENUNCIAS_OCULTAR || 2) && !String(e.flags).includes("foto_aprobada") ? 1 : 0 }); }
  const mesas = cons.results.map(c => ({ id: c.mesa_id, municipio: c.municipio, local: c.local, censo: c.censo, estado: c.estado, nueva: c.nueva ? 1 : 0, cifras: visible && c.cifras ? JSON.parse(c.cifras) : null,
    n: c.n_envios, indep: c.n_indep, fotos: porMesa.get(c.mesa_id) || [] }));
  await env.FOTOS.put(`public/prov/${prov}.json`, JSON.stringify({ prov, generado: ahora(), totales_visibles: visible, candidaturas: cands.results, mesas }), { httpMetadata: { contentType: "application/json" } });
}

async function publicarResumen(env) {
  const mostrarTotales = totalesVisibles(env);
  const [tot, est, cands, cifras] = await env.DB.batch([
    env.DB.prepare("SELECT m.prov, COALESCE(MAX(p.mesas), SUM(CASE WHEN m.nueva = 0 THEN 1 ELSE 0 END)) AS n FROM mesas m LEFT JOIN provincias p ON p.prov = m.prov GROUP BY m.prov"),
    env.DB.prepare("SELECT prov, estado, COUNT(*) AS n FROM consenso GROUP BY prov, estado"),
    env.DB.prepare("SELECT prov, codigo, siglas FROM candidaturas"),
    env.DB.prepare("SELECT prov, cifras FROM consenso WHERE estado IN ('verificada','validada')"),
  ]);
  const siglas = new Map(cands.results.map(c => [c.prov + "|" + c.codigo, c.siglas]));
  const P = new Map(); for (const r of tot.results) P.set(r.prov, { prov: r.prov, mesas: r.n, con_envio: 0, verificada: 0, validada: 0, pendiente: 0, conflicto: 0, revision: 0, invalidada: 0, votos: {} });
  for (const r of est.results) { const p = P.get(r.prov); if (p) { p[r.estado] = (p[r.estado] || 0) + r.n; p.con_envio += r.n; } }
  const nac = { mesas: 0, con_envio: 0, verificada: 0, validada: 0, pendiente: 0, conflicto: 0, revision: 0, invalidada: 0, votos: {} };
  if (mostrarTotales) for (const r of cifras.results) { const c = JSON.parse(r.cifras); const p = P.get(r.prov); if (!p) continue;
    for (const [cod, v] of Object.entries(c.cand)) { const s = siglas.get(r.prov + "|" + cod) || cod; p.votos[s] = (p.votos[s] || 0) + v; nac.votos[s] = (nac.votos[s] || 0) + v; }
    for (const k of ["blanco", "nulos", "votantes"]) { p.votos["_" + k] = (p.votos["_" + k] || 0) + c[k]; nac.votos["_" + k] = (nac.votos["_" + k] || 0) + c[k]; } }
  for (const p of P.values()) for (const k of ["mesas", "con_envio", "verificada", "validada", "pendiente", "conflicto", "revision", "invalidada"]) nac[k] += p[k] || 0;
  await env.FOTOS.put("public/resumen.json", JSON.stringify({ generado: ahora(), totales_visibles: mostrarTotales, nacional: nac, provincias: [...P.values()] }),
    { httpMetadata: { contentType: "application/json" }, customMetadata: { totales: mostrarTotales ? "1" : "0" } });
}
// Registro público de decisiones, encadenado. Cada decisión lleva una «huella» (SHA-256) calculada a partir de la huella
// de la decisión anterior y de sus propios datos; la huella de la última resume todo el registro. Si alguien cambiara o
// borrara una decisión antigua directamente en la base de datos, cambiarían todas las huellas desde ese punto y ya no
// coincidirían con las publicadas antes (por ejemplo, en un mensaje en redes o en una copia guardada del archivo).
// Cualquiera puede comprobarlo con scripts/verificar_registro.py.
// Solo se regenera cuando hay decisiones nuevas, para no repetir trabajo cada minuto.
const HUELLA_INICIAL = "0".repeat(64);
export async function encadenar(decisiones) {
  const enc = new TextEncoder(); let h = HUELLA_INICIAL; const salida = [];
  for (const d of decisiones) {
    h = await sha256hex(enc.encode(h + "\n" + JSON.stringify([d.id, d.ts, d.hash, d.mesa_id, d.decision, d.motivo ?? null])));
    salida.push({ ...d, huella: h });
  }
  return { huella: h, decisiones: salida };
}
async function publicarDecisiones(env) {
  const ultima = String((await env.DB.prepare("SELECT MAX(id) AS m FROM decisiones").first())?.m || 0);
  const previo = await env.FOTOS.head("public/decisiones.json");
  if (previo && previo.customMetadata?.ultima === ultima) return;
  const r = await env.DB.prepare("SELECT id, ts, hash, mesa_id, decision, motivo FROM decisiones ORDER BY id").all();
  const { huella, decisiones } = await encadenar(r.results);
  // Se publican todas, de la más reciente a la más antigua; la huella del registro completo va arriba.
  await env.FOTOS.put("public/decisiones.json", JSON.stringify({ generado: ahora(), total: decisiones.length, huella, decisiones: decisiones.reverse() }),
    { httpMetadata: { contentType: "application/json" }, customMetadata: { ultima } });
}

// ---------------------------------------------------------------- panel de validación
async function admin(req, env, url) {
  // Primera llave: Cloudflare Access (solo los correos autorizados). Si ACCESS_TEAM y ACCESS_AUD están configurados, es obligatoria.
  if (env.ACCESS_TEAM && env.ACCESS_AUD) {
    if (!(await accesoValido(req, env))) return json({ error: "no_autorizado_access" }, 403);
  } else if (env.MODO_PRUEBAS !== "1") {
    return json({ error: "falta_configurar_access" }, 403); // en producción no se abre el panel sin Access
  }
  // Segunda llave: el token del panel.
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || tok.length < 32 || !(await igualSeguro(tok, env.ADMIN_TOKEN))) return json({ error: "no_autorizado" }, 401);
  const p = url.pathname.replace("/admin/api/", "");
  let mf;
  if ((mf = p.match(/^(foto|mini)\/([a-f0-9]{64})\.jpg$/)) && req.method === "GET") return await servirFotoAdmin(env, mf[1], mf[2]);
  if (p === "cola" && req.method === "GET" && ["fotos", "denunciadas"].includes(url.searchParams.get("estado"))) {
    // Fotos sospechosas: en cuarentena (no parece acta, nombres sin tapar, la IA la marca) o denunciadas, sin revisar aún.
    const cond = [...CUARENTENA.map(() => "e.flags LIKE ?"), "e.denuncias >= ?"].join(" OR ");
    const r = await env.DB.prepare(`SELECT DISTINCT m.id AS mesa_id, m.prov, m.muni, m.municipio, m.censo, m.local, m.nueva, c.estado, c.cifras, c.n_envios, c.n_indep
      FROM envios e JOIN mesas m ON m.id = e.mesa_id LEFT JOIN consenso c ON c.mesa_id = m.id
      WHERE e.estado = 'pendiente' AND e.flags NOT LIKE '%foto_aprobada%' AND (${cond}) ORDER BY e.ts DESC LIMIT 40`)
      .bind(...CUARENTENA.map(f => `%"${f}"%`), Number(env.DENUNCIAS_OCULTAR || 2)).all();
    return json({ mesas: await conEnvios(env, r.results) });
  }
  if (p === "cola" && req.method === "GET" && url.searchParams.get("estado") === "espera") {
    // Fotos de mesas ya verificadas que no se han leído: sin prioridad, para cuando tengas tiempo (las más antiguas primero)
    const prov = url.searchParams.get("prov"); const args = [];
    let sql = `SELECT m.id AS mesa_id, m.prov, m.muni, m.municipio, m.censo, m.local, m.nueva, c.estado, c.cifras, c.n_envios, c.n_indep, MIN(e.ts) AS t
      FROM envios e JOIN mesas m ON m.id = e.mesa_id LEFT JOIN consenso c ON c.mesa_id = m.id
      WHERE e.ia_estado = 'en_espera' AND e.estado = 'pendiente' AND e.flags NOT LIKE '%foto_aprobada%'`;
    if (prov) { sql += " AND e.prov = ?"; args.push(prov); }
    sql += " GROUP BY m.id ORDER BY t LIMIT 30";
    return json({ mesas: await conEnvios(env, (await env.DB.prepare(sql).bind(...args).all()).results) });
  }
  if (p === "cola" && req.method === "GET" && url.searchParams.get("estado") === "sin_leer") {
    // Fotos de mesas ya verificadas que se publicarían, pero que la lectura automática aún no ha podido leer (está
    // saturada, ha fallado varias veces o se ha llegado al tope). Se pueden aprobar a mano; cuando la lectura automática
    // las lee, salen solas de esta lista (y si las marca, pasan a «Fotos sospechosas»). Las más antiguas primero.
    const prov = url.searchParams.get("prov"); const args = [];
    let sql = `SELECT m.id AS mesa_id, m.prov, m.muni, m.municipio, m.censo, m.local, m.nueva, c.estado, c.cifras, c.n_envios, c.n_indep, MIN(e.ts) AS t
      FROM envios e JOIN consenso c ON c.mesa_id = e.mesa_id JOIN mesas m ON m.id = e.mesa_id
      WHERE c.estado IN ('verificada','validada') AND e.estado != 'invalida' AND e.ia_estado IN (${SIN_LEER.map(() => "?").join(",")})
        AND e.flags NOT LIKE '%foto_aprobada%' AND ${CUARENTENA.map(() => "e.flags NOT LIKE ?").join(" AND ")}`;
    args.push(...SIN_LEER, ...CUARENTENA.map(f => `%"${f}"%`));
    if (prov) { sql += " AND e.prov = ?"; args.push(prov); }
    sql += " GROUP BY m.id ORDER BY t LIMIT 30";
    return json({ mesas: await conEnvios(env, (await env.DB.prepare(sql).bind(...args).all()).results) });
  }
  if (p === "leer_en_espera" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const r = b.hash ? await env.DB.prepare("UPDATE envios SET ia_estado = 'forzada' WHERE hash = ? AND ia_estado = 'en_espera'").bind(String(b.hash)).run()
                     : await env.DB.prepare("UPDATE envios SET ia_estado = 'forzada' WHERE mesa_id = ? AND ia_estado = 'en_espera'").bind(String(b.mesa_id || "")).run();
    return json({ ok: true, fotos: r.meta.changes });
  }
  if (p === "retapar" && req.method === "POST") {
    // Fotos con nombres a la vista: se tapan en el panel, la versión tapada sustituye a la original (que no se conserva) y queda aprobada.
    let form; try { form = await req.formData(); } catch { return json({ error: "formato" }, 400); }
    const hash = String(form.get("hash") || ""), foto = form.get("foto"), mini = form.get("mini");
    if (!/^[a-f0-9]{64}$/.test(hash) || !(foto instanceof File) || !(mini instanceof File) || foto.size > 2_500_000 || mini.size > 250_000) return json({ error: "parametros" }, 400);
    const e = await env.DB.prepare("SELECT mesa_id, prov, flags FROM envios WHERE hash = ?").bind(hash).first(); if (!e) return json({ error: "no_encontrado" }, 404);
    const fb = await foto.arrayBuffer(), mb = await mini.arrayBuffer();
    const u8 = new Uint8Array(fb); if (u8[0] !== 0xff || u8[1] !== 0xd8) return json({ error: "formato_foto" }, 400);
    const nueva = await sha256hex(fb); const t = ahora();
    await env.FOTOS.put(`foto/${hash}.jpg`, fb, { httpMetadata: { contentType: "image/jpeg" } });
    await env.FOTOS.put(`mini/${hash}.jpg`, mb, { httpMetadata: { contentType: "image/jpeg" } });
    const flags = [...new Set([...JSON.parse(e.flags || "[]").filter(f => f !== "nombres_sin_tapar" && !f.startsWith("retapada:")), "foto_aprobada", `retapada:${nueva}`])];
    await env.DB.batch([
      env.DB.prepare("UPDATE envios SET flags = ? WHERE hash = ?").bind(JSON.stringify(flags), hash),
      env.DB.prepare("INSERT INTO decisiones (ts, hash, mesa_id, decision, motivo) VALUES (?,?,?,?,?)").bind(t, hash, e.mesa_id, "foto_retapada", `Nombres tapados a mano en la revisión. Huella SHA-256 de la foto publicada: ${nueva}`),
      env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(e.mesa_id, e.prov, t),
    ]);
    return json({ ok: true, huella: nueva });
  }
  if (p === "aprobar_foto" && req.method === "POST") {
    // La foto está bien (es un acta y no muestra nombres): se puede publicar. No cambia las cifras de la mesa.
    const b = await req.json().catch(() => ({}));
    const e = await env.DB.prepare("SELECT mesa_id, prov, flags FROM envios WHERE hash = ?").bind(String(b.hash || "")).first(); if (!e) return json({ error: "no_encontrado" }, 404);
    const flags = [...new Set([...JSON.parse(e.flags || "[]"), "foto_aprobada"])]; const t = ahora();
    await env.DB.batch([
      env.DB.prepare("UPDATE envios SET flags = ? WHERE hash = ?").bind(JSON.stringify(flags), b.hash),
      env.DB.prepare("INSERT INTO decisiones (ts, hash, mesa_id, decision, motivo) VALUES (?,?,?,?,?)").bind(t, b.hash, e.mesa_id, "foto_aprobada", "Foto revisada: es un acta y no muestra datos personales"),
      env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(e.mesa_id, e.prov, t),
    ]);
    return json({ ok: true });
  }
  if (p === "resolver_mesa" && req.method === "POST") {
    // Das por buena una versión de la mesa: sus envíos quedan validados y el resto invalidados, en un solo paso.
    const b = await req.json().catch(() => ({}));
    const es = (await env.DB.prepare("SELECT hash, firma, prov, estado FROM envios WHERE mesa_id = ?").bind(String(b.mesa_id || "")).all()).results;
    if (!es.length || !es.some(e => e.firma === b.firma)) return json({ error: "parametros" }, 400);
    const t = ahora(); const st = [];
    for (const e of es) {
      const buena = e.firma === b.firma; if (e.estado === "invalida" && buena) continue;
      const dec = buena ? "valida" : "invalida", mot = buena ? "Versión correcta de la mesa" : "No coincide con la versión correcta de la mesa";
      if (e.estado === dec) continue;
      st.push(env.DB.prepare("UPDATE envios SET estado = ?, motivo = ? WHERE hash = ?").bind(dec, mot, e.hash));
      st.push(env.DB.prepare("INSERT INTO decisiones (ts, hash, mesa_id, decision, motivo) VALUES (?,?,?,?,?)").bind(t, e.hash, b.mesa_id, dec, mot));
    }
    st.push(env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(b.mesa_id, es[0].prov, t));
    await env.DB.batch(st);
    return json({ ok: true, cambios: (st.length - 1) / 2 });
  }
  if (p === "cola" && req.method === "GET" && url.searchParams.get("estado") === "nuevas") {
    const prov = url.searchParams.get("prov"); const args = [];
    let sql = `SELECT m.id AS mesa_id, m.prov, m.muni, m.municipio, m.censo, m.local, m.nueva, c.estado, c.cifras, c.n_envios, c.n_indep
               FROM mesas m LEFT JOIN consenso c ON c.mesa_id = m.id WHERE m.nueva = 1`;
    if (prov) { sql += " AND m.prov = ?"; args.push(prov); }
    sql += " ORDER BY c.actualizado DESC LIMIT 50";
    return json({ mesas: await conEnvios(env, (await env.DB.prepare(sql).bind(...args).all()).results) });
  }
  if (p === "mesas_municipio" && req.method === "GET") {
    const r = await env.DB.prepare("SELECT id, censo FROM mesas WHERE prov = ? AND muni = ? AND nueva = 0 ORDER BY id").bind(url.searchParams.get("prov"), url.searchParams.get("muni")).all();
    return json({ mesas: r.results });
  }
  if (p === "reasignar" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const e = await env.DB.prepare("SELECT hash, mesa_id, prov, flags FROM envios WHERE hash = ?").bind(String(b.hash || "")).first();
    if (!e) return json({ error: "no_encontrado" }, 404);
    const dest = await env.DB.prepare("SELECT id, prov, nueva FROM mesas WHERE id = ?").bind(String(b.mesa_destino || "").toUpperCase()).first();
    if (!dest || dest.nueva) return json({ error: "mesa_destino_desconocida", mensaje: "La mesa de destino no existe en la lista oficial." }, 400);
    if (dest.prov !== e.prov) return json({ error: "otra_provincia", mensaje: "Solo se puede reasignar dentro de la misma provincia." }, 400);
    const flags = JSON.parse(e.flags || "[]").filter(f => f !== "mesa_nueva"); const t = ahora();
    await env.DB.batch([
      env.DB.prepare("UPDATE envios SET mesa_id = ?, flags = ? WHERE hash = ?").bind(dest.id, JSON.stringify(flags), e.hash),
      env.DB.prepare("INSERT INTO decisiones (ts, hash, mesa_id, decision, motivo) VALUES (?,?,?,?,?)").bind(t, e.hash, dest.id, "reasignada", `Desde ${e.mesa_id}`),
      env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(dest.id, dest.prov, t),
      env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(e.mesa_id, e.prov, t),
    ]);
    // si la mesa de origen era una mesa nueva y se ha quedado sin envíos, desaparece
    await env.DB.prepare("DELETE FROM mesas WHERE id = ? AND nueva = 1 AND NOT EXISTS (SELECT 1 FROM envios WHERE mesa_id = ?)").bind(e.mesa_id, e.mesa_id).run();
    return json({ ok: true });
  }
  if (p === "confirmar_mesa" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const m = await env.DB.prepare("SELECT id, prov FROM mesas WHERE id = ? AND nueva = 1").bind(String(b.mesa_id || "")).first();
    if (!m) return json({ error: "no_encontrado" }, 404);
    const envs = (await env.DB.prepare("SELECT hash, flags FROM envios WHERE mesa_id = ?").bind(m.id).all()).results; const t = ahora();
    await env.DB.batch([
      env.DB.prepare("UPDATE mesas SET nueva = 0 WHERE id = ?").bind(m.id),
      ...envs.map(e => env.DB.prepare("UPDATE envios SET flags = ? WHERE hash = ?").bind(JSON.stringify(JSON.parse(e.flags || "[]").filter(f => f !== "mesa_nueva")), e.hash)),
      env.DB.prepare("INSERT INTO decisiones (ts, hash, mesa_id, decision, motivo) VALUES (?,?,?,?,?)").bind(t, "-", m.id, "mesa_confirmada", "Mesa no incluida en la lista de referencia, confirmada a mano"),
      env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(m.id, m.prov, t),
    ]);
    return json({ ok: true });
  }
  if (p === "cola" && req.method === "GET") {
    const estados = (url.searchParams.get("estado") || "conflicto,revision").split(",").filter(Boolean).slice(0, 6);
    const prov = url.searchParams.get("prov"); const lim = Math.min(100, Number(url.searchParams.get("limit")) || 30);
    let sql = `SELECT c.*, m.muni, m.municipio, m.censo, m.local, m.nueva FROM consenso c JOIN mesas m ON m.id = c.mesa_id WHERE c.estado IN (${estados.map(() => "?").join(",")})`;
    const args = [...estados]; if (prov) { sql += " AND c.prov = ?"; args.push(prov); }
    sql += " ORDER BY c.actualizado DESC LIMIT ?"; args.push(lim);
    const mesas = (await env.DB.prepare(sql).bind(...args).all()).results;
    return json({ mesas: await conEnvios(env, mesas) });
  }
  if (p === "mesa" && req.method === "GET") {
    const id = url.searchParams.get("id");
    const m = await env.DB.prepare("SELECT m.id AS mesa_id, m.prov, m.muni, m.municipio, m.censo, m.local, m.nueva, c.estado, c.cifras, c.n_envios, c.n_indep FROM mesas m LEFT JOIN consenso c ON c.mesa_id = m.id WHERE m.id = ?").bind(id).first();
    if (!m) return json({ error: "mesa_desconocida" }, 404);
    return json({ mesas: await conEnvios(env, [m]) });
  }
  if (p === "decision" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!/^[a-f0-9]{64}$/.test(b.hash || "") || !["valida", "invalida", "pendiente"].includes(b.decision)) return json({ error: "parametros" }, 400);
    const e = await env.DB.prepare("SELECT mesa_id, prov FROM envios WHERE hash = ?").bind(b.hash).first(); if (!e) return json({ error: "no_encontrado" }, 404);
    const motivo = String(b.motivo || "").slice(0, 200) || null; const t = ahora();
    await env.DB.batch([
      env.DB.prepare("UPDATE envios SET estado = ?, motivo = ? WHERE hash = ?").bind(b.decision, motivo, b.hash),
      env.DB.prepare("INSERT INTO decisiones (ts, hash, mesa_id, decision, motivo) VALUES (?,?,?,?,?)").bind(t, b.hash, e.mesa_id, b.decision, motivo),
      env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(e.mesa_id, e.prov, t),
    ]);
    return json({ ok: true });
  }
  if (p === "acciones" && req.method === "GET") {
    // Registro de decisiones tomadas en el panel (las más recientes primero), de todas las mesas o de una sola
    const mesa = url.searchParams.get("mesa"); const lim = Math.min(500, Number(url.searchParams.get("limit")) || 100);
    const r = mesa
      ? await env.DB.prepare("SELECT ts, hash, mesa_id, decision, motivo FROM decisiones WHERE mesa_id = ? ORDER BY id DESC LIMIT ?").bind(mesa, lim).all()
      : await env.DB.prepare("SELECT ts, hash, mesa_id, decision, motivo FROM decisiones ORDER BY id DESC LIMIT ?").bind(lim).all();
    return json({ acciones: r.results });
  }
  if (p === "reabrir_mesa" && req.method === "POST") {
    // Deshace todas las decisiones sobre las fotos de una mesa: vuelven a «pendiente» y la mesa se recalcula como si
    // nadie la hubiera revisado. Sirve para corregir un clic equivocado. Queda anotado en el registro de decisiones.
    const b = await req.json().catch(() => ({}));
    const es = (await env.DB.prepare("SELECT hash, prov, estado FROM envios WHERE mesa_id = ?").bind(String(b.mesa_id || "")).all()).results;
    if (!es.length) return json({ error: "parametros" }, 400);
    const t = ahora(); const st = [];
    for (const e of es) if (e.estado !== "pendiente") st.push(env.DB.prepare("UPDATE envios SET estado = 'pendiente', motivo = NULL WHERE hash = ?").bind(e.hash));
    st.push(env.DB.prepare("INSERT INTO decisiones (ts, hash, mesa_id, decision, motivo) VALUES (?,?,?,?,?)").bind(t, "-", b.mesa_id, "reabierta", "Mesa reabierta para revisarla de nuevo: se deshacen las decisiones sobre sus fotos"));
    st.push(env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(b.mesa_id, es[0].prov, t));
    await env.DB.batch(st);
    return json({ ok: true, cambios: st.length - 2 });
  }
  if (p === "recalcular" && req.method === "POST") return json(await recalcular(env));
  if (p === "aceptar_licencia_ia" && req.method === "POST") {
    // Meta exige aceptar su licencia la primera vez que se usa el modelo de visión en la cuenta.
    if (!env.AI) return json({ error: "sin_ia" }, 400);
    const r = await env.AI.run(env.MODELO_IA || MODELO_IA, { prompt: "agree" }).catch(e => ({ error: String(e) }));
    return json({ ok: true, respuesta: r });
  }
  if (p === "rellenar_demo" && req.method === "POST") {
    // Inventa actas para una provincia, para ver la web con datos. Solo funciona con MODO_PRUEBAS = "1".
    if (env.MODO_PRUEBAS !== "1") return json({ error: "solo_en_modo_pruebas" }, 403);
    const b = await req.json().catch(() => ({})); if (b.confirmar !== "RELLENAR") return json({ error: "falta_confirmacion" }, 400);
    if (!/^\d\d$/.test(String(b.prov || ""))) return json({ error: "provincia" }, 400);
    return json(await rellenarDemo(env, String(b.prov), Math.min(0.5, Math.max(0.01, Number(b.fraccion) || 0.1))));
  }
  if (p === "apuntados_demo" && req.method === "POST") {
    // Inventa personas apuntadas a colegios de una provincia (para ver «Me apunto» con datos). Solo en MODO_PRUEBAS = "1".
    if (env.MODO_PRUEBAS !== "1") return json({ error: "solo_en_modo_pruebas" }, 403);
    const b = await req.json().catch(() => ({})); if (b.confirmar !== "RELLENAR") return json({ error: "falta_confirmacion" }, 400);
    if (!/^\d\d$/.test(String(b.prov || ""))) return json({ error: "provincia" }, 400);
    const r = await apuntadosDemo(env, String(b.prov), Math.min(0.9, Math.max(0.01, Number(b.fraccion) || 0.3)));
    if (b.publicar) await publicarApuntados(env);
    return json(r);
  }
  if (p === "oficial" && req.method === "POST") {
    // Carga el dato oficial de Interior de una provincia (ya convertido con scripts/oficial_desde_interior.py o con el
    // lector de la noche electoral). Sustituye entero al que hubiera de esa provincia. La web lo compara con las actas.
    const b = await req.json().catch(() => ({}));
    if (!/^\d\d$/.test(String(b.prov || ""))) return json({ error: "provincia" }, 400);
    const limpio = limpiarOficial(String(b.prov), b.datos);
    if (limpio.error) return json(limpio, 400);
    await env.FOTOS.put(`public/oficial/${b.prov}.json`, JSON.stringify(limpio), { httpMetadata: { contentType: "application/json" } });
    return json({ ok: true, municipios: Object.keys(limpio.municipios).length, mesas: Object.keys(limpio.mesas).length });
  }
  if (p === "oficial_demo" && req.method === "POST") {
    // Inventa un «dato oficial» a partir de las actas verificadas, con algunas diferencias, para ver la comparación. Solo en pruebas.
    if (env.MODO_PRUEBAS !== "1") return json({ error: "solo_en_modo_pruebas" }, 403);
    const b = await req.json().catch(() => ({}));
    if (!/^\d\d$/.test(String(b.prov || "")) || !["municipio", "mesa"].includes(b.nivel)) return json({ error: "parametros" }, 400);
    const datos = await oficialDemo(env, String(b.prov), b.nivel);
    await env.FOTOS.put(`public/oficial/${b.prov}.json`, JSON.stringify(datos), { httpMetadata: { contentType: "application/json" } });
    return json({ ok: true, municipios: Object.keys(datos.municipios).length, mesas: Object.keys(datos.mesas).length });
  }
  if (p === "vaciar_pruebas" && req.method === "POST") {
    // Borra todos los envíos, fotos y JSON públicos de las pruebas. Solo funciona con MODO_PRUEBAS = "1".
    if (env.MODO_PRUEBAS !== "1") return json({ error: "solo_en_modo_pruebas" }, 403);
    const b = await req.json().catch(() => ({})); if (b.confirmar !== "VACIAR") return json({ error: "falta_confirmacion" }, 400);
    await asegurarTablasApuntados(env);
    await env.DB.batch(["DELETE FROM envios", "DELETE FROM denuncias", "DELETE FROM lecturas", "DELETE FROM contador", "DELETE FROM consenso", "DELETE FROM pendientes", "DELETE FROM decisiones", "DELETE FROM mesas WHERE de_usuario = 1",
      "DELETE FROM apuntados", "DELETE FROM apuntados_cambios", "DELETE FROM intentos_cancelar"].map(q => env.DB.prepare(q)));
    let borrados = 0;
    for (const prefix of ["foto/", "mini/", "public/"]) {
      let cursor;
      do { const l = await env.FOTOS.list({ prefix, cursor, limit: 1000 }); const keys = l.objects.map(o => o.key);
           if (keys.length) { await env.FOTOS.delete(keys); borrados += keys.length; } cursor = l.truncated ? l.cursor : undefined; } while (cursor);
    }
    await publicarResumen(env); await publicarDecisiones(env); await publicarApuntados(env);
    return json({ ok: true, objetos_borrados: borrados });
  }
  if (p === "estadisticas" && req.method === "GET") {
    await asegurarTablasApuntados(env);
    const [a, b, c, dd, ee, ap] = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS envios, COUNT(DISTINCT mesa_id) AS mesas, MAX(ts) AS ultimo FROM envios"),
      env.DB.prepare("SELECT estado, COUNT(*) AS n FROM consenso GROUP BY estado"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM pendientes"),
      env.DB.prepare("SELECT SUM(ia_estado IN ('pendiente','forzada','leyendo')) AS n, SUM(ia_estado = 'en_espera') AS espera, SUM(ia_estado IN ('error','omitida')) AS sin_leer FROM envios"),
      env.DB.prepare("SELECT COALESCE(MAX(n), 0) AS n FROM contador WHERE clave = 'lecturas_ia'"),
      env.DB.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT colegio) AS colegios FROM apuntados WHERE cancelado IS NULL"),
    ]);
    return json({ ...a.results[0], estados: b.results, pendientes_recalculo: c.results[0].n, lecturas_pendientes: dd.results[0].n || 0, fotos_en_espera: dd.results[0].espera || 0, fotos_no_leidas: dd.results[0].sin_leer || 0, lecturas_ia: ee.results[0].n, tope_lecturas_ia: Number(env.MAX_LECTURAS_IA || 100000),
      apuntados: ap.results[0].n, colegios_con_apuntados: ap.results[0].colegios, clave_ip_ok: !!env.SAL_IP && env.SAL_IP.length >= 12 });
  }
  return json({ error: "no_encontrado" }, 404);
}
// ---------------------------------------------------------------- dato oficial de Interior
// Formato (uno por provincia, en R2: public/oficial/PP.json):
//   { prov, tipo: "provisional" | "definitivo", fuente, actualizado,
//     municipios: { "079": { escrutado, votantes, nulos, blanco, cand: { C02: 123, ... } } },
//     mesas:      { "28-079-01-001-A": { votantes, nulos, blanco, cand: {...} } } }
// Los códigos de candidatura son los de la web (C01, C02…). Si una candidatura oficial no se ha podido emparejar,
// va con su sigla precedida de «?». «escrutado» es el porcentaje de mesas escrutadas del municipio (0 a 100).
const entero = (v) => v == null ? null : (Number.isInteger(v) && v >= 0 && v < 10_000_000 ? v : undefined);
function cifrasOficiales(x) {
  if (!x || typeof x !== "object") return null;
  const r = { votantes: entero(x.votantes), nulos: entero(x.nulos), blanco: entero(x.blanco), cand: {} };
  if ([r.votantes, r.nulos, r.blanco].includes(undefined)) return null;
  if (x.escrutado != null) { const e = Number(x.escrutado); if (!(e >= 0 && e <= 100)) return null; r.escrutado = e; }
  for (const [k, v] of Object.entries(x.cand || {})) {
    if (!/^[^<>"&]{1,60}$/.test(k)) return null; const n = entero(v); if (n == null) return null; r.cand[k] = n;
  }
  return r;
}
function limpiarOficial(prov, d) {
  if (!d || typeof d !== "object") return { error: "datos" };
  if (!["provisional", "definitivo"].includes(d.tipo)) return { error: "tipo" };
  const out = { prov, tipo: d.tipo, fuente: String(d.fuente || "Ministerio del Interior").slice(0, 200), actualizado: String(d.actualizado || new Date().toISOString()).slice(0, 40), municipios: {}, mesas: {} };
  for (const [k, v] of Object.entries(d.municipios || {})) { if (!/^\d{3}$/.test(k)) return { error: "municipio", clave: k }; const c = cifrasOficiales(v); if (!c) return { error: "cifras", clave: k }; out.municipios[k] = c; }
  for (const [k, v] of Object.entries(d.mesas || {})) { if (!RE_MESA.test(k) || k.slice(0, 2) !== prov) return { error: "mesa", clave: k }; const c = cifrasOficiales(v); if (!c) return { error: "cifras", clave: k }; out.mesas[k] = c; }
  return out;
}
async function oficialDemo(env, prov, nivel) {
  // Copia las cifras de las mesas verificadas y cambia unas pocas (unos votos de una candidatura a otra, o votos de más),
  // para que en pruebas se vean tanto coincidencias como diferencias.
  const rs = (await env.DB.prepare("SELECT mesa_id, cifras FROM consenso WHERE prov = ? AND estado IN ('verificada','validada') AND cifras IS NOT NULL").bind(prov).all()).results;
  const total = new Map((await env.DB.prepare("SELECT muni, COUNT(*) AS n FROM mesas WHERE prov = ? AND COALESCE(de_usuario, 0) = 0 GROUP BY muni").bind(prov).all()).results.map(r => [r.muni, r.n]));
  const mesas = {};
  for (const r of rs) {
    const c = JSON.parse(r.cifras); const o = { votantes: c.votantes, nulos: c.nulos, blanco: c.blanco, cand: { ...c.cand } };
    const ks = Object.keys(o.cand); const azar = Math.random();
    if (ks.length >= 2 && azar < 0.06) { const [a, b] = [ks[Math.floor(Math.random() * ks.length)], ks[Math.floor(Math.random() * ks.length)]]; const k = Math.min(o.cand[b] || 0, 1 + Math.floor(Math.random() * 12)); if (a !== b && k) { o.cand[a] += k; o.cand[b] -= k; } }
    else if (ks.length && azar < 0.09) { const a = ks[Math.floor(Math.random() * ks.length)]; const k = 1 + Math.floor(Math.random() * 5); o.cand[a] += k; o.votantes += k; }
    mesas[r.mesa_id] = o;
  }
  const municipios = {};
  if (nivel === "municipio") {
    const por = {}; for (const [id, o] of Object.entries(mesas)) (por[id.split("-")[1]] = por[id.split("-")[1]] || []).push(o);
    for (const [k, lista] of Object.entries(por)) {
      const s = { escrutado: 100, votantes: 0, nulos: 0, blanco: 0, cand: {} };
      for (const o of lista) { s.votantes += o.votantes || 0; s.nulos += o.nulos || 0; s.blanco += o.blanco || 0; for (const [c, v] of Object.entries(o.cand)) s.cand[c] = (s.cand[c] || 0) + (v || 0); }
      // Solo el municipio entero tiene sentido: si faltan mesas por verificar, su «escrutado» oficial seguiría siendo 100, pero aquí no se inventa.
      if (lista.length === (total.get(k) || 0)) municipios[k] = s;
    }
  }
  return { prov, tipo: nivel === "mesa" ? "definitivo" : "provisional", fuente: "DATOS INVENTADOS para la versión de pruebas", actualizado: new Date().toISOString(),
    municipios, mesas: nivel === "mesa" ? mesas : {} };
}
async function conEnvios(env, mesas) {
  if (!mesas.length) return [];
  const ids = mesas.map(m => m.mesa_id);
  const envs = (await env.DB.prepare(`SELECT hash, mesa_id, cifras, cuadra, errores, substr(dispositivo,1,8) AS disp, substr(ip_hash,1,8) AS red, geo_ok, geo_dist, ts_foto, ts, estado, motivo, flags, publica, denuncias, firma, ia, ia_estado FROM envios WHERE mesa_id IN (${ids.map(() => "?").join(",")}) ORDER BY ts`).bind(...ids).all()).results;
  const provs = [...new Set(mesas.map(m => m.prov))];
  const cands = (await env.DB.prepare(`SELECT prov, codigo, siglas, orden FROM candidaturas WHERE prov IN (${provs.map(() => "?").join(",")}) ORDER BY orden`).bind(...provs).all()).results;
  return mesas.map(m => ({ ...m, cifras: m.cifras ? JSON.parse(m.cifras) : null, candidaturas: cands.filter(c => c.prov === m.prov),
    envios: envs.filter(e => e.mesa_id === m.mesa_id).map(e => ({ ...e, cifras: JSON.parse(e.cifras), errores: JSON.parse(e.errores || "[]"), flags: JSON.parse(e.flags || "[]"), ia: e.ia ? JSON.parse(e.ia) : null })) }));
}
async function igualSeguro(a, b) {
  const [x, y] = await Promise.all([sha256hex(new TextEncoder().encode(a)), sha256hex(new TextEncoder().encode(b))]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i); return d === 0;
}

// ---------------------------------------------------------------- Cloudflare Access (verificación del JWT)
let CERTS = null, CERTS_TS = 0;
function b64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function accesoValido(req, env) {
  const jwt = req.headers.get("cf-access-jwt-assertion"); if (!jwt) return false;
  const partes = jwt.split("."); if (partes.length !== 3) return false;
  let cab, cuerpo; try { cab = JSON.parse(new TextDecoder().decode(b64url(partes[0]))); cuerpo = JSON.parse(new TextDecoder().decode(b64url(partes[1]))); } catch { return false; }
  const equipo = `https://${env.ACCESS_TEAM}.cloudflareaccess.com`;
  if (cab.alg !== "RS256" || cuerpo.iss !== equipo) return false;
  const aud = Array.isArray(cuerpo.aud) ? cuerpo.aud : [cuerpo.aud]; if (!aud.includes(env.ACCESS_AUD)) return false;
  const t = Math.floor(Date.now() / 1000); if (!cuerpo.exp || cuerpo.exp < t || (cuerpo.nbf && cuerpo.nbf > t + 60)) return false;
  if (env.ACCESS_EMAIL && String(cuerpo.email || "").toLowerCase() !== env.ACCESS_EMAIL.toLowerCase()) return false;
  if (!CERTS || Date.now() - CERTS_TS > 3600000) { const r = await fetch(`${equipo}/cdn-cgi/access/certs`); if (!r.ok) return false; CERTS = (await r.json()).keys || []; CERTS_TS = Date.now(); }
  const jwk = CERTS.find(k => k.kid === cab.kid); if (!jwk) { CERTS = null; return false; }
  const clave = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", clave, b64url(partes[2]), new TextEncoder().encode(partes[0] + "." + partes[1]));
}

// ---------------------------------------------------------------- lectura automática del acta (Workers AI)
// Lee la foto con un modelo de visión y devuelve las cifras en los mismos campos que el formulario.
// Se usa para dos cosas: marcar en amarillo lo que la persona ha escrito distinto de lo que se ve en la foto,
// y avisarte en el panel cuando unas cifras no parecen coincidir con su foto. También detecta lo que no es un acta.
export function flagsLectura(l) {
  const f = [];
  if (l && l.es_acta === false) f.push("ia_no_acta");
  if (l && l.inapropiada === true) f.push("ia_inapropiada");
  return f;
}
// Fiabilidad de cada cifra: el acta trae cada número dos veces, «en letra» y «en número». Si las dos lecturas
// coinciden, la cifra es fiable (alta); si solo se lee una, media; si no coinciden, baja.
// (Los modelos de visión no dan un porcentaje de confianza fiable, así que no se inventa ninguno.)
// Modelos de visión que se pueden probar desde la versión de pruebas (el de la pública se fija con MODELO_IA)
const MODELOS_IA = ["@cf/meta/llama-3.2-11b-vision-instruct", "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/google/gemma-3-12b-it"];
// Versión de la forma de leer. Las lecturas guardadas con otra versión no se reutilizan en el formulario (se vuelve a leer).
const LECTURA_VERSION = 3;

// Cifra escrita con letras («treinta y uno», «trenta-u», «trinta e un»...) convertida a número. Entiende castellano,
// valenciano/catalán y gallego, que son las lenguas de las actas bilingües más habituales. Si no la entiende, null.
const PALABRAS_NUM = (() => {
  const m = {};
  const pon = (v, ...ps) => ps.forEach(p => { m[p] = v; });
  pon(0, "cero", "zero"); pon(1, "uno", "un", "una", "u", "unha"); pon(2, "dos", "dues", "dous", "duas"); pon(3, "tres");
  pon(4, "cuatro", "quatre", "catro"); pon(5, "cinco", "cinc"); pon(6, "seis", "sis"); pon(7, "siete", "set", "sete");
  pon(8, "ocho", "vuit", "huit", "oito"); pon(9, "nueve", "nou", "nove"); pon(10, "diez", "deu", "dez"); pon(11, "once", "onze");
  pon(12, "doce", "dotze"); pon(13, "trece", "tretze"); pon(14, "catorce", "catorze"); pon(15, "quince", "quinze");
  pon(16, "dieciseis", "setze", "dezaseis"); pon(17, "diecisiete", "disset", "desset", "dezasete");
  pon(18, "dieciocho", "divuit", "dihuit", "dezaoito"); pon(19, "diecinueve", "dinou", "denou", "dezanove");
  pon(20, "veinte", "vint", "vinte"); pon(30, "treinta", "trenta", "trinta"); pon(40, "cuarenta", "quaranta", "corenta");
  pon(50, "cincuenta", "cinquanta"); pon(60, "sesenta", "seixanta"); pon(70, "setenta", "setanta");
  pon(80, "ochenta", "vuitanta", "huitanta", "oitenta"); pon(90, "noventa", "noranta");
  pon(100, "cien", "ciento", "cent", "cents", "cen", "cento");
  pon(200, "doscientos", "doscientas", "douscentos", "duascentas"); pon(300, "trescientos", "trescientas", "trescentos", "trescentas");
  pon(400, "cuatrocientos", "cuatrocientas", "catrocentos", "catrocentas"); pon(500, "quinientos", "quinientas", "cincocentos", "cincocentas");
  pon(600, "seiscientos", "seiscientas", "seiscentos", "seiscentas"); pon(700, "setecientos", "setecientas", "setecentos", "setecentas");
  pon(800, "ochocientos", "ochocientas", "oitocentos", "oitocentas"); pon(900, "novecientos", "novecientas", "novecentos", "novecentas");
  ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"].forEach((u, i) => { m["veinti" + u] = 21 + i; });
  m.veintiun = 21; m.veintiuna = 21;
  return m;
})();
export function letraANumero(t) {
  if (typeof t !== "string") return null;
  const p = t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]+/g, " ").trim().split(" ").filter(x => x && !["y", "i", "e"].includes(x));
  if (!p.length) return null;
  let total = 0, actual = 0;
  for (const w of p) {
    if (w === "mil") { total += (actual || 1) * 1000; actual = 0; continue; }
    // «dos-cents», «tres-centes» (catalán): unidad seguida de «cents/centes»
    if ((w === "cents" || w === "centes") && actual > 0 && actual < 10) { actual *= 100; continue; }
    const v = PALABRAS_NUM[w]; if (v === undefined) return null;
    actual += v;
  }
  return total + actual;
}
async function leerConIA(env, fotoBuf, prov, modeloPedido) {
  const modelo = modeloPedido || env.MODELO_IA || MODELO_IA;
  const cands = (await env.DB.prepare("SELECT codigo, siglas, denominacion FROM candidaturas WHERE prov = ? ORDER BY orden").bind(prov).all()).results;
  const lista = cands.map((c, i) => `${i + 1}. ${c.denominacion || c.siglas} (${c.siglas})`).join("\n");
  const prompt = `Esta imagen debería ser la foto de un ACTA DE ESCRUTINIO de unas elecciones españolas: un impreso con unas casillas
de totales arriba y una tabla de candidaturas con los votos rellenados a mano.
Cada cifra puede aparecer dos veces: escrita con palabras (columna «En letra») y con números (columna «En número», a la derecha).
Responde SOLO con un objeto JSON válido, sin texto adicional ni explicaciones, con esta forma exacta:
{"es_acta": true, "inapropiada": false, "electores": [N, "L"], "votantes": [N, "L"], "nulos": [N, "L"], "blanco": [N, "L"], "votos": [[F, N, "L"], ...]}
- N: la cifra escrita con números, como número entero. Lee todos sus dígitos: 20 no es 2, 30 no es 3 ni 0.
- "L": copia LITERALMENTE las palabras escritas en la casilla «En letra», entre comillas (por ejemplo "treinta y uno").
  No conviertas las palabras a número. Si esa casilla está vacía o no se lee, pon null. Nunca copies ahí la cifra en número.
- Usa null cuando una casilla esté vacía o no se lea.
- es_acta: false si la imagen no es un acta de escrutinio. inapropiada: true si contiene desnudos, contenido sexual, violencia u otra cosa ofensiva.
- electores: «Total electores (1+2)»; si esa casilla está vacía, el número de electores según las listas del censo (casilla 1). votantes: «Total votantes (A+B)», la suma de A y B, no solo A.
  nulos y blanco: votos nulos y votos en blanco (casillas de arriba a la derecha).
- votos: un trío [F, N, "L"] por cada fila de la tabla de candidaturas que tenga algo escrito, donde F es el número de
  fila impreso a la izquierda (1, 2, 3...). Comprueba que cada cifra va con el número de su fila: si una fila está vacía,
  la siguiente sigue llevando su propio número. No repitas filas.
  Como referencia, las ${cands.length} candidaturas de esta provincia, en el orden de las filas, son:
${lista}`;
  const datosFoto = "data:image/jpeg;base64," + aBase64(fotoBuf);
  const sistema = { role: "system", content: "Lees actas electorales españolas y respondes solo con JSON." };
  // Llama 3.2 recibe la imagen aparte; el resto de modelos, dentro del mensaje (formato de chat con imagen)
  const entrada = modelo.includes("llama-3.2")
    ? { messages: [sistema, { role: "user", content: prompt }], image: datosFoto }
    : { messages: [sistema, { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: datosFoto } }] }] };
  let r;
  try { r = iaSimulada(env) ? iaDePrueba(fotoBuf) : await env.AI.run(modelo, { ...entrada, max_tokens: 1000, temperature: 0 }); }
  catch (e) { const err = new Error("ia_no_disponible: " + String(e && e.message || e).slice(0, 300)); err.sinCoste = true; throw err; }
  // En pruebas locales, una foto con el comentario {"_falla": true} simula que el servicio está saturado
  if (iaSimulada(env) && /"_falla":\s*true/.test(String(r && r.response))) { const err = new Error("ia_no_disponible: simulado"); err.sinCoste = true; throw err; }
  // …y con {"_rota": true}, que el modelo contesta algo que no se puede leer (eso sí se cobra y cuenta como intento)
  if (iaSimulada(env) && /"_rota":\s*true/.test(String(r && r.response))) r = { response: "respuesta sin datos" };
  const o = jsonDeRespuesta(r && (r.response ?? r.result?.response ?? r.choices?.[0]?.message?.content));
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : (typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : null));
  // Fiabilidad: «alta» solo si la cifra en número coincide con las PALABRAS de la casilla «En letra», que convierte el
  // servidor (el modelo solo las copia). Si la letra falta, no se entiende o el modelo devuelve otra vez un número
  // (se lo puede haber inventado copiando la cifra), «media». Si letra y número no coinciden, «baja».
  const fiab = {};
  const leer = (clave, v) => {
    const [num, letraTxt] = Array.isArray(v) ? [n(v[0]), v[1]] : [n(v), null];
    const letra = typeof letraTxt === "string" && !/\d/.test(letraTxt) ? letraANumero(letraTxt) : null;
    if (num == null && letra == null) return null;
    fiab[clave] = num != null && letra != null ? (num === letra ? "alta" : "baja") : "media";
    return num != null ? num : letra;
  };
  // Cada voto llega como [fila, número, letra]; si el modelo no da la fila ([número, letra]), se toma el orden de la lista.
  // (Se probó a pedir también el nombre escrito en cada fila para no depender del orden, pero el modelo copiaba los
  // nombres de la lista de referencia en vez de leerlos, así que no servía.)
  const porCand = {}; const votos = Array.isArray(o.votos) ? o.votos : [];
  votos.forEach((v, i) => {
    if (Array.isArray(v) && v.length >= 3 && Number.isInteger(Number(v[0])) && Number(v[0]) >= 1) porCand[Number(v[0]) - 1] = [v[1], v[2]];
    else porCand[i] = v;
  });
  const cand = {}; cands.forEach((c, i) => { cand[c.codigo] = leer(c.codigo, porCand[i] ?? null); });
  // Control de cuadre: si lo leído no suma (candidaturas + blanco + nulos = votantes), alguna cifra o alguna fila está mal
  // leída, aunque no se sepa cuál. Entonces ninguna candidatura se da por fiable (no se pone nada en amarillo por ellas).
  const vot = leer("_v", o.votantes), bl = leer("_b", o.blanco), nu = leer("_n", o.nulos); delete fiab._v; delete fiab._b; delete fiab._n;
  const sumaCand = Object.values(cand).reduce((a, x) => a + (x || 0), 0);
  const noCuadra = vot == null || sumaCand + (bl || 0) + (nu || 0) !== vot;
  if (noCuadra) for (const c of cands) if (fiab[c.codigo] === "alta") fiab[c.codigo] = "media";
  const res = { v: LECTURA_VERSION, no_cuadra: noCuadra, es_acta: o.es_acta !== false, inapropiada: o.inapropiada === true, electores: leer("electores", o.electores), votantes: leer("votantes", o.votantes),
    nulos: leer("nulos", o.nulos), blanco: leer("blanco", o.blanco), cand, fiab, modelo };
  if (env.MODO_PRUEBAS === "1" && r && r.usage) res.uso = r.usage;   // tokens gastados, para calcular el coste en las pruebas
  if (env.MODO_PRUEBAS === "1") res.bruto = o;                         // respuesta del modelo tal cual, para ajustar la lectura
  return res;
}
// Saca el objeto JSON de la respuesta del modelo. Algunos modelos lo devuelven ya como objeto y otros como texto,
// a veces con texto alrededor o cortado al final (si se acaban los tokens); en ese caso se recorta a la última fila completa.
function jsonDeRespuesta(resp) {
  if (resp && typeof resp === "object") return resp;
  const txt = String(resp || "");
  const ini = txt.indexOf("{"); if (ini < 0) throw new Error("respuesta_ia_sin_json: " + txt.slice(0, 400));
  // Arreglos de errores típicos: la letra N en vez de null y cifras escritas con palabras sin comillas (se descartan)
  let t = txt.slice(ini).replace(/\bN\b/g, "null").replace(/([,\[]\s*)(?!null\b|true\b|false\b)[a-záéíóúüñ][a-záéíóúüñ ]*(?=\s*[,\]])/gi, "$1null");
  const fin = t.lastIndexOf("}");
  if (fin > 0) { try { return JSON.parse(t.slice(0, fin + 1)); } catch {} }
  const corte = t.lastIndexOf("]");   // respuesta cortada: se cierra la lista de votos y el objeto
  if (corte > 0) { try { return JSON.parse(t.slice(0, corte + 1).replace(/,\s*$/, "") + "]}"); } catch {} }
  throw new Error("respuesta_ia_json_roto: " + txt.slice(0, 400));
}
// Convierte los bytes de la foto a texto base64 (por trozos, para no desbordar la memoria con fotos grandes)
function aBase64(buf) {
  const bytes = new Uint8Array(buf); let txt = "";
  for (let i = 0; i < bytes.length; i += 0x8000) txt += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(txt);
}
// Tope de gasto: como máximo MAX_LECTURAS_IA lecturas en total (todo el día de las elecciones). Al llegar, se deja de leer:
// la web sigue funcionando igual, sin las sugerencias, y las fotos se publican con el filtro sin IA.
async function hayCupoIA(env) {
  const tope = Number(env.MAX_LECTURAS_IA || 100000);
  const r = await env.DB.prepare("INSERT INTO contador (clave, n) VALUES ('lecturas_ia', 1) ON CONFLICT(clave) DO UPDATE SET n = n + 1 WHERE n < ? RETURNING n").bind(tope).first();
  return !!r;
}
// Si el servicio de lectura no llega a leer la foto (por ejemplo, porque está saturado), no se cobra: se devuelve al contador,
// para que el tope cuente solo las lecturas hechas.
async function devolverCupoIA(env) {
  await env.DB.prepare("UPDATE contador SET n = n - 1 WHERE clave = 'lecturas_ia' AND n > 0").run();
}
// El formulario pide la lectura en cuanto la persona elige la foto (mientras copia las cifras).
async function leerParaFormulario(req, env) {
  if (!iaActiva(env)) return json({ error: "desactivada" }, 404);
  if (!abierto(env)) return json({ error: "cerrado" }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
  const ipHash = await huellaIP(env, ip);
  let form; try { form = await req.formData(); } catch { return json({ error: "formato" }, 400); }
  const foto = form.get("foto"); const prov = String(form.get("prov") || "");
  // Solo en la versión de pruebas: elegir otro modelo para compararlos (no se usa la caché ni se guarda la lectura)
  const modeloPrueba = env.MODO_PRUEBAS === "1" && MODELOS_IA.includes(String(form.get("modelo") || "")) ? String(form.get("modelo")) : null;
  if (!(foto instanceof File) || foto.size > 2_500_000 || foto.size < 5_000 || !/^\d{2}$/.test(prov)) return json({ error: "parametros" }, 400);
  const buf = await foto.arrayBuffer(); const hash = await sha256hex(buf);
  const guardada = await env.DB.prepare("SELECT lectura FROM lecturas WHERE hash = ?").bind(hash).first();
  // Una lectura hecha con una versión anterior de la lectura no se reutiliza: se vuelve a leer
  const ya = guardada && (() => { try { return JSON.parse(guardada.lectura).v === LECTURA_VERSION; } catch { return false; } })() ? guardada : null;
  const mesaId = String(form.get("mesa_id") || "").toUpperCase();
  if (!ya && mesaId) {
    const c = await env.DB.prepare("SELECT c.estado, (SELECT COUNT(*) FROM envios e WHERE e.mesa_id = c.mesa_id AND e.ia_estado = 'hecha' AND e.estado != 'invalida') AS n FROM consenso c WHERE c.mesa_id = ?").bind(mesaId).first();
    if (c && (c.estado === "verificada" || c.estado === "validada")) return json({ omitida: "mesa_verificada" });
  }
  if (ya && !modeloPrueba) return json({ hash, lectura: JSON.parse(ya.lectura) });
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM lecturas WHERE ip_hash = ? AND ts > ?").bind(ipHash, ahora() - 600000).first();
  if (n.n >= Number(env.MAX_LECTURAS_IP_10MIN || 300)) return json({ error: "demasiadas_lecturas" }, 429);
  if (!(await turnstileOK(env, form.get("turnstile"), ip))) return json({ error: "verificacion" }, 403);
  if (!(await hayCupoIA(env))) return json({ error: "tope_alcanzado" }, 429);
  // En la versión de pruebas se devuelve también el motivo del fallo, para poder ajustar la lectura; en la pública, no
  let lectura; try { lectura = await leerConIA(env, buf, prov, modeloPrueba); } catch (e) { console.error("IA", e); if (e.sinCoste) await devolverCupoIA(env); return json({ error: "lectura_fallida", ...(env.MODO_PRUEBAS === "1" ? { detalle: String(e && e.message || e).slice(0, 600) } : {}) }, 502); }
  if (modeloPrueba) return json({ hash, lectura });
  await env.DB.prepare("INSERT OR REPLACE INTO lecturas (hash, lectura, ip_hash, ts) VALUES (?,?,?,?)").bind(hash, JSON.stringify(lectura), ipHash, ahora()).run();
  return json({ hash, lectura });
}
// Lee una foto con la IA y guarda el resultado. Devuelve "hecha", "saturado", "fallo" u "otra" (ya la tenía otra tarea).
async function leerUnaFoto(env, e) {
  // Se reserva antes de leerla («leyendo»): si otra tarea coincide en el tiempo, se la salta y no se lee dos veces
  const reserva = await env.DB.prepare(`UPDATE envios SET ia_estado = 'leyendo', ia_ts = ?, ia_intentos = ia_intentos + 1
    WHERE hash = ? AND ia_estado IN ('pendiente','forzada','en_espera') RETURNING ia_intentos`).bind(ahora(), e.hash).first();
  if (!reserva) return "otra";
  const recalcular = env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(e.mesa_id, e.prov, ahora());
  try {
    const o = await env.FOTOS.get(`foto/${e.hash}.jpg`);
    if (!o) { await env.DB.prepare("UPDATE envios SET ia_estado = 'error' WHERE hash = ?").bind(e.hash).run(); return "fallo"; }
    if (!(await hayCupoIA(env))) { await env.DB.batch([env.DB.prepare("UPDATE envios SET ia_estado = 'omitida' WHERE hash = ?").bind(e.hash), recalcular]); return "fallo"; }
    let l; try { l = await leerConIA(env, await o.arrayBuffer(), e.prov); } catch (err) { if (err.sinCoste) await devolverCupoIA(env); throw err; }
    const flags = [...new Set([...JSON.parse(e.flags || "[]"), ...flagsLectura(l)])];
    await env.DB.batch([env.DB.prepare("UPDATE envios SET ia = ?, ia_estado = 'hecha', flags = ? WHERE hash = ?").bind(JSON.stringify(l), JSON.stringify(flags), e.hash), recalcular]);
    return "hecha";
  } catch (err) {
    console.error("IA cron", err);
    if (err.sinCoste) {   // servicio saturado: vuelve a la lista sin contar como intento
      await env.DB.prepare("UPDATE envios SET ia_estado = 'pendiente', ia_intentos = MAX(0, ia_intentos - 1) WHERE hash = ?").bind(e.hash).run();
      return "saturado";
    }
    const otraVez = reserva.ia_intentos < MAX_INTENTOS_IA;
    // si ya no se vuelve a intentar, se recalcula la mesa para que la foto aparezca en la cola de revisión manual
    await env.DB.batch([env.DB.prepare("UPDATE envios SET ia_estado = ? WHERE hash = ?").bind(otraVez ? "pendiente" : "error", e.hash), ...(otraVez ? [] : [recalcular])]);
    return "fallo";
  }
}
// El cron lee las fotos enviadas sin lectura previa (por ejemplo, de quien se salta la web). Hasta entonces no se publican.
// Va aparte del recálculo del mapa, así que una lectura lenta no retrasa los resultados.
async function leerPendientesIA(env) {
  // Solo se gasta en mesas que aún no están verificadas:
  //  - si la mesa ya está verificada o validada y tiene 2 fotos leídas de esa versión, las fotos nuevas quedan "en_espera" (sin leer ni publicar; las cifras
  //    cuentan igual) y se revisan a mano desde la cola "Fotos en espera" del panel;
  //  - si llega una foto con otras cifras, la mesa pasa a conflicto y entonces sí se leen sus fotos en espera;
  //  - antes de verificarse, como mucho FOTOS_LEIDAS_POR_VERSION fotos leídas con las mismas cifras (por si llegan muchas a la vez);
  //  - van primero las que se fuerzan desde el panel y después las de mesas verificadas (son las que se publicarían).
  // Se leen IA_PARALELO fotos a la vez (cada lectura empieza en cuanto termina otra), como mucho IA_POR_MINUTO por tarea y sin
  // empezar ninguna nueva pasados 50 s (la tarea siguiente, un minuto después, sigue por donde se quedó).
  // Si el servicio de lectura está saturado, la foto vuelve a la lista sin gastar ningún intento ni nada del tope, y quien
  // estaba leyendo espera unos segundos. Si el modelo contesta algo que no se puede leer, la foto se vuelve a intentar en las
  // tareas siguientes, hasta MAX_INTENTOS_IA veces; después queda para la revisión manual (cola «Fotos aún sin leer»).
  // Mientras tanto, las fotos de mesas verificadas también aparecen en esa cola, por si se quieren aprobar a mano.
  const t0 = ahora(); const N = Number(env.FOTOS_LEIDAS_POR_VERSION || 3);
  const porMinuto = Math.max(1, Number(env.IA_POR_MINUTO || 300)), paralelo = Math.max(1, Number(env.IA_PARALELO || 30));
  // Fotos que se quedaron a medio leer (la tarea se cortó): vuelven a la lista
  await env.DB.prepare("UPDATE envios SET ia_estado = 'pendiente' WHERE ia_estado = 'leyendo' AND ia_ts < ?").bind(t0 - 5 * 60 * 1000).run();
  const cand = (await env.DB.prepare(`SELECT e.hash, e.mesa_id, e.prov, e.flags, e.firma, e.ia_estado, c.estado AS mesa_estado FROM envios e LEFT JOIN consenso c ON c.mesa_id = e.mesa_id
    WHERE e.ia_estado IN ('pendiente','forzada') OR (e.ia_estado = 'en_espera' AND c.estado IN ('conflicto','revision'))
    ORDER BY (e.ia_estado = 'forzada') DESC, (c.estado IN ('verificada','validada')) DESC, (e.ia_estado = 'en_espera') DESC, e.ts LIMIT ?`).bind(porMinuto).all()).results;
  const mesas = [...new Set(cand.map(e => e.mesa_id))]; const leidas = new Map();
  for (let i = 0; i < mesas.length; i += 90) {
    const ids = mesas.slice(i, i + 90);
    const r = (await env.DB.prepare(`SELECT mesa_id, firma, COUNT(*) AS n FROM envios WHERE ia_estado = 'hecha' AND estado != 'invalida' AND mesa_id IN (${ids.map(() => "?").join(",")}) GROUP BY mesa_id, firma`).bind(...ids).all()).results;
    for (const x of r) leidas.set(x.mesa_id + "|" + x.firma, x.n);
  }
  const pend = [], espera = [];
  for (const e of cand) { const k = e.mesa_id + "|" + e.firma, n = leidas.get(k) || 0;
    const verificada = e.mesa_estado === "verificada" || e.mesa_estado === "validada";
    if (e.ia_estado === "forzada") { pend.push(e); continue; }
    // en mesas verificadas se leen igualmente las 2 primeras fotos de cada versión (las que se publican); el resto espera
    if ((verificada && n >= 2) || n >= N) { if (e.ia_estado !== "en_espera") espera.push(e.hash); } else { pend.push(e); leidas.set(k, n + 1); } }
  for (let i = 0; i < espera.length; i += 90) { const h = espera.slice(i, i + 90);
    await env.DB.prepare(`UPDATE envios SET ia_estado = 'en_espera' WHERE hash IN (${h.map(() => "?").join(",")}) AND ia_estado = 'pendiente'`).bind(...h).run(); }
  let siguiente = 0;
  const lector = async () => {
    while (siguiente < pend.length && ahora() - t0 < 50000) {
      const resultado = await leerUnaFoto(env, pend[siguiente++]);
      if (resultado === "saturado") await new Promise(listo => setTimeout(listo, 3000));
    }
  };
  await Promise.all(Array.from({ length: Math.min(paralelo, pend.length) }, lector));
}
