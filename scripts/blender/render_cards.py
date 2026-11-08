"""
Renders each car's model.glb as the picture on its garage card: a three-quarter front view on a
transparent background, lit like a studio shot. Run through build-cards.sh.
"""
import sys, math, bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]
PAINT = argv[2] if len(argv) > 2 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
lo = Vector((1e9, 1e9, 1e9)); hi = -lo
for o in objs:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
mid = (lo + hi) / 2
size = max(hi.x - lo.x, hi.y - lo.y)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
# on the graphics card if there is one (OptiX on an RTX card, else CUDA), the processor otherwise
cprefs = bpy.context.preferences.addons["cycles"].preferences
for backend in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
    try:
        cprefs.compute_device_type = backend
    except TypeError:
        continue
    cprefs.get_devices()
    gpus = [d for d in cprefs.devices if d.type == backend]
    if gpus:
        for d in cprefs.devices:
            d.use = d.type == backend
        scene.cycles.device = "GPU"
        if backend == "OPTIX":
            scene.cycles.denoiser = "OPTIX"  # (denoise on the card too, not the processor)
        print("CYCLES on", backend, ", ".join(d.name for d in gpus))
        break
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.render.resolution_x, scene.render.resolution_y = 960, 480
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"

world = bpy.data.worlds.new("w"); scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.57, 0.6, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.35

def light(name, kind, energy, loc, size=4):
    d = bpy.data.lights.new(name, kind); d.energy = energy
    if kind == "AREA": d.size = size
    o = bpy.data.objects.new(name, d); scene.collection.objects.link(o)
    o.location = mid + Vector(loc)
    o.rotation_euler = (mid - o.location).to_track_quat("-Z", "Y").to_euler()
light("key", "AREA", 700, (3, -4, 5), 5)
light("rim", "AREA", 450, (-5, 4, 3), 4)
light("top", "AREA", 110, (0, 0, 6), 6)

# the car in its own colour (the model's paint is a stand-in the game repaints too)
if PAINT:
    h = PAINT.lstrip("#")
    lin = [((int(h[i:i + 2], 16) / 255 + 0.055) / 1.055) ** 2.4 for i in (0, 2, 4)]
    for m in bpy.data.materials:
        if m.name.lower().startswith("paint") and m.use_nodes:
            bsdf = m.node_tree.nodes.get("Principled BSDF")
            if bsdf:
                bsdf.inputs["Base Color"].default_value = (*lin, 1)

# a shadow catcher under the car, so it sits on something
bpy.ops.mesh.primitive_plane_add(size=40, location=(mid.x, mid.y, lo.z))
floor = bpy.context.object
floor.is_shadow_catcher = True

cam_data = bpy.data.cameras.new("cam"); cam_data.lens = 70
cam = bpy.data.objects.new("cam", cam_data); scene.collection.objects.link(cam)
scene.camera = cam
# glTF +X forward becomes Blender +X; stand off the front-left corner, a little above
ang = math.radians(-38)
dist = size * 3.1
cam.location = mid + Vector((math.cos(ang) * dist, math.sin(ang) * dist, size * 0.42))
look = mid + Vector((0, 0, -(hi.z - lo.z) * 0.08))
cam.rotation_euler = (look - cam.location).to_track_quat("-Z", "Y").to_euler()

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("CARD", OUT)
