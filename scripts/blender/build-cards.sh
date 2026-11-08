#!/usr/bin/env bash
# Renders each car's garage-card picture into public/vehicles/<id>/card.webp.
#   scripts/blender/build-cards.sh [car ids...]   (every car with a model.glb if none given)
# Needs Blender 4.2+ (BLENDER=path if it isn't on your PATH) and ImageMagick.
set -euo pipefail
cd "$(dirname "$0")/../.."
BLENDER="${BLENDER:-blender}"
ids=("$@")
if [ ${#ids[@]} -eq 0 ]; then
  for d in public/vehicles/*/; do [ -f "$d/model.glb" ] && ids+=("$(basename "$d")"); done
fi
tmp="$(mktemp -d)"
for id in "${ids[@]}"; do
  accent="$(node -e 'console.log(require("./public/vehicles/'"$id"'/config.json").ui.accent)')"
  "$BLENDER" --background --factory-startup --python scripts/blender/render_cards.py -- "public/vehicles/$id/model.glb" "$tmp/$id.png" "$accent" 2>&1 | grep -E "Error|Traceback" || true
  magick "$tmp/$id.png" -trim +repage -resize 720x -quality 82 "public/vehicles/$id/card.webp"
  echo "CARD $id $(du -k "public/vehicles/$id/card.webp" | cut -f1) KB"
done
rm -rf "$tmp"
