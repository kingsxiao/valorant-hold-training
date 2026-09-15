// 朝向偏差探针：自然波次跑 N 秒，逐 tick 量每只活跃 bot：
//  1) 身体 yaw 误差 = faceTargetYaw(玩家) − mesh.rotation.y（最短角，度）
//  2) 枪口指向误差 = 枪前向（holder 世界系 -Z）与「枪→玩家眼」方向的夹角（度）
//  3) 距离/速度/风格/相位 —— 按 (风格, 相位, 速度段) 聚合出均值/绝对均值/p95
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'

const RUN_SECONDS = 40
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

const setup = await page.evaluate(async () => {
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
  return { pool: last }
})
console.log('pool:', JSON.stringify(setup))

await page.evaluate(() => {
  const g = window.__game
  window.__probe = { rows: [], t0: performance.now() }
  const origStep = g.bots.step.bind(g.bots)
  const yawTo = (dx, dz) => Math.atan2(dx, dz) // GLB 正面 +Z
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
  g.bots.step = (dt, alpha) => {
    origStep(dt, alpha)
    const p = g.player
    for (const b of g.bots.bots) {
      if (!b._officialLo || !b.active || b.mode !== 'peek') continue
      const dx = p.pos.x - b.pos.x, dz = p.pos.z - b.pos.z
      const dist = Math.hypot(dx, dz)
      const yawErr = wrap(yawTo(dx, dz) - b.mesh.rotation.y) * 180 / Math.PI
      let gunErr = null
      if (b.gun && !b._drop) {
        // 枪指向：holder.matrixWorld（上一渲染帧，统计口径足够）。前向 = 世界
        // 系 -Z 基向量；原点 = 平移列
        const e = b.gun.holder.matrixWorld.elements
        const fx = -e[8], fy = -e[9], fz = -e[10]
        const ox = e[12], oy = e[13], oz = e[14]
        let tx = p.pos.x - ox, ty = p.pos.y + p.eyeHeight - oy, tz = p.pos.z - oz
        const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl
        gunErr = Math.acos(Math.max(-1, Math.min(1, fx * tx + fy * ty + fz * tz))) * 180 / Math.PI
      }
      window.__probe.rows.push({
        t: +(performance.now() - window.__probe.t0).toFixed(0),
        hero: b.anim.walk.getClip().name.split('-')[0],
        style: b.peek?.style ?? '-', phase: b.peek?.phase ?? '-',
        dist: +dist.toFixed(2), speed: +Math.hypot(b.velX, b.velZ).toFixed(2),
        yawErr: +yawErr.toFixed(2), gunErr: gunErr === null ? null : +gunErr.toFixed(2),
      })
    }
  }
})
await page.waitForTimeout(RUN_SECONDS * 1000)
const rows = await page.evaluate(() => window.__probe.rows)
await browser.close()

// 聚合
const agg = new Map()
for (const r of rows) {
  const v = Math.abs(r.speed) > 3.8 ? 'run' : Math.abs(r.speed) > 0.6 ? 'slow' : 'stand'
  const k = `${r.style}/${r.phase}/${v}`
  const a = agg.get(k) ?? { n: 0, sum: 0, absSum: 0, absMax: 0, gSum: 0, gAbsSum: 0, gAbsMax: 0, gN: 0, distSum: 0, sgn: 0 }
  a.n++; a.sum += r.yawErr; a.absSum += Math.abs(r.yawErr)
  a.absMax = Math.max(a.absMax, Math.abs(r.yawErr))
  a.distSum += r.dist
  a.sgn += Math.sign(r.yawErr)
  if (r.gunErr !== null) { a.gN++; a.gSum += r.gunErr; a.gAbsSum += r.gunErr; a.gAbsMax = Math.max(a.gAbsMax, r.gunErr) }
  agg.set(k, a)
}
console.log(`rows: ${rows.length}`)
console.log('key | n | dist | yawErr mean | |yawErr| mean/max | sign bias | gunErr mean/max')
for (const [k, a] of [...agg.entries()].sort()) {
  console.log(`${k} | ${a.n} | ${(a.distSum / a.n).toFixed(1)}m | ${(a.sum / a.n).toFixed(2)}° | ${(a.absSum / a.n).toFixed(2)}°/${a.absMax.toFixed(2)}° | ${(a.sgn / a.n).toFixed(2)} | ${a.gN ? (a.gSum / a.gN).toFixed(2) + '°/' + a.gAbsMax.toFixed(2) + '°' : '-'}`)
}
// 稳态分布（speed>3.8 的 out 相）：yawErr 直方
const steady = rows.filter(r => r.speed > 3.8 && r.phase === 'out')
const hist = new Map()
for (const r of steady) {
  const b = Math.round(r.yawErr)
  hist.set(b, (hist.get(b) ?? 0) + 1)
}
console.log('steady out yawErr histogram (deg → count):')
for (const [deg, n] of [...hist.entries()].sort((a, b) => a[0] - b[0])) console.log(`  ${deg}°: ${'#'.repeat(Math.min(60, n))} ${n}`)
