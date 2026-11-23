# Prueba de extremo a extremo contra el Worker local (wrangler dev en :8787, MODO_PRUEBAS=1)
import hashlib, io, json, sys, urllib.request, uuid
from PIL import Image, ImageOps, ImageDraw
ZONA = (0, 0.27, 0.29, 0.7)   # misma zona que ZONAS_DIFUMINADO: la web la tapa siempre antes de subir

BASE = "http://127.0.0.1:8787"
ADMIN = "token-de-pruebas-1234567890-abcdefghijk"
ACTA = __import__("os").environ.get("ACTA", "test/acta.jpg")   # foto de un acta real; no se incluye (muestra nombres y firmas)

def tapar(img):
    im = img.copy(); W, H = im.size; x, y, w, h = ZONA
    ImageDraw.Draw(im).rectangle([int(x * W), int(y * H), int((x + w) * W), int((y + h) * H)], fill=(43, 43, 43)); return im

def jpeg(img, ancho, q, lectura=None):
    im = img.copy(); im.thumbnail((ancho, ancho * 2)); b = io.BytesIO(); im.save(b, "JPEG", quality=q); d = b.getvalue()
    if lectura is not None:   # lectura automática simulada (solo con IA_SIMULADA): JSON en un comentario JPEG
        t = json.dumps(lectura).encode(); d = d[:2] + b"\xff\xfe" + (len(t) + 2).to_bytes(2, "big") + t + d[2:]
    return d

def lectura_de(cifras, **extra):
    l = {"es_acta": True, "inapropiada": False, "electores": cifras["electores"], "votantes": cifras["votantes"], "nulos": cifras["nulos"], "blanco": cifras["blanco"],
         "votos": [cifras["cand"][c] for c in cands.values()]}
    l.update(extra); return l

def lectura_pares(cifras, dudosos=()):
    # como la devolvería el modelo: [cifra en número, cifra en letra]; en "dudosos" la letra no coincide
    par = lambda k, v: [v, v + 1 if k in dudosos else v]
    return {"es_acta": True, "inapropiada": False, **{k: par(k, cifras[k]) for k in ("electores", "votantes", "nulos", "blanco")},
            "votos": [par(cod, cifras["cand"][cod]) for cod in cands.values()]}

def multipart(campos):
    bnd = uuid.uuid4().hex; out = io.BytesIO()
    for k, v in campos.items():
        out.write(f"--{bnd}\r\n".encode())
        if isinstance(v, bytes):
            out.write(f'Content-Disposition: form-data; name="{k}"; filename="{k}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()); out.write(v)
        else:
            out.write(f'Content-Disposition: form-data; name="{k}"\r\n\r\n{v}'.encode())
        out.write(b"\r\n")
    out.write(f"--{bnd}--\r\n".encode()); return out.getvalue(), bnd

def post_envio(cifras, variante=0, disp=None, ip="1.1.1.1", mesa="12-002-01-001-U", sin_tapar=False, lectura="auto", imagen=None):
    img = ImageOps.exif_transpose(Image.open(imagen or ACTA)).convert("RGB")
    if variante: img = img.rotate(variante * 0.3, expand=False, fillcolor="white")   # foto distinta => huella distinta
    if not sin_tapar: img = tapar(img)
    if lectura == "auto": lectura = lectura_de(cifras) if cifras.get("cand") and len(cifras["cand"]) == len(cands) else None
    foto = jpeg(img, 1600, 80, lectura); mini = jpeg(img, 480, 65)
    datos = {"mesa_id": mesa, "cifras": cifras, "hash": hashlib.sha256(foto).hexdigest(), "dhash": f"{variante:016x}",
             "dispositivo": disp or uuid.uuid4().hex, "geo": None, "ts_foto": None}
    body, bnd = multipart({"foto": foto, "mini": mini, "datos": json.dumps(datos)})
    req = urllib.request.Request(BASE + "/api/envio", data=body, method="POST",
                                 headers={"content-type": f"multipart/form-data; boundary={bnd}", "cf-connecting-ip": ip})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())

def get(path, admin=False, method="GET", body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"authorization": "Bearer " + ADMIN, "content-type": "application/json"} if admin else {})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")

def cron():
    import time
    urllib.request.urlopen(BASE + "/__scheduled?cron=*+*+*+*+*").read(); time.sleep(2.2)

