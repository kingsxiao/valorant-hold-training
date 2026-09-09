// 开火手感/特效实机评测 v3：时序全部在页面内驱动（宿主截图只读不改状态）。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const outDir = process.argv[2] ?? '/tmp/feel-shots'
const URL_ = process.env.URL ?? 'http://127.0.0.1:5567/'
const MODE = process.env.WEAPON ?? 'vandal'
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(URL_, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })
console.log('clicked start')
await page.waitForTimeout(1200)

if (MODE !== 'vandal') {
  await page.evaluate((id) => { window.__game.weapons.switchTo(id) }, MODE)
  await page.waitForTimeout(1300)
}
await page.screenshot({ path: `${outDir}/00-idle.png` })

const pre = await page.evaluate(() => {
  const w = window.__game.weapons
  return { spray: w.sprayIndex, heat: +w.heat.toFixed(3), id: w.currentId }
})

// 连发：页面内压 2s，宿主并发截图 6 张
const holdP = page.evaluate(() => {
  const g = window.__game
  g.input.mouse0 = true
  g.weapons.queueEdges(true, false)
  return new Promise(r => setTimeout(() => { g.input.mouse0 = false; r(g.weapons.sprayIndex) }, 2000))
})
for (let i = 1; i <= 6; i++) {
  await page.waitForTimeout(330)
  await page.screenshot({ path: `${outDir}/01-fire-${i}.png` })
}
const sprayAfter = await holdP
await page.waitForTimeout(500)
await page.screenshot({ path: `${outDir}/02-recover.png` })

const mid = await page.evaluate(() => {
  const w = window.__game.weapons
  return { spray: w.sprayIndex, heat: +w.heat.toFixed(3), punch: +window.__game.player.punchPitch.toFixed(4) }
})

// 对墙 3 发：页面内依次触发（间隔 0.4s），宿主跟拍
await page.evaluate(() => { window.__game.player.pitch = 0.35 })
const wallP = page.evaluate(async () => {
  const g = window.__game
  for (let i = 0; i < 3; i++) {
    g.weapons.queueEdges(true, false)
    g.input.mouse0 = true
    await new Promise(r => setTimeout(r, 60))
    g.input.mouse0 = false
    await new Promise(r => setTimeout(r, 340))
  }
})
for (const n of [1, 2, 3]) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${outDir}/03-wall-${n}.png` })
}
await wallP
await page.waitForTimeout(250)
await page.screenshot({ path: `${outDir}/04-wall-after.png` })

const post = await page.evaluate(() => {
  const fx = window.__game.fx
  return {
    decals: fx.decals.filter(d => d.life > 0).length,
    shellsAir: fx.shells.filter(s => s.life > 0).length,
    sparks: fx.sparks.n, puffs: fx.puffs.n,
  }
})
console.log('PRE', JSON.stringify(pre), 'sprayAfter', sprayAfter)
console.log('MID', JSON.stringify(mid))
console.log('POST', JSON.stringify(post))
console.log('ERRORS', JSON.stringify(errors))
await browser.close()
console.log('DONE')
