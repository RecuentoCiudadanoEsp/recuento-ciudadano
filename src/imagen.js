// Comprobaciones de la foto en el servidor (sin IA). Decodifica el JPEG y comprueba dos cosas:
//  1) que la zona de nombres esté tapada (la web la rellena de gris oscuro uniforme antes de subir);
//  2) que la imagen parezca un documento en papel: mayoría de píxeles claros y sin color, y poca piel.
import jpegDecoder from "jpeg-js/lib/decoder.js";
const decode = jpegDecoder.decode || jpegDecoder;

export const COLOR_TAPADO = 43; // #2b2b2b

export function analizarJPEG(buf, zonas) {
  let img;
  try { img = decode(new Uint8Array(buf), { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 30, maxMemoryUsageInMB: 256 }); }
  catch { return { ok: false, error: "no_decodifica" }; }
  const { width: W, height: H, data: D } = img;
  // muestreo en rejilla (~40.000 puntos) para que cueste poco
  const paso = Math.max(1, Math.floor(Math.sqrt((W * H) / 40000)));
  // brillo de referencia: percentil 90 (así una foto de noche, más oscura, no deja de parecer papel)
  const hist = new Uint32Array(256); let n = 0;
  for (let y = 0; y < H; y += paso) for (let x = 0; x < W; x += paso) { const i = (y * W + x) * 4; hist[Math.max(D[i], D[i + 1], D[i + 2])]++; n++; }
  let acc = 0, p90 = 255; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.9) { p90 = v; break; } }
  const umbralClaro = Math.max(50, p90 * 0.62);
  let papel = 0, piel = 0, colorido = 0;
  for (let y = 0; y < H; y += paso) for (let x = 0; x < W; x += paso) {
    const i = (y * W + x) * 4, r = D[i], g = D[i + 1], b = D[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (mx > umbralClaro && sat < 0.22) papel++;
    if (sat > 0.45 && mx > 60) colorido++;
    // regla clásica de piel en RGB
    if (r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r - g) > 15 && r > g && r > b && sat > 0.23) piel++;
  }
  const res = { ok: true, ancho: W, alto: H, papel: papel / n, piel: piel / n, colorido: colorido / n, zonas: [] };
  for (const z of zonas || []) {
    // se mide el interior de la zona (con margen) para no depender de los bordes del JPEG
    const x0 = Math.floor((z[0] + z[2] * 0.04) * W), x1 = Math.floor((z[0] + z[2] * 0.96) * W);
    const y0 = Math.floor((z[1] + z[3] * 0.04) * H), y1 = Math.floor((z[1] + z[3] * 0.96) * H);
    let s = 0, s2 = 0, k = 0; const p = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
    for (let y = y0; y < y1; y += p) for (let x = x0; x < x1; x += p) { const i = (y * W + x) * 4; const v = (D[i] + D[i + 1] + D[i + 2]) / 3; s += v; s2 += v * v; k++; }
    const media = k ? s / k : 0, sd = k ? Math.sqrt(Math.max(0, s2 / k - media * media)) : 999;
    res.zonas.push({ media: Math.round(media), sd: Math.round(sd * 10) / 10, tapada: k > 0 && Math.abs(media - COLOR_TAPADO) < 18 && sd < 14 });
  }
  return res;
}

// Avisos que dejan la foto en cuarentena (no se publica hasta que la revises).
export function avisosImagen(a) {
  if (!a.ok) return ["foto_ilegible"];
  const f = [];
  if (a.zonas.some(z => !z.tapada)) f.push("nombres_sin_tapar");
  if (a.papel < 0.3 || a.piel > 0.3 || a.colorido > 0.3) f.push("no_parece_acta");
  return f;
}
