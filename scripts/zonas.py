# Prepara la vista «Por zonas» del panal de mesas de cada municipio.
#
# Idea: se rellena la silueta del municipio con hexágonos (uno por hueco) y cada mesa ocupa el hueco libre más
# cercano al centro de su sección censal. Así el panal tiene la forma del municipio y cada mesa queda, más o menos,
# en su barrio. Todo se calcula aquí una sola vez; la web solo descarga el resultado.
#
# Entrada: la cartografía de secciones censales del INE (shapefile, coordenadas UTM huso 30, en metros), que no se
#          incluye en el repositorio por su tamaño. Se descarga gratis en https://ine.es/dyngs/DAB/index.htm?cid=1389
#          (fichero «España_Seccionado2026_ETRS89H30»), y las listas de mesas de public/data/mesas/.
# Salida:  public/data/zonas/PP.json, uno por provincia: { "código de municipio": [col, fila, col, fila, ...] }, con una
#          pareja de números por mesa, en el mismo orden (ordenadas por su código) que en public/data/mesas/PP.json.
#          Columna y fila son la posición del hexágono en una rejilla de hexágonos «de punta hacia arriba», en la que las
#          filas impares van desplazadas medio hexágono a la derecha. La fila 0 es la de más al norte.
#
# Uso: python3 scripts/zonas.py RUTA/SECC_CE_20260101   (ruta al shapefile, sin la extensión)
# Necesita: pip install pyshp shapely numpy
import json, math, os, random, sys
from collections import defaultdict

import numpy as np
import shapefile
from shapely import contains_xy
from shapely.geometry import shape
from shapely.ops import unary_union

HOLGURA = 1.2      # huecos de sobra respecto al número de mesas, para que cada una encuentre sitio cerca de su sección
RAIZ3 = math.sqrt(3)


def rejilla(forma, radio):
    """Centros de los hexágonos de radio `radio` que caen dentro de la forma, con su columna y fila."""
    x0, y0, x1, y1 = forma.bounds
    ancho, alto = RAIZ3 * radio, 1.5 * radio
    filas = int((y1 - y0) / alto) + 2
    cols = int((x1 - x0) / ancho) + 2
    f, c = np.meshgrid(np.arange(filas), np.arange(cols), indexing="ij")
    x = x0 + c * ancho + (f % 2) * ancho / 2
    y = y1 - f * alto                              # fila 0 arriba (al norte)
    dentro = contains_xy(forma, x, y)
    return x[dentro], y[dentro], c[dentro], f[dentro]


def colocar(forma, objetivos):
    """Coloca una mesa por objetivo (punto de su sección) en el hueco libre más cercano. Devuelve [(col, fila)]."""
    n = len(objetivos)
    # tamaño de hexágono que deja unos HOLGURA×n huecos dentro de la silueta (búsqueda por bisección)
    radio = math.sqrt(forma.area / (n * HOLGURA * 1.5 * RAIZ3))
    for _ in range(30):
        x, y, c, f = rejilla(forma, radio)
        if len(x) >= n * HOLGURA * 0.97 and len(x) <= n * HOLGURA * 1.1:
            break
        radio *= math.sqrt(len(x) / (n * HOLGURA)) if len(x) else 0.7
    while len(x) < n:                               # siluetas muy estrechas: se encoge hasta que quepan todas
        radio *= 0.85
        x, y, c, f = rejilla(forma, radio)
    libre = np.ones(len(x), dtype=bool)
    sitio = [None] * n
    orden = list(range(n))
    random.Random(29).shuffle(orden)                # orden fijo para que el resultado no cambie de una vez a otra
    for i in orden:
        ox, oy = objetivos[i]
        d = (x - ox) ** 2 + (y - oy) ** 2
        d[~libre] = np.inf
        j = int(np.argmin(d))
        libre[j] = False
        sitio[i] = (int(c[j]), int(f[j]))
    # se recorta la rejilla para que empiece en la columna y fila 0 (manteniendo la paridad de las filas)
    c0 = min(s[0] for s in sitio)
    f0 = min(s[1] for s in sitio)
    f0 -= f0 % 2
    return [(s[0] - c0, s[1] - f0) for s in sitio]


def main(ruta_shp):
    lector = shapefile.Reader(ruta_shp)
    campos = [f[0] for f in lector.fields[1:]]
    i_cusec = campos.index("CUSEC")
    secciones = defaultdict(dict)                   # "PPMMM" -> {"DDSSS": geometría}
    for reg in lector.iterShapeRecords():
        cusec = reg.record[i_cusec]                 # PP MMM DD SSS
        secciones[cusec[:5]][cusec[5:]] = shape(reg.shape.__geo_interface__)

    os.makedirs("public/data/zonas", exist_ok=True)
    sin_seccion = 0
    for nombre in sorted(os.listdir("public/data/mesas")):
        prov = nombre[:2]
        mesas = json.load(open(f"public/data/mesas/{nombre}"))["mesas"]
        por_muni = defaultdict(list)
        for m in mesas:
            por_muni[m[0].split("-")[1]].append(m[0])
        salida = {}
        for muni, ids in sorted(por_muni.items()):
            secc = secciones.get(prov + muni)
            if not secc:
                continue                            # sin cartografía: la web usará la vista agrupada
            forma = unary_union(list(secc.values())).buffer(0)
            centro = forma.representative_point()
            objetivos = []
            for id_ in sorted(ids):
                _, _, dist, sec, _ = id_.split("-")
                g = secc.get(dist + sec)
                if g is None:
                    sin_seccion += 1
                    p = centro
                else:
                    p = g.representative_point()    # punto dentro de la sección (el centro geométrico puede caer fuera)
                objetivos.append((p.x, p.y))
            salida[muni] = [v for par in colocar(forma, objetivos) for v in par]
        with open(f"public/data/zonas/{prov}.json", "w") as fh:
            json.dump(salida, fh, separators=(",", ":"))
        print(prov, len(salida), "municipios")
    print("mesas sin sección en la cartografía (colocadas en el centro del municipio):", sin_seccion)


if __name__ == "__main__":
    main(sys.argv[1])
