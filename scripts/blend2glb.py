# Blender headless：.blend → GLB（无畏契约官方资产转换，配方沉淀自 126 轮武器转换）
# 用法：Blender -b -P scripts/blend2glb.py -- 源.blend 出.glb [轴长出向]
#   1) 删 LIGHT/CAMERA/EMPTY 与 0 尺寸图像块（Render Result）
#   2) 选中全部 MESH → export_scene.gltf(use_selection=True, GLB, export_apply, 无动画)
# 贴图（DF/NM/MRAE）自动内嵌；MRS 通道语义问题由 scripts/ability-glb-patch.mjs 处理
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
