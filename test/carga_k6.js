// Prueba de carga contra el despliegue real (con MODO_PRUEBAS = "1" y las claves de prueba de Turnstile).
// Uso:  k6 run -e BASE=https://tu-dominio test/carga_k6.js
// Simula el pico: sube hasta 400 envíos por segundo y lo mantiene 10 minutos, más visitas a resultados.
import http from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";
import crypto from "k6/crypto";

const BASE = __ENV.BASE;
const foto = open("./acta_prueba.jpg", "b");     // copia aquí cualquier foto de acta (< 2 MB)
const mesas = new SharedArray("mesas", () => JSON.parse(open("../public/data/mesas/28.json")).mesas.map(m => m[0]));
const cands = JSON.parse(open("../public/data/candidaturas/28.json")).candidaturas.map(c => c.codigo);

export const options = {
  scenarios: {
    envios: { executor: "ramping-arrival-rate", startRate: 10, timeUnit: "1s", preAllocatedVUs: 300, maxVUs: 1500,
              stages: [{ target: 400, duration: "3m" }, { target: 400, duration: "10m" }, { target: 0, duration: "1m" }] },
    visitas: { executor: "constant-arrival-rate", rate: 300, timeUnit: "1s", duration: "14m", preAllocatedVUs: 100, exec: "visita" },
  },
  thresholds: { "http_req_failed{escenario:envio}": ["rate<0.01"], "http_req_duration{escenario:envio}": ["p(95)<1500"] },
};

export default function () {
  const i = Math.floor(Math.random() * 1e9);
  const bytes = new Uint8Array(foto.byteLength + 8); bytes.set(new Uint8Array(foto)); new DataView(bytes.buffer).setFloat64(foto.byteLength, i); // foto única
  const buf = bytes.buffer;
  const v = {}; let suma = 0; for (const c of cands) { v[c] = Math.floor(Math.random() * 50); suma += v[c]; }
  const datos = { mesa_id: mesas[i % mesas.length], cifras: { electores: 800, votantes: suma + 4, nulos: 2, blanco: 2, cand: v },
                  hash: crypto.sha256(buf, "hex"), dhash: i.toString(16).padStart(16, "0"), dispositivo: "k6-" + i };
  const r = http.post(`${BASE}/api/envio`, { foto: http.file(buf, "acta.jpg", "image/jpeg"), mini: http.file(foto.slice(0, 60000), "mini.jpg", "image/jpeg"),
                                            datos: JSON.stringify(datos), turnstile: "XXXX.DUMMY.TOKEN.XXXX" },
                     { headers: { "cf-connecting-ip": `10.${i % 250}.${(i >> 8) % 250}.${(i >> 16) % 250}` }, tags: { escenario: "envio" } });
  check(r, { "aceptado": x => x.status === 200 || x.status === 409 || x.status === 429 });
}
export function visita() {
  http.get(`${BASE}/api/public/resumen.json`, { tags: { escenario: "visita" } });
}
