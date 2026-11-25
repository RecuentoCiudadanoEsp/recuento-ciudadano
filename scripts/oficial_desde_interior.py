#!/usr/bin/env python3
"""
Convierte los resultados oficiales por mesa del Ministerio del Interior (ZIP del área de descargas de
Infoelectoral, elecciones al Congreso) en los archivos de «dato oficial» que compara la web.

Uso:
    python3 scripts/oficial_desde_interior.py 02202611_MESA.zip [carpeta_de_salida]

Genera una carpeta (por defecto «oficial») con un PP.json por provincia. Se cargan desde el panel con el
botón «Cargar dato oficial…» (se pueden elegir todos a la vez).

Ficheros que lee (diseño de registro de Interior, ISO-8859-1; las posiciones empiezan en 1):
    03xxaamm.DAT  candidaturas: código 9-14, siglas 15-64
    09xxaamm.DAT  datos de mesa: provincia 12-13, municipio 14-16, distrito 17-18, sección 19-22, mesa 23,
                  votos en blanco 66-72, nulos 73-79, a candidaturas 80-86, datos oficiales (S/N) 101
    10xxaamm.DAT  votos por mesa: mismo prefijo hasta la mesa (23), candidatura 24-29, votos 30-36

El municipio 999 es el voto de residentes en el extranjero (CERA): no es una mesa y no se compara.
Las candidaturas de Interior se emparejan con las de la web por sus siglas. Las que no se puedan emparejar se
guardan con la sigla precedida de «?» y el script avisa: conviene revisarlas antes de cargar los archivos.
"""
import json, os, pathlib, re, sys, unicodedata, zipfile
from datetime import datetime, timezone

RAIZ = pathlib.Path(__file__).resolve().parent.parent
CANDS = RAIZ / "public" / "data" / "candidaturas"


def leer_dat(z, prefijo):
    nombres = [n for n in z.namelist() if os.path.basename(n).upper().startswith(prefijo) and n.upper().endswith(".DAT")]
    if not nombres:
        sys.exit(f"No encuentro ningún fichero {prefijo}*.DAT en el ZIP.")
    with z.open(nombres[0]) as f:
        return f.read().decode("latin-1").splitlines()


def clave_siglas(t):
    # «PSC-PSOE», «psc psoe» y «PSC·PSOE» dan lo mismo: mayúsculas, sin acentos ni signos
    t = unicodedata.normalize("NFD", t or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Z0-9]", "", t.upper())


def numero(txt):
    try:
        return int(txt)
    except ValueError:
        return None


def id_mesa(l):
    prov, muni, dist, secc, mesa = l[11:13], l[13:16], l[16:18], l[18:22].strip(), l[22:23].strip()
    return prov, muni, f"{prov}-{muni}-{dist}-{secc.zfill(3)}-{mesa}"


def main(ruta_zip, salida):
    z = zipfile.ZipFile(ruta_zip)
    siglas_interior = {l[8:14]: l[14:64].strip() for l in leer_dat(z, "03") if len(l) >= 20}

    mesas, oficiales = {}, {}
    for l in leer_dat(z, "09"):
        if len(l) < 86:
            continue
        prov, muni, mid = id_mesa(l)
        if muni == "999" or not prov.isdigit():
            continue
        blanco, nulos, a_cand = numero(l[65:72]), numero(l[72:79]), numero(l[79:86])
        votantes = None if None in (blanco, nulos, a_cand) else blanco + nulos + a_cand
        mesas.setdefault(prov, {})[mid] = {"votantes": votantes, "nulos": nulos, "blanco": blanco, "cand": {}}
        oficiales.setdefault(prov, set()).add(l[100:101] if len(l) > 100 else "")

    # Emparejar códigos de Interior con los de la web, provincia a provincia
    sin_pareja = {}
    tabla = {}
    for prov in mesas:
        f = CANDS / f"{prov}.json"
        web = json.loads(f.read_text(encoding="utf-8"))["candidaturas"] if f.exists() else []
        tabla[prov] = {clave_siglas(c["siglas"]): c["codigo"] for c in web}

    for l in leer_dat(z, "10"):
        if len(l) < 36:
            continue
        prov, muni, mid = id_mesa(l)
        if muni == "999" or prov not in mesas or mid not in mesas[prov]:
            continue
        votos = numero(l[29:36])
        if votos is None:
            continue
        sig = siglas_interior.get(l[23:29], l[23:29].strip())
        cod = tabla[prov].get(clave_siglas(sig))
        if not cod:
            cod = "?" + sig
            sin_pareja.setdefault(prov, set()).add(sig)
        c = mesas[prov][mid]["cand"]
        c[cod] = c.get(cod, 0) + votos

    salida = pathlib.Path(salida)
    salida.mkdir(parents=True, exist_ok=True)
    ahora = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for prov, ms in sorted(mesas.items()):
        tipo = "definitivo" if oficiales.get(prov) == {"S"} else "provisional"
        datos = {"prov": prov, "tipo": tipo, "fuente": f"Ministerio del Interior, resultados por mesa ({os.path.basename(ruta_zip)})",
                 "actualizado": ahora, "municipios": {}, "mesas": ms}
        (salida / f"{prov}.json").write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"  provincia {prov}: {len(ms)} mesas ({tipo})")
    for prov, s in sorted(sin_pareja.items()):
        print(f"  AVISO provincia {prov}: candidaturas sin pareja en la web: {', '.join(sorted(s))}")
    print(f"Listo: {sum(len(m) for m in mesas.values())} mesas en {len(mesas)} provincias, en la carpeta {salida}/")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "oficial")
