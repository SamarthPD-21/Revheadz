#!/usr/bin/env bash
# Renders each car's garage-card picture into public/vehicles/<id>/card.webp.
#   scripts/blender/build-cards.sh [car ids...]   (every car with a model.glb if none given)
# Needs Blender 4.2+ (BLENDER=path if it isn't on your PATH) and ImageMagick. Renders on the
# graphics card when there is one, JOBS (default 3) cars at a time: each takes well under 1 GB.
set -euo pipefail
cd "$(dirname "$0")/../.."
export BLENDER="${BLENDER:-blender}"
ids=("$@")
if [ ${#ids[@]} -eq 0 ]; then
  for d in public/vehicles/*/; do [ -f "$d/model.glb" ] && ids+=("$(basename "$d")"); done
fi
export TMP_CARDS="$(mktemp -d)"
trap 'rm -rf "$TMP_CARDS"' EXIT

render() {
  local id="$1"
  local accent
  accent="$(node -e 'console.log(require("./public/vehicles/'"$id"'/config.json").ui.accent)')"
  "$BLENDER" --background --factory-startup --python scripts/blender/render_cards.py -- "public/vehicles/$id/model.glb" "$TMP_CARDS/$id.png" "$accent" 2>&1 | grep -E "Error|Traceback" || true
  magick "$TMP_CARDS/$id.png" -trim +repage -resize 720x -quality 82 "public/vehicles/$id/card.webp"
  echo "CARD $id $(du -k "public/vehicles/$id/card.webp" | cut -f1) KB"
}
export -f render
printf '%s\n' "${ids[@]}" | xargs -P "${JOBS:-3}" -I{} bash -c 'render "$1"' _ {}
