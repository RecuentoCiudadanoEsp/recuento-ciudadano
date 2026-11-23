# 600 envíos a 600 mesas distintas, 30 en paralelo, contra el Worker local. Mide errores y latencias.
import json, random, time, concurrent.futures as cf, sys
sys.path.insert(0, "test")
import api_test as T  # reutiliza post_envio (no ejecuta pruebas: ver guardia abajo)
import io, hashlib
from PIL import Image
mesas = [m[0] for p in ["08","28","41","46"] for m in json.load(open(f"public/data/mesas/{p}.json"))["mesas"]][:600]
cands = {p: [c["codigo"] for c in json.load(open(f"public/data/candidaturas/{p}.json"))["candidaturas"]] for p in ["08","28","41","46"]}
base = Image.open(T.ACTA).convert("RGB"); base.thumbnail((1600, 3200))
def uno(i):
    mesa = mesas[i]; cs = cands[mesa[:2]]; v = {c: random.randint(0, 60) for c in cs}
    cif = {"electores": 700, "votantes": sum(v.values()) + 6, "nulos": 3, "blanco": 3, "cand": v}
    im = base.copy(); im.putpixel((i % 500, 5), (i % 255, 0, 0))
    b = io.BytesIO(); im.save(b, "JPEG", quality=78); foto = b.getvalue()
    m = io.BytesIO(); im.resize((480, 680)).save(m, "JPEG", quality=60)
    datos = {"mesa_id": mesa, "cifras": cif, "hash": hashlib.sha256(foto).hexdigest(), "dhash": f"{i:016x}", "dispositivo": f"d{i}"}
    body, bnd = T.multipart({"foto": foto, "mini": m.getvalue(), "datos": json.dumps(datos)})
    req = T.urllib.request.Request(T.BASE + "/api/envio", data=body, method="POST", headers={"content-type": f"multipart/form-data; boundary={bnd}", "cf-connecting-ip": f"10.1.{i//200}.{i%200}"})
    t = time.time()
    try:
        with T.urllib.request.urlopen(req) as r: s = r.status
    except T.urllib.error.HTTPError as e: s = e.code
    return s, time.time() - t
t0 = time.time()
with cf.ThreadPoolExecutor(30) as ex: res = list(ex.map(uno, range(len(mesas))))
lat = sorted(r[1] for r in res); codes = {}
for s, _ in res: codes[s] = codes.get(s, 0) + 1
print(f"{len(res)} envíos en {time.time()-t0:.1f} s · códigos {codes} · latencia mediana {lat[len(lat)//2]*1000:.0f} ms · p95 {lat[int(len(lat)*.95)]*1000:.0f} ms")
t = time.time(); T.urllib.request.urlopen(T.BASE + "/__scheduled?cron=*+*+*+*+*").read(); print(f"recálculo de consenso lanzado ({time.time()-t:.1f} s)")
