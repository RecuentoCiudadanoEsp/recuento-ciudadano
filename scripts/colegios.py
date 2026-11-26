# Prepara la lista de colegios electorales (locales) de cada municipio, para la sección «Me apunto».
#
# Un colegio es un local de votación: puede tener mesas de varias secciones, y alguna sección tiene mesas en dos
# locales distintos. Por eso se agrupan las mesas por municipio, nombre del local y dirección, no por sección.
#
# Entrada: sql/01_mesas.sql (las mesas oficiales del 29N, con local y dirección) y public/data/zonas/PP.json
#          (posición aproximada de cada mesa en el panal «Por zonas», para ordenar los colegios cercanos).
# Salida:  public/data/colegios/PP.json, uno por provincia:
#          { "prov": "28", "municipios": { "079": [ [id, nombre, dirección, nº de mesas, [secciones], col, fila], ... ] } }
#          · id: el código de la primera mesa del colegio (la de código más bajo). Es el identificador del colegio en
#            la web y en el servidor, que lo calcula igual a partir de la tabla de mesas.
#          · secciones: «DD-SSS» (distrito y sección) de las mesas del colegio, para poder filtrar.
#          · col, fila: centro aproximado del colegio en la rejilla del panal «Por zonas» (null si no hay datos).
#            Solo sirve para comparar distancias entre colegios de un mismo municipio.
#          Y public/data/colegios/resumen.json: { "PP": nº de colegios de la provincia }, para los porcentajes del mapa.
#
# Uso: python3 scripts/colegios.py   (si cambian las listas de mesas, volver a ejecutarlo)
import json, os, re, sqlite3
from collections import defaultdict

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(RAIZ, "public", "data", "colegios")


def clave(local, direccion):
    """Misma regla que el servidor (claveColegio en src/worker.js): mayúsculas y espacios simples."""
    t = lambda s: re.sub(r"\s+", " ", (s or "").strip().upper())
    return t(local) + "|" + t(direccion)


def main():
    db = sqlite3.connect(":memory:")
    with open(os.path.join(RAIZ, "schema.sql"), encoding="utf-8") as f:
        db.executescript(f.read())
    with open(os.path.join(RAIZ, "sql", "01_mesas.sql"), encoding="utf-8") as f:
        db.executescript(f.read())
    os.makedirs(SALIDA, exist_ok=True)
    total = 0
    resumen = {}
    provs = [r[0] for r in db.execute("SELECT DISTINCT prov FROM mesas ORDER BY prov")]
    for prov in provs:
        ruta_z = os.path.join(RAIZ, "public", "data", "zonas", f"{prov}.json")
        zonas = json.load(open(ruta_z, encoding="utf-8")) if os.path.exists(ruta_z) else {}
        filas = db.execute("SELECT id, muni, distrito, seccion, local, direccion FROM mesas WHERE prov = ? ORDER BY id", (prov,)).fetchall()
        # posición de cada mesa en el panal: el archivo de zonas va en el orden de los códigos de mesa del municipio
        orden = defaultdict(list)
        for id_, muni, *_ in filas:
            orden[muni].append(id_)
        pos = {}
        for muni, ids in orden.items():
            z = zonas.get(muni)
            if z and len(z) == 2 * len(ids):
                for i, id_ in enumerate(ids):
                    pos[id_] = (z[2 * i], z[2 * i + 1])
        grupos = defaultdict(list)
        for id_, muni, dist, secc, local, direc in filas:
            grupos[(muni, clave(local, direc))].append((id_, dist, secc, local, direc))
        munis = defaultdict(list)
        for (muni, _), ms in grupos.items():
            ms.sort()
            secs = sorted({f"{d}-{s}" for _, d, s, _, _ in ms})
            ps = [pos[m[0]] for m in ms if m[0] in pos]
            c = round(sum(p[0] for p in ps) / len(ps), 1) if ps else None
            fi = round(sum(p[1] for p in ps) / len(ps), 1) if ps else None
            munis[muni].append([ms[0][0], (ms[0][3] or "").strip(), (ms[0][4] or "").strip(), len(ms), secs, c, fi])
        for lista in munis.values():
            lista.sort(key=lambda x: x[0])
            total += len(lista)
        resumen[prov] = sum(len(v) for v in munis.values())
        with open(os.path.join(SALIDA, f"{prov}.json"), "w", encoding="utf-8") as f:
            json.dump({"prov": prov, "municipios": dict(sorted(munis.items()))}, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(SALIDA, "resumen.json"), "w", encoding="utf-8") as f:
        json.dump(resumen, f, separators=(",", ":"))
    print(f"{total} colegios en {len(provs)} provincias")


if __name__ == "__main__":
    main()
