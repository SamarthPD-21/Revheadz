"""
Turns a downloaded car model (any glTF/GLB, any scale or orientation) into the game's model.glb:

  blender --background --factory-startup --python scripts/blender/import_model.py -- \
      <in.glb> <out.glb> <real length m> [flip] [preview.png]

- lies the car flat with its length along +x (flip turns it round if the nose ends up at -x)
- splits it into its separate parts and finds the wheels: the low, outboard parts gathered at
  the four corners, each grouped under an empty wheel_FL / wheel_FR / wheel_RL / wheel_RR at
  its hub (what the game spins and steers)
- names the lamp materials head* / tail* so they light up, cuts it to about 90k triangles and
  shrinks its textures, then writes a compressed .glb
"""
import math, re, sys
import bpy
from mathutils import Vector, Matrix

args = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT, LENGTH = args[0], args[1], float(args[2])
FLIP = len(args) > 3 and args[3] == "1"
PREVIEW = args[4] if len(args) > 4 else None
MAX_TRIS = 90000
MAX_TEX = 1024

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene


def meshes():
    return [o for o in scene.objects if o.type == "MESH"]


def bounds(objs):
    # (from the vertices themselves: an object's cached bound box lags behind mesh edits)
    lo = Vector((1e9,) * 3)
    hi = -lo
    for o in objs:
        mw = o.matrix_world
        for v in o.data.vertices:
            w = mw @ v.co
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


# 1. one object in world space, then split into its loose parts
for o in scene.objects:
    o.select_set(o.type == "MESH")
bpy.context.view_layer.objects.active = meshes()[0]
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.join()
car = bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in list(scene.objects):
    if o.type != "MESH":
        bpy.data.objects.remove(o)

# 2. flat and along +x: longest side is the length, shortest the height
lo, hi = bounds([car])
size = hi - lo
axes = sorted(range(3), key=lambda i: size[i])  # [height, width, length]
basis = [Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))]
rot = Matrix((basis[axes[2]], basis[axes[1]], basis[axes[0]]))  # rows: new x, y, z
if rot.determinant() < 0:
    rot[1] = -rot[1]
if FLIP:
    rot = Matrix.Rotation(math.pi, 3, "Z") @ rot
car.data.transform(rot.to_4x4())
lo, hi = bounds([car])
car.data.transform(Matrix.Scale(LENGTH / (hi.x - lo.x), 4))
lo, hi = bounds([car])
car.data.transform(Matrix.Translation(Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))))
lo, hi = bounds([car])
L, W, H = hi - lo

bpy.ops.object.select_all(action="DESELECT")
car.select_set(True)
bpy.context.view_layer.objects.active = car
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.separate(type="LOOSE")
bpy.ops.object.mode_set(mode="OBJECT")
parts = meshes()
for p in parts:
    bpy.context.view_layer.objects.active = p
    p.select_set(True)
bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")


# 3. the wheels: the tyres are the biggest low, round, outboard parts near each corner
_boxes = {}


def box(o):
    # (measured once per part: a big model splits into thousands of them)
    if o.name not in _boxes:
        a, b = bounds([o])
        _boxes[o.name] = (a, b, (a + b) / 2, b - a)
    return _boxes[o.name]


cands = []
for p in parts:
    a, b, c, s = box(p)
    round_xz = s.z > 0.25 * H and abs(s.x - s.z) < 0.25 * max(s.x, s.z)
    if round_xz and a.z < 0.08 * H and abs(c.y) > 0.22 * W and s.z < 0.75 * H and s.y < 0.3 * W:
        cands.append((s.z * s.x, p, c, s))
hubs = {}
for _, p, c, s in sorted(cands, key=lambda t: -t[0]):
    key = ("F" if c.x > 0 else "R") + ("L" if c.y > 0 else "R")
    if key not in hubs:
        hubs[key] = (Vector((c.x, c.y, c.z)), max(s.x, s.z) / 2)
print("HUBS", {k: (round(v[0].x, 2), round(v[0].y, 2), round(v[0].z, 2), round(v[1], 2)) for k, v in hubs.items()})
if len(hubs) < 4:
    print("WARN wheels found:", sorted(hubs))