cands = {c["siglas"]: c["codigo"] for c in json.load(open("public/data/candidaturas/12.json"))["candidaturas"]}
def cifras_ain(**cambios):
    # Cifras reales del acta de Aín (23J) repartidas sobre las candidaturas del 29N en Castellón: suman 94 + 1 blanco + 1 nulo = 96
    v = {k: 0 for k in cands}
    v.update({"PSOE": 31, "PP": 19, "VOX": 9, "COMPROMIS-EUPV-PODEM-ERPV": 33, "PACMA": 1, "SALF": 1})
    v.update(cambios)
    return {"electores": 121, "votantes": 96, "nulos": 1, "blanco": 1, "cand": {cands[k]: n for k, n in v.items()}}

def post_nueva(mesa, variante, ip):
    import types
    img = tapar(ImageOps.exif_transpose(Image.open(ACTA)).convert("RGB").rotate(variante * 0.3, fillcolor="white"))
    foto = jpeg(img, 1600, 80, lectura_de(cifras_ain())); mini = jpeg(img, 480, 65)
    datos = {"mesa_id": mesa, "mesa_nueva": True, "cifras": cifras_ain(), "hash": hashlib.sha256(foto).hexdigest(), "dhash": f"{variante:016x}", "dispositivo": uuid.uuid4().hex}
    body, bnd = multipart({"foto": foto, "mini": mini, "datos": json.dumps(datos)})
    req = urllib.request.Request(BASE + "/api/envio", data=body, method="POST", headers={"content-type": f"multipart/form-data; boundary={bnd}", "cf-connecting-ip": ip})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())

