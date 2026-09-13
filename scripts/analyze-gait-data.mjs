// 官方步态数据体检（只读分析，不改管线）：
// 对每条移动 clip 测：
//  1) ik 锚曲线（盆骨空间）的支撑窗（z 低段）时长与 x 扫幅（前后向）
//  2) Splitter/Pelvis 位置轨道的平移范围（跑步机分量是否存在）
//  3) 「零滑步隐含速度」= 支撑窗 x 扫幅 / 支撑窗时长（对比本体移速档）
//  4) 官方 clip 周期 vs 本体 STEP_LEN 相位锁周期
import fs from 'node:fs'

const loco = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))

const analyze = (name, clip) => {
  const n = clip.n, dur = clip.duration
  const ik = clip.ik
  const out = { name, n, dur: +dur.toFixed(3) }
  // Splitter / Pelvis 位置轨道
  for (const bn of ['Splitter', 'Pelvis']) {
    const tr = clip.tracks.find(t => t.b === bn)
    if (tr?.p) {
      const xs = [], ys = [], zs = []
      for (let i = 0; i < n; i++) {
        xs.push(tr.p[i * 3]); ys.push(tr.p[i * 3 + 1]); zs.push(tr.p[i * 3 + 2])
      }
      out[bn + 'Pos'] = {
        x: [+Math.min(...xs).toFixed(3), +Math.max(...xs).toFixed(3)],
        y: [+Math.min(...ys).toFixed(3), +Math.max(...ys).toFixed(3)],
        z: [+Math.min(...zs).toFixed(3), +Math.max(...zs).toFixed(3)],
      }
    }
  }
  if (!ik) return out
  for (const side of ['L', 'R']) {
    const a = ik[side]
    if (!a) continue
    const pts = []
    for (let i = 0; i < n; i++) pts.push({ t: i / (n - 1) * dur, x: a[i * 3], y: a[i * 3 + 1], z: a[i * 3 + 2] })
    const yRange = [Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y))]
    // 轴约定（Bot.js 落地口径）：psa 前进 = -x（mesh -Z），侧 = y，高 = z
    // 支撑窗 = z < 0.22（官方支撑带 0.123~0.155，缓冲）
    const stance = pts.filter(p => p.z < 0.22)
    if (!stance.length) { out[side] = { stance: 0 }; continue }
    // 连续段（环形）：找最大连续支撑段
    const segs = []
    let seg = [stance[0]]
    for (let i = 1; i < stance.length; i++) {
      if (stance[i].i === undefined && stance[i - 1] !== undefined && Math.abs(stance[i].t - seg[seg.length - 1].t) < dur / n * 2) seg.push(stance[i])
      else { segs.push(seg); seg = [stance[i]] }
    }
    segs.push(seg)
    segs.sort((s1, s2) => s2.length - s1.length)
    const s = segs[0]
    const x0 = s[0].x, x1 = s[s.length - 1].x
    const sweep = x1 - x0 // 盆骨空间支撑窗 x 变化（负 = 后扫，前进 = -x）
    const span = s[s.length - 1].t - s[0].t
    out[side] = {
      yRange: [+yRange[0].toFixed(3), +yRange[1].toFixed(3)],
      strideY: +(yRange[1] - yRange[0]).toFixed(3),
      stanceFrames: s.length, stanceDur: +span.toFixed(3),
      sweepX: +sweep.toFixed(3), // 正=向 +x；前进方向 = -x → 后扫为正
      zMin: +Math.min(...pts.map(p => p.z)).toFixed(3),
      zMax: +Math.max(...pts.map(p => p.z)).toFixed(3),
      xRange: [+Math.min(...pts.map(p => p.x)).toFixed(3), +Math.max(...pts.map(p => p.x)).toFixed(3)],
      impliedSpeed: +(Math.abs(sweep) / span).toFixed(2), // 零滑步隐含体速（1x 播放）
      impliedStepLen: +Math.abs(sweep).toFixed(3), // 支撑扫幅 = 步距（零滑步）
    }
  }
  // 全周期两脚各一次支撑 → 周期步距 = 单脚扫幅；周期推进 = 2×扫幅（双脚步行）
  const sweeps = ['L', 'R'].filter(s => out[s]?.sweepX !== undefined).map(s => Math.abs(out[s].sweepX))
  if (sweeps.length) {
    out.cycleAdvance = +(2 * sweeps.reduce((a, v) => a + v, 0) / sweeps.length).toFixed(3)
    out.impliedCadence = +(out.cycleAdvance / dur).toFixed(2) // 1x 播放零滑步体速
  }
  return out
}

const list = []
const push = (tag, c) => { if (c?.tracks) list.push(analyze(tag, c)) }
push('core.walkN', loco.core.walkN)
push('core.runN', loco.core.runN)
push('core.walkE', loco.core.walkE)
push('core.runE', loco.core.runE)
push('core.walkW', loco.core.walkW)
push('core.runW', loco.core.runW)
push('crouch.idle', loco.crouch.idle)
push('crouch.walkN', loco.crouch.walkN)
push('crouch.walkE', loco.crouch.walkE)
push('crouch.walkW', loco.crouch.walkW)
push('jump.jumpN', loco.jump.jumpN)
push('turn.E90', loco.turn.E90)
push('turn.W90', loco.turn.W90)
console.log(JSON.stringify(list, null, 1))
