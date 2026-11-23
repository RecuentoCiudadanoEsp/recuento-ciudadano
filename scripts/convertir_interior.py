#!/usr/bin/env python3
"""
Convierte el ZIP de resultados por mesa del Ministerio del Interior en los datos que usa la web.

Uso:
    python3 scripts/convertir_interior.py 02202307_MESA.zip

Genera:
    public/data/provincias.json            lista de provincias con su número de mesas
    public/data/mesas/PP.json              mesas de cada provincia (código, municipio, censo)
    public/data/candidaturas/PP.json       candidaturas de cada provincia (ver nota)
    sql/01_mesas.sql, sql/02_candidaturas.sql   para cargar en D1:
        npx wrangler d1 execute recuento --remote --file sql/01_mesas.sql

Formato de los ficheros .DAT (diseño de registro de Interior, codificación ISO-8859-1):
    03xxaamm.DAT  candidaturas:  código 9-14, siglas 15-64, denominación 65-214
    09xxaamm.DAT  datos de mesa: prov 12-13, muni 14-16, distrito 17-18, sección 19-22, mesa 23, censo INE 24-30
    10xxaamm.DAT  votos por mesa: (mismo prefijo hasta mesa 23), candidatura 24-29, votos 30-36

Nota sobre candidaturas: el ZIP del 23J trae las candidaturas de 2023. Para el 29N hay que sustituirlas
por las proclamadas (ficheros auxiliares de Interior o BOE) con scripts/candidaturas_desde_csv.py.
"""
import csv, io, json, os, sys, zipfile, pathlib

RAIZ = pathlib.Path(__file__).resolve().parent.parent
DATOS = RAIZ / "public" / "data"
SQL = RAIZ / "sql"
REF = pathlib.Path(__file__).resolve().parent / "ref"

def leer_dat(z, prefijo):
    nombres = [n for n in z.namelist() if os.path.basename(n).upper().startswith(prefijo) and n.upper().endswith(".DAT")]
    if not nombres:
        sys.exit(f"No encuentro ningún fichero {prefijo}*.DAT en el ZIP. Ficheros: {z.namelist()}")
    with z.open(nombres[0]) as f:
        return f.read().decode("latin-1").splitlines()

def nombre_ine(t):
    # "ADRADA (LA)" -> "Adrada (La)": solo para municipios que no estén en la tabla de nombres
    return " ".join(w.capitalize() if not w.startswith("(") else "(" + w[1:].capitalize() for w in t.lower().split()) if t else None

def s(txt):
    return "'" + str(txt).replace("'", "''") + "'"

