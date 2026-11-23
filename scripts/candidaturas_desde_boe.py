"""
Extrae del BOE las candidaturas proclamadas al Congreso, por provincia y en el orden del acta.

Uso:
    pdftotext -layout eg2026_candidaturas_proclamadas.pdf proc.txt
    python3 scripts/candidaturas_desde_boe.py proc.txt          -> cands29n.json

Excluye las listas "No proclamada". Para el 29N da 534 candidaturas (21 no proclamadas), las cifras oficiales.
Las correcciones de errores posteriores (BOE 278, 7/11/2026) se aplicaron a mano: en Navarra la candidatura 1
pasa a "EUSKAL HERRIA BILDU (EH BILDU)". El resultado final está en scripts/ref/candidaturas_29N.csv.
"""
import re, json, unicodedata, sys
def norm(s): return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").upper().strip()
PROV = {norm(k): v for k, v in {
 "ALBACETE":"02","ALICANTE":"03","ALMERÍA":"04","ÁLAVA":"01","ASTURIAS":"33","ÁVILA":"05","BADAJOZ":"06","ILLES BALEARS":"07","BARCELONA":"08",
 "BIZKAIA":"48","BURGOS":"09","CÁCERES":"10","CÁDIZ":"11","CANTABRIA":"39","CASTELLÓN":"12","CIUDAD REAL":"13","CÓRDOBA":"14","A CORUÑA":"15",
 "CUENCA":"16","GIPUZKOA":"20","GIRONA":"17","GRANADA":"18","GUADALAJARA":"19","HUELVA":"21","HUESCA":"22","JAÉN":"23","LEÓN":"24","LLEIDA":"25",
 "LUGO":"27","MADRID":"28","MÁLAGA":"29","MURCIA":"30","NAVARRA":"31","OURENSE":"32","PALENCIA":"34","LAS PALMAS":"35","PONTEVEDRA":"36",
 "LA RIOJA":"26","SALAMANCA":"37","SANTA CRUZ DE TENERIFE":"38","SEGOVIA":"40","SEVILLA":"41","SORIA":"42","TARRAGONA":"43","TERUEL":"44",
 "TOLEDO":"45","VALENCIA":"46","VALLADOLID":"47","ZAMORA":"49","ZARAGOZA":"50","CEUTA":"51","MELILLA":"52"}.items()}
lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
NOPROC = []; res = {}; prov = None; sec = None; exp = 1; i = 0
ruido = re.compile(r"BOLETÍN OFICIAL|Núm\. \d+|Verificable en|cve: BOE")
while i < len(lines):
    l = lines[i]; t = l.strip()
    m = re.match(r"JUNTA ELECTORAL (?:PROVINCIAL )?DE (.+)$", t)
    if m:
        p = PROV.get(norm(m.group(1)))
        if not p: sys.exit("provincia desconocida: " + t)
        if p != prov: prov = p; exp = res.get(p) and len(res[p]) + 1 or 1
        sec = None; i += 1; continue
    if t == "CONGRESO DE LOS DIPUTADOS": sec = "C"; exp = len(res.get(prov, [])) + 1; i += 1; continue
    if t == "SENADO": sec = "S"; i += 1; continue
    if sec == "C" and prov:
        m = re.match(r"^(\d+)\.\s+(.+)$", t)
        if m and int(m.group(1)) == exp:
            # siguientes líneas no vacías ni de ruido
            sig_lines = []; j = i + 1
            while j < len(lines) and len(sig_lines) < 3:
                x = lines[j].strip()
                if x and not ruido.search(x): sig_lines.append((j, x))
                j += 1
            if sig_lines and sig_lines[0][1].startswith("No proclamada"):
                NOPROC.append((prov, t)); exp += 1; i = sig_lines[0][0] + 1; continue          # lista no proclamada: no aparece en el acta
            letras = [c for c in m.group(2)[:25] if c.isalpha()]
            upper = sum(c.isupper() for c in letras) / max(1, len(letras))
            if not t.endswith(".") and (upper > 0.7 or "(" in t):
                texto = m.group(2); fin = i
                for (j, x) in sig_lines:                              # continuación del nombre en la línea siguiente
                    if re.match(r"^\d+\.\s", x) or x.startswith("Suplente"): break
                    if x.startswith("(") or (sum(c.isupper() for c in x if c.isalpha()) / max(1, sum(c.isalpha() for c in x)) > 0.8 and "(" not in texto) or texto.count("(") > texto.count(")"):
                        texto += " " + x; fin = j
                    else: break
                k = fin + 1
                while k < len(lines) and (not lines[k].strip() or ruido.search(lines[k])): k += 1
                if k < len(lines) and lines[k].strip().startswith("No proclamada"):
                    NOPROC.append((prov, texto)); exp += 1; i = k + 1; continue
                texto = re.sub(r"\s+", " ", texto).strip()
                if "PSE-EE" in texto: den, sig = "PARTIDO SOCIALISTA DE EUSKADI-EUSKADIKO EZKERRA (PSOE)", "PSE-EE (PSOE)"
                else:
                    mm = re.match(r"^(.*)\((.+?)\)\s*$", texto)
                    den, sig = (mm.group(1).strip(), mm.group(2).strip()) if mm else (texto, texto)
                res.setdefault(prov, []).append({"orden": exp, "siglas": sig, "denominacion": den})
                exp += 1; i = fin + 1; continue
    i += 1
json.dump(res, open("cands29n.json", "w"), ensure_ascii=False, indent=0)
print("no proclamadas Congreso:", len(NOPROC)); print("provincias:", len(res), "candidaturas Congreso:", sum(len(v) for v in res.values()))
for p in sorted(res): print(p, len(res[p]), " | ".join(c["siglas"] for c in res[p]))
