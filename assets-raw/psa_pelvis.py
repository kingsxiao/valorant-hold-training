#!/usr/bin/env python3
"""盆骨专项分析（psa_osc 之外的第二层口径：为 GaitBake 补盆骨 roll/pitch/侧移轨道取数）：
  - 三轴旋转振荡：按 1×/2× 步频谐波拟合（盆骨 roll/yaw 每步一摆 = 2× 周期频率），
    产出幅值与相位（相位基准 = 谐波 sin 分量，L 膝摆动峰值同法拟合可对齐）
  - 位置轨迹：x/y/z 各轴同法拟合（横向重心移动 / 垂直 bob）
  - 静态姿态差：盆骨/脊柱循环均值 rotvec − Face_Idle 均值 rotvec = 跑/走相对待机的
    前倾/侧倾/扭转（R 侧镜像约定只影响四肢骨，中轴骨可靠）
用法：python3 psa_pelvis.py <file.psa> [more.psa ...]   （单文件加 --idle=Face_Idle.psa 指基准）"""
import struct, sys, math

def parse(path):
    buf = open(path, 'rb').read()
    chunks = {}
    off = 0
    while off + 32 <= len(buf):
        cid = buf[off:off+20].split(b'\0')[0].decode('ascii', 'replace')
        _, ds, n = struct.unpack_from('<iii', buf, off+20)
        chunks[cid] = (ds, n, off+32)
        off += 32 + ds*n
    ob = chunks['BONENAMES']; base = ob[2]
    names = [buf[base+i*ob[0]:base+i*ob[0]+64].split(b'\0')[0].decode('ascii','replace') for i in range(ob[1])]
    ai = chunks['ANIMINFO'][2]
    totalbones, = struct.unpack_from('<i', buf, ai+128)
    tracktime, animrate = struct.unpack_from('<ff', buf, ai+148)
    kb = chunks['ANIMKEYS']; kbase = kb[2]
    nframes = kb[1] // totalbones
    frames = []
    for f in range(nframes):
        o = kbase + f*totalbones*32
        fr = []
        for b in range(totalbones):
            px, py, pz = struct.unpack_from('<fff', buf, o + b*32)
            x, y, z, w = struct.unpack_from('<ffff', buf, o + b*32 + 12)
            fr.append(((px, py, pz), (x, y, z, w)))
        frames.append(fr)
    return names, frames, nframes, tracktime/animrate

def rotvec(q):
    x, y, z, w = q
    n = math.sqrt(x*x+y*y+z*z)
    if n < 1e-9: return (0.0, 0.0, 0.0)
    ang = 2*math.atan2(n, w)
    if ang > math.pi: ang -= 2*math.pi
    return (x/n*ang, y/n*ang, z/n*ang)

def bone_curves(names, frames, bone):
    bi = names.index(bone)
    qs, ps = [], []
    for f in range(len(frames)):
        q = frames[f][bi][1]
        if q[3] < 0: q = (-q[0], -q[1], -q[2], -q[3])
        qs.append(rotvec(q))
        ps.append(frames[f][bi][0])
    return qs, ps

def mean3(curves):
    n = len(curves)
    return [sum(c[k] for c in curves)/n for k in range(3)]

def harm_fit(devs, nframes, harm):
    """各轴对 sin/cos 谐波最小二乘：返回 {axis: (幅值, sin相位)}（幅值=峰值偏差）"""
    out = {}
    for k, ax in enumerate('XYZ'):
        sa = sb = 0.0
        for f, d in enumerate(devs):
            th = 2*math.pi*f/nframes*harm
            sa += d[k]*math.sin(th); sb += d[k]*math.cos(th)
        amp = 2*math.hypot(sa, sb)/nframes
        ph = math.atan2(sb, sa)
        out[ax] = (amp, ph)
    return out

def analyze(path, idle_path=None, knee_ref=True):
    names, frames, nframes, dur = parse(path)
    tag = path.split('/')[-1].replace('.psa.psa', '').replace('.psa', '')
    print(f"\n== {tag}  ({nframes}帧 {dur:.3f}s)")
    # 相位参照：L 膝 Z 分量 1× 谐波相位
    if knee_ref and 'L_Knee' in names:
        kz, _ = bone_curves(names, frames, 'L_Knee')
        mz = mean3(kz)
        fit = harm_fit([[v[2]-mz[2], 0.0, 0.0] for v in kz], nframes, 1)
        print(f"   L_Knee.Z  1×幅={math.degrees(fit['X'][0]):5.1f}° sin相位={fit['X'][1]:+.2f}rad")
    # 盆骨
    qs, ps = bone_curves(names, frames, 'Pelvis')
    mq = mean3(qs); mp = mean3(ps)
    devs = [[q[k]-mq[k] for k in range(3)] for q in qs]
    for harm, label in [(1, '1×'), (2, '2×')]:
        fit = harm_fit(devs, nframes, harm)
        s = '  '.join(f"{ax}:{math.degrees(fit[ax][0]):5.2f}°@{fit[ax][1]:+.2f}" for ax in 'XYZ')
        print(f"   Pelvis rot {label}: {s}")
    pdevs = [[p[k]-mp[k] for k in range(3)] for p in ps]
    for harm in (1, 2):
        fit = harm_fit(pdevs, nframes, harm)
        s = '  '.join(f"{ax}:{fit[ax][0]*100:5.2f}cm@{fit[ax][1]:+.2f}" for ax in 'XYZ')
        print(f"   Pelvis pos {harm}×: {s}   均值=({mp[0]:.2f},{mp[1]:.2f},{mp[2]:.2f})cm")
    print(f"   Pelvis rot 均值(rad)=({mq[0]:+.3f},{mq[1]:+.3f},{mq[2]:+.3f}) = ({math.degrees(mq[0]):+.1f}°,{math.degrees(mq[1]):+.1f}°,{math.degrees(mq[2]):+.1f}°)")
    for spine in ['Spine1', 'Spine4']:
        if spine in names:
            sq, _ = bone_curves(names, frames, spine)
            sm = mean3(sq)
            print(f"   {spine} rot 均值(rad)=({sm[0]:+.3f},{sm[1]:+.3f},{sm[2]:+.3f})")
    # 静态姿态差（相对 idle 均值）：盆骨被动画搬走的前倾/侧倾/扭转
    if idle_path:
        inames, iframes, _, _ = parse(idle_path)
        iqs, _ = bone_curves(inames, iframes, 'Pelvis')
        im = mean3(iqs)
        d = [mq[k]-im[k] for k in range(3)]
        print(f"   vs Idle 盆骨Δ(rad)=({d[0]:+.3f},{d[1]:+.3f},{d[2]:+.3f}) = ({math.degrees(d[0]):+.1f}°,{math.degrees(d[1]):+.1f}°,{math.degrees(d[2]):+.1f}°)")
        for spine in ['Spine1', 'Spine4']:
            if spine in names and spine in inames:
                s2, _ = bone_curves(inames, iframes, spine)
                sd = [mean3(sq)[k]-mean3(s2)[k] for k in range(3)]
                print(f"   vs Idle {spine}Δ(rad)=({sd[0]:+.3f},{sd[1]:+.3f},{sd[2]:+.3f})")

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--idle=')]
    idle = next((a.split('=')[1] for a in sys.argv[1:] if a.startswith('--idle=')), None)
    for p in args:
        try: analyze(p, idle)
        except Exception:
            import traceback; traceback.print_exc()
