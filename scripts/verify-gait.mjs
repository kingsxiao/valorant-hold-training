// 浏览器实测 v2：轮询等 bot → 采数值（clip 时长/步频/膝角）+ 抓 pull/cross 截图
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const outDir = process.argv[2] ?? '/tmp/gait-shots'
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()) })
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })
console.log('clicked start')

// 轮询等 active bot（≤15s）
const ok = await page.waitForFunction(() => {
  const g = window.__game
  const bots = (g?.bots?.bots ?? g?.bots ?? []).filter(b => b.active && b.mode !== 'corpse')
  return bots.length > 0
}, { timeout: 15000, polling: 300 }).then(() => true).catch(() => false)
if (!ok) { console.log('NO BOT appeared'); await browser.close(); process.exit(1) }

// 数值探针：clip 时长 + 1s 相位推进（挑一个移动中的 mixer bot）
const probe = await page.evaluate(async () => {
  const g = window.__game
  const all = (g.bots?.bots ?? g.bots ?? [])
  const find = (pred) => all.find(b => b.active && b.mixer && pred(b))
  let b = find(x => Math.abs(x.velX) > 0.8)
  for (let i = 0; i < 40 && !b; i++) { // 等一个移动中的
    await new Promise(r => setTimeout(r, 250))
    b = find(x => Math.abs(x.velX) > 0.8)
  }
  if (!b) return { err: 'no moving mixer bot', actives: all.filter(x => x.active).map(x => ({ vel: x.velX, mixer: !!x.mixer })) }
  const p0 = b.walkPhase
  const k0 = b.anim.walk.time; const r0 = b.anim.run ? b.anim.run.time : 0
  await new Promise(r => setTimeout(r, 1000))
  const dPhase = b.walkPhase - p0
  return {
    peek: b.peek?.style, velX: +b.velX.toFixed(2),
    walkDur: +b.anim.walk.getClip().duration.toFixed(4),
    runDur: b.anim.run ? +b.anim.run.getClip().duration.toFixed(4) : null,
    dPhase: +dPhase.toFixed(3), // 1s 内相位推进（rad）
    dWalkTime: +(b.anim.walk.time - k0).toFixed(4),
    dRunTime: b.anim.run ? +(b.anim.run.time - r0).toFixed(4) : null,
    cadenceStepsPerS: +(Math.abs(dPhase) / Math.PI).toFixed(3),
  }
})
console.log('PROBE', JSON.stringify(probe, null, 1))

// 抓截图：每隔 ~350ms 一张共 16 张，同时记录当帧 bot 状态，之后挑 pull/cross 各一
const shots = []
for (let i = 0; i < 16; i++) {
  const st = await page.evaluate(() => {
    const g = window.__game
    const b = (g.bots?.bots ?? g.bots ?? []).find(x => x.active && Math.abs(x.velX) > 0.3)
    return b ? { peek: b.peek?.style, velX: +b.velX.toFixed(2) } : null
  })
  const path = `${outDir}/s${String(i).padStart(2, '0')}.png`
  await page.screenshot({ path })
  shots.push({ i, path, ...st })
  await page.waitForTimeout(220)
}
console.log('SHOTS', JSON.stringify(shots.filter(s => s.peek), null, 0))
await browser.close()
console.log('DONE')
