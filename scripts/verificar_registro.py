#!/usr/bin/env python3
"""Comprueba el registro público de decisiones de Recuento Ciudadano.

Cada decisión del panel de revisión lleva una «huella» (SHA-256) que depende de la huella de la decisión anterior y
de sus propios datos. Por eso, si alguien cambiara o borrara una decisión antigua, cambiarían todas las huellas desde
ese punto. Este programa recalcula todas las huellas y avisa si algo no cuadra.

Uso:
  python3 verificar_registro.py                          descarga el registro de la web y lo comprueba
  python3 verificar_registro.py decisiones.json          comprueba un archivo guardado
  python3 verificar_registro.py ACTUAL --huella H        además, comprueba que una huella publicada antes (por ejemplo,
                                                         en un mensaje en redes) sigue en el registro
  python3 verificar_registro.py ACTUAL --anterior VIEJO  además, comprueba que todo lo que había en una copia antigua
                                                         sigue igual en la actual

ACTUAL puede ser un archivo o una dirección web. Solo usa la biblioteca estándar de Python.
"""
import argparse, hashlib, json, sys, urllib.request

WEB = "https://recuentociudadano.es/api/public/decisiones.json"
INICIAL = "0" * 64


def cargar(origen):
    if origen.startswith("http://") or origen.startswith("https://"):
        with urllib.request.urlopen(origen) as r:
            return json.loads(r.read())
    with open(origen, encoding="utf-8") as f:
        return json.load(f)


def huella(anterior, d):
    # Mismo cálculo que el servidor: huella anterior, salto de línea y los datos de la decisión en JSON compacto.
    datos = json.dumps([d["id"], d["ts"], d["hash"], d["mesa_id"], d["decision"], d.get("motivo")], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256((anterior + "\n" + datos).encode("utf-8")).hexdigest()


def comprobar(registro):
    """Devuelve una lista de problemas (vacía si todo cuadra). Las decisiones vienen de la más reciente a la más antigua."""
    problemas, h = [], INICIAL
    decisiones = sorted(registro.get("decisiones", []), key=lambda d: d["id"])
    for i, d in enumerate(decisiones):
        if i and d["id"] != decisiones[i - 1]["id"] + 1:
            problemas.append(f"faltan decisiones entre la {decisiones[i - 1]['id']} y la {d['id']}")
        h = huella(h, d)
        if d.get("huella") != h:
            problemas.append(f"la decisión {d['id']} no cuadra (huella publicada {d.get('huella')}, calculada {h})")
            h = d.get("huella") or h
    if decisiones and decisiones[0]["id"] != 1:
        problemas.append(f"el registro no empieza en la decisión 1 (empieza en la {decisiones[0]['id']})")
    if registro.get("huella", INICIAL) != h:
        problemas.append(f"la huella del registro ({registro.get('huella')}) no es la de la última decisión ({h})")
    return problemas


def main():
    a = argparse.ArgumentParser(description="Comprueba el registro público de decisiones.")
    a.add_argument("actual", nargs="?", default=WEB)
    a.add_argument("--huella", action="append", default=[], help="huella publicada antes que debe seguir en el registro")
    a.add_argument("--anterior", help="copia antigua del registro (archivo o dirección)")
    o = a.parse_args()
    reg = cargar(o.actual)
    problemas = comprobar(reg)
    huellas = {d["huella"] for d in reg.get("decisiones", [])}
    for h in o.huella:
        if h.strip().lower() not in huellas:
            problemas.append(f"la huella {h} ya no está en el registro: algo anterior a ella ha cambiado")
    if o.anterior:
        actuales = {d["id"]: d for d in reg.get("decisiones", [])}
        for d in cargar(o.anterior).get("decisiones", []):
            if actuales.get(d["id"]) != d:
                problemas.append(f"la decisión {d['id']} es distinta (o ha desaparecido) respecto a la copia antigua")
    print(f"Decisiones: {len(reg.get('decisiones', []))} · huella del registro: {reg.get('huella')}")
    if problemas:
        print("PROBLEMAS:"); [print(" -", p) for p in problemas]; sys.exit(1)
    print("Todo cuadra: ninguna decisión se ha cambiado ni borrado.")


if __name__ == "__main__":
    main()
