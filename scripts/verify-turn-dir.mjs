// Turn E/W 旋向数据判定工具（138/139 轮）：慢速播 TurnE90/W90，量双脚在
// mesh 局部系绕竖直轴的方位角净漂移。结论（2026-09-11 实测）：E90/W90 双脚
// 净漂移均 ≈0（原地步型，根旋转在 rip 时被剥离）——绝对旋向无法从数据恢复，
// E=右转/W=左转 维持命名推定 + pickTurnClip 单测锁定；若与本体录像比对发现
// 相反，交换 pickTurnClip 的 'E'/'W' 返回值即可（一行）。
// Turn E/W 转身方向数据判定：慢速播 TurnE90/W90，量双脚在 MESH 局部系
// 绕竖直轴的方位角漂移（消掉 yaw lerp 污染；压零 idle 等混合）。
// 判据：漂移为负（顺时针/向右）= 该 clip 是右转步型；正 = 左转。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })
const out = await page.evaluate(async () => {
  const g = window.__game
  let b = null
  for (let i = 0; i < 300 && !b; i++) {
    b = (g?.bots?.bots ?? []).find(x => x._officialLo)
    if (!b) await new Promise(r => setTimeout(r, 200))
  }
  if (!b) return { err: 'no bot' }
  g.bots.roundEndAt = 0
  g.bots.countdownUntil = 0
  const dt = 1 / 128
  b.place(0, b.manager.map.peekLineZ, 'peek')
  b.peek = { style: 'pull', dir: 1, phase: 'hold', startX: 0, holdX: 0, endX: 0, stopAt: 1,
    stopped: false, stopUntil: b.manager.now() + 999, holdUntil: 1e9, resolved: true, jiggleAt: 0, crouchWalk: false }
  b.velX = 0
  const res = {}
  for (const key of ['E90', 'W90']) {
    const a = b.anim.turn[key]
    a.reset(); a.play(); a.timeScale = 0.25
    b._turnW = 1
    for (const [k2, act] of Object.entries(b.anim.turn)) {
      act.setEffectiveWeight(k2 === key ? 1 : 0)
    }
    if (b.anim.idle) b.anim.idle.setEffectiveWeight(0)
    b.anim.walk.setEffectiveWeight(0)
    if (b.anim.run) b.anim.run.setEffectiveWeight(0)
    // 旁路 _setAnimWeights（它每 tick 清零转身权重/恢复 idle）：测量期权重冻结
    b._setAnimWeights = () => {}
    b._pinOff = true // 钉地 IK 也让位（测量纯 clip 步型）
    const feet = {
      L: b._strafeRig.legs.find(l => l.side === 'L').foot,
      R: b._strafeRig.legs.find(l => l.side === 'R').foot,
    }
    const drift = { L: 0, R: 0 }
    let prev = { L: null, R: null }
    for (let i = 0; i < 512; i++) {
      b.manager.t += dt
      g.bots.step(dt, 1)
      b.mesh.updateMatrixWorld(true)
      const qInv = b.mesh.quaternion.clone().invert()
      for (const s of ['L', 'R']) {
        const f = feet[s]
        f.updateWorldMatrix(true, false)
        const e = f.matrixWorld.elements
        const vec = new (b.mesh.position.constructor)(e[12] - b.mesh.position.x, 0, e[14] - b.mesh.position.z).applyQuaternion(qInv)
        const th = Math.atan2(vec.x, -vec.z) // mesh 局部：-Z=0（面向）、+X=+90°（右侧）
        if (prev[s] !== null) {
          let d = th - prev[s]
          while (d > Math.PI) d -= 2 * Math.PI
          while (d < -Math.PI) d += 2 * Math.PI
          drift[s] += d
        }
        prev[s] = th
      }
    }
    res[key] = { L: +((drift.L * 180) / Math.PI).toFixed(1), R: +((drift.R * 180) / Math.PI).toFixed(1) }
    a.setEffectiveWeight(0)
  }
  return res
})
console.log('落脚 mesh 局部方位角漂移（度，- = 向右/CW、+ = 向左/CCW）:', JSON.stringify(out, null, 1))
await browser.close()
