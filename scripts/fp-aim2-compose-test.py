# Aim2 复合方向验证：Aim2E 是加法增量（与 AimN≈identity 互证），绝对 ADS 姿势
# = idle ⊗ aim2 或 aim2 ⊗ idle——渲染三方案（绝对直用/后乘/前乘）人工判定
import bpy
import struct
import sys
from mathutils import Vector, Quaternion


def parse_frames(path):
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
    tb, = struct.unpack_from('<i', buf, ai + 128)
    kb = chunks['ANIMKEYS']
    nf = kb[1] // tb
    out = []
    for f in range(nf):
        o = kb[2] + f * tb * 32
        fr = {}
        for b in range(tb):
            px, py, pz = struct.unpack_from('<fff', buf, o + b * 32)
            x, y, z, w = struct.unpack_from('<ffff', buf, o + b * 32 + 12)
            fr[names[b]] = (Vector((px, py, pz)) * 0.01, Quaternion((w, x, y, z)))
        out.append(fr)
    return out


argv = sys.argv[sys.argv.index('--') + 1:]
psa_dir, out_prefix = argv[0], argv[1]
IDLE = parse_frames(f'{psa_dir}/FP_Core_Carbine_S0_IdlePose.psa')[1]
AIM2E = parse_frames(f'{psa_dir}/FP_Core_Carbine_S0_Aim2E.psa')[1]

bpy.ops.wm.open_mainfile(filepath=argv[2])
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')

rest_ctx = {}
for b in arm.data.bones:
    parented = b.parent is not None
    if parented:
        orig_loc = b.matrix_local.translation - b.parent.matrix_local.translation
        orig_loc.rotate(b.parent.matrix_local.to_quaternion().conjugated())
        oq = b.matrix_local.to_quaternion().copy()
        oq.rotate(b.parent.matrix_local.to_quaternion().conjugated())
        oq.conjugate()
    else:
        orig_loc = b.matrix_local.translation.copy()
        oq = b.matrix_local.to_quaternion().copy()
    rest_ctx[b.name] = (parented, orig_loc, oq, oq.conjugated())


def apply_pose(keys):
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Quaternion((1, 0, 0, 0))
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
    for name, (parented, orig_loc, oq, post_quat) in rest_ctx.items():
        if name not in keys:
            continue
        p_pos, p_quat = keys[name]
        q2 = post_quat.copy()
        q2.rotate(p_quat.conjugated() if not parented else p_quat)
        quat = post_quat.copy()
        quat.rotate(oq)
        quat.rotate(q2.conjugated())
        loc = p_pos - orig_loc
        loc.rotate(post_quat.conjugated())
        pb = arm.pose.bones[name]
        pb.rotation_quaternion = quat
        pb.location = loc
    bpy.context.view_layer.update()


def render(path):
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new('C')
    cam = bpy.data.objects.new('C', cam_data)
    scene.collection.objects.link(cam)
    cam_pb = arm.pose.bones['Camera']
    cam.location = cam_pb.head.copy()
    d = (cam_pb.tail - cam_pb.head).normalized()
    cam.rotation_mode = 'QUATERNION'
    cam.rotation_quaternion = d.to_track_quat('-Z', 'Y')
    cam_data.lens = 24
    scene.camera = cam
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.filepath = path
    for o in bpy.data.objects:
        if o.type not in ('MESH', 'CAMERA'):
            o.hide_render = True
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.cameras.remove(cam_data)


# 方案A：Aim2E 直用（绝对）
apply_pose(AIM2E)
rh = arm.pose.bones['R_Hand']
print(f'A absolute: R_Hand=({rh.head.x:.3f},{rh.head.y:.3f},{rh.head.z:.3f})')
render(f'{out_prefix}_a_absolute.png')

# 方案B：idle ⊗ aim2（后乘，与 fire 应用同构）
post = {}
for name, (pi, qi) in IDLE.items():
    pe, qe = AIM2E[name]
    post[name] = (pi, qi.copy() @ qe)
apply_pose(post)
rh = arm.pose.bones['R_Hand']
print(f'B post-mult: R_Hand=({rh.head.x:.3f},{rh.head.y:.3f},{rh.head.z:.3f})')
render(f'{out_prefix}_b_post.png')

# 方案C：aim2 ⊗ idle（前乘）
pre = {}
for name, (pi, qi) in IDLE.items():
    pe, qe = AIM2E[name]
    pre[name] = (pi, qe.copy() @ qi)
apply_pose(pre)
rh = arm.pose.bones['R_Hand']
print(f'C pre-mult: R_Hand=({rh.head.x:.3f},{rh.head.y:.3f},{rh.head.z:.3f})')
render(f'{out_prefix}_c_pre.png')
