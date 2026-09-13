// 腿部动作全景检查 v2：清场（隐藏其他 bot、停调度）+ 手动驱动（moveToward）
// 各状态固定相位步进连拍 + 逐帧遥测。产出 docs/leg-frames/<state>-N.png + telemetry.json。
// 用法：node scripts/inspect-legs.mjs [outDir=docs/leg-frames]
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const outDir = process.argv[2] ?? 'docs/leg-frames'
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
await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })
await page.waitForTimeout(1200)

const SPECS = [
  { tag: 'runN', style: 'cross', vx: 5.4, shots: 12, warm: 1.2 },
  { tag: 'walkN', style: 'cross', vx: 3.0, shots: 12, warm: 1.2 },
  { tag: 'runE', style: 'pull', vx: 5.4, shots: 12, warm: 1.2 },
  { tag: 'runW', style: 'pull', vx: -5.4, shots: 12, warm: 1.2 },
  { tag: 'stop90', style: 'cross', vx: 5.4, shots: 12, warm: 1.2, turn: 1.5708 },
  { tag: 'brace', style: 'cross', vx: 5.4, shots: 8, warm: 1.2, turn: 0.1 },
  { tag: 'crouchIdle', style: 'pull', vx: 0, shots: 4, warm: 1.8, crouch: true },
  { tag: 'crouchWalkE', style: 'pull', vx: 2.7, shots: 10, warm: 1.2, crouchWalk: true },
  { tag: 'jump', style: 'cross', vx: 3.0, shots: 12, warm: 0.8, jump: true },
]

// 初始化：清场 + 取官方 bot
const init = await page.evaluate(async () => {
  const g = window.__game
  let b = null
  for (let i = 0; i < 400 && !b; i++) {
    b = (g?.bots?.bots ?? []).find(x => x._officialLo)
    if (!b) await new Promise(r => setTimeout(r, 200))
  }
  if (!b) return { err: 'no official bot' }
  window.__tb = b
  g.bots.roundEndAt = 0
  g.bots.countdownUntil = 0
  // 停调度 + 藏掉所有其他 bot（清场，只留被测 bot）
  if (g.bots.hold) for (const s of g.bots.hold.slots) { s.nextAt = 1e18; if (s.bot && s.bot !== b) s.bot.hide() ; s.bot = null }
  for (const x of g.bots.bots) { if (x !== b && x.active) x.hide() }
  return { ok: true }
})
if (init.err) { console.log(init.err); process.exit(1) }

const setup = (sp) => page.evaluate((sp) => {
  const g = window.__game
  const b = window.__tb
  const dt = 1 / 128
  const px = g.player.pos.x, pz = g.player.pos.z
  const dir = Math.sign(sp.vx) || 1
  const startX = px - dir * 7
  b.place(startX, pz - 5.5, 'peek')
  b.peek = { style: sp.style, dir, phase: 'out', startX,
    endX: startX + dir * 80, stopAt: 1, stopped: false, stopUntil: 0,
    holdX: startX, resolved: true, jiggleAt: 0, crouchWalk: !!sp.crouchWalk, jumpPlanned: false, jumped: false }
  window.__drive = { vx: sp.vx, warm: sp.warm, turn: sp.turn ?? 0, crouch: !!sp.crouch, jump: !!sp.jump }
  // warm：手动驱动到稳态（moveToward 真实加速/摩擦）
  const ticks = Math.round(sp.warm / dt)
  for (let i = 0; i < ticks; i++) {
    if (sp.crouch) { b.peek.stopUntil = 1e9; b._crouchPlanned = true; b.moveToward(0, dt) }
    else b.moveToward(sp.vx, dt)
    g.bots.step(dt, 1)
  }
  if (sp.jump) { b.startJump() }
  // turn：急停 + 朝向差（触发转身踏步/支架）
  if (sp.turn !== undefined && sp.turn !== null && !sp.jump) {
    for (let i = 0; i < Math.round(0.25 / dt); i++) { b.moveToward(0, dt); g.bots.step(dt, 1) }
    b.mesh.rotation.y -= sp.turn // 人为制造朝向差
    b.peek.stopUntil = 1e9
    b._crouchPlanned = false
  }
  window.__rows = []
  return { ok: true }
}, sp)

const step = (tag) => page.evaluate((tag) => {
  const g = window.__game
  const b = window.__tb
  const d = window.__drive
  const dt = 1 / 128
  for (let i = 0; i < 8; i++) {
    if (d.turn && d.turn > 0.2) b.moveToward(0, dt)
    else if (d.crouch) b.moveToward(0, dt)
    else b.moveToward(d.vx, dt)
    g.bots.step(dt, 1)
  }
  b.mesh.updateMatrixWorld(true)
  const row = { tag, ph: +b.walkPhase.toFixed(2), v: +Math.abs(b.velX).toFixed(2), meshY: +b.mesh.position.y.toFixed(3) }
  const rig = b._strafeRig
  if (rig) {
    rig.hips.updateWorldMatrix(true, false)
    row.hipsY = +rig.hips.matrixWorld.elements[13].toFixed(3)
    for (const leg of rig.legs) {
      leg.foot.updateWorldMatrix(true, false)
      leg.knee.updateWorldMatrix(true, false)
      const fe = leg.foot.matrixWorld.elements
      const ke = leg.knee.matrixWorld.elements
      row['y' + leg.side] = +fe[13].toFixed(3)
      row['x' + leg.side] = +fe[12].toFixed(3)
      row['kneeY' + leg.side] = +ke[13].toFixed(3)
      const st = leg.foot.userData._pin
      row['w' + leg.side] = +(st?.w ?? 0).toFixed(2)
    }
  }
  row.runW = +b.anim.run.getEffectiveWeight().toFixed(2)
  row.walkW = +b.anim.walk.getEffectiveWeight().toFixed(2)
  row.strafeW = +(b._strafeW ?? 0).toFixed(2)
  row.cwW = +(b._crouchWW ?? 0).toFixed(2)
  row.turnW = +(b._turnW ?? 0).toFixed(2)
  row.braceW = +(b._braceW ?? 0).toFixed(2)
  row.jumpW = +(b._jumpW ?? 0).toFixed(2)
  window.__rows.push(row)
  return row
}, tag)

const report = {}
for (const sp of SPECS) {
  await setup(sp)
  const rows = []
  for (let shot = 1; shot <= sp.shots; shot++) {
    rows.push(await step(sp.tag))
    await page.screenshot({ path: `${outDir}/${sp.tag}-${shot}.png` })
  }
  report[sp.tag] = rows
  console.log(`saved ${sp.tag} (${sp.shots} shots)`)
}
fs.writeFileSync(`${outDir}/telemetry.json`, JSON.stringify(report, null, 1))
await browser.close()
console.log('DONE')
