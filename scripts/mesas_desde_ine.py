#!/usr/bin/env python3
"""
Convierte la relación definitiva de mesas y locales del INE (un único Excel para toda España) en la lista de mesas del 29N.

Uso:
    python3 scripts/mesas_desde_ine.py elecgen2026_mesas_y_locales.xlsx     -> scripts/ref/mesas29n/PP.json (52 ficheros)
    python3 scripts/convertir_interior.py 02202307_MESA.zip                  -> regenera public/data y sql/

Fuente: https://www.ine.es/oficina_censo/elecgen2026/elecgen2026_mesas_y_locales.xlsx (hoja "Mesas y locales MI").
Comprueba que el total coincide con la tabla de mesas por provincia del INE (scripts/ref/mesas_ine_29n.json).
"""
import collections, json, pathlib, re, sys
import openpyxl

REF = pathlib.Path(__file__).resolve().parent / "ref"

def main(ruta):
    ws = openpyxl.load_workbook(ruta, read_only=True, data_only=True)["Mesas y locales MI"]
    limpia = lambda s: re.sub(r"\s+", " ", str(s or "")).strip()
    out = collections.defaultdict(dict)
    for r in ws.iter_rows(min_row=3, values_only=True):
        if not r or not r[0] or not str(r[0]).isdigit(): continue
        p, _, mu, mun, d, sc, sb, me, loc, dire, cp = [limpia(x) for x in r[:11]]
        i = f"{p}-{mu}-{d}-{int(sc):03d}-{me}"
        if i in out[p]: sys.exit(f"Código de mesa repetido: {i}")
        out[p][i] = dict(id=i, prov=p, muni=mu, distrito=d, seccion=f"{int(sc):03d}", mesa=me, local=loc,
                         direccion=dire + (", " + cp if cp else ""), municipio_ine=mun)
    ine = json.loads((REF / "mesas_ine_29n.json").read_text(encoding="utf-8"))
    malas = [p for p in ine if len(out.get(p, {})) != ine[p]["mesas_29n"]]
    if malas: sys.exit(f"No cuadra con el INE en: {malas}")
    dest = REF / "mesas29n"; dest.mkdir(parents=True, exist_ok=True)
    for f in dest.glob("*.json"): f.unlink()
    for p, d in out.items():
        (dest / f"{p}.json").write_text(json.dumps(sorted(d.values(), key=lambda x: x["id"]), ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"OK: {sum(len(v) for v in out.values())} mesas en {len(out)} provincias, todas cuadran con el INE.")

if __name__ == "__main__":
    if len(sys.argv) != 2: sys.exit(__doc__)
    main(sys.argv[1])
