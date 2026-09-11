// 抽搐检测台架：钩住真实模拟循环（128Hz），自然波次跑 N 秒，逐 tick 采样
// 全身骨骼四元数增量 + 关键骨世界坐标 + 全部动画层状态，事后统计：
//  1) 帧间跳变（snap）：单 tick 骨骼角变化 / 世界位移超阈（步态固有速率的数倍）
//  2) 高频振荡（jitter）：mesh.y、膝角等连续正负翻转
// 输出：每类事件计数 + 最恶劣事件发生时的动画层快照（定位是哪一层在抽）
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'

const RUN_SECONDS = 40

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.text().startsWith('[wait]')) console.log('[console]', m.text()) })
await page.goto('http://127.0.0.1:5213/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 8000 })

console.log(`sampling ${RUN_SECONDS}s of natural waves ...`)
const out = await page.evaluate(async (runSec) => {
  const g = window.__game
  const all = () => (g?.bots?.bots ?? [])
  // 等 pool 建满（official bot 在场）
  let n = 0
  for (let i = 0; i < 150; i++) {
    n = all().filter(b => b._officialLo).length
    if (n) break
    if (i % 10 === 0) console.log(`[wait] t=${i * 0.4}s bots=${all().length} official=${n} playing=${g?.state?.playing}`)
    await new Promise(r => setTimeout(r, 400))
  }
  if (!n) return { err: 'no official bot' }
  g.bots.roundEndAt = 0
  g.bots.countdownUntil = 0

  const prev = new Map() // botId -> {q: Map(boneName->quat), feet: {L:Vector3,R:...}, meshY, ...}
  const samples = []
  const ang = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180 / Math.PI

  const weightsOf = (b) => {
    const A = b.anim
    if (!A) return null
    const w = { idle: A.idle?.getEffectiveWeight() ?? null, walk: A.walk.getEffectiveWeight(), run: A.run?.getEffectiveWeight() ?? null }
    if (A.strafe) for (const s of ['E', 'W']) w['s' + s] = A.strafe[s].walk.getEffectiveWeight() + A.strafe[s].run.getEffectiveWeight()
    if (A.crouchIdle) w.crouchIdle = A.crouchIdle.getEffectiveWeight()
    if (A.crouchWalk) for (const s of ['E', 'W']) w['cw' + s] = A.crouchWalk[s].getEffectiveWeight()
    if (A.turn) { w.turnKey = b._turnKey; w.turnW = b._turnW ?? 0; for (const [k, a] of Object.entries(A.turn)) w['turn_' + k] = a.getEffectiveWeight() }
    if (A.stopAdd) w.braceW = b._braceW ?? 0
    if (A.jump) w.jumpW = b._jumpW ?? 0
    if (A.fall) w.fallW = A.fall.getEffectiveWeight()
    if (A.jumpLand) w.jlW = A.jumpLand.getEffectiveWeight()
    return w
  }

  const origStep = g.bots.step.bind(g.bots)
  let t0 = 0
  g.bots.step = (dt, alpha) => {
    origStep(dt, alpha)
    if (!t0) t0 = performance.now()
    if (performance.now() - t0 > runSec * 1000) return
    for (const b of all()) {
      if (!b.mesh.visible) continue
      if (!b.active && b.mode !== 'dying') continue
      const rig = b._strafeRig
      if (!rig) continue
      // 生命隔离：place() 会更新 spawnGuardUntil —— 变号即新命，丢弃上一命基线
      // （重生首帧 vs 上一命终态必然全骨翻转，那是采样伪影不是抽搐）
      const lifeKey = b.spawnGuardUntil ?? 0
      const wasFresh = prev.get(b.id)?.lifeKey !== lifeKey
      const row = {
        id: b.id, mode: b.mode, dying: b.mode === 'dying',
        style: b.peek?.style ?? null, phase: b.peek?.phase ?? null,
        vx: +b.velX.toFixed(2), meshY: +b.mesh.position.y.toFixed(4),
        loY: b._loY ?? null, loMin: b._loMinY ?? null, jumpArc: b._jumpArcY ?? 0,
        cw: +(b._crouchW ?? 0).toFixed(2), cww: +(b._crouchWW ?? 0).toFixed(2),
        sw: +(b._strafeW ?? 0).toFixed(2), side: b._strafeSide ?? null,
        w: weightsOf(b),
        pin: {}, bones: {}, feet: {},
      }
      for (const leg of rig.legs) {
        const st = leg.foot.userData._pin
        row.pin[leg.side] = st ? { has: st.has, w: +st.w.toFixed(2), ay: st.has ? +st.anchor.y.toFixed(3) : null } : null
        const p = wasFresh ? null : prev.get(b.id)
        for (const [k, bone] of [['up', leg.up], ['knee', leg.knee], ['foot', leg.foot], ['toe', leg.toe]]) {
          if (!bone) continue
          if (p?.q?.has(leg.side + k)) row.bones[leg.side + k] = +ang(bone.quaternion, p.q.get(leg.side + k)).toFixed(2)
          else if (p) row.bones[leg.side + k] = 0
        }
        leg.foot.updateWorldMatrix(true, false)
        const e = leg.foot.matrixWorld.elements
        row.feet[leg.side] = [+e[12].toFixed(4), +e[13].toFixed(4), +e[14].toFixed(4)]
      }
      if (b._rigExtra) {
        const p = wasFresh ? null : prev.get(b.id)
        b._rigExtra.spine.forEach((bone, i) => {
          if (p?.q?.has('sp' + i)) row.bones['sp' + i] = +ang(bone.quaternion, p.q.get('sp' + i)).toFixed(2)
          else if (p) row.bones['sp' + i] = 0
        })
      }
      // ik 锚源（复刻 _ikAnchorSource 的选型）
      const A = b.anim
      if (A) {
        const cands = [['walk', A.walk], ['run', A.run]]
        if (A.strafe) cands.push(['sE-w', A.strafe.E.walk], ['sE-r', A.strafe.E.run], ['sW-w', A.strafe.W.walk], ['sW-r', A.strafe.W.run])
        let best = null, bestW = -1
        for (const [k, a] of cands) { if (!a?.getClip().userData.ik) continue; const w = a.getEffectiveWeight(); if (w > bestW) { bestW = w; best = k } }
        row.ikSrc = bestW > 0.01 ? best : null
      }
      row.meshDY = (!wasFresh && prev.get(b.id)) ? +(row.meshY - prev.get(b.id).meshY).toFixed(4) : 0
      row.fresh = wasFresh
      if (b.mode === 'dying') row.deathT = +b.deathT.toFixed(2)
      samples.push(row)
      // 更新 prev 快照
      const q = new Map()
      for (const leg of rig.legs) {
        for (const [k, bone] of [['up', leg.up], ['knee', leg.knee], ['foot', leg.foot], ['toe', leg.toe]]) if (bone) q.set(leg.side + k, bone.quaternion.clone())
      }
      b._rigExtra?.spine.forEach((bone, i) => q.set('sp' + i, bone.quaternion.clone()))
      prev.set(b.id, { q, meshY: row.meshY, lifeKey })
    }
  }
  await new Promise(r => setTimeout(r, runSec * 1000 + 500))
  g.bots.step = origStep

  // ---- 事后分析（页内做，免序列化巨表）----
  const BONE_SNAP = 12   // °/tick：步态峰值 ~5°/tick，>12°=跳变
  const MESH_SNAP = 0.02 // m/tick：步态垂直 ≤~5mm
  const FOOT_SNAP = 0.30 // m/tick：摆动脚峰值 ~7-9cm
  const spikes = []
  let i = 0
  for (const s of samples) {
    for (const [k, v] of Object.entries(s.bones)) {
      if (v > BONE_SNAP) spikes.push({ i, kind: 'bone:' + k, val: v, s })
    }
    if (Math.abs(s.meshDY) > MESH_SNAP && !s.dying) spikes.push({ i, kind: 'meshY', val: +s.meshDY.toFixed(3), s })
    const p = samples[i - 1]
    if (p && p.id === s.id && !s.dying && !s.fresh) {
      for (const side of ['L', 'R']) {
        const d = Math.hypot(s.feet[side][0] - p.feet[side][0], s.feet[side][1] - p.feet[side][1], s.feet[side][2] - p.feet[side][2])
        if (d > FOOT_SNAP) spikes.push({ i, kind: 'foot:' + side, val: +d.toFixed(3), s })
      }
    }
    i++
  }
  // mesh.y 振荡：连续 ≥4 次同幅（≥3mm）正负交替
  const osc = []
  const perBot = samples.reduce((m, s) => { (m[s.id] ??= []).push(s); return m }, {})
  for (const [id, rows] of Object.entries(perBot)) {
    let run = []
    for (let j = 1; j < rows.length; j++) {
      const d = rows[j].meshY - rows[j - 1].meshY
      const big = Math.abs(d) >= 0.003 && !rows[j].dying
      const flips = big && run.length && Math.sign(d) !== Math.sign(run[run.length - 1].d)
      if (big) run.push({ j, d, flips })
      else {
        if (run.filter(r => r.flips).length >= 3) osc.push({ id, len: run.length, flips: run.filter(r => r.flips).length, t: run[0].j, sample: rows[run[0].j] })
        run = []
      }
    }
    if (run.filter(r => r.flips).length >= 3) osc.push({ id, len: run.length, flips: run.filter(r => r.flips).length, t: run[0].j, sample: rows[run[0].j] })
  }
  const ctx = (ev) => {
    const s = ev.s ?? ev.sample
    return { id: s.id, style: s.style, phase: s.phase, vx: s.vx, meshY: s.meshY, meshDY: s.meshDY,
      cw: s.cw, cww: s.cww, sw: s.sw, side: s.side, ikSrc: s.ikSrc, pin: s.pin, w: s.w, bones: s.bones }
  }
  const summary = {}
  for (const sp of spikes) summary[sp.kind] = (summary[sp.kind] ?? 0) + 1
  // 抽搐分布：meshY 跳变按 波风格/阶段/速度档 分桶（定位发生在哪些窗口）
  const bucket = {}
  for (const s of samples) {
    if (s.dying || s.fresh || Math.abs(s.meshDY) <= 0.02) continue
    const key = `${s.style ?? '?'}/${s.phase ?? (s.style === 'cross' ? 'run' : '?')}/vx${s.vx > 3 ? '>3' : s.vx > 1 ? '1-3' : s.vx > 0.3 ? '0.3-1' : '<0.3'}`
    bucket[key] = (bucket[key] ?? 0) + 1
  }
  // 最恶劣 meshY 事件前后的逐 tick 时间序列（机理证据）
  let worstIdx = -1, worstVal = 0
  samples.forEach((s, k) => { if (!s.dying && !s.fresh && Math.abs(s.meshDY) > worstVal) { worstVal = Math.abs(s.meshDY); worstIdx = k } })
  const win = samples.slice(Math.max(0, worstIdx - 30), worstIdx + 30).filter(s => s.id === samples[worstIdx].id)
  const series = win.map(s => ({
    vx: s.vx, meshY: s.meshY, dY: s.meshDY, loMin: s.loMin, sw: s.sw, cw: s.cw,
    ikSrc: s.ikSrc, side: s.side,
    idleW: s.w ? +(s.w.idle ?? 0).toFixed(2) : null, walkW: s.w ? +(s.w.walk ?? 0).toFixed(2) : null,
    runW: s.w ? +(s.w.run ?? 0).toFixed(2) : null, sEW: s.w ? +((s.w.sE ?? 0) + (s.w.sW ?? 0)).toFixed(2) : null,
    turnW: s.w?.turnW ?? null, braceW: s.w?.braceW ?? null,
    pinL: s.pin?.L ? `${s.pin.L.has ? 'Y' : 'n'}:${s.pin.L.w}` : null, pinR: s.pin?.R ? `${s.pin.R.has ? 'Y' : 'n'}:${s.pin.R.w}` : null,
    ayL: s.pin?.L?.ay, ayR: s.pin?.R?.ay,
    Lknee: s.bones?.Lknee, Rknee: s.bones?.Rknee, Lup: s.bones?.Lup, Rup: s.bones?.Rup,
  }))
  return {
    totalSamples: samples.length,
    bots: Object.keys(perBot).length,
    spikeSummary: summary,
    meshYBucket: bucket,
    worstSeries: series,
    topSpikes: spikes.sort((a, b) => b.val - a.val).slice(0, 25).map(sp => ({ kind: sp.kind, val: sp.val, ...ctx(sp) })),
    oscillations: osc.slice(0, 10).map(o => ({ id: o.id, len: o.len, flips: o.flips, ...ctx(o) })),
    // mesh.y 全程速率分布（P50/P95/max，按 tick 绝对值）供阈值校准
    meshYAbs: (() => {
      const v = samples.filter(s => !s.dying).map(s => Math.abs(s.meshDY)).sort((a, b) => a - b)
      return { p50: +v[Math.floor(v.length * .5)].toFixed(4), p95: +v[Math.floor(v.length * .95)].toFixed(4), max: +v[v.length - 1].toFixed(4) }
    })(),
  }
}, RUN_SECONDS)
console.log(JSON.stringify(out, null, 1))
await browser.close()
console.log('DONE')
