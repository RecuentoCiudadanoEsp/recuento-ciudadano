# Recorre el panel de validación en el navegador (después de test/api_test.py, que deja datos en el servidor local):
# entra con la contraseña, prueba cada cola, abre una mesa, la reabre y comprueba que los botones responden.
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8787"
ADMIN = "token-de-pruebas-1234567890-abcdefghijk"
fallos = []
def check(nombre, cond, extra=""):
    print(("OK   " if cond else "FALLO"), nombre, extra)
    if not cond: fallos.append(nombre)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1100, "height": 900}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("dialog", lambda d: d.accept())   # confirma «¿Volver a dejar pendientes…?»
    pg.goto(BASE + "/admin/"); pg.fill("#tok", ADMIN); pg.click("#btnLogin")
    pg.wait_for_selector("#app", state="visible"); pg.wait_for_timeout(800)
    check("entra con la contraseña y carga la cola", "envíos" in pg.inner_text("#stats"))
    for valor in ["fotos", "espera", "nuevas", "pendiente", "verificada,validada", "acciones", "conflicto,revision"]:
        pg.select_option("#fEstado", valor); pg.wait_for_timeout(700)
        check(f"la cola «{valor}» se carga sola al elegirla", pg.inner_text("#cola").strip() != "")
    pg.select_option("#fEstado", "acciones"); pg.wait_for_timeout(700)
    check("el registro muestra decisiones", pg.locator("#cola table tr").count() > 1)
    pg.screenshot(path="/tmp/panel_acciones.png", full_page=False)
    mesa = pg.locator("#cola a[data-abrir]").first.get_attribute("data-abrir")
    pg.locator("#cola a[data-abrir]").first.click(); pg.wait_for_timeout(1000)
    check("pulsar una mesa del registro la abre con su historial", mesa in pg.inner_text("#cola") and "Historial de decisiones" in pg.inner_text("#cola"), mesa)
    pg.screenshot(path="/tmp/panel_mesa.png", full_page=True)
    pg.click("button[data-reabrir]"); pg.wait_for_timeout(1500)
    check("«Volver a revisar esta mesa» funciona y sigue en la misma mesa", "Mesa reabierta" in pg.inner_text("#cola") and mesa in pg.inner_text("#cola"))
    pg.fill("#fMesa", "12-002-01-001-U"); pg.click("#btnMesa"); pg.wait_for_timeout(1000)
    check("el botón «Abrir mesa» funciona", "12-002-01-001-U" in pg.inner_text("#cola"))
    pg.fill("#fMesa", "99-999-99-999-Z"); pg.press("#fMesa", "Enter"); pg.wait_for_timeout(800)
    check("con Enter también abre, y avisa si la mesa no existe", "No existe la mesa" in pg.inner_text("#cola"))
    pg.click("#btnRecalc"); pg.wait_for_timeout(1000)
    check("el botón «Recalcular ahora» funciona", not pg.is_disabled("#btnRecalc"))
    check("sin errores de JavaScript", not errs, errs)
    b.close()
print("\nRESULTADO:", "todo correcto" if not fallos else "HAY FALLOS: " + ", ".join(fallos))