if __name__ == "__main__":
    ok = True
    def check(nombre, cond, extra=""):
        global ok; ok &= bool(cond); print(("OK   " if cond else "FALLO"), nombre, extra)

    s, r = post_envio(cifras_ain(), variante=0, ip="10.0.0.1"); check("envío 1 aceptado y cuadra", s == 200 and r["cuadra"], r)
    s, r2 = post_envio(cifras_ain(), variante=0, ip="10.0.0.2"); check("misma foto rechazada como duplicada", s == 409, r2)
    s, r = post_envio(cifras_ain(), variante=1, ip="10.0.0.2"); check("envío 2 (otra persona) aceptado", s == 200, r)
    cron(); s, p = get("/api/public/prov/12.json"); m = next((x for x in p["mesas"] if x["id"] == "12-002-01-001-U"), None)
    check("mesa de Aín verificada con 2 fuentes", m and m["estado"] == "verificada" and m["indep"] == 2, m and (m["estado"], m["indep"]))
    s, r = post_envio(cifras_ain(PP=29, PSOE=21), variante=2, ip="10.0.0.3"); check("versión alterada que cuadra aceptada", s == 200 and r["cuadra"], r)
    cron(); s, p = get("/api/public/prov/12.json"); m = next(x for x in p["mesas"] if x["id"] == "12-002-01-001-U")
    check("mesa pasa a conflicto", m["estado"] == "conflicto", m["estado"])
    s, r = post_envio(cifras_ain(VOX=19), variante=3, ip="10.0.0.4"); check("acta que no cuadra RECHAZADA", s == 400 and r["error"] == "no_cuadra", r)
    s, r = post_envio({"electores": 121, "votantes": 96, "nulos": 1, "blanco": 1, "cand": {}}, variante=4, ip="10.0.0.5"); check("cifras incompletas rechazadas", s == 400, r)
    s, r = post_envio(cifras_ain(), variante=5, ip="10.0.0.6", mesa="99-999-99-999-Z"); check("mesa inexistente rechazada", s == 400, r)
    s, r = get("/admin/api/estadisticas"); check("panel sin contraseña rechazado", s == 401)
    s, q = get("/admin/api/cola?estado=conflicto,revision", admin=True); check("cola del panel con la mesa en conflicto", s == 200 and any(x["mesa_id"] == "12-002-01-001-U" for x in q["mesas"]))
    alterada = next(e for m_ in q["mesas"] for e in m_["envios"] if e["cifras"]["cand"][cands["PP"]] == 29)
    s, r = get("/admin/api/decision", admin=True, method="POST", body={"hash": alterada["hash"], "decision": "invalida", "motivo": "Cifras mal copiadas respecto a la foto"})
    check("invalidar la versión alterada", s == 200)
    cron(); s, p = get("/api/public/prov/12.json"); m = next(x for x in p["mesas"] if x["id"] == "12-002-01-001-U")
    check("mesa vuelve a verificada tras invalidar", m["estado"] == "verificada", m["estado"])
    check("la foto invalidada sigue visible con motivo", any(f["est"] == "invalida" and f["mot"] for f in m["fotos"]))
    s, d = get("/api/public/decisiones.json"); check("decisión en el registro público", s == 200 and len(d["decisiones"]) >= 1)
    s, res = get("/api/public/resumen.json"); n = res["nacional"]
    check("resumen nacional con el total del INE (61.033)", n["mesas"] == 61033 and n["verificada"] >= 1, {k: n[k] for k in ("mesas", "con_envio", "verificada", "conflicto", "revision")})
    check("totales por siglas", res["nacional"]["votos"].get("PSOE") == 31, res["nacional"]["votos"])
    s, r = post_nueva("12-002-01-001-B", 30, "10.3.0.1"); check("mesa que no está en la lista aceptada como nueva", s == 200 and "mesa_nueva" in r["avisos"], r)
    s, r = post_nueva("12-999-01-001-A", 31, "10.3.0.2"); check("municipio inexistente rechazado", s == 400, r)
    s, r = post_nueva("12-002-01-002-A", 32, "10.3.0.3"); check("otra mesa nueva aceptada", s == 200, r); h_conf = r.get("hash")
    s, r = post_nueva("12-002-01-002-A", 33, "10.3.0.4"); check("segunda foto de esa mesa nueva", s == 200, r)
    cron(); s, p = get("/api/public/prov/12.json"); mn = next((x for x in p["mesas"] if x["id"] == "12-002-01-002-A"), None)
    check("mesa nueva no cuenta hasta confirmarla", mn and mn["estado"] == "revision" and mn["nueva"] == 1, mn and (mn["estado"], mn["nueva"]))
    s, q = get("/admin/api/cola?estado=nuevas", admin=True); ids = [x["mesa_id"] for x in q["mesas"]]
    check("cola de mesas nuevas en el panel", "12-002-01-001-B" in ids and "12-002-01-002-A" in ids, ids)
    s, lm = get("/admin/api/mesas_municipio?prov=12&muni=002", admin=True); check("lista de mesas del municipio para reasignar", any(x["id"] == "12-002-01-001-U" for x in lm["mesas"]), lm)
    hb = next(e["hash"] for x in q["mesas"] if x["mesa_id"] == "12-002-01-001-B" for e in x["envios"])
    s, r = get("/admin/api/reasignar", admin=True, method="POST", body={"hash": hb, "mesa_destino": "12-002-01-001-u"}); check("reasignar la foto a la mesa correcta", s == 200, r)
    s, r = get("/admin/api/reasignar", admin=True, method="POST", body={"hash": hb, "mesa_destino": "28-079-01-001-A"}); check("reasignar a otra provincia rechazado", s == 400, r)
    s, q = get("/admin/api/cola?estado=nuevas", admin=True); check("la mesa nueva vacía desaparece tras reasignar", "12-002-01-001-B" not in [x["mesa_id"] for x in q["mesas"]])
    s, r = get("/admin/api/confirmar_mesa", admin=True, method="POST", body={"mesa_id": "12-002-01-002-A"}); check("confirmar mesa nueva", s == 200, r)
    cron(); s, p = get("/api/public/prov/12.json"); mn = next(x for x in p["mesas"] if x["id"] == "12-002-01-002-A")
    check("mesa confirmada se verifica con sus dos fotos", mn["estado"] == "verificada" and mn["nueva"] == 0, (mn["estado"], mn["nueva"]))
    mu = next(x for x in p["mesas"] if x["id"] == "12-002-01-001-U"); check("la foto reasignada cuenta en su mesa", mu["n"] >= 4, mu["n"])
    otras = [m[0] for m in json.load(open("public/data/mesas/12.json"))["mesas"] if not m[0].startswith("12-002-")][:18]
    # Dos personas distintas detrás de la misma IP móvil (CGNAT) verifican su mesa
    post_envio(cifras_ain(), variante=40, ip="10.5.5.5", mesa=otras[0]); post_envio(cifras_ain(), variante=41, ip="10.5.5.5", mesa=otras[0])
    cron(); s, p = get("/api/public/prov/12.json"); mx = next(x for x in p["mesas"] if x["id"] == otras[0])
    check("misma IP compartida, dos dispositivos: mesa verificada", mx["estado"] == "verificada" and mx["indep"] == 2, (mx["estado"], mx["indep"]))
    # Una sola red muy activa (8 mesas distintas en una hora) no puede verificar mesas sola cambiando de dispositivo
    for k in range(1, 9): post_envio(cifras_ain(), variante=50 + k, ip="10.6.6.6", mesa=otras[k])
    post_envio(cifras_ain(PP=40, PSOE=10), variante=60, ip="10.6.6.6", mesa=otras[9]); post_envio(cifras_ain(PP=40, PSOE=10), variante=61, ip="10.6.6.6", mesa=otras[9])
    cron(); s, p = get("/api/public/prov/12.json"); my = next(x for x in p["mesas"] if x["id"] == otras[9])
    check("red sospechosa: sus dispositivos cuentan como una sola fuente", my["estado"] == "pendiente" and my["indep"] == 1, (my["estado"], my["indep"]))
    disp_fijo = uuid.uuid4().hex
    codes = [post_envio(cifras_ain(), variante=70 + i, ip=f"10.8.0.{i}", disp=disp_fijo, mesa=otras[i % 3])[0] for i in range(12)]
    check("límite por dispositivo (10 en 10 min)", codes.count(429) >= 1, codes[-3:])
    codes = [post_envio(cifras_ain(), variante=90 + i, ip="10.9.9.9")[0] for i in range(25)]
    check("25 envíos desde una misma IP compartida no se bloquean", codes.count(429) == 0, codes[-3:])
    def codigo_foto(h, tipo="foto"):
        try: return urllib.request.urlopen(BASE + f"/api/{tipo}/{h}.jpg").status
        except urllib.error.HTTPError as e: return e.code
    cron(); s, p = get("/api/public/prov/12.json"); m = next(x for x in p["mesas"] if x["id"] == "12-002-01-001-U")
    pubs = [f["h"] for f in m["fotos"] if f["pub"]]
    check("mesa verificada: sus fotos coincidentes son públicas", len(pubs) >= 2, len(pubs))
    check("foto pública servida", codigo_foto(pubs[0]) == 200)
    check("foto invalidada no se sirve", codigo_foto(alterada["hash"]) == 404)
    pend = next(f for x in p["mesas"] if x["estado"] == "pendiente" for f in x["fotos"])
    check("foto de mesa pendiente (1 fuente) no se sirve", not pend["pub"] and codigo_foto(pend["h"], "mini") == 404)
    rq = urllib.request.Request(BASE + f"/admin/api/foto/{pend['h']}.jpg", headers={"authorization": "Bearer " + ADMIN})
    check("el panel sí ve la foto no pública", urllib.request.urlopen(rq).status == 200)
    def denunciar(h, ip):
        rq = urllib.request.Request(BASE + "/api/denuncia", data=json.dumps({"hash": h}).encode(), method="POST", headers={"content-type": "application/json", "cf-connecting-ip": ip})
        return urllib.request.urlopen(rq).status
    victima = pubs[0]
    denunciar(victima, "10.20.0.1"); denunciar(victima, "10.20.0.1")
    s, p = get("/api/public/prov/12.json"); cron(); s, p = get("/api/public/prov/12.json")
    check("una sola red denunciando (aunque repita) no oculta", next(f for x in p["mesas"] for f in x["fotos"] if f["h"] == victima)["pub"] == 1)
    denunciar(victima, "10.20.0.2"); cron(); s, p = get("/api/public/prov/12.json")
    fv = next(f for x in p["mesas"] for f in x["fotos"] if f["h"] == victima)
    check("dos redes distintas: la foto se oculta", fv["pub"] == 0 and fv["den"] == 1, fv)
    s, q = get("/admin/api/cola?estado=fotos", admin=True); check("aparece en la cola de fotos sospechosas", any(x["mesa_id"] == "12-002-01-001-U" for x in q["mesas"]))
    s, r = get("/admin/api/aprobar_foto", admin=True, method="POST", body={"hash": victima}); cron()
    s, p = get("/api/public/prov/12.json"); fv = next(f for x in p["mesas"] for f in x["fotos"] if f["h"] == victima)
    check("foto aprobada a mano: vuelve a ser pública", fv["pub"] == 1, fv)
    denunciar(victima, "10.20.0.3"); cron(); s, p = get("/api/public/prov/12.json"); fv = next(f for x in p["mesas"] for f in x["fotos"] if f["h"] == victima)
    check("una foto aprobada ya no se oculta por denuncias", fv["pub"] == 1, fv)

    # ---- Comprobaciones de la imagen
    m2 = otras[10]
    s, r = post_envio(cifras_ain(), variante=300, ip="10.30.0.1", mesa=m2, sin_tapar=True)
    check("foto con los nombres sin tapar: se acepta pero en cuarentena", s == 200 and "nombres_sin_tapar" in r["avisos"] and r["foto_en_revision"], r)
    s, r = post_envio(cifras_ain(), variante=301, ip="10.30.0.2", mesa=m2); cron()
    s, p = get("/api/public/prov/12.json"); mm = next(x for x in p["mesas"] if x["id"] == m2)
    check("la foto sin tapar no cuenta (mesa con 1 fuente) ni se publica", mm["estado"] == "pendiente" and mm["indep"] == 1 and sum(f["pub"] for f in mm["fotos"]) == 0, (mm["estado"], [(f["pub"], f["f"]) for f in mm["fotos"]]))
    noacta = "/tmp/no_acta_test.jpg"; Image.new("RGB", (1200, 1600), (220, 40, 120)).save(noacta)
    s, r = post_envio(cifras_ain(), variante=0, ip="10.30.0.3", mesa=m2, imagen=noacta); cron()
    check("imagen que no es un acta: detectada sin IA", s == 200 and "no_parece_acta" in r["avisos"], r)
    s, p = get("/api/public/prov/12.json"); mm = next(x for x in p["mesas"] if x["id"] == m2)
    check("…y no se publica aunque la mesa esté verificada", not any(f["pub"] and "no_parece_acta" in f["f"] for f in mm["fotos"]))
    s, q = get("/admin/api/cola?estado=fotos", admin=True); check("las dos aparecen en Fotos sospechosas", sum(1 for x in q["mesas"] if x["mesa_id"] == m2) == 1 and sum(1 for x in q["mesas"] for e in x["envios"] if e["mesa_id"] == m2 and (set(e["flags"]) & {"no_parece_acta", "nombres_sin_tapar"})) == 2)
    h_sin = next(e["hash"] for x in q["mesas"] if x["mesa_id"] == m2 for e in x["envios"] if "nombres_sin_tapar" in e["flags"])
    img2 = tapar(ImageOps.exif_transpose(Image.open(ACTA)).convert("RGB")); f2 = jpeg(img2, 1600, 80); m2b = jpeg(img2, 480, 65)
    body, bnd = multipart({"hash": h_sin, "foto": f2, "mini": m2b})
    rq = urllib.request.Request(BASE + "/admin/api/retapar", data=body, method="POST", headers={"content-type": f"multipart/form-data; boundary={bnd}", "authorization": "Bearer " + ADMIN})
    r = json.loads(urllib.request.urlopen(rq).read()); cron()
    s, p = get("/api/public/prov/12.json"); fr = next(f for x in p["mesas"] for f in x["fotos"] if f["h"] == h_sin)
    servida = urllib.request.urlopen(BASE + f"/api/foto/{h_sin}.jpg").read()
    check("tapar nombres a mano: se sustituye la foto, se publica y queda en el registro", r["ok"] and fr["pub"] == 1 and hashlib.sha256(servida).hexdigest() == r["huella"] and "nombres_sin_tapar" not in fr["f"], fr["f"])
    s, q = get("/admin/api/mesa?id=" + m2, admin=True); hs_pub = next(e["hash"] for e in q["mesas"][0]["envios"] if e["publica"] and e["hash"] != h_sin)
    body, bnd = multipart({"hash": hs_pub, "foto": f2, "mini": m2b})
    rq = urllib.request.Request(BASE + "/admin/api/retapar", data=body, method="POST", headers={"content-type": f"multipart/form-data; boundary={bnd}", "authorization": "Bearer " + ADMIN})
    r = json.loads(urllib.request.urlopen(rq).read()); cron(); s, d = get("/api/public/decisiones.json")
    check("también se puede tapar una foto ya publicada (queda en el registro)", r["ok"] and any(x["hash"] == hs_pub and x["decision"] == "foto_retapada" for x in d["decisiones"]))

    # ---- Lectura automática (simulada en local)
    m3 = otras[11]
    s, r = post_envio(cifras_ain(), variante=310, ip="10.31.0.1", mesa=m3, lectura=lectura_de(cifras_ain(), es_acta=False, inapropiada=True))
    h_ia = r["hash"]; s, r = post_envio(cifras_ain(), variante=311, ip="10.31.0.2", mesa=m3); cron()
    s, q = get("/admin/api/mesa?id=" + m3, admin=True); fl = next(e for e in q["mesas"][0]["envios"] if e["hash"] == h_ia)["flags"]
    check("la IA marca imagen inapropiada / no acta: cuarentena", "ia_inapropiada" in fl and "ia_no_acta" in fl, fl)
    s, p = get("/api/public/prov/12.json"); mm = next(x for x in p["mesas"] if x["id"] == m3)
    check("…con solo otra persona más, la mesa NO se verifica", mm["estado"] == "pendiente", mm["estado"])
    # formulario: /api/leer devuelve la lectura de la foto
    img = tapar(ImageOps.exif_transpose(Image.open(ACTA)).convert("RGB").rotate(99, fillcolor="white"))
    leida = lectura_de(cifras_ain(PP=18)); foto = jpeg(img, 1600, 80, leida)
    body, bnd = multipart({"foto": foto, "prov": "12"})
    rq = urllib.request.Request(BASE + "/api/leer", data=body, method="POST", headers={"content-type": f"multipart/form-data; boundary={bnd}"})
    d = json.loads(urllib.request.urlopen(rq).read())
    check("lectura para el formulario: devuelve las cifras de la foto", d["lectura"]["cand"][cands["PP"]] == 18 and d["lectura"]["votantes"] == 96, d["lectura"])
    foto = jpeg(img.rotate(1), 1600, 80, lectura_pares(cifras_ain(), dudosos=(cands["PP"],)))
    body, bnd = multipart({"foto": foto, "prov": "12"})
    d = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/api/leer", data=body, method="POST", headers={"content-type": f"multipart/form-data; boundary={bnd}"})).read())
    fb = d["lectura"]["fiab"]
    check("fiabilidad: alta si letra y número coinciden, baja si no", fb["votantes"] == "alta" and fb[cands["PSOE"]] == "alta" and fb[cands["PP"]] == "baja" and d["lectura"]["cand"][cands["PP"]] == 19, fb)

    # ---- Conflicto con lectura que delata la versión mala y resolución por mesa
    m4 = otras[12] if len(otras) > 12 else otras[2]
    buena, mala = cifras_ain(), cifras_ain(PP=29, PSOE=21)
    post_envio(buena, variante=320, ip="10.32.0.1", mesa=m4); post_envio(buena, variante=321, ip="10.32.0.2", mesa=m4)
    post_envio(mala, variante=322, ip="10.32.0.3", mesa=m4, lectura=lectura_de(buena)); cron()
    s, q = get("/admin/api/mesa?id=" + m4, admin=True); es = q["mesas"][0]["envios"]
    e_mala = next(e for e in es if e["cifras"]["cand"][cands["PP"]] == 29)
    check("el panel recibe la lectura de la foto de la versión mala", e_mala["ia"]["cand"][cands["PP"]] == 19, e_mala["ia"])
    s, r = get("/admin/api/resolver_mesa", admin=True, method="POST", body={"mesa_id": m4, "firma": next(e for e in es if e["cifras"]["cand"][cands["PP"]] == 19)["firma"]}); cron()
    s, p = get("/api/public/prov/12.json"); mm = next(x for x in p["mesas"] if x["id"] == m4)
    check("«Esta es la buena» resuelve la mesa de un clic", s == 200 and mm["estado"] == "validada" and mm["cifras"]["cand"][cands["PP"]] == 19 and sum(1 for f in mm["fotos"] if f["est"] == "invalida") == 1, (mm["estado"], r))
    # ---- Ahorro: con 3 fotos leídas iguales, las siguientes iguales esperan; las distintas se leen
    m5 = otras[13]
    for k in range(5): post_envio(cifras_ain(), variante=400 + k, ip=f"10.50.0.{k}", mesa=m5)
    post_envio(cifras_ain(PP=29, PSOE=21), variante=410, ip="10.50.0.9", mesa=m5); cron()
    s, q = get("/admin/api/mesa?id=" + m5, admin=True); es = q["mesas"][0]["envios"]
    iguales = [e["ia_estado"] for e in es if e["cifras"]["cand"][cands["PP"]] == 19]; distinta = next(e["ia_estado"] for e in es if e["cifras"]["cand"][cands["PP"]] == 29)
    check("3 fotos iguales leídas, 2 más en espera; la distinta se lee", sorted(iguales) == ["en_espera", "en_espera", "hecha", "hecha", "hecha"] and distinta == "hecha", (iguales, distinta))
    s, r = get("/admin/api/leer_en_espera", admin=True, method="POST", body={"mesa_id": m5}); cron()
    s, q = get("/admin/api/mesa?id=" + m5, admin=True)
    check("el panel puede forzar su lectura", r["fotos"] == 2 and all(e["ia_estado"] == "hecha" for e in q["mesas"][0]["envios"]), r)
    m7 = otras[15]
    post_envio(cifras_ain(), variante=430, ip="10.70.0.1", mesa=m7); post_envio(cifras_ain(), variante=431, ip="10.70.0.2", mesa=m7)
    get("/admin/api/recalcular", admin=True, method="POST"); cron(); cron()   # la mesa se verifica ANTES de leer sus fotos
    s, p = get("/api/public/prov/12.json"); mm = next(x for x in p["mesas"] if x["id"] == m7)
    check("dos fotos casi a la vez: se leen igualmente y se publican", mm["estado"] == "verificada" and sum(f["pub"] for f in mm["fotos"]) == 2, [(f["pub"]) for f in mm["fotos"]])
    m6 = otras[14]
    post_envio(cifras_ain(), variante=420, ip="10.60.0.1", mesa=m6); post_envio(cifras_ain(), variante=421, ip="10.60.0.2", mesa=m6); cron(); cron()
    s, r = post_envio(cifras_ain(), variante=422, ip="10.60.0.3", mesa=m6); h3 = r["hash"]; cron()
    s, q = get("/admin/api/mesa?id=" + m6, admin=True); st = {e["hash"]: e["ia_estado"] for e in q["mesas"][0]["envios"]}
    check("mesa ya verificada: la tercera foto no gasta lectura", q["mesas"][0]["estado"] == "verificada" and st[h3] == "en_espera", st)
    s, q = get("/admin/api/cola?estado=espera", admin=True); check("aparece en la cola «Fotos en espera»", any(x["mesa_id"] == m6 for x in q["mesas"]))
    s, r = get("/admin/api/aprobar_foto", admin=True, method="POST", body={"hash": h3}); cron()
    s, p = get("/api/public/prov/12.json"); mm = next(x for x in p["mesas"] if x["id"] == m6)
    check("aprobada a mano sin leerla: se publica", next(f for f in mm["fotos"] if f["h"] == h3)["pub"] == 1)
    s, r = post_envio(cifras_ain(PP=29, PSOE=21), variante=423, ip="10.60.0.4", mesa=m6); hx = r["hash"]; cron(); cron()
    s, q = get("/admin/api/mesa?id=" + m6, admin=True); st = {e["hash"]: e["ia_estado"] for e in q["mesas"][0]["envios"]}
    check("si llega otra versión, la mesa deja de estar verificada y se lee", q["mesas"][0]["estado"] == "conflicto" and st[hx] == "hecha", (q["mesas"][0]["estado"], st))
    img = tapar(ImageOps.exif_transpose(Image.open(ACTA)).convert("RGB").rotate(77, fillcolor="white"))
    body, bnd = multipart({"foto": jpeg(img, 1600, 80, lectura_de(cifras_ain())), "prov": "12", "mesa_id": "12-002-01-001-U"})
    d = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/api/leer", data=body, method="POST", headers={"content-type": f"multipart/form-data; boundary={bnd}"})).read())
    check("el formulario no gasta lectura en una mesa ya verificada", d.get("omitida") == "mesa_verificada", d)
    print("\nRESULTADO:", "todo correcto" if ok else "HAY FALLOS")
