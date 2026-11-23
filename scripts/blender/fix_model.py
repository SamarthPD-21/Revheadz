"""
Tidies a car model already fitted by import_model.py (public/vehicles/<id>/model.glb):

  blender --background --factory-startup --python scripts/blender/fix_model.py -- \
      <in.glb> <out.glb> [car id] [preview prefix]

- every wheel spins about its own tyre: the wheel_* empty moves to the tyre's centre, and parts that
  stick out of the tyre (hub carriers, suspension, a calliper) stay on the body instead of spinning
- lamps where the materials don't say: materials listed for the car in lamp_hints.json (which can also
  loosen the colour tests: head_bright, the least a headlight's channels read; tail_red, how much redder
  than green and blue a tail light is; tail_in_zone, materials shared with other parts whose faces count only
  where tail lights sit), or else
  faces read by colour (texture included) - bright and forward-facing at the nose become head_lamp,
  red and rear-facing at the tail become tail_lamp - so the game can light them
- with a preview prefix, writes <prefix>-front.png and <prefix>-rear.png with the lamps painted in
"""
import json, math, os, sys
import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

args = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = args[0], args[1]
CAR = args[2] if len(args) > 2 else ""
PREVIEW = args[3] if len(args) > 3 else None
HINTS = json.load(open(os.path.join(os.path.dirname(__file__), "lamp_hints.json"))).get(CAR, {})

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene
bpy.context.view_layer.update()


def world_verts(o):
    mw = o.matrix_world
    return [mw @ v.co for v in o.data.vertices]


def box(vs):
    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    return lo, hi


def only(objs, active):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def keep_world(o, parent):
    mw = o.matrix_world.copy()
    o.parent = parent
    o.matrix_world = mw


wheels = sorted((o for o in bpy.data.objects if o.type == "EMPTY" and o.name.lower().startswith("wheel_")), key=lambda o: o.name)
in_wheel = {c for e in wheels for c in e.children_recursive}
body = max((o for o in bpy.data.objects if o.type == "MESH" and o not in in_wheel), key=lambda o: len(o.data.vertices))
loose_for_body = []

def axle_of(vs):
    """The wheel's axle (towards +y) and the wheel's centre. Of the directions a wheel's axle can take
    (steered up to 35 degrees, up to 8 of camber), it's the one whose box around the wheel - along the
    axle, across it and up - is smallest: a cylinder looked at askew needs a bigger box."""
    pts = np.array([(v.x, v.y, v.z) for v in vs])
    if len(pts) > 6000:
        pts = pts[np.random.default_rng(0).choice(len(pts), 6000, replace=False)]
    up = np.array([0.0, 0.0, 1.0])

    def boxed(yaw, camber):
        a = np.array([math.sin(yaw) * math.cos(camber), math.cos(yaw) * math.cos(camber), math.sin(camber)])
        u = np.cross(a, up)
        u /= np.linalg.norm(u)
        v = np.cross(u, a)
        return np.ptp(pts @ a) + np.ptp(pts @ u) + np.ptp(pts @ v), a

    best, best_yaw, best_camber = (1e9, np.array([0.0, 1.0, 0.0])), 0.0, 0.0
    for step, span, (y0, c0) in ((2.0, 36, (0.0, 0.0)), (0.25, 2, (None, None))):
        if y0 is None:
            y0, c0 = best_yaw, best_camber
        for yaw in np.arange(y0 - span, y0 + span + 1e-6, step):
            for camber in np.arange(max(-8, c0 - span), min(8, c0 + span) + 1e-6, step):
                size, a = boxed(math.radians(yaw), math.radians(camber))
                if size < best[0] - 1e-9:
                    best, best_yaw, best_camber = (size, a), yaw, camber
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    return Vector(best[1]).normalized(), Vector((lo + hi) / 2)


def circle(points):
    """Least-squares circle through (x, z) points: centre x, centre z, radius."""
    a = np.array([[x, z, 1.0] for x, z in points])
    b = np.array([x * x + z * z for x, z in points])
    (p, q, c), *_ = np.linalg.lstsq(a, b, rcond=None)
    cx, cz = p / 2, q / 2
    return cx, cz, math.sqrt(max(1e-9, c + cx * cx + cz * cz))


def split_off(o, faces):
    """Moves the given faces of `o` into a new object (returned), or None if there are none."""
    if not faces:
        return None
    before = set(bpy.data.objects)
    only([o], o)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_mode(type="FACE")
    bpy.ops.mesh.select_all(action="DESELECT")
    bm = bmesh.from_edit_mesh(o.data)
    for f in bm.faces:
        f.select_set(f.index in faces)
    bm.select_flush_mode()
    bmesh.update_edit_mesh(o.data)
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    return next(iter(set(bpy.data.objects) - before), None)


