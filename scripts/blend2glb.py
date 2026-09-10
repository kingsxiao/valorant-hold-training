# Blender headless：.blend → GLB（无畏契约官方资产转换，配方沉淀自 126 轮武器转换）
# 用法：Blender -b -P scripts/blend2glb.py -- 源.blend 出.glb [轴长出向]
#   1) 删 LIGHT/CAMERA/EMPTY 与 0 尺寸图像块（Render Result）
#   2) 删 1P_Weapon_Glass 材质面（皮肤移植件常见错误分层：玻璃盘混进弹匣对象、
#      卡在机匣中部悬浮——官方 Vandal 系无光学件，皮肤也只有机械瞄具）
#   3) 选中全部 MESH → export_scene.gltf(use_selection=True, GLB, export_apply, 无动画)
# 贴图（DF/NM/MRAE）自动内嵌；MRS 通道语义问题由 scripts/weapon-glb-patch.mjs 处理
import bpy
import sys

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv[0], argv[1]
bpy.ops.wm.open_mainfile(filepath=src)

for o in list(bpy.data.objects):
    if o.type in ('LIGHT', 'CAMERA', 'EMPTY'):
        bpy.data.objects.remove(o, do_unlink=True)
for img in list(bpy.data.images):
    if img.size[0] == 0 and img.size[1] == 0:
        bpy.data.images.remove(img)

# 悬浮玻璃盘清理：按材质名删面（Aristocrat 实测：97 顶点镜片盘混在弹匣对象里，
# 世界位置卡在机匣中部 z -0.012..0.068，藏在机匣内部/穿透抛壳口，官方无此件）
glass_removed = 0
for o in list(bpy.data.objects):
    if o.type != 'MESH' or not o.data.polygons:
        continue
    glass_slots = {i for i, s in enumerate(o.material_slots)
                   if s.material and 'glass' in s.material.name.lower()}
    if not glass_slots or not any(p.material_index in glass_slots for p in o.data.polygons):
        continue
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    for p in o.data.polygons:
        p.select = p.material_index in glass_slots
        glass_removed += 1 if p.select else 0
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.delete(type='FACE')
    bpy.ops.object.mode_set(mode='OBJECT')
print(f'glass faces removed: {glass_removed}')

bpy.ops.object.select_all(action='DESELECT')
mesh_n = 0
for o in bpy.data.objects:
    if o.type == 'MESH':
        o.select_set(True)
        mesh_n += 1
bpy.context.view_layer.objects.active = next(
    (o for o in bpy.data.objects if o.type == 'MESH'), None)
bpy.ops.export_scene.gltf(
    filepath=dst, use_selection=True, export_format='GLB',
    export_apply=True, export_animations=False)
print(f'BLENDF2GLB_OK meshes={mesh_n} -> {dst}')
