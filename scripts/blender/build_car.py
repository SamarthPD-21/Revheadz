"""
Models one car in Blender and exports it as a .glb for Cruise.

    blender --background --factory-startup --python scripts/blender/build_car.py -- <car id> <out.glb> [preview.png]

The car's real size, side profile, window outline, wheels and details come from
scripts/blender/cars.json (written by export-cars.ts). The body is lofted through cross-sections
into a coarse cage and subdivided into smooth panels; everything else (glass, seams, lamps,
grille, wings, vents, mirrors, handles...) is placed by casting rays onto that finished body, so
it sits on the curved surface. What the game's loader (components/cruise/carGltf.ts) looks for:

    wheel_FL / wheel_FR / wheel_RL / wheel_RR   one empty per wheel at its hub, the wheel's parts inside
    headlight_L / headlight_R                   empties where the beams start
    exhaust_*                                   empties at each pipe's exit
    materials "paint", "head", "tail"           repainted / lit up by the game

Blender space here: x from the tail (0) to the nose, y to the car's left, z up; the glTF
exporter turns that into the game's x forward, y up, z right.
"""

import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[sys.argv.index("--") + 1 :]
CAR_ID, OUT = argv[0], argv[1]
PREVIEW = argv[2] if len(argv) > 2 else None
CAR = next(c for c in json.load(open(os.path.join(HERE, "cars.json"))) if c["id"] == CAR_ID)

# Per-car character. Each entry overrides/extensions the shared features and adds signature
# details (the "sig" list). Base features still come from cars.json, so a missing entry is fine.
PER_CAR = {
    "supra_mk4":     {"wing": "hoop", "tail": "quad_round", "lamps": "slim", "sig": ["supra_wing"]},
    "skyline_r34":   {"wing": "tall", "tail": "quad_round", "grille": "big", "grille_w": 1.35, "sig": ["big_intake"]},
    "twin_turbo_v6": {"wing": "lip", "tail": "quad_round", "exhaust": "quad", "sig": ["r35_hood"]},
    "rx7_fd":        {"wing": "lip", "lamps": "popup", "tail": "single_round", "sig": ["bubble_roof"]},
    "honda_s2000":   {"wing": "none", "tail": "single_round", "lamps": "slim"},
    "subaru_sti":    {"wing": "tall", "tail": "bar", "doors": 4, "sig": ["hood_scoop_big"]},
    "jdm_i6_turbo":  {"wing": "lip", "tail": "bar", "doors": 4, "exhaust": "twin"},
    "synth_v6":      {"wing": "lip", "tail": "single_round", "exhaust": "twin"},
    "ferrari_f40":   {"wing": "full_width", "tail": "quad_round", "lamps": "popup",
                      "sig": ["louvres", "naca"]},
    "lexus_lfa":     {"wing": "lip", "exhaust": "tri", "sig": ["tri_exhaust"]},
    "porsche_gt3rs": {"wing": "swan", "tail": "bar", "lamps": "round", "sig": ["wing_vents"]},
    "v10_supercar":  {"wing": "duck", "tail": "bar", "exhaust": "centre", "sig": ["deck_grille"]},
    "aventador_svj": {"wing": "gt", "tail": "y_shape", "lamps": "y_shape", "sig": ["hex"]},
    "pagani_zonda":  {"wing": "duck", "tail": "quad_round", "exhaust": "quad_centre", "lamps": "round"},
    "bugatti_chiron":{"wing": "duck", "tail": "bar", "grille": "none", "exhaust": "quad",
                      "noFrontPlate": True, "sig": ["c_line", "horseshoe"]},
    "gt_racer":      {"wing": "lip", "tail": "single_round", "exhaust": "tri", "sig": ["race_livery"]},
    "audi_r8_v10":   {"wing": "lip", "tail": "bar", "exhaust": "quad", "intakes": False,
                      "sig": ["side_blade"]},
    "corvette_z06":  {"wing": "duck", "tail": "quad_round", "exhaust": "quad_centre", "sig": ["hood_vent"]},
    "mustang_gt":    {"wing": "lip", "tail": "tri_bar", "grille": "mesh", "grille_w": 1.5, "sig": ["wide_grille"]},
    "hellcat":       {"wing": "lip", "tail": "tri_bar", "grille": "mesh", "grille_w": 1.55,
                      "bonnet": "scoop", "sig": ["wide_grille"]},
    "muscle_v8":     {"wing": "duck", "tail": "bar", "lamps": "round", "bonnet": "scoop",
                      "sig": ["shaker_scoop"]},
    "twin_turbo_i6": {"wing": "lip", "tail": "bar", "grille": "kidney", "sig": ["power_dome"]},
    "bmw_m3_e46":    {"wing": "lip", "tail": "bar", "grille": "kidney", "sig": ["power_dome", "side_gills"]},
    "amg_c63":       {"wing": "lip", "tail": "bar", "doors": 4, "grille": "big", "grille_w": 1.4},
    "flat6_sports":  {"wing": "duck", "tail": "bar", "lamps": "round", "sig": ["whale_tail"]},
    "v12_gt":        {"wing": "lip", "tail": "bar", "grille": "slat"},
    "hot_hatch":     {"wing": "tall", "tail": "bar", "doors": 4, "exhaust": "centre"},
    "rotary_twin":   {"wing": "gt", "tail": "bar", "exhaust": "centre", "sig": ["race_livery"]},
    "boxer4_rally":  {"wing": "tall", "tail": "bar", "doors": 4, "sig": ["hood_scoop_big"]},
}

F = dict(CAR["features"])
F.update(PER_CAR.get(CAR_ID, {}))
DOORS = int(F.get("doors", 2))
SIG = set(F.get("sig", ()))

# body styles (as the game's procedural builder has them)
STYLE = {
    "coupe": (0.13, 0.5, 0.7),
    "sport": (0.12, 0.6, 0.68),
    "rally": (0.17, 0.45, 0.72),
    "supercar": (0.10, 0.75, 0.62),
    "gtcar": (0.09, 0.7, 0.62),
    "muscle": (0.14, 0.2, 0.72),
    "gt": (0.12, 0.6, 0.66),
    "hatch": (0.15, 0.45, 0.74),
}
CLEARANCE, NOSE_ROUND, ROOF_W = STYLE.get(CAR["silhouette"], STYLE["coupe"])
DARK_ROOF = CAR["silhouette"] in ("supercar", "rally", "sport")


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def smooth(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------------------- scene and materials

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"


def srgb(hexstr):
    h = hexstr.lstrip("#")
    c = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1.0]


MATS = {}