# 1. wheels: centre on the tyre's tread, and only what's within the tyre spins
for e in wheels:
    meshes = [c for c in e.children_recursive if c.type == "MESH"]
    if not meshes:
        continue
    only(meshes, meshes[0])
    if len(meshes) > 1:
        bpy.ops.object.join()
    w = meshes[0]
    # straighten it: some models come with the front wheels steered, or with toe and camber built in
    vs = world_verts(w)
    axle, ctr = axle_of(vs)
    turned = math.degrees(axle.angle(Vector((0, 1, 0))))
    if turned > 0.7:
        rot = axle.rotation_difference(Vector((0, 1, 0))).to_matrix().to_4x4()
        w.matrix_world = Matrix.Translation(ctr) @ rot @ Matrix.Translation(-ctr) @ w.matrix_world
        bpy.context.view_layer.update()
    vs = world_verts(w)
    lo, hi = box(vs)
    cx, cz = (lo.x + hi.x) / 2, (lo.z + hi.z) / 2
    for _ in range(4):
        far = max(math.hypot(v.x - cx, v.z - cz) for v in vs)
        ring = [v for v in vs if math.hypot(v.x - cx, v.z - cz) > 0.93 * far]
        cx, cz, r = circle([(v.x, v.z) for v in ring])
    y0, y1 = min(v.y for v in ring) - 0.03, max(v.y for v in ring) + 0.03
    if y1 - y0 < 0.16:  # just a rim face (the tyre is on the body): nothing to trim by width
        y0, y1 = -1e9, 1e9

    # faces beside the tyre (hub carriers, suspension) or beyond it stay on the body
    mwi = w.matrix_world
    out = {f.index for f in w.data.polygons
           if not y0 <= (mwi @ f.center).y <= y1 or math.hypot((mwi @ f.center).x - cx, (mwi @ f.center).z - cz) > r * 1.03}
    static = [o for o in [split_off(w, out)] if o]
    for o in static:
        keep_world(o, None)  # off the wheel straight away, so it isn't gathered back in below
    beside = len(out)

    # a lone off-centre lump inside the rim is a calliper: it stays put (spokes come in sets, so they spin)
    only([w], w)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    parts = [c for c in e.children_recursive if c.type == "MESH" and len(c.data.polygons)]
    info = {p.name: box(world_verts(p)) for p in parts}
    lumps = [p for p in parts if max(info[p.name][1].x - info[p.name][0].x, info[p.name][1].z - info[p.name][0].z) < 0.8 * r
             and math.hypot((info[p.name][0].x + info[p.name][1].x) / 2 - cx, (info[p.name][0].z + info[p.name][1].z) / 2 - cz) > 0.3 * r]
    if not 0 < len(lumps) <= 2:
        lumps = []
    spun = [p for p in parts if p not in lumps]
    static += lumps

    hub = Vector((cx, (min(v.y for v in ring) + max(v.y for v in ring)) / 2, cz))
    keep = {p: p.matrix_world.copy() for p in spun + static}
    e.matrix_world.translation = hub
    bpy.context.view_layer.update()
    for p in spun:
        p.parent = e
        p.matrix_world = keep[p]
    for p in static:
        p.parent = None
        p.matrix_world = keep[p]
    loose_for_body += static
    only(spun, spun[0])
    if len(spun) > 1:
        bpy.ops.object.join()
    spun[0].name = spun[0].data.name = f"{e.name}_mesh"
    print(f"WHEEL {e.name}: straightened {turned:.1f} deg, r {r:.3f}, tread {max(v.y for v in ring) - min(v.y for v in ring):.2f} wide, hub {hub.x:+.3f},{hub.y:+.3f},{hub.z:+.3f}; {beside} faces beside or beyond the tyre and {len(lumps)} calliper parts stay on the body")

if loose_for_body:
    only([body] + loose_for_body, body)
    bpy.ops.object.join()
bpy.context.view_layer.update()

# 2. lamps
lamp_mat = {}
for kind, rgb in (("head", (0.95, 0.94, 0.9)), ("tail", (0.45, 0.02, 0.02))):
    m = bpy.data.materials.get(f"{kind}_lamp") or bpy.data.materials.new(f"{kind}_lamp")
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = 0.25
    lamp_mat[kind] = m

me = body.data
mw = body.matrix_world
nm = mw.to_3x3().inverted().transposed()
slots = [s.material for s in body.material_slots]
for kind in ("head", "tail"):
    if lamp_mat[kind] not in slots:
        me.materials.append(lamp_mat[kind])
        slots.append(lamp_mat[kind])
idx = {k: slots.index(lamp_mat[k]) for k in lamp_mat}

images = {}


