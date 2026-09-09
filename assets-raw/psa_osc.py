#!/usr/bin/env python3
"""局部四元数振荡分析（链式 FK 对该导出不可靠，改用单骨局部数据）：
  - 膝屈曲：L/R_Knee 局部纯 Z 旋转角曲线 → 基础屈曲 + 摆动屈曲
  - 髋：局部旋转相对周期均值的偏角幅度 + 振荡主轴（sagittal 前后摆 vs 侧向外展）
  - 脊柱/盆骨：局部旋转振荡幅度（前倾/侧倾/扭转）
  - 左右相位差：L/R 膝曲线互相关
约定-无关：只用振荡幅度与主轴方向，不定绝对符号。"""
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

def rotvec(q, ref=None):
    """(x,y,z,w)->旋转矢量（axis*angle, |v|=角度 rad），与 ref 半球对齐"""
    x, y, z, w = q
    n = math.sqrt(x*x+y*y+z*z)
    if n < 1e-9: return (0.0, 0.0, 0.0)
    ang = 2*math.atan2(n, w)
    if ang > math.pi: ang -= 2*math.pi
    v = (x/n*ang, y/n*ang, z/n*ang)
    if ref and (v[0]*ref[0]+v[1]*ref[1]+v[2]*ref[2]) < 0:
        v = (-v[0], -v[1], -v[2])
    return v

def curve(name, frames, names, bone):
    bi = names.index(bone)
    ref = None
    out = []
    for f in range(len(frames)):
        q = frames[f][bi][1]
        if q[3] < 0: q = (-q[0], -q[1], -q[2], -q[3])
        v = rotvec(q, ref)
        if ref is None: ref = v
        out.append(v)
    return out

def osc_stats(vecs):
    """相对均值的振荡：幅度(deg)、主轴（按方差分解到三轴）"""
    n = len(vecs)
    mean = [sum(v[k] for v in vecs)/n for k in range(3)]
    devs = [tuple(v[k]-mean[k] for k in range(3)) for v in vecs]
    var = [sum(d[k]**2 for d in devs)/n for k in range(3)]
    amp = max(math.sqrt(sum(d[k]*d[k] for k in range(3))) for d in devs)
    return mean, var, math.degrees(amp), devs

def analyze(path):
    names, frames, nframes, dur = parse(path)
    tag = path.split('/')[-1].replace('.psa.psa','').replace('.psa','')
    print(f"== {tag}  ({nframes}帧 {dur:.3f}s 周期)")
    # 膝屈曲（纯 Z 旋转）
    for side in 'LR':
        bi = names.index(f'{side}_Knee')
        zs, ws = [], []
        for f in range(nframes):
            q = frames[f][bi][1]
            if q[3] < 0: q = (-q[0], -q[1], -q[2], -q[3])
            zs.append(q[2]); ws.append(q[3])
        angs = [2*math.atan2(z, w) for z, w in zip(zs, ws)]
        deg = [math.degrees(a) for a in angs]
        print(f"   {side}_Knee 屈曲: [{min(deg):6.1f}°, {max(deg):6.1f}°] 基础={min(deg):5.1f}° 摆动幅={max(deg)-min(deg):5.1f}°")
    # 髋/脊柱/盆骨振荡
    for bone in ['L_Hip', 'R_Hip', 'Pelvis', 'Spine1', 'Spine4']:
        if bone not in names: continue
        vecs = curve(bone, frames, names, bone)
        mean, var, amp, devs = osc_stats(vecs)
        ax = ['X', 'Y', 'Z']
        main = max(range(3), key=lambda k: var[k])
        varpct = [100*v/sum(var) for v in var] if sum(var) > 1e-12 else [0,0,0]
        print(f"   {bone:7s} 振荡幅={amp:5.1f}° 主轴={ax[main]} 三轴方差占比=({varpct[0]:4.0f},{varpct[1]:4.0f},{varpct[2]:4.0f})%")
    # 左右膝相位差
    lk = curve('L_Knee', frames, names, 'L_Knee'); rk = curve('R_Knee', frames, names, 'R_Knee')
    lz = [v[2] for v in lk]; rz = [v[2] for v in rk]
    n = len(lz)
    best, bestv = 0, -1e9
    for shift in range(n):
        s = sum(lz[i]*rz[(i+shift)%n] for i in range(n))
        if s > bestv: bestv, best = s, shift
    print(f"   L/R 膝相位差 ≈ {best}帧 / {nframes}帧 = {best/nframes*360:.0f}° (理想 180°=反相, 0°=同相)")
    k = max(1, nframes//16)
    lk_deg = [math.degrees(2*math.atan2(v[2], math.sqrt(max(0,1-v[2]*v[2])))) for v in lk]
    print(f"   L膝角序列: {' '.join(f'{v:5.0f}' for v in lk_deg[::k])}")

if __name__ == '__main__':
    for p in sys.argv[1:]:
        try: analyze(p)
        except Exception as e:
            import traceback; traceback.print_exc()
