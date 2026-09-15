# 官方 1P 手臂导出 v4：idle 静态 + fire 加法层（全帧）+ equip 切枪动画（全帧，
# 末帧=idle 分毫不差，天然无缝）+ phantom_ads（Aim2E/W 四元数半球对齐后平均
# 合成的 Aim2N——Drive 缺 N，三向只差偏航 E-W≤17°，平均即中位）。
# GLB 空间/骨骼约定完全由导出器自理，避免手工换算。
# 用法：Blender -b -P scripts/fp-arms-export.py -- <blend> <psa目录> <出.glb>
import bpy
import struct
import sys
from mathutils import Vector, Quaternion

POSE_FILES = {
    'vandal_idle': ('FP_Core_AK_S0_IdlePose.psa', 'mid'),
    'phantom_idle': ('FP_Core_Carbine_S0_IdlePose.psa', 'mid'),
    'vandal_fire': ('FP_Core_AK_S0_Fire.psa', 'all'),
    'phantom_fire': ('FP_Core_Carbine_S0_FireAdd.psa', 'all'),
    'vandal_equip': ('FP_Core_AK_S0_Equip.psa', 'all'),
    'phantom_equip': ('FP_Core_Carbine_S0_Equip.psa', 'all'),
    # phantom_ads 撤销（2026-09-15 复核）：Aim2E/W 是瞄准方向偏移（±偏航，
    # E/W 平均≈identity，合成后与 idle 仅差 0.49°）——不是 ADS 抬枪姿势。
    # 官方 ADS 抬枪在武器自身动画（我们由 holder 刚体完成），手臂在 ADS 下
    # 就是 idle；方向偏移层暂不接（flick 训练器里是持续噪声）
}


def synth_aim2n(psa_dir):
    # Aim 系是加法增量格式（AimN≈identity 互证；直用会把手放倒原点）——
    # 绝对 ADS 姿势 = idle ⊗ delta（后乘，与运行时 fire 层约定一致）。
    # Aim2N = Aim2E ⊕ Aim2W（三向只差偏航 E-W≤17°，半球对齐后平均即中位；
    # 位置增量≈0，用 idle 位置）
    FI = parse_psa_frames(f'{psa_dir}/FP_Core_Carbine_S0_IdlePose.psa')
    FE = parse_psa_frames(f'{psa_dir}/FP_Core_Carbine_S0_Aim2E.psa')
    FW = parse_psa_frames(f'{psa_dir}/FP_Core_Carbine_S0_Aim2W.psa')
    idle, e, w = FI[len(FI) // 2], FE[len(FE) // 2], FW[len(FW) // 2]
    out = {}
    for name, (pi, qi) in idle.items():
        pe, qe = e[name]
        pw, qw = w[name]
        if qe.dot(qw) < 0:
            qw = qw.copy()
            qw.negate()
        qd = (qe + qw).normalized()
        out[name] = (pi, qi.copy() @ qd)
    return [out]


def parse_psa_frames(path):
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
        keys = {}
        for b in range(totalbones):
            px, py, pz = struct.unpack_from('<fff', buf, o + b * 32)
            x, y, z, w = struct.unpack_from('<ffff', buf, o + b * 32 + 12)
            keys[names[b]] = (Vector((px, py, pz)) * 0.01, Quaternion((w, x, y, z)))
        frames.append(keys)
    return frames


def apply_pose(arm, keys, psa_set):
    # 清回 rest 再摆（幂等）
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Quaternion((1, 0, 0, 0))
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
    for b in arm.data.bones:
        if b.name not in psa_set:
            continue
        parented = b.parent is not None and b.parent.name in psa_set
        if parented:
            orig_loc = b.matrix_local.translation - b.parent.matrix_local.translation
            orig_loc.rotate(b.parent.matrix_local.to_quaternion().conjugated())
            oq = b.matrix_local.to_quaternion().copy()
            oq.rotate(b.parent.matrix_local.to_quaternion().conjugated())
            oq.conjugate()
        else:
            orig_loc = b.matrix_local.translation.copy()
            oq = b.matrix_local.to_quaternion().copy()
        post_quat = oq.conjugated()
        p_pos, p_quat = keys[b.name]
        q2 = post_quat.copy()
        q2.rotate(p_quat.conjugated() if not parented else p_quat)
        quat = post_quat.copy()
        quat.rotate(oq)
        quat.rotate(q2.conjugated())
        loc = p_pos - orig_loc
        loc.rotate(post_quat.conjugated())
        pb = arm.pose.bones[b.name]
        pb.rotation_quaternion = quat
        pb.location = loc
    bpy.context.view_layer.update()


argv = sys.argv[sys.argv.index('--') + 1:]
src_blend, psa_dir, out_glb = argv[0], argv[1], argv[2]
bpy.ops.wm.open_mainfile(filepath=src_blend)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')

for act_name, (fname, mode) in POSE_FILES.items():
    frames = parse_psa_frames(f'{psa_dir}/{fname}')
    keyframes = [len(frames) // 2] if mode == 'mid' else list(range(len(frames)))
    act = bpy.data.actions.new(act_name)
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    for fi, frame_idx in enumerate(keyframes):
        apply_pose(arm, frames[frame_idx], set(frames[frame_idx]))
        # NLA 已建轨道保持 mute（见下），apply 的通道不会被求值覆盖
        for pb in arm.pose.bones:
            pb.keyframe_insert('rotation_quaternion', frame=fi + 1)
            pb.keyframe_insert('location', frame=fi + 1)
    # 收进 NLA 轨道（exporter NLA_TRACKS 模式逐条导出）。必须立即 mute：
    # 未静音轨道会在 depsgraph 更新时求值并覆盖后续 apply_pose 的通道写入
    # （2026-09-15 实测：四个 action 全变成第一个姿势即此因）
    track = arm.animation_data.nla_tracks.new()
    track.name = act_name
    track.mute = True
    strip = track.strips.new(act_name, 1, act)
    strip.frame_start = 1
    strip.frame_end = len(keyframes)
    arm.animation_data.action = None
    # 采样核验：回到该姿势的摆位
    apply_pose(arm, frames[keyframes[-1]], set(frames[keyframes[-1]]))
    rh = arm.pose.bones.get('R_Hand')
    lh = arm.pose.bones.get('L_Hand')
    print(f'{act_name}: {len(keyframes)}f R_Hand=({rh.head.x:.4f},{rh.head.y:.4f},{rh.head.z:.4f}) '
          f'L_Hand=({lh.head.x:.4f},{lh.head.y:.4f},{lh.head.z:.4f})')

# 回到 rest 再导出（bind=ref，姿势全在动画轨道里）
for pb in arm.pose.bones:
    pb.rotation_quaternion = Quaternion((1, 0, 0, 0))
    pb.location = (0, 0, 0)
    pb.scale = (1, 1, 1)
bpy.context.view_layer.update()
arm.animation_data.action = None
# 帧率 60：psa 是 60fps 采样（Fire 20帧=0.317s），Blender 默认 24fps 会把轨道
# 时间拉长 2.5 倍（实测 fire 0.833s 即此因）
bpy.context.scene.render.fps = 60

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
    filepath=out_glb, use_selection=True, export_format='GLB',
    export_apply=False, export_animations=True, export_animation_mode='NLA_TRACKS',
    export_force_sampling=True,
    export_skins=True, export_def_bones=False)
print(f'GLB_OK selected={n_sel} -> {out_glb}')