def material(name, color, metallic=0.0, rough=0.5, coat=0.0, alpha=1.0, emit=None, emit_strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color if len(color) == 4 else list(color) + [1.0]
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.03
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        if hasattr(m, "blend_method"):
            m.blend_method = "BLEND"
        if hasattr(m, "surface_render_method"):
            m.surface_render_method = "BLENDED"
    if emit:
        b.inputs["Emission Color"].default_value = emit + [1.0]
        b.inputs["Emission Strength"].default_value = emit_strength
    MATS[name] = m
    return m


accent = srgb(CAR["accent"])
material("paint", accent, metallic=0.55, rough=0.28, coat=1.0)
material("paint_roof", [c * 0.25 for c in accent[:3]] + [1], metallic=0.5, rough=0.3, coat=1.0)
material("glass", [0.02, 0.025, 0.035, 1] if not F.get("tinted") else [0.005, 0.006, 0.01, 1], metallic=0.2, rough=0.03, alpha=0.86)
material("trim", [0.012, 0.012, 0.014, 1], rough=0.55)
material("rubber", [0.008, 0.008, 0.009, 1], rough=0.85)
material("chrome", [0.8, 0.8, 0.82, 1], metallic=1.0, rough=0.12)
material("rim", [0.62, 0.63, 0.66, 1], metallic=1.0, rough=0.25)
material("tyre", [0.018, 0.018, 0.02, 1], rough=0.9)
material("disc", [0.25, 0.25, 0.27, 1], metallic=1.0, rough=0.4)
material("caliper", srgb("#c81e1e") if CAR["silhouette"] in ("muscle", "coupe") else accent, metallic=0.2, rough=0.35, coat=0.6)
material("head", [0.95, 0.94, 0.9, 1], rough=0.15, emit=[1.0, 0.97, 0.9], emit_strength=2.0)
material("tail", [0.35, 0.01, 0.01, 1], rough=0.25, emit=[1.0, 0.05, 0.03], emit_strength=1.5)
material("lens", [0.6, 0.62, 0.66, 1], metallic=0.0, rough=0.02, alpha=0.35)
material("amber", [0.9, 0.35, 0.02, 1], rough=0.2, emit=[1.0, 0.45, 0.05], emit_strength=0.6)
material("carbon", [0.025, 0.025, 0.03, 1], metallic=0.3, rough=0.35, coat=0.8)
material("stripe", [0.92, 0.92, 0.94, 1], metallic=0.2, rough=0.3, coat=1.0)
material("well", [0.006, 0.006, 0.007, 1], rough=0.95)
material("interior", [0.03, 0.03, 0.033, 1], rough=0.75)
material("plate", [0.85, 0.85, 0.82, 1], rough=0.4)
material("reverse", [0.85, 0.86, 0.88, 1], rough=0.1)
YEAR = CAR.get("year", 2000)


def aero_mat():
    return MATS["carbon"] if F.get("carbon") else MATS["trim"]


def new_object(name, bm, mats, smooth_shade=True, parent=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(MATS[m] if isinstance(m, str) else m)
    if smooth_shade:
        for p in me.polygons:
            p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    if parent:
        ob.parent = parent
    return ob


def V(x, up, right):
    """A point in the game's car space (x forward, up, right) in Blender's (x, left, up)."""
    return Vector((x, -right, up))


# ---------------------------------------------------------------------------- the body's shape

profile = [tuple(p) for p in CAR["profile"]]
xs = [p[0] for p in profile]
X0, X1 = min(xs) + 0.01, max(xs) - 0.01
LEN = X1 - X0
W = CAR["width"]
BELT = CAR["belt"]
WHEELS = CAR["wheels"]
WZ = CAR["wheelZ"]
HW_IN = WZ[0] - 0.06


def span_at(x):
    lo, hi = math.inf, -math.inf
    n = len(profile)
    for i in range(n):
        ax, ay = profile[i]
        bx, by = profile[(i + 1) % n]
        if (ax - x) * (bx - x) > 0 or ax == bx:
            continue
        y = ay + (x - ax) / (bx - ax) * (by - ay)
        lo, hi = min(lo, y), max(hi, y)
    return (lo, hi) if hi > lo else None


def top_at(x):
    s = span_at(clamp(x, X0, X1))
    return s[1] if s else BELT


def half_width(x):
    ef = (X1 - x) / (LEN * (0.1 + 0.1 * NOSE_ROUND))
    er = (x - X0) / (LEN * 0.09)

    def f(e, lo):
        return 1.0 if e >= 1 else lo + (1 - lo) * math.sqrt(max(0.0, 1 - (1 - e) * (1 - e)))

    return W / 2 * min(f(ef, 0.7 - 0.12 * NOSE_ROUND), f(er, 0.82))


def floor_at(x):
    return CLEARANCE + 0.08 * (1 - smooth(0, 0.3, x - X0)) + 0.05 * (1 - smooth(0, 0.3, X1 - x))


def arch_at(x):
    y = -math.inf
    for w in WHEELS:
        R = w["r"] + 0.08
        dx = x - w["x"]
        if abs(dx) < R:
            y = max(y, w["r"] + math.sqrt(R * R - dx * dx))
    return y


SIDE, TOP = 5, 7


def section(x):
    """Half a cross-section, from the middle of the floor round to the middle of the roof, as (right, up)."""
    top = top_at(x)
    floor = floor_at(x)
    hw = half_width(x)
    arch = arch_at(x)
    side_bot = min(max(floor, arch), min(top, BELT) - 0.05)
    ys = max(side_bot + 0.04, min(top, BELT))
    cabin = smooth(0.02, 0.2, top - BELT)
    well_in = min(HW_IN, hw * 0.92)
    pts = [(0.0, floor), (well_in, floor), (well_in, side_bot), (hw * 0.985, side_bot)]
    for i in range(1, SIDE + 1):
        s = i / SIDE
        y = side_bot + (ys - side_bot) * s
        z = hw * (1 - 0.05 * (1 - s) ** 3 - 0.03 * s**5)
        pts.append((z, y))
    roof_w = hw * ROOF_W
    for i in range(1, TOP + 1):
        t = i / TOP
        hz = hw * 0.97 * (1 - t**1.35)
        hy = ys + 0.035 * math.sin(min(1, t * 3) * math.pi / 2) + 0.025 * (1 - (hz / hw) ** 2) * t
        if t <= 0.5:
            u = t / 0.5
            cz = hw * 0.93 + (roof_w - hw * 0.93) * u
            cy = ys + (top - 0.045 - ys) * (1 - (1 - u) ** 1.6)
        else:
            u = (t - 0.5) / 0.5
            cz = roof_w * (1 - u)
            cy = top - 0.045 * (cz / roof_w) ** 2
        pts.append((hz + (cz - hz) * cabin, hy + (cy - hy) * cabin))
    return pts, top - BELT > 0.12


def build_body():
    stations = []
    n = 44
    for i in range(n + 1):
        t = i / n
        stations.append(X0 + LEN * (0.5 - 0.5 * math.cos(math.pi * t)))
    for w in WHEELS:
        for k in range(-4, 5):
            stations.append(w["x"] + k / 4 * (w["r"] + 0.08) * 0.999)
    stations = sorted(set(round(s, 4) for s in stations))
    bm = bmesh.new()
    rings = []
    cabin_flags = []
    for x in stations:
        half, cabin = section(x)
        # the full ring: the left side from the roof down, then the right side back up (the
        # middle points shared)
        ring_pts = [(-z, y) for (z, y) in reversed(half[1:])] + [(z, y) for (z, y) in half]
        verts = [bm.verts.new(V(x, y, z)) for (z, y) in ring_pts]
        rings.append(verts)
        cabin_flags.append(cabin)
    count = len(rings[0])
    half_n = (count + 1) // 2  # index of the floor's middle
    for r in range(len(rings) - 1):
        A, B = rings[r], rings[r + 1]
        for k in range(count - 1):
            f = bm.faces.new((A[k], B[k], B[k + 1], A[k + 1]))
            # which part: the well and floor dark, the roof darker on some liveries, the rest paint
            j = k if k >= half_n - 1 else count - 2 - k  # distance round from the left roof to the floor
            dist_from_floor = abs(k - (half_n - 1))
            if dist_from_floor < 3:
                f.material_index = 2
            elif DARK_ROOF and cabin_flags[r] and (k < TOP // 2 or k > count - 2 - TOP // 2):
                f.material_index = 1
            else:
                f.material_index = 0
    # crisp character lines: the shoulder along each flank, and a softer one at the arch lips,
    # so the subdivided body keeps an edge there instead of melting into one soft shape
    crease = bm.edges.layers.float.get("crease_edge") or bm.edges.layers.float.new("crease_edge")
    half_len = half_n  # points in a half-section (the floor's middle is shared)
    shoulder = 3 + SIDE
    lines = {(half_len - 1) + shoulder: 0.75, (half_len - 1) - shoulder: 0.75, (half_len - 1) + 3: 0.45, (half_len - 1) - 3: 0.45}
    for r in range(len(rings) - 1):
        for idx, value in lines.items():
            if 0 <= idx < count:
                e = bm.edges.get((rings[r][idx], rings[r + 1][idx]))
                if e:
                    e[crease] = value
    # close the nose and the tail with a fan to a point a few centimetres out
    for ring, dirn in ((rings[0], -1), (rings[-1], 1)):
        c = sum((v.co for v in ring), Vector()) / len(ring)
        c.x += dirn * 0.04
        tip = bm.verts.new(c)
        for k in range(count - 1):
            bm.faces.new((ring[k], ring[k + 1], tip) if dirn > 0 else (ring[k + 1], ring[k], tip))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = new_object("body", bm, ["paint", "paint_roof", "well"])
    sub = ob.modifiers.new("smooth", "SUBSURF")
    sub.levels = 2
    sub.render_levels = 2
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    ob.modifiers.clear()
    old = ob.data
    ob.data = me
    bpy.data.meshes.remove(old)
    for p in me.polygons:
        p.use_smooth = True
    return ob


body = build_body()
dg = bpy.context.evaluated_depsgraph_get()
BVH = BVHTree.FromObject(body, dg)


def hit(origin, direction, dist=5.0):
    """Where a ray from `origin` along `direction` meets the body: (point, normal) or None."""
    loc, nor, _, _ = BVH.ray_cast(Vector(origin), Vector(direction).normalized(), dist)
    return (loc, nor) if loc is not None else None


def on_side(x, up, side, out=0.004):
    """The body's flank at (x, up) on one side (1 right, -1 left): cast outward from the middle."""
    h = hit(V(x, up, 0), V(0, 0, side) - V(0, 0, 0))
    if not h:
        return None
    return h[0] + h[1] * out, h[1]


def on_top(x, right, out=0.004):
    h = hit(V(x, 3, right), (0, 0, -1))
    if not h:
        return None
    return h[0] + h[1] * out, h[1]


def on_nose(up, right, out=0.004):
    h = hit(V(X1 + 1, up, right), (-1, 0, 0))
    return (h[0] + h[1] * out, h[1]) if h else None


def on_tail(up, right, out=0.004):
    h = hit(V(X0 - 1, up, right), (1, 0, 0))
    return (h[0] + h[1] * out, h[1]) if h else None


# ---------------------------------------------------------------------------- small modelling tools


def oriented(obj, at, normal, up=(0, 0, 1)):
    """Stands an object at `at` with its local +z along the surface normal."""
    n = Vector(normal).normalized()
    u = Vector(up)
    if abs(n.dot(u)) > 0.95:
        u = Vector((1, 0, 0))
    xa = u.cross(n).normalized()
    ya = n.cross(xa)
    # (keeping its own scale: an ellipsoid lens or a long slot stays that shape)
    scale = Matrix.Diagonal(tuple(obj.scale) + (1.0,))
    obj.matrix_world = Matrix.Translation(at) @ Matrix((xa, ya, n)).transposed().to_4x4() @ scale


def box(name, size, at, mat, bevel=0.0, rot=None, segments=2):
    """A bevelled box, `size` its half extents along its own x, y, z (for a part laid on the body
    by `oriented`: x and y across the surface, z out of it)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
        v.co.z *= size[2]
    if bevel:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=min(bevel, 0.95 * min(size)), segments=segments, affect="EDGES", profile=0.5)
    ob = new_object(name, bm, [mat])
    ob.location = at
    if rot:
        ob.rotation_euler = rot
    return ob


def cylinder(name, r, depth, at, mat, axis="Y", segs=24, r2=None, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segs, radius1=r, radius2=r if r2 is None else r2, depth=depth)
    ob = new_object(name, bm, [mat])
    ob.location = at
    ob.rotation_euler = {"X": (0, math.pi / 2, 0), "Y": (math.pi / 2, 0, 0), "Z": (0, 0, 0)}[axis]
    return ob


def sphere(name, r, at, mat, scale=(1, 1, 1), segs=20):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=max(8, segs // 2), radius=r)
    ob = new_object(name, bm, [mat])
    ob.location = at
    ob.scale = scale
    return ob


def tube(name, points, r, mat, closed=False):
    """A thin tube along points (seams, seals, wiper arms, roll cage)."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    cu.bevel_resolution = 2
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    for i, p in enumerate(points):
        sp.points[i].co = (p[0], p[1], p[2], 1)
    sp.use_cyclic_u = closed
    ob = bpy.data.objects.new(name, cu)
    scene.collection.objects.link(ob)
    cu.materials.append(MATS[mat] if isinstance(mat, str) else mat)
    return ob


def mirror_wedge(name, center, mat, fwd=0.085, half_out=0.052, half_up=0.043, taper=0.62, bevel=0.016):
    """A rounded wedge in world space: a wide rear face (the mirror) tapering forward."""
    bm = bmesh.new()
    rings = []
    for xi, sc in ((-1, 1.0), (1, taper)):
        cz = center.z - (0.0 if xi < 0 else 0.006)
        vs = [bm.verts.new(Vector((center.x + xi * fwd, center.y + yo * half_out * sc, cz + zo * half_up * sc)))
              for (yo, zo) in ((-1, -1), (-1, 1), (1, 1), (1, -1))]
        rings.append(vs)
    a, b = rings
    for k in range(4):
        bm.faces.new((a[k], a[(k + 1) % 4], b[(k + 1) % 4], b[k]))
    bm.faces.new(tuple(reversed(a)))
    bm.faces.new(tuple(b))
    if bevel:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=3, affect="EDGES", profile=0.5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_object(name, bm, [mat])


def empty(name, at):
    e = bpy.data.objects.new(name, None)
    e.location = at
    scene.collection.objects.link(e)
    return e


# ---------------------------------------------------------------------------- glass

windows = [tuple(p) for p in CAR["windows"]]


def inside(poly, x, y):
    hit_ = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit_ = not hit_
        j = i
    return hit_


def build_side_glass():
    """The side windows: the window outline itself, finely triangulated and wrapped onto the flank."""
    if len(windows) < 3:
        return
    from mathutils.geometry import tessellate_polygon

    tris = tessellate_polygon([[Vector((x, y, 0)) for x, y in windows]])
    for side in (1, -1):
        bm = bmesh.new()
        flat = [bm.verts.new(Vector((x, y, 0))) for x, y in windows]
        for a, b, c in tris:
            try:
                bm.faces.new((flat[a], flat[b], flat[c]))
            except ValueError:
                pass
        for _ in range(3):
            bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        # each point of the flat outline onto the glasshouse
        for v in bm.verts:
            x, y = v.co.x, v.co.y
            hs = on_side(x, min(y, top_at(x) - 0.03), side, 0.006)
            v.co = hs[0] if hs else V(x, y, side * half_width(x) * 0.8)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        new_object("glass_side_" + ("R" if side > 0 else "L"), bm, ["glass"])
        # a black rubber seal round the outline
        seal = []
        for k in range(len(windows) + 1):
            x, y = windows[k % len(windows)]
            hs = on_side(x, min(y, top_at(x) - 0.03), side, 0.004)
            if hs:
                seal.append(hs[0])
        if len(seal) > 3:
            tube("seal_" + ("R" if side > 0 else "L"), seal, 0.009, "rubber", closed=True)


def screens():
    """The steep runs of the roof line through the cabin: windscreen (nose end) and rear screen."""
    cab = [x / 400 * LEN + X0 for x in range(401) if top_at(x / 400 * LEN + X0) - BELT > 0.1]
    if not cab:
        return []
    c0, c1 = cab[0], cab[-1]

    def slope(x):
        return (top_at(x + 0.06) - top_at(x - 0.06)) / 0.12

    def run(start, step, want):
        a = start
        while (a > c0 if step < 0 else a < c1) and not want(slope(a)):
            a += step
        b = a
        while (b > c0 if step < 0 else b < c1) and want(slope(b)):
            b += step
        return (min(a, b), max(a, b))

    return [run(c1, -0.01, lambda s: s < -0.4), run(c0, 0.01, lambda s: s > 0.3)]


SCREENS = screens()


def build_screens():
    for idx, (sa, sb) in enumerate(SCREENS):
        if sb - sa < 0.15:
            continue
        bm = bmesh.new()
        nx, nz = 20, 22
        grid = {}
        for i in range(nx + 1):
            x = sa + 0.03 + (sb - sa - 0.06) * i / nx
            hw = half_width(x) * ROOF_W
            edge = abs(i / nx - 0.5) * 2
            wdt = max(0.2, (hw - 0.06) * (1 - 0.12 * edge**6))
            for j in range(nz + 1):
                z = -wdt + 2 * wdt * j / nz
                s = on_top(x, z, 0.006)
                if s:
                    grid[(i, j)] = bm.verts.new(s[0])
        for i in range(nx):
            for j in range(nz):
                q = [grid.get(k) for k in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))]
                if all(q):
                    bm.faces.new(q)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        for f in bm.faces:
            if f.normal.z < 0:
                f.normal_flip()
        new_object("glass_screen_%d" % idx, bm, ["glass"])
        # wipers on the windscreen: parked flat along its bottom (cowl) edge
        if idx == 0 and F.get("wipers"):
            for z0, z1 in ((-0.46, -0.04), (0.04, 0.46)):
                for name, out, rad in (("wiper_arm", 0.006, 0.005), ("wiper_blade", 0.013, 0.0035)):
                    pts = []
                    for k in range(9):
                        t = k / 8
                        z = z0 + (z1 - z0) * t
                        x = sa + 0.045 + 0.06 * t  # a slight rise up the glass
                        s = on_top(x, z, out)
                        if s:
                            pts.append(s[0])
                    if len(pts) > 3:
                        tube(name, pts, rad, "trim" if name == "wiper_arm" else "rubber")
            for z in (-0.05, 0.05):
                s = on_top(sa + 0.045, z, 0.012)
                if s:
                    sphere("wiper_pivot", 0.012, s[0], "trim", segs=10)


build_side_glass()
build_screens()

# ---------------------------------------------------------------------------- panel seams (shut lines)


def seam_side(x, y0, y1, side):
    pts = []
    for k in range(12):
        y = y0 + (y1 - y0) * k / 11
        s = on_side(x, y, side, 0.0015)
        if s:
            pts.append(s[0])
    if len(pts) > 3:
        tube("seam", pts, 0.0035, "trim")


def seam_across(x, side_up):
    pts = []
    for k in range(25):
        z = -0.95 + 1.9 * k / 24
        z *= half_width(x) * 0.95
        s = on_top(x, z, 0.0015)
        if s:
            pts.append(s[0])
    if len(pts) > 3:
        tube("seam", pts, 0.0035, "trim")


if windows:
    wx = [p[0] for p in windows]
    wx0, wx1 = min(wx), max(wx)
    door_front, door_back = wx1 - 0.08, wx0 + (wx1 - wx0) * 0.35
    door_rear = wx0 + (wx1 - wx0) * 0.08 if DOORS >= 4 else None
    for side in (1, -1):
        seam_side(door_front, CLEARANCE + 0.16, BELT - 0.02, side)
        seam_side(door_back, CLEARANCE + 0.16, BELT - 0.02, side)
        if door_rear is not None:
            # the rear door's trailing line, on 4-door cars
            seam_side(door_rear, CLEARANCE + 0.16, BELT - 0.02, side)
        if F.get("doorHandles"):
            for hx in ((door_back + 0.18,) if door_rear is None else (door_back + 0.18, door_rear + 0.16)):
                s = on_side(hx, BELT - 0.09, side, 0.004)
                if s:
                    h = box("door_handle", (0.075, 0.012, 0.007), s[0], "chrome" if CAR["silhouette"] in ("muscle", "gt") else "trim", bevel=0.005)
                    oriented(h, s[0], s[1])
    if SCREENS:
        # the bonnet's shut line ahead of the windscreen, and the boot's behind the rear screen
        cowl = SCREENS[0][0]
        seam_across(max(X0 + 0.2, cowl - 0.12), True)
        # the two longitudinal bonnet edge seams, running from the cowl to the nose
        for side in (1, -1):
            pts = []
            xs = max(cowl + 0.04, X0 + 0.3)
            xe = X1 - 0.1
            for k in range(16):
                t = k / 15
                x = xs + (xe - xs) * t
                s = on_top(x, side * half_width(x) * (0.68 - 0.14 * t), 0.0015)
                if s:
                    pts.append(s[0])
            if len(pts) > 3:
                tube("seam", pts, 0.0035, "trim")
        if SCREENS[1][1] - SCREENS[1][0] > 0.15:
            seam_across(max(X0 + 0.25, SCREENS[1][0] - 0.12), True)

# ---------------------------------------------------------------------------- lamps

nose_y = min(top_at(X1 - 0.3) - 0.08, 0.66)
heads = []
for side in (1, -1):
    z = side * half_width(X1 - 0.25) * 0.66
    s = on_nose(nose_y, z, 0.0)
    if not s:
        continue
    at, n = s
    if F["lamps"] == "popup":
        # a raised popup pod with a dark seam, its lamp slit on the front face
        t = on_top(at.x - 0.16, z, 0.003)
        if t:
            seam = box("popup_seam", (0.155, 0.17, 0.003), t[0] + t[1] * 0.001, "trim", bevel=0.006, segments=3)
            oriented(seam, t[0] + t[1] * 0.001, t[1])
            pod = box("popup_lid", (0.14, 0.155, 0.008), t[0] + t[1] * 0.006, "paint", bevel=0.012, segments=4)
            oriented(pod, t[0] + t[1] * 0.006, t[1])
            slit = t[0] + t[1] * 0.014 + Vector((0.138, 0, 0))
            housing = box("head_housing", (0.1, 0.012, 0.014), slit - n * 0.004, "trim", bevel=0.006)
            oriented(housing, slit - n * 0.004, Vector((1, 0, 0)))
            lamp = box("head_slit", (0.09, 0.006, 0.005), slit + n * 0.004, "head", bevel=0.003)
            oriented(lamp, slit + n * 0.004, Vector((1, 0, 0)))
    elif F["lamps"] == "round":
        # dark recessed bowl, chrome reflector, projector, clear domed lens
        housing = cylinder("head_housing", 0.1, 0.035, at - n * 0.012, "trim", segs=28)
        oriented(housing, at - n * 0.012, n)
        bowl = cylinder("head_reflector", 0.082, 0.025, at - n * 0.002, "chrome", segs=28, r2=0.055)
        oriented(bowl, at - n * 0.002, n)
        bulb = sphere("head_lamp", 0.045, at + n * 0.002, "head", scale=(1, 1, 0.5))
        oriented(bulb, at + n * 0.002, n)
        lens = sphere("head_lens", 0.086, at + n * 0.008, "lens", scale=(1, 1, 0.2), segs=28)
        oriented(lens, at + n * 0.008, n)
    elif F["lamps"] == "y_shape":
        # dark recessed panel with a Y-shaped daytime light
        housing = box("head_housing", (0.15, 0.06, 0.014), at - n * 0.008, "trim", bevel=0.02, segments=3)
        oriented(housing, at - n * 0.008, n)
        stem = box("head_drl", (0.008, 0.012, 0.055), at + n * 0.004 + Vector((0, 0, -0.035)), "head", bevel=0.003)
        for sgn in (1, -1):
            arm = box("head_drl", (0.008, 0.07, 0.01), at + n * 0.004 + Vector((0, sgn * 0.032, 0.032)), "head", bevel=0.003)
            arm.rotation_euler = (sgn * 0.7, 0, 0)
        proj = sphere("head_lamp", 0.028, at + n * 0.002 + Vector((0, 0, -0.046)), "head", scale=(1, 1, 0.5))
        oriented(proj, at + n * 0.002 + Vector((0, 0, -0.046)), n)
    else:
        # wide slim unit: dark recessed surround, two chrome reflectors + projectors, clear flush lens
        housing = box("head_housing", (0.17, 0.058, 0.016), at - n * 0.008, "trim", bevel=0.024, segments=4)
        oriented(housing, at - n * 0.008, n)
        inner = box("head_recess", (0.15, 0.048, 0.008), at - n * 0.014, "rubber", bevel=0.02, segments=3)
        oriented(inner, at - n * 0.014, n)
        for dy in (-0.055, 0.055):
            p = at + Vector((0, dy, 0))
            ref = cylinder("head_reflector", 0.048, 0.02, p - n * 0.002, "chrome", segs=24, r2=0.032)
            oriented(ref, p - n * 0.002, n)
            proj = sphere("head_lamp", 0.031, p + n * 0.004, "head", scale=(1.25, 1, 0.55))
            oriented(proj, p + n * 0.004, n)
        drl = box("head_drl", (0.125, 0.004, 0.003), at + n * 0.012 + Vector((0, 0, -0.042)), "head", bevel=0.002)
        oriented(drl, at + n * 0.012 + Vector((0, 0, -0.042)), n)
        lens = box("head_lens", (0.155, 0.05, 0.009), at + n * 0.007, "lens", bevel=0.02, segments=3)
        oriented(lens, at + n * 0.007, n)
    heads.append(empty("headlight_" + ("R" if side > 0 else "L"), at + n * 0.05))

# the grille and the splitter under the nose
grille_y = max(CLEARANCE + 0.14, nose_y - 0.24)
g = on_nose(grille_y, 0.0, 0.0)
if g:
    at, n = g
    hw = half_width(at.x) * 0.55
    kind = F.get("grille", "slat")
    if kind in ("slat", "big", "mesh", "eggcrate", "intake", "horse"):
        wdt = {"big": 1.25, "intake": 1.35, "eggcrate": 1.15}.get(kind, 1.0) * hw * F.get("grille_w", 1.0)
        hgt = {"big": 0.2, "intake": 0.17, "eggcrate": 0.16}.get(kind, 0.12)
        back = box("grille_back", (wdt, hgt / 2, 0.02), at - n * 0.012, "rubber", bevel=0.012)
        oriented(back, at - n * 0.01, n)
        bars = 5 if kind in ("slat", "horse") else 0
        for i in range(bars):
            y = -hgt / 2 + hgt * (i + 0.5) / bars
            bar = box("grille_slat", (wdt * 0.95, 0.006, 0.008), at + Vector((0, 0, y)) + n * 0.004, "chrome" if kind == "slat" and CAR["silhouette"] in ("muscle", "gt") else "trim", bevel=0.003)
            oriented(bar, at + Vector((0, 0, y)) + n * 0.005, n)
        if kind in ("mesh", "eggcrate", "big"):
            cols, rows = (14, 4) if kind != "mesh" else (22, 5)
            for i in range(cols + 1):
                yy = -wdt + 2 * wdt * i / cols
                bar = box("grille_mesh", (0.003, hgt / 2 * 0.92, 0.006), at + Vector((0, -yy, 0)) + n * 0.004, "trim")
                oriented(bar, at + Vector((0, -yy, 0)) + n * 0.006, n)
            for j in range(rows + 1):
                y = -hgt / 2 + hgt * j / rows
                bar = box("grille_mesh", (wdt * 0.98, 0.003, 0.006), at + Vector((0, 0, y)) + n * 0.004, "trim")
                oriented(bar, at + Vector((0, 0, y)) + n * 0.006, n)
        if kind == "horse":
            badge = box("grille_badge", (0.03, 0.04, 0.005), at + n * 0.012, "chrome", bevel=0.004)
            oriented(badge, at + n * 0.012, n)
    elif kind == "kidney":
        for side in (1, -1):
            k = box("kidney", (0.1, 0.065, 0.012), at + Vector((0, -side * 0.13, 0.04)) + n * 0.004, "rubber", bevel=0.03, segments=4)
            oriented(k, at + Vector((0, -side * 0.13, 0.04)) + n * 0.004, n)
            ring = box("kidney_surround", (0.11, 0.075, 0.008), at + Vector((0, -side * 0.13, 0.04)), "chrome", bevel=0.032, segments=4)
            oriented(ring, at + Vector((0, -side * 0.13, 0.04)), n)
    # lower intakes either side
    for side in (1, -1):
        li = on_nose(CLEARANCE + 0.13, side * half_width(X1 - 0.2) * 0.62, 0.0)
        if li:
            v = box("intake_lower", (0.12, 0.03, 0.012), li[0] - li[1] * 0.006, "rubber", bevel=0.02, segments=3)
            oriented(v, li[0], li[1])
if F.get("splitter") != "none":
    big = F["splitter"] == "wing"
    sx = X1 - (0.05 if big else 0.1)
    sp = box("splitter", (0.11 if big else 0.05, half_width(sx) * (1.0 if big else 0.88), 0.008), V(sx, CLEARANCE - 0.005, 0), "carbon" if F.get("carbon") else "trim", bevel=0.005)
if F.get("canards"):
    for side in (1, -1):
        c = on_side(X1 - 0.3, CLEARANCE + 0.22, side, 0.0)
        if c:
            cn = box("canard", (0.08, 0.004, 0.035), c[0] + c[1] * 0.03, "carbon", bevel=0.002)
            cn.rotation_euler = (0, -0.25, 0)

# tail lamps
tail_y = min(top_at(X0 + 0.25) - 0.09, 0.8)
thw = half_width(X0 + 0.1)
tail_kind = F.get("tail", "bar")


def round_tail(name, at, n, r=0.075):
    """A real lamp unit: dark recessed housing, chrome reflector, domed red lens."""
    housing = cylinder(name + "_housing", r * 1.22, 0.022, at - n * 0.008, "trim", segs=28)
    oriented(housing, at - n * 0.008, n)
    ring = cylinder(name + "_ring", r * 1.12, 0.012, at - n * 0.002, "chrome", segs=28, cap=False)
    oriented(ring, at - n * 0.002, n)
    refl = cylinder(name + "_reflector", r * 0.92, 0.008, at - n * 0.001, "chrome", segs=28)
    oriented(refl, at - n * 0.001, n)
    lens = sphere(name, r, at + n * 0.004, "tail", scale=(1, 1, 0.3), segs=28)
    oriented(lens, at + n * 0.004, n)


if tail_kind in ("quad", "quad_round"):
    for side in (1, -1):
        for off in (0.2, 0.46):
            t = on_tail(tail_y, side * (thw - off), 0.0)
            if t:
                round_tail("tail_round", t[0], t[1])
elif tail_kind == "single_round":
    for side in (1, -1):
        t = on_tail(tail_y, side * (thw - 0.32), 0.0)
        if t:
            round_tail("tail_round", t[0], t[1], 0.082)
elif tail_kind == "tri_bar":
    for side in (1, -1):
        base = on_tail(tail_y, side * (thw - 0.33), 0.0)
        if not base:
            continue
        at, n = base
        panel = box("tail_housing", (0.115, 0.075, 0.012), at - n * 0.008, "trim", bevel=0.014, segments=3)
        oriented(panel, at - n * 0.008, n)
        for dx in (-0.062, 0.0, 0.062):
            b = box("tail_bar", (0.016, 0.055, 0.008), at + Vector((0, dx, 0)) + n * 0.004, "tail", bevel=0.004)
            oriented(b, at + Vector((0, dx, 0)) + n * 0.004, n)
elif tail_kind == "y_shape":
    for side in (1, -1):
        base = on_tail(tail_y, side * (thw - 0.34), 0.0)
        if not base:
            continue
        at, n = base
        box("tail_housing", (0.01, 0.09, 0.075), at - n * 0.008, "trim", bevel=0.014, segments=3)
        box("tail_bar", (0.008, 0.012, 0.06), at + n * 0.004 + Vector((0, 0, -0.025)), "tail", bevel=0.003)
        for sgn in (1, -1):
            arm = box("tail_bar", (0.008, 0.075, 0.012), at + n * 0.004 + Vector((0, sgn * 0.036, 0.035)), "tail", bevel=0.003)
            arm.rotation_euler = (sgn * 0.75, 0, 0)
else:
    # full-width light bar: dark housing behind a red lens, plus end clusters
    pts, behind = [], []
    for k in range(31):
        z = -thw * 0.92 + 2 * thw * 0.92 * k / 30
        t = on_tail(tail_y, z, 0.006)
        b = on_tail(tail_y, z, 0.0)
        if t:
            pts.append(t[0])
        if b:
            behind.append(b[0])
    if len(pts) > 5:
        tube("tail_housing", behind, 0.026, "trim")
        tube("tail_bar", pts, 0.017, "tail")
    for side in (1, -1):
        t = on_tail(tail_y - 0.02, side * (thw - 0.28), 0.0)
        if t:
            h = box("tail_housing", (0.1, 0.038, 0.012), t[0] - t[1] * 0.004, "trim", bevel=0.01, segments=3)
            oriented(h, t[0] - t[1] * 0.004, t[1])
            c = box("tail_cluster", (0.085, 0.028, 0.008), t[0] + t[1] * 0.002, "tail", bevel=0.01, segments=3)
            oriented(c, t[0] + t[1] * 0.002, t[1])
# the diffuser, and the exhausts through it
dy = CLEARANCE + 0.1
diff = box("diffuser", (0.08, thw * 0.75, 0.03), V(X0 + 0.1, dy, 0), aero_mat(), bevel=0.008)
if F.get("diffuser") == "fins":
    for i in range(6):
        z = -thw * 0.6 + thw * 1.2 * i / 5
        box("diffuser_fin", (0.09, 0.003, 0.03), V(X0 + 0.08, dy - 0.02, -z), aero_mat())
ey = CLEARANCE + (0.2 if F["exhaust"] in ("centre", "tri", "quad_centre") else 0.1)
hex_tip = "hex" in SIG
if F["exhaust"] == "tri":
    # LFA-style triangular triple exit
    spots = [(-0.09, 0.03), (0.09, 0.03), (0.0, -0.065)]
elif F["exhaust"] == "quad_centre":
    spots = [(-0.12, 0.0), (-0.04, 0.0), (0.04, 0.0), (0.12, 0.0)]
else:
    zs = {"centre": (-0.09, 0.09), "quad": (-0.55, -0.4, 0.4, 0.55)}.get(F["exhaust"], (-0.42, 0.42))
    spots = [(z, 0.0) for z in zs]
for k, (zr, zu) in enumerate(spots):
    at = V(X0 + 0.03, ey + zu, zr)
    tip = cylinder("pipe_tip", 0.052, 0.16, at, "chrome", axis="X", segs=6 if hex_tip else 24,
                   cap=False, r2=0.058 if hex_tip else None)
    inner = cylinder("pipe_inner", 0.044, 0.12, at + Vector((0.01, 0, 0)), "rubber", axis="X",
                     segs=6 if hex_tip else 24)
    empty("exhaust_%d" % k, V(X0 - 0.06, ey + zu, zr))

# side markers, fuel cap, strakes, intakes
for side in (1, -1):
    if F.get("sideMarker"):
        for x in (X1 - 0.35, X0 + 0.35):
            s = on_side(x, CLEARANCE + 0.32, side, 0.002)
            if s:
                mk = box("marker", (0.025, 0.01, 0.004), s[0], "amber", bevel=0.003)
                oriented(mk, s[0], s[1])
    if F.get("fuelCap") and side == 1:
        s = on_side(X0 + 0.7, BELT - 0.06, side, 0.0015)
        if s:
            cap = cylinder("fuel_cap", 0.065, 0.006, s[0], "paint", segs=24)
            oriented(cap, s[0], s[1])
            tube("seam", [s[0] + Vector((math.cos(a) * 0.066, 0, math.sin(a) * 0.066)) * 1 for a in [i / 16 * 2 * math.pi for i in range(17)]], 0.002, "trim")
    rear = min(WHEELS, key=lambda w: w["x"])
    if F.get("intakes"):
        s = on_side(rear["x"] + rear["r"] + 0.4, BELT - 0.12, side, -0.01)
        if s:
            at, n = s
            sc = at - n * 0.028
            scoop = sphere("side_intake", 0.1, sc, "rubber", scale=(3.1, 1.05, 0.45), segs=24)
            oriented(scoop, sc, n)
    if F.get("sideStrakes"):
        for k in range(3):
            s = on_side(rear["x"] + rear["r"] + 0.25 + k * 0.08, BELT - 0.2, side, 0.003)
            if s:
                st = box("strake", (0.006, 0.035, 0.005), s[0], "trim", bevel=0.002)
                oriented(st, s[0], s[1])

# door mirrors: a short stalk from the front corner of the side window, a rounded wedge
# housing, and a dark mirror face pointing backwards
if windows:
    wxs = [p[0] for p in windows]
    wys = [p[1] for p in windows]
    mx = max(wxs) - 0.12
    my = BELT - 0.02
    for side in (1, -1):
        s = None
        for up in (my, BELT - 0.06, BELT + 0.01, BELT - 0.1):
            s = on_side(mx, up, side, 0.0)
            if s:
                break
        if not s:
            continue
        at, n = s
        out = Vector((0, -side, 0))
        tube("mirror_stalk", [at + out * 0.005, at + out * 0.05 + Vector((0, 0, 0.04)),
                              at + out * 0.095 + Vector((0, 0, 0.075))], 0.013, "trim")
        center = at + out * 0.115 + Vector((0, 0, 0.085))
        mirror_wedge("mirror", center, "paint", fwd=0.085, half_out=0.05, half_up=0.043)
        box("mirror_lip", (0.006, 0.05, 0.045), center + Vector((-0.079, 0, 0.0)), "paint", bevel=0.012, segments=3)
        box("mirror_face", (0.004, 0.038, 0.033), center + Vector((-0.084, 0, 0.0)), "trim", bevel=0.008, segments=3)

# ---------------------------------------------------------------------------- the bonnet, the wing, the roof


if F.get("bonnet") == "scoop":
    bx = X1 - min(0.95, LEN * 0.2)
    big = "hood_scoop_big" in SIG
    s = on_top(bx, 0, 0.0)
    if s:
        sc = box("bonnet_scoop", (0.28 if big else 0.24, 0.26 if big else 0.22, 0.05 if big else 0.035),
                 s[0] + Vector((0, 0, 0.018 if big else 0.015)), "paint", bevel=0.03, segments=3)
        mouth = box("bonnet_scoop_mouth", (0.008, 0.22 if big else 0.18, 0.025 if big else 0.02),
                    s[0] + Vector((0.28 if big else 0.24, 0, 0.03 if big else 0.025)), "rubber", bevel=0.006)
elif F.get("bonnet") == "vents":
    bx = X1 - min(0.95, LEN * 0.2)
    for side in (1, -1):
        s = on_top(bx, side * 0.32, 0.002)
        if s:
            for k in range(4):
                sl = box("bonnet_vent", (0.006, 0.09, 0.004), s[0], "trim", bevel=0.002)
                oriented(sl, s[0] + Vector((0, (k - 1.5) * 0.025, 0)), s[1])

if F.get("stripes"):
    for z in (0.12, -0.27):
        bm = bmesh.new()
        prev = None
        for k in range(160):
            x = X0 + 0.05 + (LEN - 0.1) * k / 159
            if any(sa < x < sb for sa, sb in SCREENS):
                prev = None
                continue
            a = on_top(x, z, 0.0025)
            b = on_top(x, z + 0.15, 0.0025)
            if not (a and b):
                prev = None
                continue
            va, vb = bm.verts.new(a[0]), bm.verts.new(b[0])
            if prev:
                bm.faces.new((prev[0], prev[1], vb, va))
            prev = (va, vb)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        for f in bm.faces:
            if f.normal.z < 0:
                f.normal_flip()
        new_object("stripe", bm, ["stripe"])

deck_x = X0 + 0.22
deck = on_top(deck_x, 0, 0.0)
deck_y = deck[0].z if deck else top_at(deck_x)
span = half_width(deck_x) * 1.75
wing = F.get("wing", "none")
if wing in ("lip", "duck"):
    duck = wing == "duck"
    # sat on the boot lid where it actually is (it falls away towards the tail)
    lx = X0 + (0.17 if duck else 0.09)
    under = on_top(lx, 0, 0.0)
    ly = (under[0].z if under else top_at(lx)) + (0.03 if duck else 0.008)
    lp = box("wing_lip", (0.13 if duck else 0.06, span / 2, 0.02 if duck else 0.01), V(lx, ly, 0), "paint" if not F.get("carbon") else "carbon", bevel=0.008)
    lp.rotation_euler = (0, 0.22 if duck else 0.12, 0)
elif wing in ("gt", "tall"):
    tall = wing == "tall"
    lift = 0.22 if tall else 0.3
    wx = X0 + (0.24 if tall else 0.3)
    top_y = top_at(wx) + lift
    # an aerofoil: a bevelled slab, thicker at the leading edge
    plane = box("wing", (0.12 if tall else 0.16, span / 2 * (0.97 if tall else 0.92), 0.016), V(wx, top_y, 0), aero_mat() if not tall else "paint", bevel=0.012, segments=3)
    plane.rotation_euler = (0, 0.12, 0)
    for side in (1, -1):
        box("wing_upright", (0.05, 0.008, lift / 2), V(wx + 0.02, top_y - lift / 2, side * span * 0.28), aero_mat(), bevel=0.005)
        box("wing_endplate", (0.13 if tall else 0.18, 0.004, 0.065), V(wx, top_y + 0.02, side * span / 2 * (0.97 if tall else 0.92)), aero_mat(), bevel=0.003)
elif wing == "hoop":
    # a big Supra-style hoop wing on tall uprights
    wx = X0 + 0.3
    top_y = top_at(wx) + 0.34
    half = span / 2 * 0.98
    plane = box("wing", (0.17, half, 0.017), V(wx, top_y, 0), aero_mat(), bevel=0.012, segments=3)
    plane.rotation_euler = (0, 0.14, 0)
    for side in (1, -1):
        z = side * half * 0.86
        box("wing_upright", (0.045, 0.012, 0.17), V(wx + 0.02, top_y - 0.17, z), aero_mat(), bevel=0.006)
        brace = box("wing_upright", (0.09, 0.008, 0.02), V(wx + 0.1, top_y - 0.05, z), aero_mat(), bevel=0.004)
        brace.rotation_euler = (0, -0.55, 0)
        box("wing_endplate", (0.16, 0.006, 0.085), V(wx, top_y + 0.03, side * half * 0.99), aero_mat(), bevel=0.004)
elif wing == "swan":
    # swan-neck uprights that reach over the top of the plane
    wx = X0 + 0.28
    top_y = top_at(wx) + 0.34
    half = span / 2 * 0.93
    plane = box("wing", (0.17, half, 0.016), V(wx, top_y, 0), aero_mat(), bevel=0.012, segments=3)
    plane.rotation_euler = (0, 0.1, 0)
    for side in (1, -1):
        z = side * half * 0.62
        box("wing_upright", (0.03, 0.01, 0.17), V(wx + 0.03, top_y - 0.17, z), aero_mat(), bevel=0.004)
        hook = box("wing_upright", (0.1, 0.008, 0.012), V(wx - 0.02, top_y + 0.018, z), aero_mat(), bevel=0.004)
        hook.rotation_euler = (0, 0.12, 0)
        box("wing_endplate", (0.17, 0.005, 0.055), V(wx, top_y + 0.025, side * half), aero_mat(), bevel=0.003)
elif wing == "full_width":
    # F40-style full-width rear wing with deep endplates
    wx = X0 + 0.22
    top_y = top_at(wx) + 0.28
    half = half_width(wx) * 0.98
    plane = box("wing", (0.16, half, 0.018), V(wx, top_y, 0), aero_mat(), bevel=0.012, segments=3)
    plane.rotation_euler = (0, 0.14, 0)
    for side in (1, -1):
        box("wing_upright", (0.05, 0.01, 0.14), V(wx + 0.02, top_y - 0.14, side * half * 0.42), aero_mat(), bevel=0.005)
        box("wing_endplate", (0.18, 0.005, 0.09), V(wx, top_y + 0.045, side * half), aero_mat(), bevel=0.004)

# ---------------------------------------------------------------------------- per-car signature details

if ("louvres" in SIG or "deck_grille" in SIG) and SCREENS:
    # louvred engine cover / rear deck
    x0 = X0 + 0.34
    x1 = max(x0 + 0.2, SCREENS[1][0] - 0.1)
    count = 9 if "louvres" in SIG else 6
    for k in range(count):
        x = x0 + (x1 - x0) * k / (count - 1)
        s = on_top(x, 0, 0.002)
        if s:
            sl = box("louvre", (0.012, half_width(x) * 0.44, 0.006), s[0], "trim", bevel=0.003)
            oriented(sl, s[0], s[1])

if "naca" in SIG:
    # NACA ducts pressed into the doors
    for side in (1, -1):
        for k in range(2):
            s = on_side(X0 + 0.82 + k * 0.24, BELT - 0.2, side, -0.004)
            if s:
                d = sphere("naca_duct", 0.065, s[0], "rubber", scale=(1.5, 0.65, 0.12), segs=18)
                oriented(d, s[0], s[1])

if "c_line" in SIG:
    # the Chiron's big C-shaped side line
    for side in (1, -1):
        cx, cz = X0 + LEN * 0.55, BELT + 0.02
        pts = []
        for k in range(19):
            a = math.radians(-140 + 280 * k / 18)
            s = on_side(cx + 0.52 * math.cos(a), cz + 0.3 * math.sin(a), side, 0.004)
            if s:
                pts.append(s[0])
        if len(pts) > 4:
            tube("c_line", pts, 0.006, "trim")

if "horseshoe" in SIG:
    # the Bugatti horseshoe grille surround
    gy = max(CLEARANCE + 0.18, nose_y - 0.24)
    g = on_nose(gy, 0, 0.0)
    if g:
        at, n = g
        back = box("horseshoe_back", (0.22, 0.16, 0.014), at - n * 0.008, "rubber", bevel=0.03, segments=4)
        oriented(back, at - n * 0.008, n)
    path = []
    for k in range(6):
        path.append((gy + 0.13 - 0.24 * k / 5, -0.13))
    for k in range(1, 7):
        path.append((gy - 0.11, -0.13 + 0.26 * k / 6))
    for k in range(1, 6):
        path.append((gy - 0.11 + 0.24 * k / 5, 0.13))
    pts = []
    for up, right in path:
        s = on_nose(up, right, 0.004)
        if s:
            pts.append(s[0])
    if len(pts) > 4:
        tube("horseshoe", pts, 0.012, "chrome")

if "hex" in SIG:
    # hexagonal vents on the flanks and engine cover
    for side in (1, -1):
        for k in range(3):
            s = on_side(X0 + LEN * 0.62 + k * 0.13, BELT - 0.1 - k * 0.03, side, -0.002)
            if s:
                h = cylinder("hex_vent", 0.055, 0.012, s[0], "rubber", segs=6)
                oriented(h, s[0], s[1])
        for k in range(2):
            s = on_top(X0 + 0.55 + k * 0.16, side * 0.25, 0.001)
            if s:
                h = cylinder("hex_vent", 0.05, 0.01, s[0], "rubber", segs=6)
                oriented(h, s[0], s[1])

if "wing_vents" in SIG:
    # louvres over the front wheels
    fx = max(w["x"] for w in WHEELS)
    for side in (1, -1):
        for k in range(4):
            x = fx - 0.2 + k * 0.12
            s = on_top(x, side * half_width(x) * 0.62, 0.002)
            if s:
                v = box("fender_vent", (0.008, 0.075, 0.005), s[0], "trim", bevel=0.002)
                oriented(v, s[0], s[1])

if "power_dome" in SIG:
    # halfway along the bonnet (between the nose and the windscreen's foot), sunk into it
    base = SCREENS[0][1] if SCREENS else X1 - LEN * 0.3
    s = on_top((base + X1 - 0.3) / 2, 0, 0.0)
    if s:
        dome = sphere("power_dome", 0.5, s[0] - s[1] * 0.014, "paint", scale=(0.36, 0.62, 0.05), segs=24)  # (local y runs along the car once oriented)
        oriented(dome, s[0] - s[1] * 0.014, s[1])

if "side_blade" in SIG:
    rear = min(WHEELS, key=lambda w: w["x"])
    bx = rear["x"] + rear["r"] + 0.17
    for side in (1, -1):
        s = on_side(bx, BELT - 0.04, side, 0.003)
        if s:
            b = box("side_blade", (0.16, 0.085, 0.012), s[0], "carbon", bevel=0.008, segments=3)
            oriented(b, s[0], s[1])

if "side_gills" in SIG:
    for side in (1, -1):
        for k in range(3):
            s = on_side(X1 - 0.95 + k * 0.06, BELT - 0.22, side, -0.003)
            if s:
                g = box("side_gill", (0.012, 0.05, 0.006), s[0], "trim", bevel=0.003)
                oriented(g, s[0], s[1])

if "hood_vent" in SIG:
    bx = X1 - min(0.9, LEN * 0.2)
    for k in range(4):
        s = on_top(bx + 0.05 * k, 0, 0.002)
        if s:
            v = box("hood_vent", (0.008, 0.16, 0.005), s[0], "trim", bevel=0.002)
            oriented(v, s[0], s[1])

if "r35_hood" in SIG:
    for side in (1, -1):
        s = on_top(X1 - min(0.9, LEN * 0.2), side * 0.28, 0.002)
        if s:
            for k in range(3):
                v = box("bonnet_vent", (0.006, 0.075, 0.004), s[0], "trim", bevel=0.002)
                oriented(v, s[0] + Vector((0, (k - 1) * 0.03, 0)), s[1])

if "big_intake" in SIG:
    # wide front bumper opening
    gy = CLEARANCE + 0.16
    g = on_nose(gy, 0, 0.0)
    if g:
        at, n = g
        w = half_width(at.x) * 0.92
        back = box("bumper_intake", (w, 0.07, 0.014), at - n * 0.006, "rubber", bevel=0.03, segments=4)
        oriented(back, at - n * 0.006, n)
        for k in range(5):
            yy = -w + 2 * w * k / 4
            bar = box("bumper_intake_mesh", (0.004, 0.07, 0.006), at + Vector((0, -yy, 0)) + n * 0.004, "trim")
            oriented(bar, at + Vector((0, -yy, 0)) + n * 0.004, n)

if F.get("roofVent") and SCREENS:
    rx = (SCREENS[0][0] + SCREENS[1][1]) / 2
    s = on_top(rx, 0, 0.0)
    if s:
        at, n = s
        sc = at - n * 0.012
        sb = box("roof_scoop", (0.13, 0.07, 0.02), sc, aero_mat(), bevel=0.018, segments=3)
        oriented(sb, sc, n)
if F.get("aerial") and SCREENS:
    s = on_top(SCREENS[1][1] + 0.15, -0.25, 0.0)
    if s:
        cylinder("aerial", 0.004, 0.5, s[0] + Vector((0, 0, 0.25)), "trim", axis="Z", segs=6)
if F.get("badges"):
    s = on_tail(tail_y - 0.12, 0, 0.002)
    if s:
        b = box("badge", (0.045, 0.006, 0.003), s[0], "chrome", bevel=0.002)
        oriented(b, s[0], s[1])
if F.get("rollCage") and windows:
    wx = [p[0] for p in windows]
    hw = half_width((min(wx) + max(wx)) / 2) * 0.55
    hi = top_at((min(wx) + max(wx)) / 2) - 0.08
    for x in (min(wx) + 0.1, max(wx) - 0.25):
        tube("roll_cage", [V(x, BELT - 0.25, -hw), V(x, hi, -hw * 0.85), V(x, hi, hw * 0.85), V(x, BELT - 0.25, hw)], 0.018, "trim")

# ---------------------------------------------------------------------------- finishing details

if windows:
    wxs = [p[0] for p in windows]
    wx0, wx1 = min(wxs), max(wxs)
    floor_y = CLEARANCE + 0.16
    # the cabin, seen through the glass: two seats, the dashboard and a wheel (driver on the left)
    for z in (-0.36, 0.36):
        sx = wx0 + (wx1 - wx0) * 0.38
        # keep the seat inside the cabin even on low-roofed supercars
        vscale = clamp((top_at(sx) - floor_y - 0.18) / 0.9, 0.5, 1.0)
        box("seat", (0.24, 0.24, 0.05), V(sx, floor_y + 0.12, z), "interior", bevel=0.04, segments=3)
        back = box("seat_back", (0.06, 0.24, 0.3 * vscale), V(sx - 0.24, floor_y + 0.42 * vscale, z), "interior", bevel=0.05, segments=3)
        back.rotation_euler = (0, -0.28, 0)
        box("headrest", (0.05, 0.12, 0.08), V(sx - 0.34, floor_y + 0.78 * vscale, z), "interior", bevel=0.03, segments=2)
    dash_x = wx1 - 0.12
    box("dashboard", (0.18, half_width(dash_x) * 0.82, 0.08), V(dash_x, BELT - 0.04, 0), "interior", bevel=0.05, segments=3)
    # the wheel goes where the cabin has headroom for it (under a raked windscreen that's well back)
    wheel_x = dash_x - 0.24
    while wheel_x > wx0 + 0.3 and top_at(wheel_x) - 0.06 < BELT + 0.2:
        wheel_x -= 0.02
    wheel_c = V(wheel_x, BELT - 0.01, -0.36)
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=False, radius=0.18, segments=24)
    sw = new_object("steering_rim", bm, ["interior"])
    tube("steering_wheel", [wheel_c + Vector((0, math.cos(a) * 0.17, math.sin(a) * 0.17)) for a in [i / 24 * 2 * math.pi for i in range(25)]], 0.015, "interior")
    bpy.data.objects.remove(sw)
    cylinder("steering_column", 0.025, max(0.1, dash_x - wheel_x), wheel_c + Vector(((dash_x - wheel_x) / 2, 0, -0.04)), "interior", axis="X", segs=10)
    # the belt line: a trim strip along the foot of the side windows
    for side in (1, -1):
        pts = []
        for k in range(30):
            x = wx0 + 0.05 + (wx1 - wx0 - 0.1) * k / 29
            ys = [y for (xx, y) in windows]
            bottom = min(ys)
            hs = on_side(x, bottom + 0.01, side, 0.004)
            if hs:
                pts.append(hs[0])
        if len(pts) > 4:
            tube("belt_trim", pts, 0.007, "chrome" if YEAR < 1995 else "trim")

