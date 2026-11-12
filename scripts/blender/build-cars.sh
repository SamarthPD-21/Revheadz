#!/usr/bin/env bash
# Builds every car's Blender model into public/vehicles/<id>/model.glb.
#   scripts/blender/build-cars.sh [car ids...]   (all cars if none given)
# Needs Blender 4.2+ (set BLENDER to its path if it isn't on your PATH), and a fresh
# scripts/blender/cars.json (npx jiti scripts/blender/export-cars.ts, with JITI_JSX=1).
set -euo pipefail
cd "$(dirname "$0")/../.."
BLENDER="${BLENDER:-blender}"
# cars whose model.glb came from a downloaded model (scripts/blender/import_model.py), not this builder
DOWNLOADED="v12_gt audi_r8_v10 twin_turbo_i6 bugatti_chiron gt_racer mustang_gt honda_s2000 aventador_svj rx7_fd twin_turbo_v6 skyline_r34 flat6_sports supra_mk4"
ids=("$@")
if [ ${#ids[@]} -eq 0 ]; then
  mapfile -t ids < <(node -e 'for (const c of require("./scripts/blender/cars.json")) console.log(c.id)')
fi
for id in "${ids[@]}"; do
  # cars using a downloaded model (made with import_model.py) keep it
  if [[ " $DOWNLOADED " == *" $id "* ]]; then
    echo "SKIP $id (downloaded model)"
    continue
  fi
  out="public/vehicles/$id/model.glb"
  "$BLENDER" --background --factory-startup --python scripts/blender/build_car.py -- "$id" "$out" ${PREVIEW_DIR:+"$PREVIEW_DIR/$id.png"} 2>&1 | grep -E "BUILT|Error|Traceback" || true
done
