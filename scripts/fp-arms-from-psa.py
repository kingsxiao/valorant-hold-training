# 官方 1P 手臂姿态应用（Befzz blender3d_import_psk_psa 非 psk 骨架分支的精确配方）：
# psa 四元数经 post_quat = q_parent⁻¹⊗q_bone 换系 + 共轭后写入 pose 通道；
# 根骨 p_quat 共轭（bDontInvertRoot）；psa 位置 ×0.01 cm→m；
# 位置通道 = post_quat⁻¹⊗(p_pos − orig_loc)（通道是骨本地系里相对 rest 的增量）
# 用法：Blender -b -P scripts/fp-arms-from-psa.py -- <blend> <psa> <帧号|mid> <渲染.png> [--bake <出.glb>]
import bpy
import struct
import sys
from mathutils import Matrix, Vector, Quaternion


def parse_psa(path):
    buf = open(path, 'rb').read()
    chunks = {}
    off = 0
    while off + 32 <= len(buf):
        cid = buf[off:off + 20].split(b'\0')[0].decode('ascii', 'replace')
        _, ds, n = struct.unpack_from('<iii', buf, off + 20)
        chunks[cid] = (ds, n, off + 32)
        off += 32 + ds * n
    ob = chunks['BONENAMES']
    names = [buf[ob[2] + i * ob[0]:ob[2] + i * ob[0] + 64].split(b'\0')[0].decode('ascii', 'replace')
             for i in range(ob[1])]
    ai = chunks['ANIMINFO'][2]
    totalbones, = struct.unpack_from('<i', buf, ai + 128)
    kb = chunks['ANIMKEYS']
    nframes = kb[1] // totalbones
    frames = []
    for f in range(nframes):
        o = kb[2] + f * totalbones * 32
        fr = []
        for b in range(totalbones):
            px, py, pz = struct.unpack_from('<fff', buf, o + b * 32)
            x, y, z, w = struct.unpack_from('<ffff', buf, o + b * 32 + 12)
            fr.append((Vector((px, py, pz)) * 0.01, Quaternion((w, x, y, z))))
        frames.append(fr)
    return names, frames, nframes


argv = sys.argv[sys.argv.index('--') + 1:]
src_blend, psa_path, frame_arg, render_out = argv[0], argv[1], argv[2], argv[3]
bake_out = argv[argv.index('--bake') + 1] if '--bake' in argv else None

bpy.ops.wm.open_mainfile(filepath=src_blend)
names, frames, nframes = parse_psa(psa_path)
print(f'psa: {psa_path.split("/")[-1]} bones={len(names)} frames={nframes}')
frame_idx = nframes // 2 if frame_arg == 'mid' else int(frame_arg)
key = dict(zip(names, frames[frame_idx]))

arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
psa_set = set(names)

# orig_loc / orig_quat / post_quat（照抄导入器 new_psa_bone 非 psk 分支）
conv = {}
for b in arm.data.bones:
    pb = arm.pose.bones.get(b.name)
    if not pb or b.name not in psa_set:
        continue
    # 导入器 quirk：blend 父骨必须已在 psa_bones 中才算有父（BONENAMES 深度优先序，
    # 父必先于子出现——我们的 104/104 全命中，等价于 blend 层级父子）
    has_parent = b.parent is not None and b.parent.name in psa_set
    if has_parent:
        orig_loc = b.matrix_local.translation - b.parent.matrix_local.translation
        orig_loc.rotate(b.parent.matrix_local.to_quaternion().conjugated())
        oq = b.matrix_local.to_quaternion().copy()
        oq.rotate(b.parent.matrix_local.to_quaternion().conjugated())
        oq.conjugate()
    else:
        orig_loc = b.matrix_local.translation.copy()
        oq = b.matrix_local.to_quaternion().copy()
    conv[b.name] = (orig_loc, oq, oq.conjugated())

# 每骨写通道（不按层级顺序也没关系：Blender 在 update 时统一求解）
for name, (orig_loc, oq, post_quat) in conv.items():
    p_pos, p_quat = key[name]
    pb = arm.pose.bones[name]
    q2 = post_quat.copy()
    parented = arm.data.bones[name].parent is not None and arm.data.bones[name].parent.name in psa_set
    if not parented:
        q2.rotate(p_quat.conjugated())
    else:
        q2.rotate(p_quat)
    quat = post_quat.copy()
    quat.rotate(oq)          # = I，保留以照抄配方形状
    quat.rotate(q2.conjugated())
    loc = p_pos - orig_loc
    loc.rotate(post_quat.conjugated())
    pb.rotation_mode = 'QUATERNION'
    pb.rotation_quaternion = quat
    pb.location = loc
bpy.context.view_layer.update()

for probe in ['Camera', 'VFX_Camera', 'MasterWeapon', 'R_WeaponPoint', 'R_Hand', 'L_Hand',
              'R_Elbow', 'L_Elbow', 'R_Index3', 'L_Index3', 'R_Shoulder', 'L_Shoulder']:
    pb = arm.pose.bones.get(probe)
    if pb:
        print(f'posed {probe}: head=({pb.head.x:.4f},{pb.head.y:.4f},{pb.head.z:.4f}) '
              f'tail=({pb.tail.x:.4f},{pb.tail.y:.4f},{pb.tail.z:.4f})')

# 官方相机骨视角渲染
scene = bpy.context.scene
cam_data = bpy.data.cameras.new('FPCam')
cam = bpy.data.objects.new('FPCam', cam_data)
scene.collection.objects.link(cam)
cam_pb = arm.pose.bones.get('Camera')
loc = cam_pb.head.copy()
direc = (cam_pb.tail - cam_pb.head).normalized()
cam.location = loc
cam.rotation_mode = 'QUATERNION'
cam.rotation_quaternion = direc.to_track_quat('-Z', 'Y')
cam_data.lens = 32
scene.camera = cam
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.show_object_outline = False
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.filepath = render_out
scene.render.image_settings.file_format = 'PNG'
for o in bpy.data.objects:
    if o.type not in ('MESH', 'CAMERA'):
        o.hide_render = True
bpy.ops.render.render(write_still=True)
print(f'render -> {render_out}')

if bake_out:
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.pose.armature_apply(selected=False)
    for o in list(bpy.data.objects):
        if o.type in ('LIGHT', 'CAMERA', 'EMPTY'):
            bpy.data.objects.remove(o, do_unlink=True)
    for img in list(bpy.data.images):
        if img.size[0] == 0 and img.size[1] == 0:
            bpy.data.images.remove(img)
    bpy.ops.object.select_all(action='DESELECT')
    n_sel = 0
    for o in bpy.data.objects:
        if o.type in ('MESH', 'ARMATURE'):
            o.select_set(True)
            n_sel += 1
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=bake_out, use_selection=True, export_format='GLB',
        export_apply=False, export_animations=False,
        export_bone_directions='BLENDER', export_skins=True, export_def_bones=False)
    print(f'BAKED_OK selected={n_sel} -> {bake_out}')
