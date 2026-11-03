#!/usr/bin/env bash
# Builds every car's Blender model into public/vehicles/<id>/model.glb.
#   scripts/blender/build-cars.sh [car ids...]   (all cars if none given)
# Needs Blender 4.2+ (set BLENDER to its path if it isn't on your PATH), and a fresh
# scripts/blender/cars.json (npx jiti scripts/blender/export-cars.ts, with JITI_JSX=1).
set -euo pipefail
cd "$(dirname "$0")/../.."
BLENDER="${BLENDER:-blender}"
ids=("$@")
if [ ${#ids[@]} -eq 0 ]; then
  mapfile -t ids < <(node -e 'for (const c of require("./scripts/blender/cars.json")) console.log(c.id)')
fi
for id in "${ids[@]}"; do
  out="public/vehicles/$id/model.glb"
  "$BLENDER" --background --factory-startup --python scripts/blender/build_car.py -- "$id" "$out" ${PREVIEW_DIR:+"$PREVIEW_DIR/$id.png"} 2>&1 | grep -E "BUILT|Error|Traceback" || true
done
