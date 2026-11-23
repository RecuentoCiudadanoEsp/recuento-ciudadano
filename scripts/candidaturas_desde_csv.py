#!/usr/bin/env python3
"""
Sustituye las candidaturas por las proclamadas para el 29N a partir de un CSV sencillo.

Uso:
    python3 scripts/candidaturas_desde_csv.py candidaturas_29N.csv

El CSV (separado por comas, UTF-8, con cabecera) tiene estas columnas:
    prov,siglas,denominacion
    08,PARTIDO A,Partido A de ejemplo
    08,PARTIDO B,Partido B de ejemplo
    ...
"prov" es el código de provincia de dos dígitos (08 Barcelona, 28 Madrid...). El orden de las filas dentro
de cada provincia es el orden en que aparecerán en el formulario: conviene que siga el orden del acta.

Genera public/data/candidaturas/PP.json y sql/02_candidaturas.sql.
"""
import csv, json, pathlib, sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
DATOS = RAIZ / "public" / "data" / "candidaturas"
SQL = RAIZ / "sql"

def s(t):
    return "'" + str(t).replace("'", "''") + "'"

def main(ruta):
    por_prov = {}
    with open(ruta, encoding="utf-8-sig", newline="") as f:
        for fila in csv.DictReader(f):
            prov = fila["prov"].strip().zfill(2)
            siglas = fila["siglas"].strip()
            if not siglas:
                continue
            lista = por_prov.setdefault(prov, [])
            lista.append({"codigo": f"C{len(lista) + 1:02d}", "siglas": siglas,
                          "denominacion": (fila.get("denominacion") or "").strip(), "orden": len(lista) + 1})
    if not por_prov:
        sys.exit("El CSV no tiene filas válidas.")
    DATOS.mkdir(parents=True, exist_ok=True)
    SQL.mkdir(exist_ok=True)
    with open(SQL / "02_candidaturas.sql", "w", encoding="utf-8") as out:
        out.write("DELETE FROM candidaturas;\n")
        for prov, lista in sorted(por_prov.items()):
            (DATOS / f"{prov}.json").write_text(json.dumps({"prov": prov, "fuente": "candidaturas proclamadas 29N", "candidaturas": lista},
                                                           ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            for c in lista:
                out.write(f"INSERT INTO candidaturas (prov,codigo,siglas,denominacion,orden) VALUES ({s(prov)},{s(c['codigo'])},{s(c['siglas'])},{s(c['denominacion'])},{c['orden']});\n")
    print(f"OK: {sum(len(v) for v in por_prov.values())} candidaturas en {len(por_prov)} provincias.")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