def main(ruta_zip):
    z = zipfile.ZipFile(ruta_zip)
    municipios = json.loads((REF / "municipios.json").read_text(encoding="utf-8"))
    provincias = {p["codigo"]: p for p in json.loads((REF / "provincias.json").read_text(encoding="utf-8"))}

    # --- mesas y censo (fichero 09)
    mesas = {}
    for l in leer_dat(z, "09"):
        if len(l) < 30:
            continue
        prov, muni, dist, secc, mesa = l[11:13], l[13:16], l[16:18], l[18:22].strip(), l[22:23].strip()
        if muni == "999" or not prov.isdigit():   # 999 = voto de residentes ausentes (CERA), no son mesas físicas
            continue
        secc = secc.zfill(3)
        mid = f"{prov}-{muni}-{dist}-{secc}-{mesa}"
        try:
            censo = int(l[23:30])
        except ValueError:
            censo = None
        mesas[mid] = {"id": mid, "prov": prov, "muni": muni, "distrito": dist, "seccion": secc, "mesa": mesa,
                      "municipio": municipios.get(prov + muni, muni), "censo": censo}

    # --- mesas del 29N sacadas de los boletines provinciales (scripts/mesas_desde_bop.py): sustituyen a las del 23J
    #     en esas provincias. Se conserva el censo del 23J cuando la mesa existía; las nuevas quedan sin censo.
    origen = {}
    for f in sorted((REF / "mesas29n").glob("*.json")) if (REF / "mesas29n").exists() else []:
        prov = f.stem; nuevas = json.loads(f.read_text(encoding="utf-8"))
        antes = {k: v for k, v in mesas.items() if v["prov"] == prov}
        for k in antes: del mesas[k]
        for n in nuevas:
            mesas[n["id"]] = {"id": n["id"], "prov": prov, "muni": n["muni"], "distrito": n["distrito"], "seccion": n["seccion"], "mesa": n["mesa"],
                              "municipio": municipios.get(prov + n["muni"]) or nombre_ine(n.get("municipio_ine")) or n["muni"], "censo": antes.get(n["id"], {}).get("censo"),
                              "local": n.get("local") or None, "direccion": n.get("direccion") or None}
        origen[prov] = "29N"
        print(f"  provincia {prov}: lista del 29N ({len(nuevas)} mesas) en lugar de la del 23J ({len(antes)})")

    # --- candidaturas (03) y votos por provincia (10) para ordenarlas
    siglas = {}
    for l in leer_dat(z, "03"):
        if len(l) >= 20:
            siglas[l[8:14]] = (l[14:64].strip(), l[64:214].strip())
    votos_prov = {}
    for l in leer_dat(z, "10"):
        if len(l) < 36 or l[13:16] == "999":
            continue
        prov, cod = l[11:13], l[23:29]
        try:
            v = int(l[29:36])
        except ValueError:
            continue
        votos_prov.setdefault(prov, {}).setdefault(cod, 0)
        votos_prov[prov][cod] += v

    # --- salida JSON para la web
    (DATOS / "mesas").mkdir(parents=True, exist_ok=True)
    (DATOS / "candidaturas").mkdir(parents=True, exist_ok=True)
    SQL.mkdir(exist_ok=True)
    por_prov = {}
    for m in mesas.values():
        por_prov.setdefault(m["prov"], []).append(m)
    lista_prov = []
    for prov, ms in sorted(por_prov.items()):
        ms.sort(key=lambda m: m["id"])
        munis = {m["muni"]: m["municipio"] for m in ms}
        (DATOS / "mesas" / f"{prov}.json").write_text(json.dumps(
            {"prov": prov, "lista": origen.get(prov, "23J"), "municipios": munis,
             "mesas": [[m["id"], m["censo"]] + ([m["local"]] if m.get("local") else []) for m in ms]},
            ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        cands = sorted(votos_prov.get(prov, {}).items(), key=lambda kv: -kv[1])
        clist = [{"codigo": c, "siglas": siglas.get(c, (c, ""))[0], "denominacion": siglas.get(c, ("", ""))[1], "orden": i + 1}
                 for i, (c, _) in enumerate(cands)]
        (DATOS / "candidaturas" / f"{prov}.json").write_text(json.dumps(
            {"prov": prov, "fuente": "23J 2023 (provisional: sustituir por las candidaturas proclamadas)", "candidaturas": clist},
            ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        info = provincias.get(prov, {"nombre": prov, "ccaa": ""})
        lista_prov.append({"prov": prov, "nombre": info["nombre"], "ccaa": info.get("ccaa", ""), "mesas": len(ms), "lista": origen.get(prov, "23J")})
    (DATOS / "provincias.json").write_text(json.dumps(lista_prov, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # --- SQL para D1 (lotes de 500 filas)
    with open(SQL / "01_mesas.sql", "w", encoding="utf-8") as f:
        f.write("DELETE FROM mesas;\n")
        filas = list(mesas.values())
        for i in range(0, len(filas), 500):
            n = lambda v: s(v) if v else "NULL"
            vals = ",".join(f"({s(m['id'])},{s(m['prov'])},{s(m['muni'])},{s(m['distrito'])},{s(m['seccion'])},{s(m['mesa'])},{s(m['municipio'])},{m['censo'] if m['censo'] is not None else 'NULL'},{n(m.get('local'))},{n(m.get('direccion'))})" for m in filas[i:i + 500])
            f.write(f"INSERT INTO mesas (id,prov,muni,distrito,seccion,mesa,municipio,censo,local,direccion) VALUES {vals};\n")
    if (REF / "candidaturas_29N.csv").exists():
        import subprocess
        subprocess.run([sys.executable, str(pathlib.Path(__file__).parent / "candidaturas_desde_csv.py"), str(REF / "candidaturas_29N.csv")], check=True)
    else:
      with open(SQL / "02_candidaturas.sql", "w", encoding="utf-8") as f:
          f.write("DELETE FROM candidaturas;\n")
          for prov in sorted(por_prov):
              data = json.loads((DATOS / "candidaturas" / f"{prov}.json").read_text(encoding="utf-8"))
              for c in data["candidaturas"]:
                  f.write(f"INSERT INTO candidaturas (prov,codigo,siglas,denominacion,orden) VALUES ({s(prov)},{s(c['codigo'])},{s(c['siglas'])},{s(c['denominacion'])},{c['orden']});\n")

    total = sum(p["mesas"] for p in lista_prov)
    print(f"OK: {total} mesas en {len(lista_prov)} provincias. Datos en {DATOS}, SQL en {SQL}.")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
