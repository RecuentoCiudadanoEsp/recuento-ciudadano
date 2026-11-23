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
const MODELO_IA = "@cf/meta/llama-3.2-11b-vision-instruct";
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
      let m;
      if ((m = url.pathname.match(/^\/api\/(foto|mini)\/([a-f0-9]{64})\.jpg$/))) return await servirFoto(req, env, ctx, m[1], m[2]);
      if ((m = url.pathname.match(/^\/api\/public\/(resumen|decisiones|prov\/\d{2})\.json$/))) return await servirPublico(req, env, ctx, m[1]);
      return json({ error: "no_encontrado" }, 404);
    } catch (e) {
      console.error(e && e.stack || e);
      return json({ error: "error_interno" }, 500);
    }
  },
  async scheduled(evt, env, ctx) {
    ctx.waitUntil((async () => { if (iaActiva(env)) await leerPendientesIA(env); await recalcular(env); })());
  },
};

// ---------------------------------------------------------------- utilidades
function json(obj, status = 200, extra = {}) { return new Response(JSON.stringify(obj), { status, headers: { ...JSONH, ...extra } }); }
async function sha256hex(buf) { const d = await crypto.subtle.digest("SHA-256", buf); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
const num = (v) => Number.isInteger(v) && v >= 0;
function distanciaM(a, b, c, d) { const R = 6371000, r = Math.PI / 180; const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
const ahora = () => Date.now();
function config(env) {
  let zonas = []; try { zonas = JSON.parse(env.ZONAS_DIFUMINADO || "[]"); } catch {}
  return { nombre: env.NOMBRE || "Recuento Ciudadano", abre: env.ABRE, totales_desde: env.TOTALES_DESDE || env.ABRE,
    turnstile_sitekey: env.TURNSTILE_SITEKEY || "", zonas_difuminado: zonas, modo_pruebas: env.MODO_PRUEBAS === "1", lectura_ia: iaActiva(env) };
}
const abierto = (env) => env.MODO_PRUEBAS === "1" || ahora() >= Date.parse(env.ABRE);

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

async function turnstileOK(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true; // sin configurar (desarrollo)
  if (!token) return false;
  const f = new FormData(); f.append("secret", env.TURNSTILE_SECRET); f.append("response", token); if (ip) f.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: f });
  const d = await r.json().catch(() => ({}));
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

  if (!(await turnstileOK(env, form.get("turnstile"), ip))) return json({ error: "verificacion", mensaje: "No se ha podido verificar que no eres un robot. Recarga la página." }, 403);

  const fotoBuf = await foto.arrayBuffer(); const miniBuf = await mini.arrayBuffer();
  const u8 = new Uint8Array(fotoBuf); if (u8[0] !== 0xff || u8[1] !== 0xd8) return json({ error: "formato_foto" }, 400);
  const hash = await sha256hex(fotoBuf);
  if (d.hash && d.hash !== hash) return json({ error: "huella_distinta" }, 400);

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
  if (!val.ok) return json({ error: "no_cuadra", detalle: val.errores, mensaje: "Las cuentas del acta no cuadran. Revisa las cifras copiadas." }, 400);

  // Comprobaciones de la imagen (foto grande y miniatura): zona de nombres tapada y aspecto de documento
  let zonas = []; try { zonas = JSON.parse(env.ZONAS_DIFUMINADO || "[]"); } catch {}
  const anaFoto = analizarJPEG(fotoBuf, zonas), anaMini = analizarJPEG(miniBuf, zonas);
  if (!anaFoto.ok || !anaMini.ok) return json({ error: "formato_foto" }, 400);
  const avisosFoto = [...new Set([...avisosImagen(anaFoto), ...avisosImagen(anaMini)])];

  const t = ahora(); const desde = t - 10 * 60 * 1000;
  const ipHash = (await sha256hex(new TextEncoder().encode((env.SAL_IP || "sal") + ip))).slice(0, 32);
  const disp = String(d.dispositivo || "").slice(0, 64) || "sin-id";
  const [dup, nIp, nDisp, mesasDisp, mesasRed, reuso] = await env.DB.batch([
    env.DB.prepare("SELECT 1 AS x FROM envios WHERE hash = ?").bind(hash),
    env.DB.prepare("SELECT COUNT(*) AS n FROM envios WHERE ip_hash = ? AND ts > ?").bind(ipHash, desde),
    env.DB.prepare("SELECT COUNT(*) AS n FROM envios WHERE dispositivo = ? AND ts > ?").bind(disp, desde),
    env.DB.prepare("SELECT COUNT(DISTINCT mesa_id) AS n FROM envios WHERE dispositivo = ? AND ts > ?").bind(disp, t - 30 * 60 * 1000),
    env.DB.prepare("SELECT COUNT(DISTINCT mesa_id) AS n FROM envios WHERE ip_hash = ? AND ts > ?").bind(ipHash, t - 60 * 60 * 1000),
    env.DB.prepare("SELECT COUNT(*) AS n FROM envios WHERE dhash = ? AND mesa_id <> ?").bind(String(d.dhash || "-"), mesa.id),
  ]);
  if (dup.results.length) return json({ error: "duplicada", mensaje: "Esta foto ya se había enviado.", mesa_id: mesa.id }, 409);
  if (nIp.results[0].n >= Number(env.MAX_ENVIOS_IP_10MIN || 300) || nDisp.results[0].n >= Number(env.MAX_ENVIOS_DISPOSITIVO_10MIN || 10))
    return json({ error: "demasiados_envios", mensaje: "Demasiados envíos seguidos. Espera unos minutos." }, 429);

  const flags = [...val.avisos, ...avisosFoto];
  if (mesa.nueva) flags.push("mesa_nueva");
  if (mesasDisp.results[0].n >= 4) flags.push("muchas_mesas");
  // Muchas IP son compartidas (las operadoras móviles agrupan a miles de clientes): esto no bloquea ni excluye,
  // solo impide que varios "dispositivos" detrás de una misma red muy activa cuenten como fuentes independientes.
  if (mesasRed.results[0].n >= Number(env.MAX_MESAS_RED_HORA || 8)) flags.push("red_muchas_mesas");
  if (d.dhash && reuso.results[0].n > 0) flags.push("foto_reutilizada");
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
  const hit = await cache.match(clave); if (hit) return hit;
  const res = await producir(); if (!res.ok) return res;
  const r = new Response(res.body, res); r.headers.set("cache-control", `public, max-age=${segundos}`);
  ctx.waitUntil(cache.put(clave, r.clone())); return r;
}
// Una foto solo se sirve al público si es "publica" (mesa verificada por fuentes independientes o validada a mano).
// Caché corta (5 min): si se oculta una foto, deja de verse en minutos en todo el mundo.
async function servirFoto(req, env, ctx, tipo, hash) {
  return conCache(req, ctx, 300, async () => {
    const e = await env.DB.prepare("SELECT publica FROM envios WHERE hash = ?").bind(hash).first();
    if (!e || e.publica !== 1) return json({ error: "no_publica" }, 404);
    const o = await env.FOTOS.get(`${tipo}/${hash}.jpg`); if (!o) return json({ error: "no_encontrada" }, 404);
    return new Response(o.body, { headers: { "content-type": "image/jpeg" } });
  });
}
async function servirFotoAdmin(env, tipo, hash) {
  const o = await env.FOTOS.get(`${tipo}/${hash}.jpg`); if (!o) return json({ error: "no_encontrada" }, 404);
  return new Response(o.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } });
}

