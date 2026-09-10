// 官方 .psa 曲线接入的曲线级验证台架（手动驱动，确定性）：
//  1) 曲线比对：手动以恒速驱动 bot（walk 3.0 / run 5.4 m/s，横移面向玩家），
//     采样 L_Knee / L_Hip 局部四元数按播放头分相位桶，vs locomotion.json 的
//     slerp 求值（hero 自己的 N 集或 strafe 集），RMS 报告。钉地 IK 实例级
//     关闭（它有意偏离曲线——脚要钉回锚点，见 2）。
//  2) 钉地效果：钉地开启，支撑脚（较低者）世界速度沿移动轴——官方导出剥离了
//     根位移、脚相对骨盆无净后退（实测全速滑地 5.3~5.7 m/s），钉地后应 <1 m/s。
//  3) 侧别 A/B：横移分别强制 E/W，支撑脚滑速小者=正确侧别。
// 手动驱动 = 不受 rAF/回合边界/暂停干扰（探针在真实波次里采样会被这些打断）。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const loco = JSON.parse(fs.readFileSync('public/models/locomotion.json', 'utf8'))
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:5213/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })

const run = await page.evaluate(async ({ specs, locoJson }) => {
  const loco = locoJson
  const g = window.__game
  const all = () => (g?.bots?.bots ?? [])
  let b = null
  for (let i = 0; i < 300 && !b; i++) {
    b = all().find(x => x._officialLo)
    if (!b) await new Promise(r => setTimeout(r, 200))
  }
  if (!b) return { err: 'no official bot in pool' }
  g.bots.roundEndAt = 0 // 关回合计时（手动驱动不限时）
  g.bots.countdownUntil = 0
  // 速度档经 CONFIG 注入（manager 按 peek.dir × moveSpeed 驱动）——台架绝不能
  // 自己再调 moveToward：manager 内部同样驱动，双积分会把体速跑成 2×（曾把
  // 钉地/曲线全部指标测在两倍速度上）
  const speed0 = g.CONFIG.bot.moveSpeed
  const hero = b.anim.walk.getClip().name.split('-')[0] // 'jett-walkN' → 'jett'
  const dt = 1 / 128
  const results = []
  for (const sp of specs) {
    g.CONFIG.bot.moveSpeed = Math.abs(sp.vx)
    b.place(sp.startX, b.manager.map.peekLineZ, 'peek')
    b.peek = { style: sp.style, dir: Math.sign(sp.vx) || 1, phase: 'out', startX: sp.startX,
      endX: sp.startX + Math.sign(sp.vx) * 40, stopAt: 1, stopped: false, stopUntil: 0,
      holdX: sp.startX + Math.sign(sp.vx) * 40, resolved: true, jiggleAt: 0 }
    if (sp.pinOff) b._pinOff = true // 曲线比对只关钉锚（IK 有意偏离曲线），贴地高度照常
    else delete b._pinOff
    if (sp.forceSide) b._strafeSide = sp.forceSide
    // 销毁段：跑 ~1 个周期让相位/钉地/权重进入稳态
    for (let i = 0; i < 96; i++) { b.manager.t += dt; g.bots.step(dt, 1) }
    for (const leg of b._strafeRig.legs) { const st = leg.foot.userData._pin; if (st) { st.has = false; st.w = 0 } }
    // 起步权重爬坡（moveW/runW 淡入 ~0.5s）会污染相位桶——丢弃一段再采样
    for (let i = 0; i < 64; i++) { b.manager.t += dt; g.bots.step(dt, 1) }
    const bones = { knee: b._strafeRig.legs[0].knee, hip: b._strafeRig.legs[0].up }
    const foot = (s) => b._strafeRig.legs.find(l => l.side === s).foot
    const snapQ = { knee: bones.knee.quaternion.clone(), hip: bones.hip.quaternion.clone() }
    const ang = (qa, qb) => 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb)))) * 180 / Math.PI
    const samples = []
    for (let i = 0; i < sp.steps; i++) {
      b.manager.t += dt
      g.bots.step(dt, 1)
      // 相位基准 = 被比对 clip 自己的播放头（walk 时长 0.867 ≠ run 0.6，拿 run.time
      // 给 walk 分桶会整体错相位——RMS 虚高 3 倍的教训）
      const t = sp.jsonSet === 'walk'
        ? b.anim.walk.time
        : sp.style === 'pull'
          ? b.anim.strafe[b._strafeSide ?? 'E'].run.time
          : b.anim.run.time
      const row = {
        t, speed: Math.abs(b.velX),
        knee: +ang(bones.knee.quaternion, snapQ.knee).toFixed(3),
        hip: +ang(bones.hip.quaternion, snapQ.hip).toFixed(3),
        pinL: foot('L').userData._pin?.has ? 1 : 0, pinR: foot('R').userData._pin?.has ? 1 : 0,
        wL: +(foot('L').userData._pin?.w ?? 0).toFixed(2), wR: +(foot('R').userData._pin?.w ?? 0).toFixed(2),
      }
      b.mesh.updateMatrixWorld(true) // 整树刷新（渲染帧平替：逐骨 updateWorldMatrix
      // 的链上矩阵与渲染路径有微妙差异，脚高曾因此恒高不下）
      for (const s of ['L', 'R']) {
        const e = foot(s).matrixWorld.elements
        row['y' + s] = e[13]; row['x' + s] = e[12]
      }
      if (samples.length < 6) {
        const hips = b._strafeRig.hips
        hips.updateWorldMatrix(true, false)
        row.dbg = {
          meshY: +b.mesh.position.y.toFixed(3), meshX: +b.mesh.position.x.toFixed(2),
          hipsWY: +hips.matrixWorld.elements[13].toFixed(3),
          hipsLocalY: +hips.position.y.toFixed(4),
          runW: +b.anim.run.getEffectiveWeight().toFixed(2),
          ph: +b.walkPhase.toFixed(2),
        }
      }
      samples.push(row)
    }
    // 曲线桶比对（引擎同款 slerp 求值，同基=采样起点）
    const jsonClip = sp.jsonSet === 'strafe'
      ? loco.strafe[sp.forceSide === 'W' ? 'runW' : 'runE']
      : (loco[hero] ?? loco.core ?? loco.jett)[sp.jsonSet === 'walk' ? 'walkN' : 'runN']
    const trackOf = (bone) => jsonClip.tracks.find(t => t.b === bone)
    const dot = (a, b2) => a[0]*b2[0]+a[1]*b2[1]+a[2]*b2[2]+a[3]*b2[3]
    const slerp = (tr, t) => {
      const T = jsonClip.times
      const f = (t / jsonClip.duration) * (T.length - 1)
      const i = Math.min(T.length - 2, Math.floor(f)), k = f - i
      const a = tr.q.slice(i * 4, i * 4 + 4), b2 = tr.q.slice((i + 1) * 4, (i + 1) * 4 + 4)
      let d = dot(a, b2)
      if (d < 0) { for (let j = 0; j < 4; j++) b2[j] = -b2[j]; d = -d }
      const th = 2 * Math.acos(Math.min(1, d))
      if (th < 1e-4) return a
      const sA = Math.sin((1 - k) * th) / Math.sin(th), sB = Math.sin(k * th) / Math.sin(th)
      const out = a.map((v, j) => v * sA + b2[j] * sB)
      const n = Math.hypot(...out)
      return out.map(v => v / n)
    }
    const compare = (rowKey, bone) => {
      const tr = trackOf(bone)
      if (!tr) return null
      const t0 = samples[0].t
      const q0 = slerp(tr, t0)
      const NB = 16
      const bins = Array.from({ length: NB }, () => [])
      for (const s of samples) {
        let ph = ((s.t - t0) / jsonClip.duration) % 1
        if (ph < 0) ph += 1
        bins[Math.min(NB - 1, Math.floor(ph * NB))].push(s[rowKey])
      }
      const wrap = (t) => ((t % jsonClip.duration) + jsonClip.duration) % jsonClip.duration
      const angArr = (a, b2) => 2 * Math.acos(Math.min(1, Math.abs(dot(a, b2)))) * 180 / Math.PI
      const official = Array.from({ length: NB }, (_, i) => angArr(slerp(tr, wrap(t0 + (i / NB) * jsonClip.duration)), q0))
      const errs = bins.map((b2, i) => b2.length ? Math.abs(b2.reduce((a, v) => a + v, 0) / b2.length - official[i]) : null).filter(e => e !== null)
      if (!errs.length) return null
      return { rms: +Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length).toFixed(2),
        max: +Math.max(...errs).toFixed(2), bins: errs.length }
    }
    // 摆动脚相对身体的顺移向速度（高脚采样，符号判 E/W 侧别：正确侧别=摆动脚
    // 朝移动方向跨过 → 显著正；错配=背向 → 负）
    const swingV = []
    for (let i = 1; i < samples.length; i++) {
      const sL = samples[i].yL > samples[i].yR // 高脚=摆动
      const x0 = sL ? samples[i - 1].xL : samples[i - 1].xR
      const x1 = sL ? samples[i].xL : samples[i].xR
      swingV.push(Math.sign(sp.vx) * ((x1 - x0) / dt) - Math.abs(samples[i].speed))
    }
    // 支撑脚滑速（较低脚沿移动轴，去边界 10% 截尾均值）；分项：钉住帧
    // （pin.w≥0.5）vs 边界帧（入锚/出锚过渡，合法移动相）
    const stanceV = []
    const pinnedV = []
    for (let i = 1; i < samples.length; i++) {
      const sL = samples[i].yL <= samples[i].yR
      const x0 = sL ? samples[i - 1].xL : samples[i - 1].xR
      const x1 = sL ? samples[i].xL : samples[i].xR
      stanceV.push((x1 - x0) / dt)
      if ((sL ? samples[i].wL : samples[i].wR) >= 0.5) pinnedV.push((x1 - x0) / dt)
    }
    stanceV.sort((a, b2) => a - b2)
    const trim = stanceV.slice(Math.floor(stanceV.length * 0.1), Math.floor(stanceV.length * 0.9))
    const absMean = (arr) => +(arr.reduce((a, v) => a + Math.abs(v), 0) / Math.max(1, arr.length)).toFixed(2)
    const absSorted = stanceV.map(Math.abs).sort((a, b2) => a - b2)
    const absP95 = absSorted[Math.floor(absSorted.length * 0.95)] ?? 0
    results.push({
      ySeries: samples.filter((_, i) => i % 12 === 0).map(r => +Math.min(r.yL, r.yR).toFixed(3)),
      dRunT: +(samples[samples.length-1].t - samples[0].t).toFixed(3),
      tag: sp.tag, hero, style: sp.style, vx: sp.vx, side: b._strafeSide,
      clipDur: jsonClip.duration, samples: samples.length,
      kneeCmp: compare('knee', 'L_Knee'), hipCmp: compare('hip', 'L_Hip'),
      stanceAbsMean: +(trim.reduce((a, v) => a + Math.abs(v), 0) / trim.length).toFixed(2),
      stanceAbsP95: +absP95.toFixed(2),
      pinnedAbsMean: absMean(pinnedV),
      pinnedFrames: pinnedV.length,
      bodyV: +Math.abs(sp.vx).toFixed(2),
      pinDuty: +((samples.filter(r => r.pinL || r.pinR).length / samples.length)).toFixed(2),
      yMin: +Math.min(...samples.map(r => Math.min(r.yL, r.yR))).toFixed(3),
      yMax: +Math.max(...samples.map(r => Math.max(r.yL, r.yR))).toFixed(3),
      footYRangeL: [+Math.min(...samples.map(r => r.yL)).toFixed(3), +Math.max(...samples.map(r => r.yL)).toFixed(3)],
      footYRangeR: [+Math.min(...samples.map(r => r.yR)).toFixed(3), +Math.max(...samples.map(r => r.yR)).toFixed(3)],
      swingVrelMean: +(swingV.reduce((a, v) => a + v, 0) / swingV.length).toFixed(2),
      lowFootHist: (() => { // 低脚 y 直方图（0.05m 桶）——定入锚阈值用
        const H = new Array(12).fill(0)
        for (const r of samples) H[Math.min(11, Math.max(0, Math.floor(Math.min(r.yL, r.yR) / 0.05)))]++
        return H
      })(),
    })
  }
  g.CONFIG.bot.moveSpeed = speed0
  b.hide()
  return { hero, results }
}, {
    locoJson: loco,
    specs: [
    { tag: 'runN 曲线', style: 'cross', vx: 5.4, startX: -20, steps: 384, jsonSet: 'run', pinOff: true },
    // 走曲线档用 3.0 m/s：speed>3.0 起跑权重混入 run 曲线（ramp 阈值 (speed-3.0)/1.6），3.39 会掺 24% 跑
    { tag: 'walkN 曲线', style: 'cross', vx: 3.0, startX: -20, steps: 512, jsonSet: 'walk', pinOff: true },
    { tag: 'strafe-E 曲线', style: 'pull', vx: 5.4, startX: -20, steps: 384, jsonSet: 'strafe', pinOff: true, forceSide: 'E' },
    { tag: 'strafe-W 曲线', style: 'pull', vx: -5.4, startX: 20, steps: 384, jsonSet: 'strafe', pinOff: true, forceSide: 'W' },
    { tag: 'E错配(左移)', style: 'pull', vx: -5.4, startX: 20, steps: 384, jsonSet: 'strafe', pinOff: true, forceSide: 'E' },
    { tag: 'W错配(右移)', style: 'pull', vx: 5.4, startX: -20, steps: 384, jsonSet: 'strafe', pinOff: true, forceSide: 'W' },
    { tag: 'runN 钉地', style: 'cross', vx: 5.4, startX: -20, steps: 512, jsonSet: 'run' },
    { tag: 'strafe 钉地', style: 'pull', vx: 5.4, startX: -20, steps: 512, jsonSet: 'strafe', forceSide: 'E' },
  ],
})
console.log(JSON.stringify(run, null, 1))
await browser.close()
console.log('DONE')
