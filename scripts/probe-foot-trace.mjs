// 脚钉地逐 tick 追踪：横移跑一整周期，记录每脚的「混合锚 z（psa 系）」与
// 「踝世界高」——定位 R 脚不落地的断点（侧别映射 / IK 越距 / 相位）
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
  for (const s of g.bots.hold?.slots ?? []) { s.bot = null; s.nextAt = 1e12 }
  g.bots.onMapRebuilt = () => {}
})
const rows = await page.evaluate(() => {
  const g = window.__game
  const b = g.bots.bots.find(x => x._officialLo)
  const dt = 1 / 128
  b.place(g.player.pos.x - 0.6, g.player.pos.z - 1.9, 'peek')
  b.peek = { style: 'pull', dir: 1, phase: 'out', startX: b.pos.x, turnX: b.pos.x + 8,
    endX: b.pos.x, jiggleAt: 0, crouchWalk: false }
  b.velX = 5.4
  const out = []
  const trace = (tag) => {
    b.mesh.updateMatrixWorld(true)
    for (const leg of b._strafeRig.legs) {
      const st = leg.foot.userData._pin
      if (!st) continue
      leg.foot.updateWorldMatrix(true, false)
      const e = leg.foot.matrixWorld.elements
      // 世界锚 → 逆 mesh 变换回 psa 系 z（只看高度分量即可：世界 y − mesh.y）
      out.push({ tag, side: leg.side, ph: +(b.walkPhase % (2 * Math.PI)).toFixed(2),
        ankleY: +e[13].toFixed(3), pinW: +(st.w ?? 0).toFixed(2),
        anchorY: +(st.anchor.y - b.mesh.position.y).toFixed(3) })
    }
  }
  for (let i = 0; i < 220; i++) {
    g.bots.step(dt, 1)
    if (i >= 60 && i % 2 === 0) trace(i)
  }
  return out
})
await browser.close()
// 按 walkPhase 折叠成周期表：相位 0..2π 分 24 桶
const buckets = new Map()
for (const r of rows) {
  const k = Math.round(r.ph / (Math.PI * 2) * 24) % 24
  const kk = `${k}|${r.side}`
  const a = buckets.get(kk) ?? { n: 0, ay: 0, an: 0, w: 0 }
  a.n++; a.ay += r.ankleY; a.an += r.anchorY; a.w += r.pinW
  buckets.set(kk, a)
}
console.log('phaseBin | side | n | ankleY | anchorY(ps z) | pinW')
for (const side of ['L', 'R']) {
  const line = []
  for (let k = 0; k < 24; k++) {
    const a = buckets.get(`${k}|${side}`)
    line.push(a ? `${(a.ay / a.n).toFixed(2)}/${(a.an / a.n).toFixed(2)}` : '--')
  }
  console.log(side, 'ankleY/anchorZ @phase0..23:', line.join(' '))
}
const lows = rows.filter(r => r.ankleY < 0.16)
console.log(`ankle<0.16 samples: L=${lows.filter(r=>r.side==='L').length} R=${lows.filter(r=>r.side==='R').length} of ${rows.length / 2} each`)
