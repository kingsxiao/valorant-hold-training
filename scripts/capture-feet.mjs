// 脚部近景评审：接管 bot 玩家正前 1.9m 横移跑，一个周期 8 相位连拍（全身+低机位）
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const outDir = process.argv[2] ?? '/tmp/feet'
fs.mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:5213/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 8000 })
await page.evaluate(async () => {
  const g = window.__game
  let last = -1, stable = 0
  for (let i = 0; i < 300; i++) {
    const n = g.bots.bots.filter(x => x._officialLo).length
    if (n === last && n >= 4) { if (++stable >= 8) break } else stable = 0
    last = n
    await new Promise(r => setTimeout(r, 250))
  }
  g.bots.roundEndAt = 0
  g.bots.countdownUntil = 0
  for (const s of g.bots.hold?.slots ?? []) { s.bot = null; s.nextAt = 1e12 }
  g.bots.onMapRebuilt = () => {}
})
for (let shot = 0; shot < 8; shot++) {
  await page.evaluate((shot) => {
    const g = window.__game
    const b = window.__tb ??= g.bots.bots.find(x => x._officialLo)
    const dt = 1 / 128
    b.place(g.player.pos.x - 0.6, g.player.pos.z - 1.9, 'peek')
    b.peek = { style: 'pull', dir: 1, phase: 'out', startX: b.pos.x, turnX: b.pos.x + 8,
      endX: b.pos.x, jiggleAt: 0, crouchWalk: false }
    b.velX = 5.4
    const ticks = 60 + Math.round((shot / 8) * 0.6 / dt)
    for (let i = 0; i < ticks; i++) g.bots.step(dt, 1)
    b.mesh.updateMatrixWorld(true)
    // 低机位看脚：主循环每帧按玩家位姿重摆相机 → 直接压玩家眼高/俯仰
    g.player.eyeHeight = 0.62
    g.player.pitch = -0.3
    window.__m = {
      shot,
      footL: { y: +(b._strafeRig.legs[0].foot.matrixWorld.elements[13]).toFixed(3) },
      footR: { y: +(b._strafeRig.legs[1].foot.matrixWorld.elements[13]).toFixed(3) },
    }
  }, shot)
  await page.screenshot({ path: `${outDir}/f-${shot}.png` })
  console.log(JSON.stringify(await page.evaluate(() => window.__m)))
}
await browser.close()
console.log('DONE →', outDir)
