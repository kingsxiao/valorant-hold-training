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

const SRC = {
  core: {
    walkN: 'assets-raw/core-psa/TP_Core_WalkN_LB.psa',
    runN: 'assets-raw/core-psa/TP_Core_RunN_LB.psa',
    walkE: 'assets-raw/core-psa/TP_Core_WalkE_LB.psa',
    runE: 'assets-raw/core-psa/TP_Core_RunE_LB.psa',
    walkW: 'assets-raw/core-psa/TP_Core_WalkW_LB.psa',
    runW: 'assets-raw/core-psa/TP_Core_RunW_LB.psa',
  },
}
const out = {}
for (const [hero, files] of Object.entries(SRC)) {
  out[hero] = {}
  for (const [k, p] of Object.entries(files)) out[hero][k] = clipFrom(p)
}
// 横移 E/W 集：TP_Core 的真方向性循环（摆动腿跨向、支撑腿蹬伸各方向不同）
out.strafe = { walkE: out.core.walkE, runE: out.core.runE, walkW: out.core.walkW, runW: out.core.runW }
fs.writeFileSync('public/models/locomotion.json', JSON.stringify(out))
const size = fs.statSync('public/models/locomotion.json').size
console.log(`written public/models/locomotion.json (${(size / 1024).toFixed(1)} KB)`)
for (const [hero, clips] of Object.entries(out)) {
  for (const [k, c] of Object.entries(clips)) {
    console.log(`${hero}.${k}: ${c.n}f ${c.duration}s tracks=${c.tracks.length} bones=[${c.tracks.map(t => t.b).join(',')}]`)
  }
}