# number plates, front and back
if not F.get("noFrontPlate"):
    pf = on_nose(CLEARANCE + 0.2, 0.0, 0.0)
    if pf:
        pl = box("plate_front", (0.24, 0.055, 0.004), pf[0] + pf[1] * 0.006, "plate", bevel=0.004)
        oriented(pl, pf[0] + pf[1] * 0.006, pf[1])
        fr = box("plate_frame", (0.25, 0.064, 0.003), pf[0] + pf[1] * 0.003, "trim", bevel=0.004)
        oriented(fr, pf[0] + pf[1] * 0.003, pf[1])
pr_ = on_tail(tail_y - 0.21, 0.0, 0.0)
if pr_:
    pl = box("plate_rear", (0.24, 0.055, 0.004), pr_[0] + pr_[1] * 0.006, "plate", bevel=0.004)
    oriented(pl, pr_[0] + pr_[1] * 0.006, pr_[1])
    fr = box("plate_frame", (0.25, 0.064, 0.003), pr_[0] + pr_[1] * 0.003, "trim", bevel=0.004)
    oriented(fr, pr_[0] + pr_[1] * 0.003, pr_[1])

# white reversing lamps either side of the plate, and a third brake light at the top of the rear screen
for side in (1, -1):
    rv = on_tail(tail_y - 0.13, side * 0.42, 0.0)
    if rv:
        lamp = box("reverse_lamp", (0.05, 0.018, 0.006), rv[0], "reverse", bevel=0.006)
        oriented(lamp, rv[0], rv[1])
