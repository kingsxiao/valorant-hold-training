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
  const times = frames.map((_, i) => +((i / (frames.length - 1)) * duration).toFixed(4))
  return { duration: +duration.toFixed(4), n: frames.length, times, tracks }
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
  },
  // 跳 peek：JumpN=预备蹲(0.13s)→蹬伸(峰值 0.63s)→空中收腿保持（3.2s，过截
  // 断）；抛物线本体走引擎（clip 无弧线）——由 Bot 的 mesh.y 弧线偏移驱动，
  // 命中区随 mesh 自动跟随；JumpLand=落地压缩→回站（0.667s 一次）
  jump: {
    jumpN: 'assets-raw/core-psa/TP_Core_JumpN_LB.psa',
    jumpLand: 'assets-raw/core-psa/TP_Core_JumpLand_LB.psa',
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
