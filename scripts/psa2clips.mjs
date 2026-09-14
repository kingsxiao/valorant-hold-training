// 官方 .psa 骨骼动画 → locomotion.json（运行时由 core/Locomotion.js 建 AnimationClip）
// 数据源：assets-raw/core-psa 的 TP_Core 共享核心集（本体所有英雄的移动都用它）——
//   走/跑 N/E/W 全 8 向里先取 6 个；死亡/跳/蹲/转身在旁待接入
// 为什么换源（128 轮滑步根因）：各英雄 Simple 目录的套装（Jett X_Knives、
//   Sova Q_Bow）是被剥掉跑步机分量的特殊变体——支撑期脚相对盆骨仅 ~46cm 行程，
//   腿链可达锥（±0.5m）根本盖不住体速位移，钉地 IK 只能钉 50-90ms 然后随体滑。
//   TP_Core 的循环支撑期脚相对盆骨后扫 ~1.2-1.5m = 全步幅，脚天生落地（盆骨
//   前移时腿关节相对后蹬），残余不匹配只剩 STEP_LEN 取中的 ±5%，IK 轻松吸收。
// 转换口径（scripts 内实测对齐）：
//   - 骨名：psa 无后缀名（L_Knee）↔ 英雄 GLB 带 _NNNN 后缀（L_Knee_0137），
//     运行时按「去后缀」解析，JSON 里存 psa 名
//   - 旋转：psa 局部四元数与 GLB kamae 第 0 帧逐骨完全一致（0.0°，含 R 侧）——
//     直接采用；(上上轮记录的「R 侧镜像约定」是坏 parent 字段导致的 FK 误诊)
//     ⚠ 例外（157 轮实测）：根链骨 Splitter/Skeleton 的 psa 轨道值是 GLB rest
//     的逆（Splitter 恒 (0.5,0.5,0.5,-0.5) vs GLB rest +0.5，相差 120°）——
//     直挂应用 = 整副骨架放倒（超人姿）。运行时 core/Locomotion.js buildClip
//     统一修正（根链跳过旋转轨道、Splitter 直接子骨左乘 restQ 换系），本脚本
//     保持 psa 数据原样导出
//   - 位置：psa cm × 0.01 = GLB m（L_Hip 11.522cm ↔ 0.11522m 分毫不差）
//   - 只保留有动画的骨（LB 恰好 12 根：Splitter/Pelvis + 双腿链），
//     恒定轨道不发（mixer 缺轨=保持 rest，骨架 rest 即官方 bind）
import fs from 'node:fs'

function parsePsa(path) {
  const buf = fs.readFileSync(path)
  const chunks = {}
  let off = 0
  while (off + 32 <= buf.length) {
    const cid = buf.subarray(off, off + 20).indexOf(0)
    const id = buf.subarray(off, off + (cid < 0 ? 20 : cid)).toString('ascii')
    const ds = buf.readInt32LE(off + 24), n = buf.readInt32LE(off + 28)
    chunks[id] = { ds, n, base: off + 32 }
    off += 32 + ds * n
  }
  const ob = chunks.BONENAMES
  const names = []
  for (let i = 0; i < ob.n; i++) {
    const s = buf.subarray(ob.base + i * ob.ds, ob.base + i * ob.ds + 64)
    names.push(s.subarray(0, s.indexOf(0)).toString('ascii'))
  }
  const ai = chunks.ANIMINFO.base
  const totalbones = buf.readInt32LE(ai + 128)
  const tracktime = buf.readFloatLE(ai + 148), animrate = buf.readFloatLE(ai + 152)
  const kb = chunks.ANIMKEYS
  const nframes = kb.n / totalbones
  const frames = []
  for (let f = 0; f < nframes; f++) {
    const o = kb.base + f * totalbones * 32
    const fr = []
    for (let b = 0; b < totalbones; b++) {
      fr.push({
        p: [buf.readFloatLE(o + b * 32), buf.readFloatLE(o + b * 32 + 4), buf.readFloatLE(o + b * 32 + 8)],
        q: [buf.readFloatLE(o + b * 32 + 12), buf.readFloatLE(o + b * 32 + 16), buf.readFloatLE(o + b * 32 + 20), buf.readFloatLE(o + b * 32 + 24)],
      })
    }
    frames.push(fr)
  }
  return { names, frames, duration: tracktime / animrate }
}