if len(SCREENS) > 1 and SCREENS[1][1] - SCREENS[1][0] > 0.15:
    hm = on_top(SCREENS[1][1] - 0.04, 0.0, 0.004)
    if hm:
        box("tail_highmount", (0.012, 0.13, 0.006), hm[0], "tail", bevel=0.004)

# fog lamps in the lower intakes of the road cars
if F.get("grille") in ("slat", "big", "kidney", "eggcrate", "mesh") and not F.get("carbon"):
    for side in (1, -1):
        fl = on_nose(CLEARANCE + 0.14, side * half_width(X1 - 0.2) * 0.66, 0.0)
        if fl:
            ring = cylinder("fog_ring", 0.042, 0.012, fl[0] + fl[1] * 0.004, "chrome", segs=20)
            oriented(ring, fl[0] + fl[1] * 0.004, fl[1])
            lens = sphere("fog_lens", 0.036, fl[0] + fl[1] * 0.006, "lens", scale=(1, 1, 0.25), segs=16)
            oriented(lens, fl[0] + fl[1] * 0.006, fl[1])

# side skirts along the sills, between the arches
rear_x = min(w["x"] for w in WHEELS) + CAR["wheelRadius"] + 0.1
front_x = max(w["x"] for w in WHEELS) - CAR["wheelRadius"] - 0.1
for side in (1, -1):
    pts = []
    for k in range(24):
        x = rear_x + (front_x - rear_x) * k / 23
        hs = on_side(x, CLEARANCE + 0.07, side, -0.004)
        if hs:
            pts.append(hs[0])
    if len(pts) > 4:
        tube("side_skirt", pts, 0.026, aero_mat())

