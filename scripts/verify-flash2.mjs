// 浏览器实测：闪光还原度第五轮五处改动的探针 + 截图
//  1) KAY/O 琥珀警示灯（glowMat.emissive = 0xffa54a，非旧青色）
//  2) Breach 起爆 = 贴墙竖直光柱（_beam 挂起后 0.32s 内 visible→false）
//  3) Reyna 近视附带 Deafened（近视期内 audio.deafenLP 频率塌到 ~800Hz，
//     消退后回 20kHz 直通）
//  4) 白闪屏效纯白平铺（computed backgroundImage = none，无径向渐变/残像色）
//  5) Dizzy 等离子糊屏绿紫配色（backgroundImage 含绿浆 blob）
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const outDir = process.argv[2] ?? '/tmp/flash2-shots'
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
await page.goto(process.env.URL ?? 'http://127.0.0.1:5417/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })
await page.waitForTimeout(1200)

const spawn = (t) => page.evaluate((type) => {
  const g = window.__game
  g.flashes.setMode(type)
  g.flashes.resetRound(99) // 调度拉远，全部手动投放
  const gap = g.map.gaps[0]
  const cx = (gap.x0 + gap.x1) / 2
  g.flashes['_spawn' + type[0].toUpperCase() + type.slice(1)](gap, cx)
}, t)

// ---- 1) KAY/O 琥珀灯：飞行中截图 + emissive 色探针 ----
await spawn('kayo')
await page.waitForTimeout(520)
await page.screenshot({ path: `${outDir}/kayo-amber-flight.png`, clip: { x: 460, y: 240, width: 560, height: 380 } })
const kayo = await page.evaluate(() => {
  const m = window.__game.flashes._models.kayo
  return { emissive: m.glowMat.emissive.getHexString(), kids: m.group.children.length }
})
console.log('kayo    ', JSON.stringify(kayo))
await page.evaluate(() => window.__game.flashes.endRound())
await page.waitForTimeout(2600) // 等白屏退净

// ---- 4) 白屏纯白：KAY/O 直视起爆（默认视角正对缺口），峰值 + 渐褪中各探一次 ----
await spawn('kayo')
await page.waitForTimeout(1560) // 引信 1.6s → 起爆后 ~40ms
const white1 = await page.evaluate(() => {
  const f = window.__game.flashes
  const cs = getComputedStyle(f.overlayEl)
  return { o: f.overlayEl.style.opacity, bg: cs.backgroundColor, img: cs.backgroundImage, blind: +f.blindRemaining.toFixed(2) }
})
await page.screenshot({ path: `${outDir}/kayo-white-full.png` })
await page.waitForTimeout(1400)
const white2 = await page.evaluate(() => {
  const f = window.__game.flashes
  const cs = getComputedStyle(f.overlayEl)
  return { o: f.overlayEl.style.opacity, bg: cs.backgroundColor, img: cs.backgroundImage, blind: +f.blindRemaining.toFixed(2) }
})
console.log('white @pop ', JSON.stringify(white1))
console.log('white @fade ', JSON.stringify(white2))
await page.evaluate(() => window.__game.flashes.endRound())
await page.waitForTimeout(2200)

// ---- 2) Breach 竖直光柱：起爆后立即探 _beam + 截图 ----
await spawn('breach')
await page.waitForTimeout(520) // 0.5s 预备 → 起爆后 ~20ms
const beam1 = await page.evaluate(() => {
  const f = window.__game.flashes
  const b = f._beam
  return b ? { visible: b.mesh.visible, scaleY: +b.mesh.scale.y.toFixed(2), op: +b.mesh.material.opacity.toFixed(2), pos: b.mesh.position.toArray().map((v) => +v.toFixed(2)) } : null
})
await page.screenshot({ path: `${outDir}/breach-beam-pop.png` })
await page.waitForTimeout(450)
const beam2 = await page.evaluate(() => {
  const f = window.__game.flashes
  const b = f._beam
  return b ? { visible: b.mesh.visible } : null
})
console.log('beam @pop  ', JSON.stringify(beam1))
console.log('beam @gone  ', JSON.stringify(beam2))
await page.evaluate(() => window.__game.flashes.endRound())
await page.waitForTimeout(2600)

// ---- 3) Reyna Deafened：近视命中时主链闷化、消散后回直通 ----
await spawn('reyna')
await page.waitForTimeout(1750) // 0.55 穿墙 + 0.4 睁眼 + 命中刷新 → 近视满效中
const deaf1 = await page.evaluate(() => {
  const g = window.__game
  return {
    ns: g.flashes.nearsightEl.style.opacity,
    lp: Math.round(g.audio.deafenLP.frequency.value),
    g: +g.audio.deafenG.gain.value.toFixed(2),
  }
})
await page.screenshot({ path: `${outDir}/reyna-nearsight.png` })
await page.waitForTimeout(2100) // 眼消散 + 近视褪去
const deaf2 = await page.evaluate(() => {
  const g = window.__game
  return {
    ns: g.flashes.nearsightEl.style.opacity,
    lp: Math.round(g.audio.deafenLP.frequency.value),
    g: +g.audio.deafenG.gain.value.toFixed(2),
  }
})
console.log('deafen @hit ', JSON.stringify(deaf1))
console.log('deafen @gone ', JSON.stringify(deaf2))
await page.evaluate(() => window.__game.flashes.endRound())
await page.waitForTimeout(800)

// ---- 5) Dizzy 血浆绿紫：等离子满效时探 CSS + 截图 ----
await spawn('gecko')
await page.waitForTimeout(1750) // 0.65 激活 + 0.35 锁定 → 满效中
const plasma = await page.evaluate(() => {
  const f = window.__game.flashes
  const cs = getComputedStyle(f.plasmaEl)
  return { o: f.plasmaEl.style.opacity, green: cs.backgroundImage.includes('108, 236, 158'), purple: cs.backgroundImage.includes('160, 108, 244') }
})
await page.screenshot({ path: `${outDir}/gecko-plasma.png` })
console.log('plasma     ', JSON.stringify(plasma))
await page.evaluate(() => window.__game.flashes.endRound())

console.log('console errors:', errors.length ? errors : 'none')
await browser.close()