const WANTED = ['Splitter', 'Pelvis', 'L_Hip', 'L_Knee', 'L_Foot', 'L_Toe', 'R_Hip', 'R_Knee', 'R_Foot', 'R_Toe']
// 官方脚部落地的本体方法：UE AnimGraph 脚部 IK 把踝约束到 IK 目标曲线——目标
// 局部空间 ≈ 盆骨空间（parent 字段坏无法确证，但「支撑期锚点在世界系静止」
// 的实测只对盆骨空间成立，±2cm）。支撑期目标随盆骨系后退 ≈ 体速 → 世界系
// 静止（实测 RunN 支撑窗内漂移 ±2cm）= 天生落地锚
const IK_BONES = { L: 'L_IK_FootTarget', R: 'R_IK_FootTarget' }

function clipFrom(path) {
  const { names, frames, duration } = parsePsa(path)
  const tracks = []
  for (const bone of WANTED) {
    const bi = names.indexOf(bone)
    if (bi < 0) continue
    const q = frames.map(f => f[bi].q)
    const p = frames.map(f => f[bi].p)
    const qVar = q.some(v => v.some((x, k) => Math.abs(x - q[0][k]) > 1e-6))
    const pVar = p.some(v => v.some((x, k) => Math.abs(x - p[0][k]) > 1e-6))
    const t = { b: bone, q: q.flat().map(v => +v.toFixed(5)) }
    if (pVar) t.p = p.flat().map(v => +(v * 0.01).toFixed(5))
    if (qVar || pVar) tracks.push(t)
  }
  const ik = {}
  for (const [side, bone] of Object.entries(IK_BONES)) {
    const bi = names.indexOf(bone)
    if (bi < 0) continue
    ik[side] = frames.map(f => [f[bi].p[0] * 0.01, f[bi].p[1] * 0.01, f[bi].p[2] * 0.01])
      .flat().map(v => +v.toFixed(5))
  }
  const times = frames.map((_, i) => +((i / (frames.length - 1)) * duration).toFixed(4))
  return { duration: +duration.toFixed(4), n: frames.length, times, tracks, ik }
}

// 全骨骼变体（死亡等整身动画）：导出所有有变化的骨（恒定轨道不发 = mixer 缺轨
// 保持 rest）。死亡是整身表现（脊柱/颈/手臂/腿全动），LB 十骨不够
function clipFromFull(path) {
  const { names, frames, duration } = parsePsa(path)
  const tracks = []
  for (let bi = 0; bi < names.length; bi++) {
    const bone = names[bi]
    if (/\b(end|Twst|Ndl|IKpv|_IUE)$/i.test(bone) || /_end$|_Twst|_Ndl|IKpv|_IUE/.test(bone)) continue
    const q = frames.map(f => f[bi].q)
    const p = frames.map(f => f[bi].p)
    const qVar = q.some(v => v.some((x, k) => Math.abs(x - q[0][k]) > 1e-6))
    const pVar = p.some(v => v.some((x, k) => Math.abs(x - p[0][k]) > 1e-6))
    if (!qVar && !pVar) continue
    const t = { b: bone, q: q.flat().map(v => +v.toFixed(5)) }
    if (pVar) t.p = p.flat().map(v => +(v * 0.01).toFixed(5))
    tracks.push(t)
  }
  // 官方 IK 落地锚（StopAdd/Turn 等整身 clip 同样带 L/R_IK_FootTarget）：
  // 急停支架/转身踏步的官方脚部约束——不导出 = 这些状态钉地无锚，原始腿曲线
  // （官方 FootIK 之前的姿态）直接暴露（脚穿地/悬空的 160 轮根因）
  const ik = {}
  for (const [side, bone] of Object.entries(IK_BONES)) {
    const bi = names.indexOf(bone)
    if (bi < 0) continue
    ik[side] = frames.map(f => [f[bi].p[0] * 0.01, f[bi].p[1] * 0.01, f[bi].p[2] * 0.01])
      .flat().map(v => +v.toFixed(5))
  }
  const times = frames.map((_, i) => +((i / (frames.length - 1)) * duration).toFixed(4))
  return { duration: +duration.toFixed(4), n: frames.length, times, tracks, ik }
}

