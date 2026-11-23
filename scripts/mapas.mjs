// Genera los mapas SVG de la web a partir de es-atlas (contornos del IGN, códigos INE):
//   public/data/mapa/espana.json            provincias de España (Canarias en recuadro)
//   public/data/mapa/municipios/PP.json     municipios de cada provincia
// La web solo pinta trazados ya proyectados: no necesita ninguna librería de mapas.
// Uso: node scripts/mapas.mjs
import fs from "node:fs";
import { feature, mesh } from "topojson-client";
import { geoPath, geoMercator } from "d3-geo";
import geoConicConformalSpain from "d3-composite-projections/src/conicConformalSpain.js";

const topo = JSON.parse(fs.readFileSync(new URL("../node_modules/es-atlas/es/municipalities.json", import.meta.url)));
const provs = feature(topo, topo.objects.provinces).features.filter(f => /^\d\d$/.test(f.id) && Number(f.id) <= 52);
const munis = feature(topo, topo.objects.municipalities).features;
const salida = new URL("../public/data/mapa/", import.meta.url);
fs.mkdirSync(new URL("municipios/", salida), { recursive: true });

// redondea coordenadas a 1 decimal: los ficheros pesan mucho menos y a esta escala no se nota
const redondear = (d) => d ? d.replace(/-?\d+\.\d+/g, (n) => (Math.round(Number(n) * 10) / 10).toString()) : "";

// ---- España por provincias
const W = 800, H = 640;
const proyEsp = geoConicConformalSpain().fitSize([W, H], { type: "FeatureCollection", features: provs });
const camEsp = geoPath(proyEsp);
const espana = { ancho: W, alto: H, provincias: provs.map(f => ({ prov: f.id, nombre: f.properties.name, d: redondear(camEsp(f)) })),
  marcoCanarias: redondear(proyEsp.getCompositionBorders ? proyEsp.getCompositionBorders() : "") };
fs.writeFileSync(new URL("espana.json", salida), JSON.stringify(espana));

// ---- municipios de cada provincia
let total = 0;
for (const p of provs) {
  const fs_ = munis.filter(m => String(m.id).slice(0, 2) === p.id);
  const w = 700, h = 560;
  const proy = geoMercator().fitSize([w, h], { type: "FeatureCollection", features: fs_ });
  const cam = geoPath(proy);
  const datos = { prov: p.id, ancho: w, alto: h, municipios: fs_.map(m => ({ muni: String(m.id).slice(2), nombre: m.properties.name, d: redondear(cam(m)) })) };
  const txt = JSON.stringify(datos); total += txt.length;
  fs.writeFileSync(new URL(`municipios/${p.id}.json`, salida), txt);
}
console.log(`España: ${espana.provincias.length} provincias · municipios: ${munis.length} en ${provs.length} ficheros (${(total / 1e6).toFixed(1)} MB sin comprimir)`);