# a shark-fin aerial on the newer cars' roofs
if YEAR >= 2010 and not F.get("aerial") and SCREENS:
    fx = SCREENS[1][1] + 0.08
    fin = on_top(fx, 0.0, 0.0)
    if fin:
        sphere("shark_fin", 0.06, fin[0] + Vector((0, 0, 0.012)), "paint", scale=(1.6, 0.35, 0.65), segs=16)

# a dark floor pan so nothing shows through underneath
box("floor", (LEN * 0.42, (W / 2) * 0.82, 0.005), V(X0 + LEN / 2, CLEARANCE + 0.02, 0), "well")

# ---------------------------------------------------------------------------- wheels


def make_wheel(name, cx, r, width, side, spokes):
    hub = empty(name, V(cx, r, side * (WZ[0] + WZ[1] - 0.04) / 2))
    centre = hub.location.copy()
    axis = Vector((0, -side, 0))  # outward (Blender y is the car's left)
    rim_r = r * 0.68
    hw = width / 2
    # the tyre: a cross-section turned round the axle (rounded shoulders, a bulging sidewall)
    bm = bmesh.new()
    prof = []
    sh = min(0.05, hw * 0.45)
    side_wall = lambda sgn: [
        (rim_r + 0.005, sgn * hw * 0.9),
        (rim_r + (r - rim_r) * 0.3, sgn * hw * 0.99),
        # a raised band round the sidewall, where the lettering would be
        (rim_r + (r - rim_r) * 0.5, sgn * hw * 1.03),
        (rim_r + (r - rim_r) * 0.62, sgn * hw * 1.035),
        (rim_r + (r - rim_r) * 0.75, sgn * hw * 1.02),
    ]
    prof.extend(side_wall(-1))
    for i in range(7):
        a = i / 6 * math.pi / 2
        prof.append((r - sh + math.sin(a) * sh, -hw + sh - math.cos(a) * sh))
    # the tread across the crown, with three circumferential grooves
    crown = []
    for g in (-0.33, 0.0, 0.33):
        gx = g * (hw - sh)
        crown += [(r, gx - 0.012), (r - 0.007, gx - 0.006), (r - 0.007, gx + 0.006), (r, gx + 0.012)]
    prof.extend(crown)
    for i in range(7):
        a = i / 6 * math.pi / 2
        prof.append((r - sh + math.cos(a) * sh, hw - sh + math.sin(a) * sh))
    prof.extend(reversed(side_wall(1)))
    segs = 48
    rings = []
    for k in range(segs):
        ang = k / segs * 2 * math.pi
        ring = []
        for rr, ax in prof:
            ring.append(bm.verts.new(centre + Vector((math.cos(ang) * rr, ax * -side, math.sin(ang) * rr))))
        rings.append(ring)
    for k in range(segs):
        A, B = rings[k], rings[(k + 1) % segs]
        for j in range(len(prof) - 1):
            bm.faces.new((A[j], B[j], B[j + 1], A[j + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    tyre = new_object(name + "_tyre", bm, ["tyre"])
    # (parts are made where they belong, then parented keeping that place)
    keep = Matrix.Translation(hub.location).inverted()
    tyre.parent = hub
    tyre.matrix_parent_inverse = keep
    # the rim: an outer lip, a dark barrel, spokes, a cap and wheel nuts
    face = centre + axis * (hw * 0.85)
    lip = cylinder(name + "_lip", rim_r + 0.012, 0.03, face, "rim", axis="Y", segs=40, cap=False)
    # a stepped lip: a second, narrower ring just inside the first
    lip2 = cylinder(name + "_lip2", rim_r - 0.01, 0.02, face - axis * 0.022, "chrome", axis="Y", segs=40, cap=False)
    valve = cylinder(name + "_valve", 0.004, 0.02, face + Vector((rim_r * 0.92, 0, 0)) + axis * 0.004, "trim", axis="Y", segs=6)
    barrel = cylinder(name + "_barrel", rim_r, width * 0.85, centre, "trim", axis="Y", segs=40, cap=False)
    disc = cylinder(name + "_disc", rim_r * 0.82, 0.03, centre + axis * (hw * 0.25), "disc", axis="Y", segs=36)
    hubc = cylinder(name + "_hub", rim_r * 0.2, 0.06, face - axis * 0.02, "rim", axis="Y", segs=20)
    cap = cylinder(name + "_cap", rim_r * 0.12, 0.02, face + axis * 0.012, "chrome", axis="Y", segs=20)
    parts = [lip, lip2, valve, barrel, disc, hubc, cap]
    # the spokes: few and wide are split into pairs; each dishes back a little towards the hub
    split = spokes <= 6
    for i in range(spokes):
        for off in ((-0.075, 0.075) if split else (0.0,)):
            a = i / spokes * 2 * math.pi + off
            mid = face + Vector((math.cos(a), 0, math.sin(a))) * (rim_r * 0.58) - axis * 0.012
            sp = box(name + "_spoke", (rim_r * 0.4, 0.009, 0.011 if split else 0.016), mid, "rim", bevel=0.005)
            sp.rotation_euler = (0, -a, 0)
            parts.append(sp)
    # cross-drilled brake disc
    for i in range(12):
        a = i / 12 * 2 * math.pi
        hole = cylinder(name + "_drill", 0.006, 0.034, centre + axis * (hw * 0.25) + Vector((math.cos(a), 0, math.sin(a))) * (rim_r * 0.66), "trim", axis="Y", segs=6)
        parts.append(hole)
    for i in range(5):
        a = i / 5 * 2 * math.pi + 0.3
        nut = cylinder(name + "_nut", 0.011, 0.02, face + Vector((math.cos(a), 0, math.sin(a))) * (rim_r * 0.3) + axis * 0.004, "chrome", axis="Y", segs=8)
        parts.append(nut)
    for p in parts:
        p.parent = hub
        p.matrix_parent_inverse = keep
    # the caliper stays still while the wheel turns past it: it belongs to the body
    cal = box(name.replace("wheel", "caliper"), (0.06, 0.02, 0.035), centre + axis * (hw * 0.4) + Vector((-0.1 if cx > LEN / 2 else 0.1, 0, rim_r * 0.55)), "caliper", bevel=0.012)
    return hub


spokes = {"muscle": 5, "rally": 6, "hatch": 10}.get(CAR["silhouette"], 10 if not F.get("carbon") else 5)
r = CAR["wheelRadius"]
width = (WZ[1] - 0.04) - WZ[0]
front_w = max(WHEELS, key=lambda w: w["x"])
rear_w = min(WHEELS, key=lambda w: w["x"])
for side, sname in ((-1, "L"), (1, "R")):
    make_wheel("wheel_F" + sname, front_w["x"], r, width, side, spokes)
    make_wheel("wheel_R" + sname, rear_w["x"], r, width * 1.05, side, spokes)

# ---------------------------------------------------------------------------- export (and a picture to check it by)

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_apply=True,
    export_yup=True,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_materials="EXPORT",
)
tris = sum(len(o.data.polygons) for o in scene.objects if o.type == "MESH")
print("BUILT %s -> %s (%d faces, %.1f KB)" % (CAR_ID, OUT, tris, os.path.getsize(OUT) / 1024))

if PREVIEW:
    world = bpy.data.worlds.new("w")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.62, 0.72, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    scene.collection.objects.link(sun)
    gm = bpy.data.meshes.new("ground")
    bmg = bmesh.new()
    bmesh.ops.create_grid(bmg, x_segments=1, y_segments=1, size=20)
    bmg.to_mesh(gm)
    ground = bpy.data.objects.new("ground", gm)
    gm.materials.append(material("ground_m", [0.08, 0.08, 0.09, 1], rough=0.8))
    scene.collection.objects.link(ground)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.lens = 45
    scene.collection.objects.link(cam)
    scene.camera = cam
    target = Vector((LEN / 2, 0, 0.55))
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 960
    scene.render.resolution_y = 540
    for k, (ang, dist, h) in enumerate(((0.65, 7.2, 1.7), (2.5, 7.2, 1.9), (math.pi / 2, 7.8, 1.0))):
        cam.location = target + Vector((math.cos(ang) * dist, -math.sin(ang) * dist, h))
        d = target - cam.location
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = PREVIEW.replace(".png", "-%d.png" % k)
        bpy.ops.render.render(write_still=True)
    print("PREVIEW", PREVIEW)