wheel_parts = {k: [] for k in hubs}
for p in parts:
    a, b, c, s = box(p)
    for k, (hub, r) in hubs.items():
        # only what turns with the wheel: parts centred on the hub (tyre, rim, brake disc), or
        # small ones close round it (wheel nuts); calipers and arch liners sit off-centre and
        # stay with the body, or the wheel would wobble round the wrong centre
        # (anything lying wholly inside the tyre's circle: spokes, nuts, discs; an arch liner or a
        # mudflap reaches outside it, and grouped in it would set the wheel spinning off-centre)
        off = (Vector((c.x, c.z)) - Vector((hub.x, hub.z))).length
        if off + max(s.x, s.z) / 2 <= r * 1.03 and abs(c.y - hub.y) < 0.2:
            wheel_parts[k].append(p)
            break


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    return o


taken = {p.name for ps in wheel_parts.values() for p in ps}
rest = [p for p in parts if p.name not in taken]  # (before the joins below remove the wheel parts)
for k, ps in wheel_parts.items():
    if not ps:
        continue
    mesh = join(ps, "wheel_%s_mesh" % k)
    hub, r = hubs[k]
    empty = bpy.data.objects.new("wheel_" + k, None)
    scene.collection.objects.link(empty)
    empty.location = hub
    bpy.context.view_layer.update()  # (or its matrix is still the old one, and the wheel jumps)
    mesh.parent = empty
    mesh.matrix_parent_inverse = empty.matrix_world.inverted()


# lamps and exhausts, found by where they are and what they're made of, since few models name
# them the way the game wants: red lamps at the back light up as tail and brake lights, white
# and clear ones at the front as headlights and running lights; small round pipes low at the
# back are where the flames come out
def mat_info(p):
    names, red, white = [], False, False
    for slot in p.material_slots:
        m = slot.material
        if not m:
            continue
        names.append(m.name.lower())
        bsdf = m.node_tree.nodes.get("Principled BSDF") if m.use_nodes else None
        if bsdf and not bsdf.inputs["Base Color"].is_linked:
            r, g, bl, _ = bsdf.inputs["Base Color"].default_value
            red = red or (r > 0.35 and g < 0.12 and bl < 0.12)
            white = white or min(r, g, bl) > 0.6
        if bsdf and "Emission Strength" in bsdf.inputs and bsdf.inputs["Emission Strength"].default_value > 0.5:
            white = white or not red
    return " ".join(names), red, white


def lamp_mat(name, color):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.diffuse_color = color
    return m


head_m = lamp_mat("head_lamp", (0.95, 0.94, 0.9, 1))
tail_m = lamp_mat("tail_lamp", (0.45, 0.02, 0.02, 1))
LAMP = re.compile(r"light|lamp|led|drl|brake|stop|tail|indicator")
heads, exhausts, tails = [], [], []
for p in rest:
    a, b, c, s = box(p)
    names, red, white = mat_info(p)
    if "glass" in names and not LAMP.search(names.replace("glass", "")):
        continue
    if any((Vector((c.x, c.z)) - Vector((h.x, h.z))).length < r * 1.15 for h, r in hubs.values()):
        continue  # (round the wheels: brake parts, not lamps)
    # (lamps are small and sit at lamp height: models often reuse a lamp's material on grilles,
    # intakes and trim, which mustn't light up with them)
    small = max(s) < 0.45
    # which way it faces: lamp lenses look straight out of the tail or the nose (a wing's top,
    # a badge set in the bonnet, or trim along the sides don't)
    fx = sum(f.normal.x * f.area for f in p.data.polygons) / max(1e-6, sum(f.area for f in p.data.polygons))
    # (no higher than the rear deck: a wing's red trim isn't a tail lamp)
    if c.x < lo.x + 0.2 * L and 0.55 * H < c.z < 0.72 * H and small and fx < -0.25 and abs(c.y) > 0.15 * W and (red or re.search(r"tail|brake|stop|rear.?light", names)):
        tails.append((p, c.z, list(p.data.materials)))
    elif c.x > hi.x - 0.2 * L and 0.42 * H < c.z < 0.8 * H and small and abs(c.y) > 0.22 * W and fx > 0.2 and (re.search(r"head|drl|front.?light|white.?light|lamp", names) or (white and LAMP.search(names))):
        p.data.materials.clear()
        p.data.materials.append(head_m)
        heads.append(c)
    elif re.search(r"exhaust|muffler|tailpipe|tip", names) or (
        c.x < lo.x + 0.1 * L and c.z < 0.4 * H and abs(s.y - s.z) < 0.3 * max(s.y, s.z) and 0.04 < max(s.y, s.z) < 0.2
    ):
        if c.x < lo.x + 0.15 * L:
            exhausts.append(Vector((a.x, c.y, c.z)))