const SRC = {
  core: {
    walkN: 'assets-raw/core-psa/TP_Core_WalkN_LB.psa',
    runN: 'assets-raw/core-psa/TP_Core_RunN_LB.psa',
    walkE: 'assets-raw/core-psa/TP_Core_WalkE_LB.psa',
    runE: 'assets-raw/core-psa/TP_Core_RunE_LB.psa',
    walkW: 'assets-raw/core-psa/TP_Core_WalkW_LB.psa',
    runW: 'assets-raw/core-psa/TP_Core_RunW_LB.psa',
  },
  // 死亡整身 clip：玩家在正面 → 后仰背摔（弹道把人向后打）；背后/侧后 → 前扑
  death: {
    back: { path: 'assets-raw/core-psa/TP_Core_Death_Land_BackSplat_Big.psa', full: true },
    front: { path: 'assets-raw/core-psa/TP_Core_Death_Land_FrontSplat_Big.psa', full: true },
  },
  // 跑动上身叠加层（加法：Spine1-3/Neck/Head/锁骨 + 枪锚骨，37f/0.6s 与 RunN
  // 同相）——本体跑动胸口随步频起伏/反向扭转，枪锚骨跟着动 = 官方武器随动
  runAdd: {
    N: { path: 'assets-raw/core-psa/TP_Core_RunAddN_UB.psa', full: true },
    E: { path: 'assets-raw/core-psa/TP_Core_RunAddE_UB.psa', full: true },
    W: { path: 'assets-raw/core-psa/TP_Core_RunAddW_UB.psa', full: true },
  },

  // 蹲踞待机循环（全程蹲姿的 4.5s 循环，根高 79.6cm vs 站姿 114.1cm = 沉降
  // 30%——下蹲过渡由权重坡合成，命中区按同比例缩放）
  crouch: {
    idle: 'assets-raw/core-psa/TP_Core_CrouchIdle_LB.psa',
    // 蹲走全 8 向：walkE/W 已接入（蹲走拉出 pull 变体）；斜向 4 向 + N/S 数据
    // 就绪待玩法决策（斜向蹲走/背向蹲走均无现有波次类型）
    walkN: 'assets-raw/core-psa/TP_Core_CrouchWalkN_LB.psa',
    walkE: 'assets-raw/core-psa/TP_Core_CrouchWalkE_LB.psa',
    walkW: 'assets-raw/core-psa/TP_Core_CrouchWalkW_LB.psa',
    walkNE: 'assets-raw/core-psa/TP_Core_CrouchWalkNE_LB.psa',
    walkNW: 'assets-raw/core-psa/TP_Core_CrouchWalkNW_LB.psa',
    walkSE: 'assets-raw/core-psa/TP_Core_CrouchWalkSE_LB.psa',
    walkSW: 'assets-raw/core-psa/TP_Core_CrouchWalkSW_LB.psa',
  },
  // 跳 peek：JumpN=预备蹲(0.13s)→蹬伸(峰值 0.63s)→空中收腿保持（3.2s，过截
  // 断）；抛物线本体走引擎（clip 无弧线）——由 Bot 的 mesh.y 弧线偏移驱动，
  // 命中区随 mesh 自动跟随；JumpLand=落地压缩→回站（0.667s 一次）
  jump: {
    jumpN: 'assets-raw/core-psa/TP_Core_JumpN_LB.psa',
    jumpLand: 'assets-raw/core-psa/TP_Core_JumpLand_LB.psa',
    // 滞空段姿态续接：JumpN 蹬伸段播完后（滞空 >0.35s）切 Falling 循环保持
    // 空中收腿姿态（根高 112-119cm 全程悬空），落地仍切 JumpLand
    fall: 'assets-raw/core-psa/TP_Core_Falling_LB.psa',
  },
  // 停步转身踏步（E=向右 / W=向左 × 45/90/135/180°，全部 1.0s）：clip 本体不带
  // 根旋转（Splitter/Pelvis Y 转角≈0）——本体引擎程序化转根，腿只出「转身踏步」
  // 步型；我们同样保持 yaw lerp 权威、clip 只出腿
  turn: {
    E45: 'assets-raw/core-psa/TP_Core_TurnE45_LB.psa',
    E90: 'assets-raw/core-psa/TP_Core_TurnE90_LB.psa',
    E135: 'assets-raw/core-psa/TP_Core_TurnE135_LB.psa',
    E180: 'assets-raw/core-psa/TP_Core_TurnE180_LB.psa',
    W45: 'assets-raw/core-psa/TP_Core_TurnW45_LB.psa',
    W90: 'assets-raw/core-psa/TP_Core_TurnW90_LB.psa',
    W135: 'assets-raw/core-psa/TP_Core_TurnW135_LB.psa',
    W180: 'assets-raw/core-psa/TP_Core_TurnW180_LB.psa',
  },
}
const out = {}
for (const [hero, files] of Object.entries(SRC)) {
  out[hero] = out[hero] ?? {}
  for (const [k, spec] of Object.entries(files)) {
    out[hero][k] = typeof spec === 'string' ? clipFrom(spec) : clipFromFull(spec.path)
  }
}

