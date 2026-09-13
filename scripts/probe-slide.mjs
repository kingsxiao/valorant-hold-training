// 受控滑速探针：清场 + 手动恒速驱动，逐 tick 采样双脚世界位，统计支撑脚
// （世界 y<0.21）沿移动轴速度与体速之差 = 真实滑步率。
// 用法：node scripts/probe-slide.mjs
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'

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
await page.waitForTimeout(1000)

const out = await page.evaluate(async () => {
  const g = window.__game
  let b = null
  for (let i = 0; i < 400 && !b; i++) { b = (g.bots.bots ?? []).find(x => x._officialLo); if (!b) await new Promise(r => setTimeout(r, 200)) }
  if (!b) return { err: 'no bot' }
  g.bots.roundEndAt = 0; g.bots.countdownUntil = 0
  if (g.bots.hold) for (const s of g.bots.hold.slots) { s.nextAt = 1e18; s.bot = null }
  for (const x of g.bots.bots) if (x !== b && x.active) x.hide()
  const dt = 1 / 128
  // 玩家侧放远点，pull 朝向稳定为正对（yaw 恒定不穿越）
  const px = g.player.pos.x, pz = g.player.pos.z

  const run = (tag, { style, vx, sec = 3, crouchWalk = false }) => {
    // 垂直几何：bot 与玩家同 x（正前方），运动 ±x = 纯横移（真实 peek 波几何；
    // 斜摆会让横移锚只能抵消横向分量，测出假滑步——162 轮起 cross 也面向玩家，
    // 同样受此几何约束）
    b.place(px, pz - 6, 'peek')
    b.peek = { style, dir: Math.sign(vx), phase: 'out', startX: b.pos.x,
      endX: b.pos.x + Math.sign(vx) * 60, stopAt: 1, stopped: false, stopUntil: 0,
      holdX: b.pos.x, resolved: true, jiggleAt: 0, crouchWalk, jumpPlanned: false, jumped: false }
    const warm = Math.round(1.2 / dt)
    for (let i = 0; i < warm; i++) { b.moveToward(vx, dt); g.bots.step(dt, 1) }
    const rows = []
    const N = Math.round(sec / dt)
    for (let i = 0; i < N; i++) {
      b.moveToward(vx, dt)
      g.bots.step(dt, 1)
      b.mesh.rotation.y = 0; g.bots.step(0, 1) // 锁正对：纯垂直横移几何（玩家在 +z，GLB 正面 +Z ⇒ 正对 yaw=0（164 轮）；远离玩家后朝向 lerp 会把横移扭成斜向，测出假滑步）
      b.mesh.updateMatrixWorld(true)
      const row = { v: b.velX }
      for (const leg of b._strafeRig.legs) {
        leg.foot.updateWorldMatrix(true, false)
        const e = leg.foot.matrixWorld.elements
        row[leg.side] = { x: e[12], y: e[13] }
      }
      rows.push(row)
    }
    // 支撑脚滑速：低脚（y<0.21）沿 x 的速度 − 体速
    const slides = []
    for (let i = 1; i < rows.length; i++) {
      for (const s of ['L', 'R']) {
        if (rows[i][s].y < 0.14 && rows[i - 1][s].y < 0.14) { // 官方触地平台 0.123-0.125；0.21 会把摆动脚过地带帧算进来
          slides.push(Math.abs((rows[i][s].x - rows[i - 1][s].x) / dt)) // 支撑脚自身世界速度：0=完美钉住
        }
      }
    }
    slides.sort((a, c) => a - c)
    const trim = slides.slice(Math.floor(slides.length * 0.1), Math.floor(slides.length * 0.9))
    const mean = trim.reduce((a, v) => a + v, 0) / trim.length
    const med = trim[Math.floor(trim.length / 2)]
    return { tag, side: b._strafeSide, v: +Math.abs(vx).toFixed(2),
      stanceFrames: slides.length, slideMean: +mean.toFixed(2), slideMed: +med.toFixed(2),
      slideP90: +trim[Math.floor(trim.length * 0.9)].toFixed(2) }
  }
  return [
    run('runN@5.4', { style: 'cross', vx: 5.4 }),
    run('walkN@3.0', { style: 'cross', vx: 3.0 }),
    run('strafe@5.4(拉右)', { style: 'pull', vx: 5.4 }),
    run('strafe@5.4(拉左)', { style: 'pull', vx: -5.4 }),
    run('crouchWalk@2.7', { style: 'pull', vx: 2.7, crouchWalk: true }),
  ]
})
console.log(JSON.stringify(out, null, 1))
await browser.close()
console.log('DONE')