// ---------------------------------------------------------------- denuncias
// Cualquiera puede denunciar una foto publicada. Con DENUNCIAS_OCULTAR redes distintas, se oculta sola
// y pasa a la cola "Fotos sospechosas" del panel. Una foto aprobada en el panel ya no se oculta por denuncias.
async function recibirDenuncia(req, env) {
  const b = await req.json().catch(() => ({}));
  if (!/^[a-f0-9]{64}$/.test(b.hash || "")) return json({ error: "parametros" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
  const ipHash = await sha256hex(new TextEncoder().encode((env.SAL_IP || "") + ip));
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
async function servirPublico(req, env, ctx, nombre) {
  return conCache(req, ctx, env.MODO_PRUEBAS === "1" ? 1 : 30, async () => {
    const o = await env.FOTOS.get(`public/${nombre}.json`);
    if (!o) return json(nombre === "resumen" ? { generado: null, provincias: [], nacional: null } : nombre === "decisiones" ? { decisiones: [] } : { mesas: [] }, 200);
    return new Response(o.body, { headers: JSONH });
  });
}

// ---------------------------------------------------------------- consenso
export function calcularConsenso(envios, umbralDenuncias = 2) {
  const visibles = envios.filter(e => e.estado !== "invalida");
  if (!envios.length) return null;
  const validadas = visibles.filter(e => e.estado === "valida").sort((a, b) => b.ts - a.ts);
  // Fotos públicas: las validadas a mano y, en mesas verificadas, las del grupo coincidente sin denuncias suficientes.
  const sinDenuncia = (e) => { const fl = JSON.parse(e.flags || "[]");
    if (fl.includes("foto_aprobada")) return true; // revisada en el panel: se publica aunque tenga avisos o denuncias
    return (e.denuncias || 0) < umbralDenuncias && !["pendiente", "en_espera", "forzada"].includes(e.ia_estado) && !fl.some(f => CUARENTENA.includes(f)); };
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
  for (const prov of provs) await publicarProvincia(env, prov);
  if (provs.size || !(await env.FOTOS.head("public/resumen.json"))) { await publicarResumen(env); await publicarDecisiones(env); }
  return { mesas: pend.length, provincias: [...provs], ms: ahora() - t0 };
}

async function publicarProvincia(env, prov) {
  const [cons, envs, cands] = await env.DB.batch([
    env.DB.prepare("SELECT c.mesa_id, c.estado, c.cifras, c.n_envios, c.n_indep, m.municipio, m.censo, m.local, m.nueva FROM consenso c JOIN mesas m ON m.id = c.mesa_id WHERE c.prov = ?").bind(prov),
    env.DB.prepare("SELECT hash, mesa_id, cifras, cuadra, geo_ok, ts, estado, motivo, flags, publica, denuncias FROM envios WHERE prov = ? ORDER BY ts").bind(prov),
    env.DB.prepare("SELECT codigo, siglas, orden FROM candidaturas WHERE prov = ? ORDER BY orden").bind(prov),
  ]);
  const porMesa = new Map(); for (const e of envs.results) { if (!porMesa.has(e.mesa_id)) porMesa.set(e.mesa_id, []);
    porMesa.get(e.mesa_id).push({ h: e.hash, c: JSON.parse(e.cifras), ok: e.cuadra, geo: e.geo_ok, ts: e.ts, est: e.estado, mot: e.motivo, f: JSON.parse(e.flags || "[]"), pub: e.publica, den: e.denuncias >= Number(env.DENUNCIAS_OCULTAR || 2) && !String(e.flags).includes("foto_aprobada") ? 1 : 0 }); }
  const mesas = cons.results.map(c => ({ id: c.mesa_id, municipio: c.municipio, local: c.local, censo: c.censo, estado: c.estado, nueva: c.nueva ? 1 : 0, cifras: c.cifras ? JSON.parse(c.cifras) : null,
    n: c.n_envios, indep: c.n_indep, fotos: porMesa.get(c.mesa_id) || [] }));
  await env.FOTOS.put(`public/prov/${prov}.json`, JSON.stringify({ prov, generado: ahora(), candidaturas: cands.results, mesas }), { httpMetadata: { contentType: "application/json" } });
}

async function publicarResumen(env) {
  const mostrarTotales = env.MODO_PRUEBAS === "1" || ahora() >= Date.parse(env.TOTALES_DESDE || env.ABRE);
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
  await env.FOTOS.put("public/resumen.json", JSON.stringify({ generado: ahora(), totales_visibles: mostrarTotales, nacional: nac, provincias: [...P.values()] }), { httpMetadata: { contentType: "application/json" } });
}
async function publicarDecisiones(env) {
  const r = await env.DB.prepare("SELECT ts, hash, mesa_id, decision, motivo FROM decisiones ORDER BY id DESC LIMIT 3000").all();
  await env.FOTOS.put("public/decisiones.json", JSON.stringify({ generado: ahora(), decisiones: r.results }), { httpMetadata: { contentType: "application/json" } });
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
  if (p === "recalcular" && req.method === "POST") return json(await recalcular(env));
  if (p === "aceptar_licencia_ia" && req.method === "POST") {
    // Meta exige aceptar su licencia la primera vez que se usa el modelo de visión en la cuenta.
    if (!env.AI) return json({ error: "sin_ia" }, 400);
    const r = await env.AI.run(env.MODELO_IA || MODELO_IA, { prompt: "agree" }).catch(e => ({ error: String(e) }));
    return json({ ok: true, respuesta: r });
  }
  if (p === "vaciar_pruebas" && req.method === "POST") {
    // Borra todos los envíos, fotos y JSON públicos de las pruebas. Solo funciona con MODO_PRUEBAS = "1".
    if (env.MODO_PRUEBAS !== "1") return json({ error: "solo_en_modo_pruebas" }, 403);
    const b = await req.json().catch(() => ({})); if (b.confirmar !== "VACIAR") return json({ error: "falta_confirmacion" }, 400);
    await env.DB.batch(["DELETE FROM envios", "DELETE FROM denuncias", "DELETE FROM lecturas", "DELETE FROM contador", "DELETE FROM consenso", "DELETE FROM pendientes", "DELETE FROM decisiones", "DELETE FROM mesas WHERE de_usuario = 1"].map(q => env.DB.prepare(q)));
    let borrados = 0;
    for (const prefix of ["foto/", "mini/", "public/"]) {
      let cursor;
      do { const l = await env.FOTOS.list({ prefix, cursor, limit: 1000 }); const keys = l.objects.map(o => o.key);
           if (keys.length) { await env.FOTOS.delete(keys); borrados += keys.length; } cursor = l.truncated ? l.cursor : undefined; } while (cursor);
    }
    await publicarResumen(env); await publicarDecisiones(env);
    return json({ ok: true, objetos_borrados: borrados });
  }
  if (p === "estadisticas" && req.method === "GET") {
    const [a, b, c, dd, ee] = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS envios, COUNT(DISTINCT mesa_id) AS mesas, MAX(ts) AS ultimo FROM envios"),
      env.DB.prepare("SELECT estado, COUNT(*) AS n FROM consenso GROUP BY estado"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM pendientes"),
      env.DB.prepare("SELECT SUM(ia_estado IN ('pendiente','forzada')) AS n, SUM(ia_estado = 'en_espera') AS espera FROM envios"),
      env.DB.prepare("SELECT COALESCE(MAX(n), 0) AS n FROM contador WHERE clave = 'lecturas_ia'"),
    ]);
    return json({ ...a.results[0], estados: b.results, pendientes_recalculo: c.results[0].n, lecturas_pendientes: dd.results[0].n || 0, fotos_en_espera: dd.results[0].espera || 0, lecturas_ia: ee.results[0].n, tope_lecturas_ia: Number(env.MAX_LECTURAS_IA || 100000) });
  }
  return json({ error: "no_encontrado" }, 404);
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
async function leerConIA(env, fotoBuf, prov) {
  const cands = (await env.DB.prepare("SELECT codigo, siglas, denominacion FROM candidaturas WHERE prov = ? ORDER BY orden").bind(prov).all()).results;
  const lista = cands.map((c, i) => `${i + 1}. ${c.denominacion || c.siglas} (${c.siglas})`).join("\n");
  const prompt = `Esta imagen debería ser la foto de un ACTA DE ESCRUTINIO de unas elecciones generales españolas (un impreso con una tabla de candidaturas y votos, rellenado a mano).
Responde SOLO con un objeto JSON, sin texto adicional, con esta forma:
{"es_acta": true|false, "inapropiada": true|false, "electores": [N, L], "votantes": [N, L], "nulos": [N, L], "blanco": [N, L], "votos": [[N, L], ...]}
donde N es la cifra escrita con números y L la cifra escrita con letras convertida a número (null si no aparece o no se lee).
- es_acta: false si la imagen no es un acta de escrutinio.
- inapropiada: true si contiene desnudos, contenido sexual, violencia o cualquier cosa ofensiva.
- electores: "Total electores (1+2)". votantes: "Total votantes (A+B)". nulos y blanco: votos nulos y en blanco.
- votos: los votos de cada candidatura, en el mismo orden que esta lista:
${lista}`;
  const r = iaSimulada(env) ? iaDePrueba(fotoBuf) : await env.AI.run(env.MODELO_IA || MODELO_IA, { messages: [{ role: "user", content: prompt }], image: [...new Uint8Array(fotoBuf)], max_tokens: 500, temperature: 0 });
  const txt = String((r && (r.response ?? r.result?.response)) || "");
  // Si la respuesta no trae un JSON válido, el error incluye el principio del texto para poder ver qué ha contestado
  const m = txt.match(/\{[\s\S]*\}/); if (!m) throw new Error("respuesta_ia_sin_json: " + txt.slice(0, 400));
  let o; try { o = JSON.parse(m[0]); } catch { throw new Error("respuesta_ia_json_roto: " + txt.slice(0, 400)); }
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : (typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : null));
  const fiab = {};
  const leer = (clave, v) => {
    const [num, letra] = Array.isArray(v) ? [n(v[0]), n(v[1])] : [n(v), null];
    if (num == null && letra == null) return null;
    fiab[clave] = num != null && letra != null ? (num === letra ? "alta" : "baja") : "media";
    return num != null ? num : letra;
  };
  const cand = {}; cands.forEach((c, i) => { cand[c.codigo] = leer(c.codigo, Array.isArray(o.votos) ? o.votos[i] : null); });
  return { es_acta: o.es_acta !== false, inapropiada: o.inapropiada === true, electores: leer("electores", o.electores), votantes: leer("votantes", o.votantes),
    nulos: leer("nulos", o.nulos), blanco: leer("blanco", o.blanco), cand, fiab, modelo: env.MODELO_IA || MODELO_IA };
}
// Tope de gasto: como máximo MAX_LECTURAS_IA lecturas en total (todo el día de las elecciones). Al llegar, se deja de leer:
// la web sigue funcionando igual, sin las sugerencias, y las fotos se publican con el filtro sin IA.
async function hayCupoIA(env) {
  const tope = Number(env.MAX_LECTURAS_IA || 100000);
  const r = await env.DB.prepare("INSERT INTO contador (clave, n) VALUES ('lecturas_ia', 1) ON CONFLICT(clave) DO UPDATE SET n = n + 1 WHERE n < ? RETURNING n").bind(tope).first();
  return !!r;
}
// El formulario pide la lectura en cuanto la persona elige la foto (mientras copia las cifras).
async function leerParaFormulario(req, env) {
  if (!iaActiva(env)) return json({ error: "desactivada" }, 404);
  if (!abierto(env)) return json({ error: "cerrado" }, 403);
  const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
  const ipHash = (await sha256hex(new TextEncoder().encode((env.SAL_IP || "sal") + ip))).slice(0, 32);
  let form; try { form = await req.formData(); } catch { return json({ error: "formato" }, 400); }
  const foto = form.get("foto"); const prov = String(form.get("prov") || "");
  if (!(foto instanceof File) || foto.size > 2_500_000 || foto.size < 5_000 || !/^\d{2}$/.test(prov)) return json({ error: "parametros" }, 400);
  const buf = await foto.arrayBuffer(); const hash = await sha256hex(buf);
  const ya = await env.DB.prepare("SELECT lectura FROM lecturas WHERE hash = ?").bind(hash).first();
  const mesaId = String(form.get("mesa_id") || "").toUpperCase();
  if (!ya && mesaId) {
    const c = await env.DB.prepare("SELECT c.estado, (SELECT COUNT(*) FROM envios e WHERE e.mesa_id = c.mesa_id AND e.ia_estado = 'hecha' AND e.estado != 'invalida') AS n FROM consenso c WHERE c.mesa_id = ?").bind(mesaId).first();
    if (c && (c.estado === "verificada" || c.estado === "validada")) return json({ omitida: "mesa_verificada" });
  }
  if (ya) return json({ hash, lectura: JSON.parse(ya.lectura) });
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM lecturas WHERE ip_hash = ? AND ts > ?").bind(ipHash, ahora() - 600000).first();
  if (n.n >= Number(env.MAX_LECTURAS_IP_10MIN || 300)) return json({ error: "demasiadas_lecturas" }, 429);
  if (!(await hayCupoIA(env))) return json({ error: "tope_alcanzado" }, 429);
  // En la versión de pruebas se devuelve también el motivo del fallo, para poder ajustar la lectura; en la pública, no
  let lectura; try { lectura = await leerConIA(env, buf, prov); } catch (e) { console.error("IA", e); return json({ error: "lectura_fallida", ...(env.MODO_PRUEBAS === "1" ? { detalle: String(e && e.message || e).slice(0, 600) } : {}) }, 502); }
  await env.DB.prepare("INSERT OR REPLACE INTO lecturas (hash, lectura, ip_hash, ts) VALUES (?,?,?,?)").bind(hash, JSON.stringify(lectura), ipHash, ahora()).run();
  return json({ hash, lectura });
}
// El cron lee las fotos enviadas sin lectura previa (por ejemplo, de quien se salta la web). Hasta entonces no se publican.
async function leerPendientesIA(env) {
  // Solo se gasta en mesas que aún no están verificadas:
  //  - si la mesa ya está verificada o validada y tiene 2 fotos leídas de esa versión, las fotos nuevas quedan "en_espera" (sin leer ni publicar; las cifras
  //    cuentan igual) y se revisan a mano desde la cola "Fotos en espera" del panel;
  //  - si llega una foto con otras cifras, la mesa pasa a conflicto y entonces sí se leen sus fotos en espera;
  //  - antes de verificarse, como mucho FOTOS_LEIDAS_POR_VERSION fotos leídas con las mismas cifras (por si llegan muchas a la vez);
  //  - las que se fuerzan desde el panel van primero.
  const N = Number(env.FOTOS_LEIDAS_POR_VERSION || 3);
  const cand = (await env.DB.prepare(`SELECT e.hash, e.mesa_id, e.prov, e.flags, e.firma, e.ia_estado, c.estado AS mesa_estado FROM envios e LEFT JOIN consenso c ON c.mesa_id = e.mesa_id
    WHERE e.ia_estado IN ('pendiente','forzada') OR (e.ia_estado = 'en_espera' AND c.estado IN ('conflicto','revision'))
    ORDER BY (e.ia_estado = 'forzada') DESC, (e.ia_estado = 'en_espera') DESC, e.ts LIMIT 150`).all()).results;
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
    await env.DB.prepare(`UPDATE envios SET ia_estado = 'en_espera' WHERE hash IN (${h.map(() => "?").join(",")})`).bind(...h).run(); }
  for (let i = 0; i < pend.length; i += 15) {
    await Promise.all(pend.slice(i, i + 15).map(async (e) => {
      try {
        const o = await env.FOTOS.get(`foto/${e.hash}.jpg`); if (!o) return;
        if (!(await hayCupoIA(env))) { await env.DB.prepare("UPDATE envios SET ia_estado = 'omitida' WHERE hash = ?").bind(e.hash).run(); return; }
        const l = await leerConIA(env, await o.arrayBuffer(), e.prov);
        const flags = [...new Set([...JSON.parse(e.flags || "[]"), ...flagsLectura(l)])];
        await env.DB.batch([
          env.DB.prepare("UPDATE envios SET ia = ?, ia_estado = 'hecha', flags = ? WHERE hash = ?").bind(JSON.stringify(l), JSON.stringify(flags), e.hash),
          env.DB.prepare("INSERT INTO pendientes (mesa_id, prov, ts) VALUES (?,?,?) ON CONFLICT(mesa_id) DO UPDATE SET ts = excluded.ts").bind(e.mesa_id, e.prov, ahora()),
        ]);
      } catch (err) {
        console.error("IA cron", err);
        await env.DB.prepare("UPDATE envios SET ia_estado = 'error' WHERE hash = ?").bind(e.hash).run();
      }
    }));
  }
}
