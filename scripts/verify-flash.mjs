// 浏览器实测：闪光系统扩容（第七类）——四类新闪光逐个强制投放，
// 采数值探针（官方模型挂载/起爆/近视/等离子）+ 抓关键时刻截图
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const outDir = process.argv[2] ?? '/tmp/flash-shots'
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
await page.goto(process.env.URL ?? 'http://127.0.0.1:5412/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })
console.log('clicked start')
await page.waitForTimeout(1500)

// 官方模型挂载探针
const official = await page.evaluate(() => {
  const f = window.__game.flashes._models
  return {
    skye: !!f.skye.official, gecko: !!f.gecko.official,
    skyeBones: f.skye.bones ? Object.keys(f.skye.bones).filter(n => /Wing|Tail/.test(n)) : [],
    geckoBones: f.gecko.bones ? Object.keys(f.gecko.bones) : [],
  }
})
console.log('official models:', JSON.stringify(official))

// 逐类强制投放：直接驱动 _spawn*（绕过随机调度），采真实 128Hz 步进的演化
async function probe(type, spawnArg, shots, waitMs) {
  await page.evaluate((t) => {
    const g = window.__game
    g.flashes.setMode(t)
    g.flashes.resetRound(99) // 调度器不出弹（nextAt 拉远），全部手动投放
  }, type)
  await page.evaluate(([t, arg]) => {
    const g = window.__game
    const gap = g.map.gaps[0]
    g.flashes['_spawn' + arg](gap, (gap.x0 + gap.x1) / 2)
    console.log('spawned', g.flashes.proj?.type)
  }, [type, spawnArg])
  for (const [label, ms] of shots) {
    await page.waitForTimeout(ms)
    await page.screenshot({ path: `${outDir}/${type}-${label}.png` })
  }
  const st = await page.evaluate((t) => {
    const f = window.__game.flashes
    return {
      type: t, proj: f.proj?.type ?? null, phase: f.proj?.phase ?? (f.proj?.bounced === undefined ? null : f.proj.bounced),
      blind: +f.blindRemaining.toFixed(2),
      ns: f.nearsightEl.style.opacity, plasma: f.plasmaEl.style.opacity,
      overlay: f.overlayEl.style.opacity,
    }
  }, type)
  console.log(type.padEnd(8), JSON.stringify(st))
  await page.evaluate(() => { window.__game.flashes.endRound() })
  await page.waitForTimeout(waitMs ?? 2600) // 等白屏/近视/等离子退净
}

// Yoru：撞面显形 → 0.6s 预备 → 爆（直视会吃 1.5s 白屏）
await probe('yoru', 'Yoru', [['0-fly', 300], ['1-bounced', 700], ['2-pop', 1400], ['3-fade', 2600]])
// Breach：贴墙 0.5s 预备 → 爆 2.25s
await probe('breach', 'Breach', [['0-mounted', 200], ['1-windup', 450], ['2-pop', 900]])
// Reyna：0.55s 穿墙 → 0.4s 睁眼 → 近视命中（默认视角正对缺口 = 看着瞳孔）
await probe('reyna', 'Reyna', [['0-fly', 250], ['1-open', 800], ['2-nearsight', 1600], ['3-gone', 3300]])
// Gekko：抛掷 → 0.65s 激活悬停 → 锁定 0.35s → 等离子糊屏 2s
await probe('gecko', 'Gecko', [['0-throw', 300], ['1-hover', 900], ['2-plasma', 1600], ['3-fade', 2900]])

// 可击毁探针：reyna 到位后 pickHit 应命中、damage 打空血后 despawn
await page.evaluate(() => {
  const g = window.__game
  const f = g.flashes
  f.setMode('reyna')
  f.resetRound(99)
  const gap = g.map.gaps[0]
  f._spawnReyna(gap, (gap.x0 + gap.x1) / 2)
  const p = f.proj
  for (let i = 0; i < 80 && f.proj && f.proj.phase !== 'active'; i++) f._stepReyna(p, 0.016) // 步进推进到 active
})
await page.waitForTimeout(120)
const destr = await page.evaluate(() => {
  const g = window.__game
  const f = g.flashes
  const eye = { x: g.player.pos.x, y: g.player.pos.y + g.player.eyeHeight, z: g.player.pos.z }
  const tp = f.proj.pos
  const dv = { x: tp.x - eye.x, y: tp.y - eye.y, z: tp.z - eye.z }
  const dl = Math.hypot(dv.x, dv.y, dv.z)
  const fw = { x: dv.x / dl, y: dv.y / dl, z: dv.z / dl } // 瞄准眼心（部署点有随机偏移）
  const hit = f.pickHit(eye, fw, 250)
  const hp0 = f.proj?.hp
  if (hit) f.damage(40)
  const hp1 = f.proj?.hp
  if (hit) f.damage(40)
  return { phase: f.proj?.phase, hitT: hit ? +hit.t.toFixed(2) : null, hp0, hp1, despawned: !f.proj, projType: f.proj?.type ?? null }
})
console.log('destructible:', JSON.stringify(destr))
await page.evaluate(() => window.__game.flashes.endRound())

// 官方模型可视性：skye/gecko 各强制投放 + 缺口区域放大截图
for (const type of ['skye', 'gecko']) {
  await page.evaluate((t) => {
    const g = window.__game
    g.flashes.setMode(t)
    g.flashes.resetRound(99)
    const gap = g.map.gaps[0]
    g.flashes['_spawn' + t[0].toUpperCase() + t.slice(1)](gap, (gap.x0 + gap.x1) / 2)
  }, type)
  await page.waitForTimeout(550)
  await page.screenshot({ path: `${outDir}/${type}-model-wide.png` })
  await page.screenshot({ path: `${outDir}/${type}-model-zoom.png`, clip: { x: 500, y: 260, width: 520, height: 340 } })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${outDir}/${type}-model-late.png`, clip: { x: 500, y: 260, width: 520, height: 340 } })
  await page.evaluate(() => window.__game.flashes.endRound())
  await page.waitForTimeout(1500)
}

console.log('console errors:', errors.length ? errors : 'none')
await browser.close()
