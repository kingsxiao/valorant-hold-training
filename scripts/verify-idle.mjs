// 浏览器实测：站定官方 idle 动画在播（kamae 是 1.9~18s 官方循环，非静帧）+
// 站定枪口钉玩家 + 急停收腿权重时间常数。探针：
//  1) pull 波 hold 站定：脊柱局部四元数持续变化（官方 idle 活着）且无单向
//     漂移棘轮（有去有回）；挂枪方向漂移小（站定 k=1 钉玩家眼位）
//  2) out→hold 停步 _strafeW 时间线：~105ms 线性收敛（急停收腿一次并步，
//     纯速度映射下 30ms 内归零 = 腿瞬移）
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const outDir = process.argv[2] ?? '/tmp/idle-sway-shots'
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()) })
await page.goto('http://127.0.0.1:5213/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })
console.log('clicked start')

// ---- 探针 1+2：等一个 pull-out bot，在 out 阶段就钉住（拦判负+延 hold），
// 站定后 4s 采样脊柱/盆骨/挂枪（判负线 450ms 比轮询快，事后钉会错过）----
const sway = await page.evaluate(async () => {
  const all = () => (window.__game?.bots?.bots ?? window.__game?.bots ?? [])
  let b = null
  for (let i = 0; i < 160 && !b; i++) {
    b = all().find(x => x.active && x.mixer && x.peek?.style === 'pull' && x.peek?.phase === 'out')
    if (!b) await new Promise(r => setTimeout(r, 250))
  }
  if (!b) return { err: 'no pull-out mixer bot in 40s' }
  b.peek.jiggleAt = 0 // 拉到 holdX 正常停（不折返）
  b.peek.resolved = true // 拦判负（否则站定 450ms 后开火撤离）
  b.peek.holdUntil = b.manager.now() + 30
  for (let i = 0; i < 400 && b.peek?.phase !== 'hold'; i++) {
    await new Promise(r => setTimeout(r, 25))
  }
  if (b.peek?.phase !== 'hold') return { err: 'never reached hold' }
  b.peek.holdUntil = b.manager.now() + 30 // 进 hold 后重钉：out→hold 转换会把
  // holdUntil 重写为 now+pullHoldMaxMs(2.4s)，out 阶段的钉桩会被冲掉
  await new Promise(r => setTimeout(r, 2500)) // 等枪线/侧倾收敛
  const ex = b._rigExtra
  if (!ex?.spine?.length) return { err: 'no spine rig', hero: true }
  const spineN = ex.spine.length
  const spine0 = ex.spine[Math.floor(ex.spine.length / 2)]
  const q0 = spine0.quaternion.clone()
  const hips0 = b._strafeRig?.hips.position.y // 官方 idle 的盆骨 Y 起伏幅度
  const gunQ0 = b.gun ? b.gun.holder.quaternion.clone() : null
  const aimQ0 = b.gun ? b.gun.aimQ.clone() : null
  const meshQ0 = b.mesh.quaternion.clone()
  const ang = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w))) * 180/Math.PI
  const samples = []
  const t0 = performance.now()
  for (let i = 0; i <= 40; i++) {
    samples.push({
      t: +((performance.now() - t0) / 1000).toFixed(3),
      spineDeg: +(THREE_RAW_ANGLE(spine0.quaternion, q0) * 180 / Math.PI).toFixed(4),
      hipsDy: +((b._strafeRig?.hips.position.y ?? 0) - hips0).toFixed(5),
      gunDeg: gunQ0 ? +(THREE_RAW_ANGLE(b.gun.holder.quaternion, gunQ0) * 180 / Math.PI).toFixed(4) : null,
      aimDrift: aimQ0 ? +ang(b.gun.aimQ, aimQ0).toFixed(3) : null,
      meshDrift: +ang(b.mesh.quaternion, meshQ0).toFixed(3),
      phase: b.peek?.phase,
      holdUntil: b.peek ? +b.peek.holdUntil.toFixed(1) : null,
      gameT: +b.manager.t.toFixed(1),
      active: b.active,
    })
    await new Promise(r => setTimeout(r, 100))
  }
  function THREE_RAW_ANGLE(a, b) { // 四元数夹角（页面内不引 three，直接算）
    const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
    return 2 * Math.acos(Math.min(1, d))
  }
  const deg = samples.map(s => s.spineDeg)
  // 释放钉住的 bot（占着槽位不放，后续波次不出、settle 探针没得测）
  if (b.peek) b.peek.holdUntil = 0
  return {
    spineN,
    samples,
    spineAmpDeg: [Math.min(...deg), Math.max(...deg)],
    spineRangeDeg: +(Math.max(...deg) - Math.min(...deg)).toFixed(4),
    hipsDyRange: +(Math.max(...samples.map(s => s.hipsDy)) - Math.min(...samples.map(s => s.hipsDy))).toFixed(5),
    gunRangeDeg: gunQ0 ? +(Math.max(...samples.map(s => s.gunDeg)) - Math.min(...samples.map(s => s.gunDeg))).toFixed(4) : null,
  }
})
console.log('SWAY', JSON.stringify(sway, null, 1))

// 站定瞄准两张截图（隔 ~1.7s，微动应让姿势略不同）
for (const tag of ['a', 'b']) {
  const holding = await page.evaluate(() => {
    const all = window.__game?.bots?.bots ?? window.__game?.bots ?? []
    return all.some(x => x.active && x.peek?.phase === 'hold')
  })
  if (holding) await page.screenshot({ path: `${outDir}/hold-${tag}.png` })
  await page.waitForTimeout(1700)
}

// ---- 探针 3：等下一个 pull 的 out→hold 转换，记录 _moveW 时间线 ----
const settle = await page.evaluate(async () => {
  const all = () => (window.__game?.bots?.bots ?? window.__game?.bots ?? [])
  let b = null
  for (let i = 0; i < 160; i++) { // 等 pull-out bot，最多 40s
    b = all().find(x => x.active && x.mixer && x.peek?.style === 'pull' && x.peek?.phase === 'out')
    if (b) break
    await new Promise(r => setTimeout(r, 250))
  }
  if (!b) return { err: 'no pull bot in 40s' }
  b.peek.resolved = true // 钉住：停步后不开火不撤离，采完 350ms 时间线
  // 16ms 轮询直到停住（phase 变 hold 或速度 < 0.05），随后 350ms 记录 _moveW/腿角
  let stopAt = -1
  for (let i = 0; i < 4000; i++) {
    if (!b.active) return { err: 'bot died mid-pull' }
    if (Math.abs(b.velX) < 0.05) { stopAt = performance.now(); break }
    await new Promise(r => setTimeout(r, 8))
  }
  if (stopAt < 0) return { err: 'never stopped' }
  const thigh = b._strafeRig?.legs[0]?.up
  const SNAP0 = thigh ? thigh.quaternion.clone() : null
  const tl = []
  for (let i = 0; i < 24; i++) {
    tl.push({
      ms: Math.round(performance.now() - stopAt),
      moveW: +(b._moveW ?? 0).toFixed(3),
      strafeW: +(b._strafeW ?? 0).toFixed(3),
      velX: +b.velX.toFixed(2),
      phase: b.peek?.phase,
      thighDeg: SNAP0 ? +(thigh.quaternion.angleTo(SNAP0) * 180 / Math.PI).toFixed(2) : null,
    })
    await new Promise(r => setTimeout(r, 16))
  }
  return { tl }
})
console.log('SETTLE', JSON.stringify(settle, null, 1))

await browser.close()
console.log('DONE')
