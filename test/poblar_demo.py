# Rellena el servidor local con envíos simulados en varias provincias, para ver el mapa y los resultados con datos.
# Uso (con el servidor local en marcha): python3 test/poblar_demo.py
import json, random, sys, uuid
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, "test")
import api_test as T

random.seed(29)
ESCALA = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
# provincia -> fracción de mesas que se fotografían (dos personas cada una)
PLAN = {"28": 0.06, "08": 0.04, "46": 0.08, "41": 0.05, "12": 0.25, "33": 0.10, "50": 0.07, "48": 0.06, "15": 0.05, "30": 0.09,
        "03": 0.05, "29": 0.04, "11": 0.06, "35": 0.05, "38": 0.04, "47": 0.12, "18": 0.05, "31": 0.08}
PESOS = [(r"PP", 33), (r"PSOE|PSC|PSdeG|PSE|PSIB", 30), (r"VOX", 14), (r"FRENTE AMPLIO|^FA$|COMUNS|SUMAR|COMPROMIS", 8), (r"PODEMOS", 3), (r"SALF", 3),
         (r"ERC", 9), (r"JxCat", 8), (r"BILDU", 20), (r"PNV", 22), (r"B\.?N\.?G", 15)]
import re

def cifras_para(prov):
    cands = json.load(open(f"public/data/candidaturas/{prov}.json"))["candidaturas"]
    electores = random.randint(400, 900); votantes = int(electores * random.uniform(0.6, 0.8))
    pesos = []
    for c in cands:
        w = 0.4
        for pat, pw in PESOS:
            if re.search(pat, c["siglas"]): w = pw * random.uniform(0.6, 1.4); break
        pesos.append(w)
    nulos = random.randint(0, 8); blanco = random.randint(2, 12); resto = votantes - nulos - blanco
    tot = sum(pesos); votos = [int(resto * w / tot) for w in pesos]; votos[pesos.index(max(pesos))] += resto - sum(votos)
    return {"electores": electores, "votantes": votantes, "nulos": nulos, "blanco": blanco, "cand": {c["codigo"]: v for c, v in zip(cands, votos)}}

def envio(args):
    mesa, cif, k = args
    T.cands = {c["siglas"]: c["codigo"] for c in json.load(open(f"public/data/candidaturas/{mesa[:2]}.json"))["candidaturas"]}
    lect = {"es_acta": True, "inapropiada": False, **{x: cif[x] for x in ("electores", "votantes", "nulos", "blanco")}, "votos": list(cif["cand"].values())}
    return T.post_envio(cif, variante=random.randint(1, 10**6), ip=f"10.{random.randint(0,255)}.{random.randint(0,255)}.{k}", mesa=mesa, lectura=lect)[0]

trabajos = []
for prov, frac in PLAN.items():
    mesas = [m[0] for m in json.load(open(f"public/data/mesas/{prov}.json"))["mesas"]]
    for mesa in random.sample(mesas, max(3, int(len(mesas) * frac * ESCALA))):
        cif = cifras_para(prov); trabajos += [(mesa, cif, 1), (mesa, cif, 2)]
print(len(trabajos), "envíos")
with ThreadPoolExecutor(8) as ex: cods = list(ex.map(envio, trabajos))
print({c: cods.count(c) for c in set(cods)})
for _ in range(80):   # recalcula y vacía la cola de lectura automática
    T.cron(); e = T.get("/admin/api/estadisticas", admin=True)[1]
    if not e["pendientes_recalculo"] and not e.get("lecturas_pendientes"): break
print(T.get("/admin/api/estadisticas", admin=True)[1])
