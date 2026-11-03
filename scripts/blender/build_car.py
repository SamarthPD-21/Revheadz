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
F = CAR["features"]

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
    cu.materials.append(MATS[mat])
    return ob


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
        # wipers on the windscreen
        if idx == 0 and F.get("wipers"):
            # parked along the foot of the windscreen (its nose end), angled up the glass
            for z in (-0.42, 0.08):
                a = on_top(sb - 0.05, z, 0.01)
                b = on_top(sb - 0.14, z + 0.4, 0.01)
                if a and b:
                    tube("wiper", [a[0], b[0]], 0.005, "trim")


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
    door_front, door_back = max(wx) - 0.08, min(wx) + (max(wx) - min(wx)) * 0.35
    for side in (1, -1):
        seam_side(door_front, CLEARANCE + 0.16, BELT - 0.02, side)
        seam_side(door_back, CLEARANCE + 0.16, BELT - 0.02, side)
        if F.get("doorHandles"):
            s = on_side(door_back + 0.18, BELT - 0.09, side, 0.004)
            if s:
                h = box("door_handle", (0.075, 0.012, 0.007), s[0], "chrome" if CAR["silhouette"] in ("muscle", "gt") else "trim", bevel=0.005)
                oriented(h, s[0], s[1])
    if SCREENS:
        # the bonnet's shut line ahead of the windscreen, and the boot's behind the rear screen
        seam_across(SCREENS[0][1] + 0.12, True)
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
        # folded flat into the bonnet: a lid with a seam round it, the lamp showing at its edge
        t = on_top(at.x - 0.16, z, 0.003)
        if t:
            lid = box("popup_lid", (0.15, 0.17, 0.006), t[0], "paint", bevel=0.004)
            oriented(lid, t[0], t[1])
            seam = box("popup_seam", (0.155, 0.175, 0.003), t[0] - t[1] * 0.001, "trim", bevel=0.003)
            oriented(seam, t[0] - t[1] * 0.001, t[1])
        lamp = box("head_slit", (0.11, 0.008, 0.006), at + n * 0.004, "head")
        oriented(lamp, at + n * 0.004, n)
    elif F["lamps"] == "round":
        cup = cylinder("head_cup", 0.085, 0.05, at - n * 0.01, "chrome", segs=28)
        oriented(cup, at - n * 0.01, n)
        bulb = sphere("head_lamp", 0.07, at - n * 0.005, "head", scale=(1, 1, 0.45))
        oriented(bulb, at - n * 0.005, n)
        lens = sphere("head_lens", 0.085, at - n * 0.012, "lens", scale=(1, 1, 0.22), segs=28)
        oriented(lens, at + n * 0.002, n)
    else:
        housing = sphere("head_housing", 0.1, at - n * 0.02, "trim", scale=(1.6, 0.55, 0.3), segs=28)
        oriented(housing, at - n * 0.012, n, up=(0, 0, 1))
        projector = sphere("head_lamp", 0.042, at - n * 0.004 + V(0, 0, -side * 0.06) - V(0, 0, 0), "head", scale=(1, 1, 0.6))
        oriented(projector, at - n * 0.004 + Vector((0, side * 0.06, 0)), n)
        drl = box("head_drl", (0.07, 0.005, 0.003), at - n * 0.004 + Vector((0, 0, 0.03)), "head", bevel=0.002)
        oriented(drl, at + n * 0.002 + Vector((0, 0, 0.035)), n)
        lens = sphere("head_lens", 0.1, at - n * 0.014, "lens", scale=(1.6, 0.55, 0.14), segs=28)
        oriented(lens, at + n * 0.004, n)
    heads.append(empty("headlight_" + ("R" if side > 0 else "L"), at + n * 0.05))

# the grille and the splitter under the nose
grille_y = max(CLEARANCE + 0.14, nose_y - 0.24)
g = on_nose(grille_y, 0.0, 0.0)
if g:
    at, n = g
    hw = half_width(at.x) * 0.55
    kind = F.get("grille", "slat")
    if kind in ("slat", "big", "mesh", "eggcrate", "intake", "horse"):
        wdt = {"big": 1.25, "intake": 1.35, "eggcrate": 1.15}.get(kind, 1.0) * hw
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
if F.get("tail") == "quad":
    for side in (1, -1):
        for off in (0.2, 0.46):
            t = on_tail(tail_y, side * (thw - off), 0.0)
            if t:
                lamp = cylinder("tail_round", 0.075, 0.03, t[0] - t[1] * 0.005, "tail", segs=28)
                oriented(lamp, t[0] - t[1] * 0.005, t[1])
                ring = cylinder("tail_ring", 0.086, 0.02, t[0] - t[1] * 0.012, "chrome", segs=28)
                oriented(ring, t[0] - t[1] * 0.012, t[1])
else:
    pts = []
    for k in range(31):
        z = -thw * 0.92 + 2 * thw * 0.92 * k / 30
        t = on_tail(tail_y, z, 0.006)
        if t:
            pts.append(t[0])
    if len(pts) > 5:
        tube("tail_bar", pts, 0.018, "tail")
    for side in (1, -1):
        t = on_tail(tail_y - 0.02, side * (thw - 0.28), 0.0)
        if t:
            c = box("tail_cluster", (0.1, 0.03, 0.01), t[0] - t[1] * 0.004, "tail", bevel=0.01, segments=3)
            oriented(c, t[0], t[1])
