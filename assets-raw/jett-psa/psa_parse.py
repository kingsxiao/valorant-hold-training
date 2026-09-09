#!/usr/bin/env python3
"""PSA (Unreal ActorX animation) parser v2 — Rocklan Valorant 导出变体：
  BONENAMES: name[64] + parent i32@64 + 52B 尾部
  ANIMINFO:  name[64] + group[64] + totalbones@128 + keyquotum@140 + tracktime@148 + animrate@152
  ANIMKEYS:  按「每骨 nKeys」分组（bone-major），每 key = pos(12B) + quat xyzw(16B) + time(4B)
  duration = tracktime / animrate（tracktime 实为帧数 × (1/animrate×?)——RunN: 37帧/61.667 = 0.6s）
"""
import struct, sys, math
import numpy as np

def parse(path):
    buf = open(path, 'rb').read()
    chunks = {}
    off = 0
    while off + 32 <= len(buf):
        cid = buf[off:off+20].split(b'\0')[0].decode('ascii', 'replace')
        _, ds, n = struct.unpack_from('<iii', buf, off+20)
        chunks[cid] = (ds, n, off+32)
        off += 32 + ds*n
    bones = []
    if 'BONENAMES' in chunks:
        ds, n, base = chunks['BONENAMES']
        for i in range(n):
            o = base + i*ds
            name = buf[o:o+64].split(b'\0')[0].decode('ascii', 'replace')
            parent, = struct.unpack_from('<i', buf, o+64)
            bones.append(dict(name=name, parent=parent))
    anims = []
    if 'ANIMINFO' in chunks:
        ds, n, base = chunks['ANIMINFO']
        for i in range(n):
            o = base + i*ds
            name = buf[o:o+64].split(b'\0')[0].decode('ascii', 'replace')
            totalbones, = struct.unpack_from('<i', buf, o+128)
            keyquotum, = struct.unpack_from('<i', buf, o+140)
            tracktime, animrate = struct.unpack_from('<ff', buf, o+148)
            anims.append(dict(name=name, totalbones=totalbones, keyquotum=keyquotum,
                              tracktime=tracktime, animrate=animrate))
    keys = []
    if 'ANIMKEYS' in chunks:
        ds, n, base = chunks['ANIMKEYS']
        for i in range(n):
            o = base + i*32
            px, py, pz = struct.unpack_from('<fff', buf, o)
            x, y, z, w = struct.unpack_from('<ffff', buf, o+12)
            t, = struct.unpack_from('<f', buf, o+28)
            keys.append(dict(q=(w, x, y, z), pos=(px, py, pz), t=t))
    return bones, anims, keys

def qmul(a, b):
    aw, ax, ay, az = a; bw, bx, by, bz = b
    return (aw*bw - ax*bx - ay*by - az*bz,
            aw*bx + ax*bw + ay*bz - az*by,
            aw*by - ax*bz + ay*bw + az*bx,
            aw*bz + ax*by - ay*bx + az*bw)

def q_euler(w, x, y, z):
    """-> (roll X deg, pitch Y deg, yaw Z deg)，UE 左手系约定下的世界角"""
    roll = math.atan2(2*(w*x + y*z), 1 - 2*(x*x + y*y))
    sp = max(-1, min(1, 2*(w*y - z*x)))
    pitch = math.asin(sp)
    yaw = math.atan2(2*(w*z + x*y), 1 - 2*(y*y + z*z))
    return math.degrees(roll), math.degrees(pitch), math.degrees(yaw)

def bone_frames(bones, keys, nkeys):
    """返回每骨每帧的 (pos, quat_local)。bone-major。"""
    out = []
    for i in range(len(bones)):
        out.append(keys[i*nkeys:(i+1)*nkeys])
    return out

def world_frame_chain(frames, bones, idx, f):
    """骨 idx 在帧 f 的世界 pos/quat（沿 parent 链复合，PSA 局部 q/p）。"""
    chain = []
    j = idx
    while j >= 0:
        chain.append(j)
        j = bones[j]['parent']
    chain.reverse()
    qw = (1.0, 0.0, 0.0, 0.0)
    pw = np.zeros(3)
    for k in chain:
        tr = frames[k][f]
        qx, qy, qz, qw0 = tr['q'][1], tr['q'][2], tr['q'][3], tr['q'][0]
        qw = qmul(qw, (qw0, qx, qy, qz))
        p = np.array(tr['pos'])
        # 旋转 + 平移（左手系下先按四元数旋转——对角度分析够用）
        pw = rotate(qw, pw) + p
    return pw, qw

def rotate(q, v):
    w, x, y, z = q
    v = np.array(v, dtype=float)
    qv = np.array([x, y, z])
    t = 2 * np.cross(qv, v)
    return v + w*t + np.cross(qv, t)

def main():
    path = sys.argv[1]
    watch = sys.argv[2].split(',') if len(sys.argv) > 2 else None
    bones, anims, keys = parse(path)
    a = anims[0]
    dur = a['tracktime'] / a['animrate']
    nkeys = a['keyquotum'] // a['totalbones']
    print(f"== {path.split('/')[-1]}: bones={len(bones)} frames/bone={nkeys} dur={dur:.4f}s "
          f"(tracktime={a['tracktime']} rate={a['animrate']:.2f})")
    print(f"   cycle at 5.4m/s -> {5.4*dur:.3f}m/周期; 3.39m/s -> {3.39*dur:.3f}m")
    names = [b['name'] for b in bones]
    if watch:
        frames = bone_frames(bones, keys, nkeys)
        for wname in watch:
            if wname not in names:
                print(f"   [missing bone] {wname}")
                continue
            i = names.index(wname)
            ro, pi, ya, pz, py = [], [], [], [], []
            for f in range(nkeys):
                p, q = world_frame_chain(frames, bones, i, f)
                r, pc, yc = q_euler(*q)
                ro.append(r); pi.append(pc); ya.append(yc); pz.append(p[2]); py.append(p[1])
            print(f"   {wname:24s} roll[{min(ro):7.1f},{max(ro):6.1f}] pitch[{min(pi):7.1f},{max(pi):6.1f}] "
                  f"yaw[{min(ya):6.1f},{max(ya):5.1f}] posY[{min(py):6.3f},{max(py):6.3f}] posZ[{min(pz):6.3f},{max(pz):6.3f}]")
            print(f"      pitch序列: {' '.join(f'{v:5.0f}' for v in pi)}")
            print(f"      posY 序列: {' '.join(f'{v:5.2f}' for v in py)}")

if __name__ == '__main__':
    main()
