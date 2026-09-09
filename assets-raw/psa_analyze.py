#!/usr/bin/env python3
"""官方 PSA 循环步态分析 v2 —— 轴系：X=前、Y=左、Z=上（Skeleton 系），world=parent⊗local。
盆骨高度在数据里恒定（原地动画，起伏由腿部几何涌现）：量「盆骨-支撑脚垂直距」变化 = 实际 bob。
步幅 = 单脚两次触地间沿 X 的水平位移。"""
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
    ob = chunks['BONENAMES']
    base = ob[2]
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

def qmul(a, b):  # (x,y,z,w)
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return (aw*bx + ax*bw + ay*bz - az*by,
            aw*by - ax*bz + ay*bw + az*bx,
            aw*bz + ax*by - ay*bx + az*bw,
            aw*bw - ax*bx - ay*by - az*bz)
def qrot(q, v):
    x, y, z, w = q
    t = (y*v[2]-z*v[1], z*v[0]-x*v[2], x*v[1]-y*v[0])
    t2 = (2*t[0], 2*t[1], 2*t[2])
    return (v[0]+w*t2[0]+(y*t2[2]-z*t2[1]),
            v[1]+w*t2[1]+(z*t2[0]-x*t2[2]),
            v[2]+w*t2[2]+(x*t2[1]-y*t2[0]))
def vsub(a,b): return (a[0]-b[0],a[1]-b[1],a[2]-b[2])
def vlen(a): return math.sqrt(vdot(a,a))
def vdot(a,b): return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
def norm(a):
    l = vlen(a) or 1
    return (a[0]/l, a[1]/l, a[2]/l)

LEG = ['L_Hip','L_Knee','L_Foot','L_Toe']
RLEG = ['R_Hip','R_Knee','R_Foot','R_Toe']

def fk(names, frames, f):
    """骨架 FK：返回 world pos 字典。链 Skeleton→Root→Pelvis→(腿/脊柱)"""
    chainmap = {}
    order = ['Skeleton','Root','Pelvis'] + ['Spine1','Spine2','Spine3','Spine4','Neck','Head'] \
            + LEG + RLEG
    pw = {}
    prev = None
    for bname in order:
        if bname not in names: continue
        bi = names.index(bname)
        pos, q = frames[f][bi]
        parent = {'Skeleton':None,'Root':'Skeleton','Pelvis':'Root'}.get(bname)
        if parent is None:
            if bname in LEG: parent = 'Pelvis' if bname=='L_Hip' else LEG[LEG.index(bname)-1]
            elif bname in RLEG: parent = 'Pelvis' if bname=='R_Hip' else RLEG[RLEG.index(bname)-1]
            elif bname.startswith('Spine'): parent = 'Pelvis' if bname=='Spine1' else f'Spine{int(bname[5:])-1}'
            elif bname == 'Neck': parent = 'Spine4'
        if parent is None:
            pw[bname] = pos; cur_q = q
        else:
            if parent not in pw: continue
            pp = pw.get(parent+'_p', (0,0,0)); pq = pw.get(parent+'_q', (0,0,0,1))
            wp = tuple(pq_i for pq_i in (
                pp[0]+qrot(pq,pos)[0], pp[1]+qrot(pq,pos)[1], pp[2]+qrot(pq,pos)[2]))
            wq = qmul(pq, q)
            pw[bname] = wp; pw[bname+'_p'] = wp; pw[bname+'_q'] = wq
            continue
        pw[bname+'_p'] = pos; pw[bname+'_q'] = q
    return pw

def leg_metrics(names, frames, side):
    leg = LEG if side=='L' else RLEG
    sw, kn, ft, abd, footz, footx = [], [], [], [], [], []
    for f in range(len(frames)):
        pw = fk(names, frames, f)
        if leg[0] not in pw or leg[2] not in pw: return None
        hip, knee, foot = pw[leg[0]], pw[leg[1]], pw[leg[2]]
        thigh = norm(vsub(knee, hip)); shin = norm(vsub(foot, knee))
        kn.append(math.degrees(math.acos(max(-1,min(1,vdot(thigh,shin))))))
        # sagittal: 大腿相对垂直方向的前后角（+前）
        sw.append(math.degrees(math.atan2(thigh[0], -thigh[2])))
        # 外展：大腿偏离 YZ 面（+左）
        abd.append(math.degrees(math.atan2(thigh[1], math.hypot(thigh[0], thigh[2]))))
        if leg[3] in pw:
            toe = norm(vsub(pw[leg[3]], foot))
            ft.append(math.degrees(math.atan2(toe[0], -toe[2])))
        footz.append(foot[2]); footx.append(foot[0])
    return sw, kn, ft, abd, footz, footx

def analyze(path):
    names, frames, nframes, dur = parse(path)
    tag = path.split('/')[-1].replace('.psa.psa','').replace('.psa','')
    # 盆骨世界高度（Root+Pelvis 平移级联）与 盆骨-脚垂直距（涌现 bob）
    pelvisZ = []; dropL = []
    for f in range(len(frames)):
        pw = fk(names, frames, f)
        pelvisZ.append(pw['Pelvis'][2] if 'Pelvis' in pw else 0)
        if 'L_Foot' in pw: dropL.append(pw['Pelvis'][2]-pw['L_Foot'][2])
    m = leg_metrics(names, frames, 'L')
    if not m:
        print(f'!! {tag}: 腿链缺'); return
    sw, kn, ft, abd, footz, footx = m
    # 步幅：脚最低(触地)帧区间沿 X 的行程（松 2cm 阈值）
    zmin = min(footz)
    lows = [i for i in range(nframes) if footz[i] <= zmin+2.0]
    stride = 0.0
    if lows:
        f0, f1 = lows[0], lows[-1]
        if f1 > f0:
            x0 = min(footx[f0:f1+1]); x1 = max(footx[f0:f1+1])
            stride = abs(x1-x0)
    cycdist = stride*2
    print(f"== {tag}")
    print(f"   帧数={nframes} 时长={dur:.3f}s 周期距离≈{cycdist:.1f}cm -> 隐含速度={cycdist/dur/100:.2f}m/s")
    print(f"   大腿前后摆: [{min(sw):6.1f}°,{max(sw):5.1f}°] 全幅={max(sw)-min(sw):5.1f}°   外展: [{min(abd):5.1f}°,{max(abd):5.1f}°]")
    print(f"   膝屈曲: [{min(kn):5.1f}°,{max(kn):5.1f}°]   脚俯仰: [{min(ft):6.1f}°,{max(ft):5.1f}°]")
    print(f"   脚高: [{zmin:.1f},{max(footz):.1f}]cm 抬脚={max(footz)-zmin:.1f}cm  盆骨恒高(±{max(pelvisZ)-min(pelvisZ):.2f}cm)")
    print(f"   涌现bob(盆-脚垂直距摆动): {max(dropL)-min(dropL):.2f}cm")
    k = max(1, nframes//18)
    print(f"   大腿摆角: {' '.join(f'{v:5.0f}' for v in sw[::k])}")
    print(f"   膝角:     {' '.join(f'{v:5.0f}' for v in kn[::k])}")
    print(f"   外展角:   {' '.join(f'{v:5.0f}' for v in abd[::k])}")
    return dict(dur=dur, stride=stride, speed=cycdist/dur/100, swing=(min(sw),max(sw)),
                knee=(min(kn),max(kn)), bob=max(dropL)-min(dropL), lift=max(footz)-zmin)

if __name__ == '__main__':
    for p in sys.argv[1:]:
        try: analyze(p)
        except Exception as e:
            import traceback; traceback.print_exc()