# the tail lamps are one cluster at one height: anything well above it (a wing's red edge, a
# spoiler's trim) is left as it was
if tails:
    zs = sorted(z for _, z, _ in tails)
    floor = zs[len(zs) // 4]
    for p, z, mats in tails:
        if z < floor + 0.1:
            p.data.materials.clear()
            p.data.materials.append(tail_m)
for side in (1, -1):
    pts = [h for h in heads if h.y * side > 0]
    if pts:
        e = bpy.data.objects.new("headlight_" + ("L" if side > 0 else "R"), None)
        scene.collection.objects.link(e)
        e.location = sum(pts, Vector()) / len(pts)
# one flame per pipe (pieces of the same pipe sit within a few cm of each other)
tips = []
for t in sorted(exhausts, key=lambda v: v.y):
    if not tips or (t - tips[-1]).length > 0.08:
        tips.append(t)
# the flames come from the lowest pipe on each side (the real tailpipes, not trim or vents above)
tips = [min(side, key=lambda v: v.z) for side in ([t for t in tips if t.y > 0], [t for t in tips if t.y <= 0]) if side]
for i, t in enumerate(tips):
    e = bpy.data.objects.new("exhaust_%d" % i, None)
    scene.collection.objects.link(e)
    e.location = t
print("LAMPS head %d tail %d, exhausts %d" % (len(heads), sum(1 for _, z, _ in tails if z < floor + 0.1) if tails else 0, len(tips)))
body = join(rest, "body")

# 4. lighter: fewer triangles and smaller textures
objs = meshes()
tris = sum(sum(len(f.vertices) - 2 for f in o.data.polygons) for o in objs)
ratio = min(1.0, MAX_TRIS / max(1, tris))
if ratio < 1:
    for o in objs:
        m = o.modifiers.new("decimate", "DECIMATE")
        m.ratio = ratio if o is body else min(1.0, ratio * 1.6)  # (wheels keep their shape better)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=m.name)
for img in bpy.data.images:
    if img.size[0] > MAX_TEX or img.size[1] > MAX_TEX:
        k = MAX_TEX / max(img.size)
        img.scale(max(1, int(img.size[0] * k)), max(1, int(img.size[1] * k)))

# 5. only the lamp parts found above light up: a material whose name happens to start with
# head or tail (the game's markers for lamps) is renamed, or every part using it would glow
for m in bpy.data.materials:
    if m in (head_m, tail_m):
        continue
    if m.name.lower().startswith(("head", "tail")):
        m.name = "m_" + m.name
    # (nor does anything glow by itself: the model's own emissive bits, a badge or a third
    # brake light, would shine day and night whatever the car was doing)
    bsdf = m.node_tree.nodes.get("Principled BSDF") if m.use_nodes else None
    if bsdf and "Emission Strength" in bsdf.inputs:
        bsdf.inputs["Emission Strength"].default_value = 0

tris = sum(sum(len(f.vertices) - 2 for f in o.data.polygons) for o in meshes())
print("OUT %s %.2fx%.2fx%.2f m, %d tris, wheels %s" % (OUT, L, W, H, tris, sorted(k for k, v in wheel_parts.items() if v)))
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_draco_mesh_compression_enable=True,
                          export_draco_mesh_compression_level=6, export_image_format="WEBP", export_yup=True)

if PREVIEW:
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.color_type = "MATERIAL"
    scene.render.resolution_x, scene.render.resolution_y = 640, 320
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = L * 1.15
    cam.location = Vector((0, -20, H / 2))
    cam.rotation_euler = (math.pi / 2, 0, 0)  # side on: +x (where the nose should be) on the right
    scene.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)
