# Recorre la web como un usuario en el móvil: elige la mesa, sube el acta real de Aín, copia cifras y envía.
import json
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8787"
ACTA = __import__("os").environ.get("ACTA", "test/acta.jpg")   # foto de un acta real; no se incluye (muestra nombres y firmas)
cands0 = [c["siglas"] for c in json.load(open("public/data/candidaturas/12.json"))["candidaturas"]]
CIFRAS = {k: 0 for k in cands0}; CIFRAS.update({"PSOE": 31, "PP": 19, "VOX": 9, "COMPROMIS-EUPV-PODEM-ERPV": 33, "PACMA": 1, "SALF": 1})
cands = {c["siglas"]: c["codigo"] for c in json.load(open("public/data/candidaturas/12.json"))["candidaturas"]}

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 400, "height": 860}, device_scale_factor=1)
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE + "/#inicio"); pg.wait_for_timeout(800)
    pg.screenshot(path="/tmp/ui_inicio.png")
    pg.goto(BASE + "/#enviar"); pg.wait_for_selector("#sProv option[value='12']", state="attached")
    # provincia y municipio se eligen escribiendo en los buscadores (sin tildes ni mayúsculas)
    pg.fill("#qProv", "castellon"); pg.click("#qProv-lista li[data-i='0']")
    pg.wait_for_function("!document.getElementById('qMuni').disabled")
    pg.fill("#qMuni", "ai"); pg.click("#qMuni-lista li:text-is('Aín')")
    assert pg.input_value("#sProv") == "12" and pg.input_value("#sMuni") == "002", "buscadores"
    pg.wait_for_function("document.getElementById('sMesa').value || !document.getElementById('sSecc').disabled")
    # flujo "Mi mesa no aparece": mesa B de Aín, que no existe en la lista
    pg.click("#btnNoAparece"); pg.fill("#nDist", "1"); pg.fill("#nSecc", "1"); pg.select_option("#nMesa", "B")
    pg.set_input_files("#foto", ACTA); pg.wait_for_selector("#editorBox:not(.hide)"); pg.wait_for_timeout(500)
    pg.fill("#n-electores", "121"); pg.fill("#n-votantes", "96"); pg.fill("#n-nulos", "1"); pg.fill("#n-blanco", "1")
    for s, v in CIFRAS.items(): pg.fill(f"#c-{cands[s]}", str(v))
    pg.wait_for_timeout(300)
    print("mesa:", pg.text_content("#mesaInfo"))
    print("checks:", [li.inner_text() for li in pg.query_selector_all("#checks li")])
    # el borrador sobrevive a una recarga (como cuando el móvil recarga la página al volver de la cámara)
    pg.reload(); pg.wait_for_selector("#recuperado:not(.hide)", timeout=10000)
    assert pg.input_value("#n-votantes") == "96" and pg.input_value("#nDist") == "1", "borrador"
    print("borrador recuperado:", pg.inner_text("#recuperado")[:60])
    pg.set_input_files("#foto", ACTA); pg.wait_for_selector("#editorBox:not(.hide)"); pg.wait_for_timeout(500)
    # fuera del modo «tapar», arrastrar sobre la foto no tapa nada
    pg.locator("#cv").scroll_into_view_if_needed(); box = pg.locator("#cv").bounding_box(); pg.mouse.move(box["x"] + 250, box["y"] + 100); pg.mouse.down(); pg.mouse.move(box["x"] + 330, box["y"] + 160); pg.mouse.up()
    assert "zona" not in pg.inner_text("#checks"), "tapado sin querer"
    pg.click("#btnTapar"); box = pg.locator("#cv").bounding_box(); pg.mouse.move(box["x"] + 250, box["y"] + 100); pg.mouse.down(); pg.mouse.move(box["x"] + 330, box["y"] + 160); pg.mouse.up()
    assert "1 zona" in pg.inner_text("#checks"), "modo tapar"; pg.click("#btnTapar")
    pg.click("#btnEnviar"); pg.wait_for_selector("#resultado .banner", timeout=20000)
    pg.screenshot(path="/tmp/ui_form.png", full_page=True)
    print("resultado:", pg.inner_text("#resultado .banner")[:120])
    pg.screenshot(path="/tmp/ui_enviado.png")
    import urllib.request; urllib.request.urlopen(BASE + "/__scheduled?cron=*+*+*+*+*").read(); pg.wait_for_timeout(2500)
    pg.goto(BASE + "/#mesa=12-002-01-001-B"); pg.wait_for_selector("#mesaCuerpo .fotos", timeout=10000); pg.wait_for_timeout(800)
    pg.screenshot(path="/tmp/ui_mesa.png", full_page=True)
    pg.goto(BASE + "/#resultados"); pg.wait_for_timeout(1200); pg.screenshot(path="/tmp/ui_resultados.png", full_page=True)
    print("errores JS:", errs)
    b.close()
