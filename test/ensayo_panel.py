# Prepara envíos simulados para ensayar el panel en la versión de pruebas: una mesa verificada con fotos en espera,
# conflictos, una foto con nombres sin tapar, una imagen que no es un acta, una foto repetida en otra mesa,
# una mesa nueva y una mesa pendiente.
#
# Como el ordenador desde el que se lanza puede no tener Python, el script no envía nada: deja en una carpeta cada
# envío ya preparado (archivos .body) y un archivo enviar.bat para Windows que los manda con curl, uno detrás de otro.
#
# Uso:  python3 test/ensayo_panel.py CARPETA [foto_acta_valencia.jpg]
#   - test/acta.jpg: foto de un acta real de Aín (Castellón, 23J), la misma que usan las pruebas automáticas.
#   - foto_acta_valencia.jpg (opcional): foto real del acta de la mesa 46-176-01-001-B (Montroy, Valencia);
#     sin ella se usa también la de Aín.
# Solo funciona contra la versión de pruebas (MODO_PRUEBAS = "1"), que acepta la marca de envío simulado.
import hashlib, json, os, sys, uuid
from PIL import Image, ImageDraw, ImageOps
sys.path.insert(0, "test")
import api_test as T

BASE = "https://recuento-ciudadano-pruebas.recuentociudadanoesp.workers.dev"
MARCA = "envio-simulado-de-pruebas"   # sustituye al token de Turnstile (solo vale en la versión de pruebas)
carpeta = sys.argv[1]; os.makedirs(carpeta, exist_ok=True)
foto_valencia = sys.argv[2] if len(sys.argv) > 2 else T.ACTA

def abrir(ruta): return ImageOps.exif_transpose(Image.open(ruta)).convert("RGB")

# Cifras reales de las dos actas, repartidas sobre las candidaturas del 29N de cada provincia
c12 = {c["siglas"]: c["codigo"] for c in json.load(open("public/data/candidaturas/12.json"))["candidaturas"]}
c46 = [c["codigo"] for c in json.load(open("public/data/candidaturas/46.json"))["candidaturas"]]
def ain(**cambios): T.cands = c12; return T.cifras_ain(**cambios)
def montroy(cambios=None):
    votos = [193, 180, 37, 28, 15, 43] + [0] * (len(c46) - 6)   # las 6 filas del acta, en orden
    for i, v in (cambios or {}).items(): votos[i] = v
    return {"electores": 769, "votantes": 523, "nulos": 16, "blanco": 11, "cand": dict(zip(c46, votos))}

def no_es_acta():
    # Imagen que no es un acta: cielo, césped y un árbol
    im = Image.new("RGB", (1200, 1600), (110, 170, 230)); d = ImageDraw.Draw(im)
    d.rectangle([0, 1000, 1200, 1600], fill=(60, 140, 60)); d.rectangle([560, 650, 640, 1050], fill=(100, 70, 40))
    d.ellipse([380, 350, 820, 800], fill=(40, 110, 40)); return im

envios = []
def preparar(nombre, img, cifras, mesa, tapada=True, nueva=False, huella=None, variante=0, calidad=80):
    img = img.rotate(variante * 0.3, fillcolor="white") if variante else img   # cada persona hace su propia foto
    if tapada: img = T.tapar(img)
    foto = T.jpeg(img, 1600, calidad); mini = T.jpeg(img, 480, 65)
    datos = {"mesa_id": mesa, "cifras": cifras, "hash": hashlib.sha256(foto).hexdigest(),
             "dhash": huella or uuid.uuid4().hex[:16], "dispositivo": uuid.uuid4().hex, "geo": None, "ts_foto": None}
    if nueva: datos["mesa_nueva"] = True
    body, bnd = T.multipart({"foto": foto, "mini": mini, "datos": json.dumps(datos), "turnstile": MARCA})
    archivo = f"{len(envios) + 1:02d}_{nombre}.body"
    open(os.path.join(carpeta, archivo), "wb").write(body)
    envios.append((archivo, bnd, nombre))

AIN, VAL = abrir(T.ACTA), abrir(foto_valencia)
# 1. Aín: dos personas con las mismas cifras -> verificada; dos fotos más iguales -> quedan «en espera»
for v in range(1, 5): preparar(f"ain_persona_{v}", AIN, ain(), "12-002-01-001-U", variante=v)
# 2. Montroy B: dos personas bien y una con dos cifras cambiadas (que siguen cuadrando) -> conflicto 2 contra 1
preparar("montroy_b_bien_1", VAL, montroy(), "46-176-01-001-B", variante=1, huella="00000000000000b1")
preparar("montroy_b_bien_2", VAL, montroy(), "46-176-01-001-B", variante=2)
preparar("montroy_b_errata", VAL, montroy({0: 183, 1: 190}), "46-176-01-001-B", variante=3)
# 3. Montroy A: empate 1 contra 1 -> conflicto; la versión sugerida es la que coincide con lo leído en la foto
preparar("montroy_a_version_1", VAL, montroy(), "46-176-01-001-A", variante=4)
preparar("montroy_a_version_2", VAL, montroy({2: 47, 3: 18}), "46-176-01-001-A", variante=5)
# 4. Foto repetida: la misma foto de Montroy B enviada a otra mesa -> revisión por «foto repetida en otra mesa»
# (otra copia del archivo, con distinta compresión: el servidor la reconoce por su huella visual)
preparar("foto_repetida", VAL, montroy(), "46-176-01-002-A", variante=1, huella="00000000000000b1", calidad=78)
# 5. Nombres sin tapar -> cuarentena; en el panel: «Tapar nombres y aprobar»
preparar("nombres_sin_tapar", AIN, ain(), "12-003-01-001-A", tapada=False, variante=6)
# 6. Una imagen que no es un acta -> cuarentena y la lectura automática dice que no es un acta
preparar("no_es_un_acta", no_es_acta(), ain(), "12-003-01-001-B")
# 7. Mesa que no está en la lista («Mi mesa no aparece») -> «Mesas nuevas por confirmar»
preparar("mesa_nueva", AIN, ain(), "12-002-01-001-B", nueva=True, variante=7)
# 8. Una sola persona -> pendiente
preparar("pendiente_una_fuente", VAL, montroy(), "46-176-01-002-B", variante=8)

lineas = ["@echo off", "rem Envia a la version de pruebas los envios simulados para ensayar el panel", 'cd /d "%~dp0"',
          f"set BASE={BASE}", f"echo Enviando {len(envios)} envios simulados...", "if exist respuestas.txt del respuestas.txt"]
for archivo, bnd, nombre in envios:
    lineas.append(f'curl.exe -s -m 60 -H "content-type: multipart/form-data; boundary={bnd}" --data-binary "@{archivo}" '
                  f'%BASE%/api/envio >> respuestas.txt & echo.>> respuestas.txt & echo {nombre} enviado')
lineas += ["echo.", "echo Terminado. Ya puedes cerrar esta ventana y avisar en el chat.", "pause"]
open(os.path.join(carpeta, "enviar.bat"), "w", newline="\r\n").write("\n".join(lineas) + "\n")
print(len(envios), "envíos preparados en", carpeta)
