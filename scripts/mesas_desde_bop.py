#!/usr/bin/env python3
"""
Convierte las relaciones de secciones, mesas y locales publicadas en los boletines provinciales (art. 24.2 LOREG)
en la lista de mesas del 29N, con el nombre y la dirección de cada local.

Uso:
    pdftotext -layout BOLETIN.pdf BOLETIN.txt                      (para cada boletín)
    python3 scripts/mesas_desde_bop.py --prov 28 BOCM-20261012-22.txt BOCM-20261026-67.txt
    python3 scripts/mesas_desde_bop.py --prov 08 3998658.txt --correccion 4011869.txt
    python3 scripts/mesas_desde_bop.py --prov 11 BOP196_12-10-26.txt
    python3 scripts/mesas_desde_bop.py --prov 33 2026-08339.txt
        -> scripts/ref/mesas29n/PP.json   [{id, prov, muni, distrito, seccion, mesa, local, direccion}]

Cada boletín tiene su formato; se reconocen los de Madrid (BOCM), Barcelona (BOPB), Cádiz y el listado estándar de la
Oficina del Censo Electoral (Asturias, Sevilla, León...). Si se pasan varios ficheros, los posteriores sustituyen a los
anteriores municipio a municipio (así funcionan las "publicaciones extraordinarias" de actualización).
"""
import argparse, json, pathlib, re, sys

SALIDA = pathlib.Path(__file__).resolve().parent / "ref" / "mesas29n"

def mid(prov, muni, dist, secc, mesa):
    return f"{prov}-{int(muni):03d}-{int(dist):02d}-{int(secc):03d}-{mesa}"

def partir(resto):
    trozos = [t.strip() for t in re.split(r"\s{2,}", resto.strip()) if t.strip()]
    return (trozos[0] if trozos else ""), (" ".join(trozos[1:]) if len(trozos) > 1 else "")

def leer_madrid(txt, prov):
    out = []; muni = None
    for l in txt.splitlines():
        m = re.match(r"^\s*Municipio:\s*(\d{3})\s*-", l)
        if m: muni = m.group(1); continue
        m = re.match(r"^\s*(\d{2})\s+(\d{3})\s+(?:(\d{1,2})\s+)?([A-Z])\s+([A-ZÑ]{1,3}\s*-\s*[A-ZÑ]{1,3})\s+(.*)$", l)
        if m and muni:
            resto = re.sub(r"\s+\d{5}\s*$", "", m.group(6)); local, dire = partir(resto)
            out.append(dict(muni=muni, distrito=m.group(1), seccion=m.group(2), mesa=m.group(4), local=local, direccion=dire))
    return out

RE_BCN = re.compile(r"^\s*08\s+(\d{3})\s+(.+?)\s+(\d{1,2})\s+(\d{1,3})\s+(?:(\d{1,2})\s+)?([A-Z])\s+([A-ZÑ])\s+([A-ZÑ])\s+(\d{7,9})\s+(.*)$")
def leer_barcelona(txt, prov):
    out = []
    for l in txt.splitlines():
        m = RE_BCN.match(l)
        if m:
            local, dire = partir(m.group(10))
            out.append(dict(muni=m.group(1), distrito=m.group(3), seccion=m.group(4), mesa=m.group(6), local=local, direccion=dire))
    return out

def leer_correccion_barcelona(txt):
    quitar, poner, modo = [], [], None
    for l in txt.splitlines():
        t = l.strip()
        if t.startswith("DONDE DICE"): modo = "q"; continue
        if t.startswith("DEBE DECIR"): modo = "p"; continue
        m = RE_BCN.match(l)
        if m and modo:
            local, dire = partir(m.group(10))
            fila = dict(muni=m.group(1), distrito=m.group(3), seccion=m.group(4), mesa=m.group(6), local=local, direccion=dire)
            (quitar if modo == "q" else poner).append(fila)
    return quitar, poner