// ── 蹲族单侧 IK 锚 z 抬高修复（165 轮）────────────────────────────────
// 全库锚 z 普查：所有 clip 两侧触地平台都落在 0.116~0.136，唯蹲族三处例外
// （实测 psa 原始数据即如此，非转换错误）：
//   CrouchIdle      R 侧恒 0.172（L 0.123）→ 蹲踞站定右脚悬空 4.9cm
//   CrouchWalkE  R 侧最低 0.152（L 0.123）→ 蹲走 E 右脚悬空 ~2.9cm
//   CrouchWalkW  L 侧最低 0.160（R 0.124）→ 蹲走 W 左脚悬空 ~3.6cm
// 判定为数据缺陷而非官方踮脚的依据：实测脚尖（L_Toe/R_Toe 世界高）同样悬
// 空 3~7cm（好侧脚尖 0.00~0.04 贴地）——若是踮脚姿态，脚尖应在地面。
// 修复口径：整条 z 曲线下沉 δ = 坏侧平台 − 同 clip 好侧平台（walkW 坏侧摆动
// 峰 0.288−0.036=0.252 与好侧 0.251 互证 = 全曲线恒定偏移；横向 y 与触地窗
// 扫速不动——坏侧 stance 段 ~1.5 m/s 扫速本来就与好侧一致，只缺落地）
const IK_Z_REPAIRS = [
  { clip: out.crouch.idle, bad: 'R', name: 'crouchIdle' },
  { clip: out.crouch.walkE, bad: 'R', name: 'crouchWalkE' },
  { clip: out.crouch.walkW, bad: 'L', name: 'crouchWalkW' },
  // 斜向蹲走同族缺陷（L 侧抬高 1.3~1.6cm；165 轮普查发现，当前无波型使用、
  // 数据先治好备将来斜向波）：SE 0.136/0.120、SW 0.136/0.123
  { clip: out.crouch.walkSE, bad: 'L', name: 'crouchWalkSE' },
  { clip: out.crouch.walkSW, bad: 'L', name: 'crouchWalkSW' },
]
const CW_STEP_CANON = 0.735 // 官方蹲走步距（Locomotion.CROUCH_WALK_STEP 同源）
for (const { clip, bad, name } of IK_Z_REPAIRS) {
  const good = bad === 'L' ? 'R' : 'L'
  const minZ = (side) => {
    let m = Infinity
    for (let i = 0; i < clip.n; i++) m = Math.min(m, clip.ik[side][i * 3 + 2])
    return m
  }
  const dz = minZ(bad) - minZ(good)
  for (let i = 0; i < clip.n; i++) {
    clip.ik[bad][i * 3 + 2] = +(clip.ik[bad][i * 3 + 2] - dz).toFixed(5)
  }
  console.log(`IK z repair: ${name} side ${bad} dz=${dz.toFixed(4)}`)
}

