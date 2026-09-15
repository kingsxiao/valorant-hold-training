// 端到端：自然波次跑 20s，玩家训练视角每 2s 一张截图
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const outDir = process.argv[2] ?? '/tmp/natural'
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
  g.bots.roundEndAt = 0; g.bots.countdownUntil = 0
})
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(2000)
  const info = await page.evaluate(() => {
    const g = window.__game
    const b = g.bots.bots.find(x => x.active && x.mode === 'peek')
    return b ? { style: b.peek?.style, x: +b.pos.x.toFixed(1), v: +b.velX.toFixed(1) } : null
  })
  await page.screenshot({ path: `${outDir}/n-${i}.png` })
  console.log(i, JSON.stringify(info))
}
await browser.close()
console.log('DONE →', outDir)