# the diffuser, and the exhausts through it
dy = CLEARANCE + 0.1
diff = box("diffuser", (0.08, thw * 0.75, 0.03), V(X0 + 0.1, dy, 0), aero_mat(), bevel=0.008)
if F.get("diffuser") == "fins":
    for i in range(6):
        z = -thw * 0.6 + thw * 1.2 * i / 5
        box("diffuser_fin", (0.09, 0.003, 0.03), V(X0 + 0.08, dy - 0.02, -z), aero_mat())
ey = CLEARANCE + (0.2 if F["exhaust"] == "centre" else 0.1)
pipes = {"centre": (-0.09, 0.09), "quad": (-0.55, -0.4, 0.4, 0.55)}.get(F["exhaust"], (-0.42, 0.42))
for k, z in enumerate(pipes):
    tip = cylinder("pipe_tip", 0.052, 0.16, V(X0 + 0.03, ey, z), "chrome", axis="X", segs=24, cap=False)
    inner = cylinder("pipe_inner", 0.044, 0.12, V(X0 + 0.04, ey, z), "rubber", axis="X", segs=24)
    empty("exhaust_%d" % k, V(X0 - 0.06, ey, z))

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
            scoop = sphere("side_intake", 0.1, s[0], "rubber", scale=(3.3, 1.2, 0.5), segs=24)
            oriented(scoop, s[0], s[1])
    if F.get("sideStrakes"):
        for k in range(3):
            s = on_side(rear["x"] + rear["r"] + 0.25 + k * 0.08, BELT - 0.2, side, 0.003)
            if s:
                st = box("strake", (0.006, 0.035, 0.005), s[0], "trim", bevel=0.002)
                oriented(st, s[0], s[1])

# door mirrors at the foot of the windscreen
if windows:
    mx = max(p[0] for p in windows) - 0.1
    my = min(BELT + 0.06, top_at(mx) - 0.06)
    for side in (1, -1):
        s = on_side(mx, my, side, 0.0)
        if s:
            at, n = s
            out = Vector((0, -side, 0))
            # a teardrop housing, flat glass facing back, on a short arm
            head = sphere("mirror", 0.075, at + out * 0.12 + Vector((0, 0, 0.03)), "paint", scale=(1.15, 0.72, 0.68))
            cut = box("mirror_back", (0.004, 0.06, 0.045), at + out * 0.12 + Vector((-0.07, 0, 0.03)), "trim", bevel=0.01)
            stalk = box("mirror_stalk", (0.03, 0.06, 0.008), at + out * 0.06 + Vector((0, 0, 0.01)), "trim", bevel=0.006)
            face = cylinder("mirror_glass", 0.055, 0.004, at + out * 0.12 + Vector((-0.085, 0, 0.03)), "chrome", axis="X", segs=20)

# ---------------------------------------------------------------------------- the bonnet, the wing, the roof


if F.get("bonnet") == "scoop":
    bx = X1 - min(0.95, LEN * 0.2)
    s = on_top(bx, 0, 0.0)
    if s:
        sc = box("bonnet_scoop", (0.24, 0.22, 0.035), s[0] + Vector((0, 0, 0.015)), "paint", bevel=0.03, segments=3)
        mouth = box("bonnet_scoop_mouth", (0.008, 0.18, 0.02), s[0] + Vector((0.24, 0, 0.025)), "rubber", bevel=0.006)
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
    lp = box("wing_lip", (0.13 if duck else 0.06, span / 2, 0.02 if duck else 0.01), V(X0 + (0.17 if duck else 0.09), deck_y + (0.035 if duck else 0.012), 0), "paint" if not F.get("carbon") else "carbon", bevel=0.008)
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

if F.get("roofVent") and SCREENS:
    rx = (SCREENS[0][0] + SCREENS[1][1]) / 2
    s = on_top(rx, 0, 0.0)
    if s:
        box("roof_scoop", (0.16, 0.1, 0.03), s[0] + Vector((0, 0, 0.012)), aero_mat(), bevel=0.025, segments=3)
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
    prof.append((rim_r + 0.005, -hw * 0.9))
    prof.append((rim_r + (r - rim_r) * 0.55, -hw * 1.02))
    for i in range(7):
        a = i / 6 * math.pi / 2
        prof.append((r - sh + math.sin(a) * sh, -hw + sh - math.cos(a) * sh))
    for i in range(7):
        a = i / 6 * math.pi / 2
        prof.append((r - sh + math.cos(a) * sh, hw - sh + math.sin(a) * sh))
    prof.append((rim_r + (r - rim_r) * 0.55, hw * 1.02))
    prof.append((rim_r + 0.005, hw * 0.9))
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
    barrel = cylinder(name + "_barrel", rim_r, width * 0.85, centre, "trim", axis="Y", segs=40, cap=False)
    disc = cylinder(name + "_disc", rim_r * 0.82, 0.03, centre + axis * (hw * 0.25), "disc", axis="Y", segs=36)
    hubc = cylinder(name + "_hub", rim_r * 0.2, 0.06, face - axis * 0.02, "rim", axis="Y", segs=20)
    cap = cylinder(name + "_cap", rim_r * 0.12, 0.02, face + axis * 0.012, "chrome", axis="Y", segs=20)
    parts = [lip, barrel, disc, hubc, cap]
    for i in range(spokes):
        a = i / spokes * 2 * math.pi
        mid = face + Vector((math.cos(a), 0, math.sin(a))) * (rim_r * 0.58) - axis * 0.012
        sp = box(name + "_spoke", (rim_r * 0.4, 0.01, 0.016 if spokes > 7 else 0.026), mid, "rim", bevel=0.006)
        sp.rotation_euler = (0, -a, 0)
        parts.append(sp)
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