def leer_cadiz(txt, prov):
    out = []
    for l in txt.splitlines():
        if not re.search(r"\.{3,}\d{5}\.{2,}", l): continue
        c = [x.strip() for x in re.split(r"\.{2,}", l)]
        c = [x for x in c if x != ""]
        # [municipio, DDSSS, subsección, mesa, apellidos, código local, local, dirección, CP]
        try:
            dsec = next(x for x in c[1:3] if re.fullmatch(r"\d{5}", x)); i = c.index(dsec)
            mesa = next(x for x in c[i + 1:i + 4] if re.fullmatch(r"[A-Z]", x))
            codl = next(x for x in c if re.fullmatch(r"\d{9}", x)); j = c.index(codl)
        except StopIteration:
            continue
        out.append(dict(muni=codl[2:5], distrito=dsec[:2], seccion=dsec[2:], mesa=mesa, local=c[j + 1] if j + 1 < len(c) else "",
                        direccion=c[j + 2] if j + 2 < len(c) and not re.fullmatch(r"\d{5}", c[j + 2]) else ""))
    return out

def leer_oce(txt, prov):
    # Listado estándar de la Oficina del Censo Electoral: "MUNICIPIO : 001 ALLANDE" y filas "DI SEC SU M LET CODLOCAL NN LOCAL  DIRECCION"
    out = []; muni = None
    for l in txt.splitlines():
        m = re.match(r"^\s*MUNICIPIO\s*:\s*(\d{3})\b", l)
        if m: muni = m.group(1); continue
        m = re.match(r"^\s*(\d{2})\s+(\d{3})\s+(\d{2})?\s*([A-Z])\s+(\S{1,7})\s+(\d{9})\s+\d{2}\s+(.*)$", l)
        if m and muni:
            local, dire = partir(m.group(7))
            out.append(dict(muni=muni, distrito=m.group(1), seccion=m.group(2), mesa=m.group(4), local=local, direccion=dire))
    return out

def detectar(txt):
    if "B.O.C.M." in txt[:3000] or "COMUNIDAD DE MADRID" in txt[:3000]: return leer_madrid
    if "bop.diba.cat" in txt[:3000]: return leer_barcelona
    if "B.O. P. DE CADIZ" in txt[:3000]: return leer_cadiz
    if "LISTA DE MESAS ELECTORALES" in txt and "MUNICIPIO :" in txt: return leer_oce
    sys.exit("Formato de boletín no reconocido.")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prov", required=True); ap.add_argument("ficheros", nargs="+"); ap.add_argument("--correccion", action="append", default=[])
    a = ap.parse_args(); prov = a.prov.zfill(2)
    por_muni = {}
    for f in a.ficheros:
        txt = pathlib.Path(f).read_text(encoding="utf-8", errors="replace")
        filas = detectar(txt)(txt, prov); nuevos = {}
        for r in filas: nuevos.setdefault(r["muni"], []).append(r)
        por_muni.update(nuevos)                       # un fichero posterior sustituye municipios enteros
        print(f"{f}: {len(filas)} mesas en {len(nuevos)} municipios")
    filas = [r for v in por_muni.values() for r in v]
    for f in a.correccion:
        quitar, poner = leer_correccion_barcelona(pathlib.Path(f).read_text(encoding="utf-8", errors="replace"))
        claves = {mid(prov, r["muni"], r["distrito"], r["seccion"], r["mesa"]) for r in quitar}
        filas = [r for r in filas if mid(prov, r["muni"], r["distrito"], r["seccion"], r["mesa"]) not in claves] + poner
        print(f"{f}: corrección, {len(quitar)} filas sustituidas por {len(poner)}")
    res = {}
    for r in filas:
        i = mid(prov, r["muni"], r["distrito"], r["seccion"], r["mesa"])
        if i in res and res[i]["local"] != r["local"]: print("  aviso: mesa repetida con distinto local", i)
        res[i] = dict(id=i, prov=prov, muni=f"{int(r['muni']):03d}", distrito=f"{int(r['distrito']):02d}", seccion=f"{int(r['seccion']):03d}",
                      mesa=r["mesa"], local=r["local"], direccion=r["direccion"])
    SALIDA.mkdir(parents=True, exist_ok=True)
    (SALIDA / f"{prov}.json").write_text(json.dumps(sorted(res.values(), key=lambda x: x["id"]), ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"TOTAL provincia {prov}: {len(res)} mesas -> {SALIDA / (prov + '.json')}")

if __name__ == "__main__":
    main()