def colour_source(mat):
    """The material's base colour factor and its texture (as an array), if it has one."""
    if mat is None or not mat.use_nodes:
        return (0.8, 0.8, 0.8), None
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        return (0.8, 0.8, 0.8), None
    inp = bsdf.inputs["Base Color"]
    factor = tuple(inp.default_value[:3])
    tex = None
    if inp.is_linked:
        n = inp.links[0].from_node
        while n.type != "TEX_IMAGE" and n.inputs and any(i.is_linked for i in n.inputs):
            n = next(i for i in n.inputs if i.is_linked).links[0].from_node
        if n.type == "TEX_IMAGE" and n.image and n.image.size[0]:
            img = n.image
            if img.name not in images:
                w, h = img.size
                images[img.name] = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, img.channels)
            tex = images[img.name]
            factor = (1.0, 1.0, 1.0) if not any(inp.default_value[:3]) else factor
    return factor, tex


sources = [colour_source(m) for m in slots]
uv = me.uv_layers.active.data if me.uv_layers.active else None
verts = [mw @ v.co for v in me.vertices]
lo, hi = box(verts)
L, W, H = hi.x - lo.x, hi.y - lo.y, hi.z - lo.z
area = {}
for p in me.polygons:
    area[p.material_index] = area.get(p.material_index, 0) + p.area
paint = max(area, key=area.get)
have = {k: any(s and s.name.lower().startswith(k) and area.get(i, 0) > 0.02 for i, s in enumerate(slots)) for k in lamp_mat}
by_name = {k: {s.name for s in slots if s and s.name in HINTS.get(k, [])} for k in lamp_mat}


def face_colour(p):
    factor, tex = sources[p.material_index]
    if tex is None or uv is None:
        return factor
    u = sum(uv[i].uv.x for i in p.loop_indices) / p.loop_total % 1.0
    v = sum(uv[i].uv.y for i in p.loop_indices) / p.loop_total % 1.0
    h, w = tex.shape[:2]
    px = tex[min(h - 1, int(v * h)), min(w - 1, int(u * w))]
    return (px[0] * factor[0], px[1] * factor[1], px[2] * factor[2])


counts = {"head": 0, "tail": 0}
for p in me.polygons:
    mat = slots[p.material_index]
    if mat is lamp_mat["head"] or mat is lamp_mat["tail"]:
        continue
    named = next((k for k in lamp_mat if mat and mat.name in by_name[k]), None)
    if named:
        p.material_index = idx[named]
        counts[named] += 1
        continue
    if p.material_index == paint and sources[paint][1] is None:  # plain paint; a texture sheet is read by colour
        continue
    c = mw @ p.center
    n = (nm @ p.normal).normalized()
    z = (c.z - lo.z) / H
    side = abs(c.y - (lo.y + hi.y) / 2) / W
    # a material shared with other parts: only its faces where that lamp sits, clear of the number plate
    if mat and mat.name in HINTS.get("tail_in_zone", []) and c.x < lo.x + 0.12 * L and n.x < -0.35 and 0.4 < z < 0.85 and side > 0.18:
        p.material_index = idx["tail"]
        counts["tail"] += 1
        continue
    if not have["head"] and not HINTS.get("head") and c.x > hi.x - 0.12 * L and n.x > 0.35 and 0.3 < z < 0.82 and side > 0.15:
        r, g, b = face_colour(p)
        if min(r, g, b) > HINTS.get("head_bright", 0.6) and max(r, g, b) - min(r, g, b) < 0.25:
            p.material_index = idx["head"]
            counts["head"] += 1
    elif not have["tail"] and not HINTS.get("tail") and c.x < lo.x + 0.12 * L and n.x < -0.35 and 0.35 < z < 0.85 and side > 0.1:
        r, g, b = face_colour(p)
        if r > 0.3 and r > HINTS.get("tail_red", 2.0) * max(g, b):
            p.material_index = idx["tail"]
            counts["tail"] += 1
print(f"LAMPS {CAR}: already named head {have['head']} tail {have['tail']}; now marked head {counts['head']} faces, tail {counts['tail']} faces")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_draco_mesh_compression_enable=True,
                          export_draco_mesh_compression_level=6, export_image_format="WEBP", export_yup=True)
print(f"OUT {OUT} {os.path.getsize(OUT) / 1024:.0f} KB")

if PREVIEW:
    for kind, rgb in (("head", (1, 0.85, 0)), ("tail", (1, 0, 0.6))):
        lamp_mat[kind].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1)
        lamp_mat[kind].diffuse_color = (*rgb, 1)
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.color_type = "TEXTURE"
    scene.display.shading.light = "STUDIO"
    scene.render.resolution_x, scene.render.resolution_y = 560, 360
    target = bpy.data.objects.new("target", None)
    scene.collection.objects.link(target)
    target.location = ((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z + H * 0.45)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.lens = 40
    con = cam.constraints.new("TRACK_TO")
    con.target = target
    con.track_axis, con.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
    for tag, pos in (("front", (hi.x + 3.2, -2.6, lo.z + 1.1)), ("rear", (lo.x - 3.2, -2.6, lo.z + 1.1))):
        cam.location = pos
        scene.render.filepath = f"{PREVIEW}-{tag}.png"
        bpy.ops.render.render(write_still=True)
