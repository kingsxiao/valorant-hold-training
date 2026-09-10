// 官方 .psa 骨骼动画 → locomotion.json（运行时由 core/Locomotion.js 建 AnimationClip）
// 数据源：assets-raw/{jett,sova}-psa 的官方第三人称 LB（下半身）循环——
//   走/跑 N（cross 前进）与 E/W（pull 横移，左右两个方向）
// 转换口径（scripts 内实测对齐）：
//   - 骨名：psa 无后缀名（L_Knee）↔ 英雄 GLB 带 _NNNN 后缀（L_Knee_0137），
//     运行时按「去后缀」解析，JSON 里存 psa 名
//   - 旋转：psa 局部四元数与 GLB kamae 第 0 帧逐骨完全一致（0.0°，含 R 侧）——
//     直接采用；(上上轮记录的「R 侧镜像约定」是坏 parent 字段导致的 FK 误诊)
//   - 位置：psa cm × 0.01 = GLB m（L_Hip 11.522cm ↔ 0.11522m 分毫不差）
//   - 只保留有动画的骨（LB 恰好 12 根：Splitter/Pelvis + 双腿链），
//     恒定轨道不发（mixer 缺轨=保持 rest，骨架 rest 即官方 bind）
//   - Jett 的 WalkE/RunE 腿轨道 = WalkN/RunN 导出复用（官方导出偷懒），真横移
//     曲线只在 Sova——横移 E/W 统一取 Sova
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
  const times = frames.map((_, i) => +((i / (frames.length - 1)) * duration).toFixed(4))
  return { duration: +duration.toFixed(4), n: frames.length, times, tracks }
}

const SRC = {
  jett: {
    walkN: 'assets-raw/jett-psa/X_Knives_WalkN_LB.psa',
    runN: 'assets-raw/jett-psa/X_Knives_RunN_LB.psa',
  },
  sova: {
    walkN: 'assets-raw/sova-psa/TP_Hunter_S0_Q_Bow_WalkN_LB.psa.psa',
    runN: 'assets-raw/sova-psa/TP_Hunter_S0_Q_Bow_RunN_LB.psa.psa',
    walkE: 'assets-raw/sova-psa/TP_Hunter_S0_Q_Bow_WalkE_LB.psa.psa',
    runE: 'assets-raw/sova-psa/TP_Hunter_S0_Q_Bow_RunE_LB.psa.psa',
    walkW: 'assets-raw/sova-psa/TP_Hunter_S0_Q_Bow_WalkW_LB.psa.psa',
    runW: 'assets-raw/sova-psa/TP_Hunter_S0_Q_Bow_RunW_LB.psa.psa',
  },
}
const out = {}
for (const [hero, files] of Object.entries(SRC)) {
  out[hero] = {}
  for (const [k, p] of Object.entries(files)) out[hero][k] = clipFrom(p)
}
// 横移 E/W 统一挂到 jett 名下以外也供 phoenix/sage 复用：单独一份 strafe 集
out.strafe = { walkE: out.sova.walkE, runE: out.sova.runE, walkW: out.sova.walkW, runW: out.sova.runW }
fs.writeFileSync('public/models/locomotion.json', JSON.stringify(out))
const size = fs.statSync('public/models/locomotion.json').size
console.log(`written public/models/locomotion.json (${(size / 1024).toFixed(1)} KB)`)
for (const [hero, clips] of Object.entries(out)) {
  for (const [k, c] of Object.entries(clips)) {
    console.log(`${hero}.${k}: ${c.n}f ${c.duration}s tracks=${c.tracks.length} bones=[${c.tracks.map(t => t.b).join(',')}]`)
  }
}