// 蹲走坏侧第二/三刀（165 轮续，按侧别实测择优）：
//  第二刀 z 平台压平（E+W 都启用）：δ 下沉后坏侧仍无平台段（好侧 9~14 帧平
//   段，坏侧窗边 0.137~0.168 波动轻吻几下）——整窗压平 = 官方 IK 目标的整窗
//   落地约束。触地窗内锚 z 恒平台，可达段脚全窗贴地
//  第三刀 y 线性化（仅 W）：实测 W 触地窗内「锚自身世界速度 med 0.91 m/s」
//   （钳制仅占 27%）——W 原始 y 窗内扫速分布 2.11/0.0/1.45 m/s@自然速率
//   （净幅对、分布错），线性化 = 恒 2×0.735/周期（med 0.87→0.68）。E 侧实测
//   反而劣化（触地 51→5 帧）——E 原始 y「慢起步再加速」与骨盆起伏相位耦合
//   （髋高相位恰逢锚远端 dTarget 1.13 > 腿长 0.948，恒速线性化让远端停留更
//   久 = 越距窗更长），E 的 y 保持原样
//  stance 窗手工定案（反相窗 + 净扫幅双验证）：E R = f09-f17（净扫 0.459 vs
//   官方 0.457）、W L = f19-f03 环回（0.756 vs 0.763）。touchdown 值不动，
//   liftoff 随扫幅差平移，摆动段按相位仿射校正（官方摆动形状保留）。自动
//   窗检测会把摆动低段框进来（实测 24 帧把脚胶死地面），勿回退
const IK_STANCE_REBUILD = [
  { clip: null, bad: 'R', name: 'crouchWalkE', from: 9, to: 17, linear: false },
  { clip: null, bad: 'L', name: 'crouchWalkW', from: 19, to: 3, linear: true },
]
for (const rep of IK_STANCE_REBUILD) {
  rep.clip = { crouchWalkE: out.crouch.walkE, crouchWalkW: out.crouch.walkW }[rep.name]
}
for (const { clip, bad, name, from, to, linear } of IK_STANCE_REBUILD) {
  const n = clip.n
  const ik = clip.ik[bad]
  const steps = ((to - from + n) % n) // 窗内区间数（环回）
  const frameDt = clip.duration / (n - 1)
  // z 压平到平台
  const plat = Math.min(...Array.from({ length: n }, (_, i) => ik[i * 3 + 2]))
  for (let k = 0; k <= steps; k++) ik[((from + k) % n) * 3 + 2] = +plat.toFixed(5)
  let yLog = 'y:原样'
  if (linear) {
    // y 线性化（官方口径扫速，方向取数据自身的净扫向）
    const y0 = ik[from * 3 + 1]
    const y1old = ik[to * 3 + 1]
    const rate = CW_STEP_CANON * 2 / clip.duration
    const dir = Math.sign(y1old - y0) || 1
    const y1new = +(y0 + dir * rate * steps * frameDt).toFixed(5)
    for (let k = 1; k <= steps; k++) {
      ik[((from + k) % n) * 3 + 1] = +(y0 + dir * rate * k * frameDt).toFixed(5)
    }
    // 摆动段仿射校正：from 端不动，to 端平移 (y1new − y1old) 按相位 u 线性分摊
    const swingSteps = n - 1 - steps
    for (let k = 1; k < swingSteps; k++) {
      const idx = ((to + k) % n) * 3 + 1
      const u = k / swingSteps
      ik[idx] = +(ik[idx] + u * (y1new - y1old)).toFixed(5)
    }
    yLog = `y: ${y0.toFixed(3)}→${y1new.toFixed(3)} (was ${y1old.toFixed(3)})`
  }
  console.log(`IK stance rebuild: ${name} ${bad} f${from}→f${to} (${steps + 1}f) z→${plat.toFixed(4)} ${yLog}`)
}
// 急停支架（Spine1-3+Neck 上身后压 + 腿，0.667s）：加法层，叠在 kamae 上——
// 单条目全骨骼 clip（SRC 循环是「集合→多 clip」语义，stopAdd 不适用故单独导出）
out.stopAdd = clipFromFull('assets-raw/core-psa/TP_Core_StopAdd.psa')
// 横移 E/W 集：TP_Core 的真方向性循环（摆动腿跨向、支撑腿蹬伸各方向不同）
out.strafe = { walkE: out.core.walkE, runE: out.core.runE, walkW: out.core.walkW, runW: out.core.runW }
// 死亡集提到顶层（与 strafe 平级），供 Locomotion.buildLocomotion 消费
out.death = { back: out.death.back, front: out.death.front }
fs.writeFileSync('public/models/locomotion.json', JSON.stringify(out))
const size = fs.statSync('public/models/locomotion.json').size
console.log(`written public/models/locomotion.json (${(size / 1024).toFixed(1)} KB)`)
for (const [hero, clips] of Object.entries(out)) {
  for (const [k, c] of Object.entries(clips)) {
    if (!c?.tracks) continue // stopAdd 是单 clip（挂在 hero 位上），在下面单独打印
    console.log(`${hero}.${k}: ${c.n}f ${c.duration}s tracks=${c.tracks.length} bones=[${c.tracks.map(t => t.b).join(',')}]`)
  }
}
console.log(`stopAdd: ${out.stopAdd.n}f ${out.stopAdd.duration}s tracks=${out.stopAdd.tracks.length}`)
