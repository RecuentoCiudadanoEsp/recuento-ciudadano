#!/bin/sh
# Arranca el servidor local de pruebas. Workers AI no funciona sin cuenta, así que se usa una copia de la
# configuración sin el enlace [ai] y con la lectura automática simulada (IA_SIMULADA, solo en modo pruebas).
cd "$(dirname "$0")/.."
# (y sin Cloudflare Access ni Turnstile, que en local no funcionan: el panel entra solo con la contraseña de .dev.vars)
sed -e '/^\[ai\]/,$d' -e 's/^ACCESS_TEAM = .*/ACCESS_TEAM = ""/' -e 's/^ACCESS_AUD = .*/ACCESS_AUD = ""/' -e 's/^TURNSTILE_SITEKEY = .*/TURNSTILE_SITEKEY = ""/' wrangler.toml > wrangler.local.toml
exec npx wrangler dev -c wrangler.local.toml --test-scheduled --port "${PUERTO:-8787}" --var LECTURA_IA:1 --var IA_SIMULADA:1 "$@"
