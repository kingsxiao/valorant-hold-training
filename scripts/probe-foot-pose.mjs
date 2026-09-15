// 脚部朝向探针：接管一只官方 bot 横移跑（5.4m/s），跨一个步态周期采样：
//  1) 脚骨世界朝向：脚尖向量（脚骨局部 -Z 或最长轴）在水平面的 yaw，与身体
//     yaw（面向玩家）差 = 脚歪角度；pitch = 脚尖上翘/下扣
//  2) 对照「clip 快照姿态」（IK 前）同一时刻的脚朝向 —— 量化钉地 IK 把脚带歪
//     了多少
// 3) 支撑/摆动分期（锚世界高度）分别统计
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
  for (const s of g.bots.hold?.slots ?? []) { s.bot = null; s.nextAt = 1e12 }
  g.bots.onMapRebuilt = () => {}
  return { pool: last }
})
console.log('pool:', JSON.stringify(setup))

const rows = await page.evaluate(() => {
  const g = window.__game
  const b = g.bots.bots.find(x => x._officialLo)
  const dt = 1 / 128
  window.__tb = b
  const out = []
  // UE 脚骨局部轴约定未知 —— 三根候选轴都量（脚骨局部 ±X/±Z），事后挑「站定
  // kamae 时最接近水平指前」的那根作为脚尖轴读数
  const axes = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  const yawOf = (v) => Math.atan2(v.x, v.z) // 与身体 yaw 同约定（front=+Z）
  const pitchOf = (v) => Math.asin(Math.max(-1, Math.min(1, v.y / Math.hypot(v.x, v.y, v.z))))
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
  for (let k = 0; k < 64; k++) {
    b.place(g.player.pos.x - 1.0, g.player.pos.z - 2.8, 'peek')
    b.peek = { style: 'pull', dir: 1, phase: 'out', startX: b.pos.x, turnX: b.pos.x + 8,
      endX: b.pos.x, jiggleAt: 0, crouchWalk: false }
    b.velX = 5.4
    const ticks = 60 + Math.round((k / 64) * 0.6 / dt)
    for (let i = 0; i < ticks; i++) g.bots.step(dt, 1)
    b.mesh.updateMatrixWorld(true)
    const bodyYaw = b.mesh.rotation.y
    for (const leg of b._strafeRig.legs) {
      const foot = leg.foot
      foot.updateWorldMatrix(true, false)
      const e = foot.matrixWorld.elements
      const worldDir = (ax) => ({
        x: e[0] * ax[0] + e[4] * ax[1] + e[8] * ax[2],
        y: e[1] * ax[0] + e[5] * ax[1] + e[9] * ax[2],
        z: e[2] * ax[0] + e[6] * ax[1] + e[10] * ax[2],
      })
      // IK 后（当前）与 IK 前（快照还原）对比：快照恢复 = 髋/膝/脚全部 copy _clipQ
      const rec = { k, side: leg.side, stance: null, cur: [], clip: [] }
      const st = foot.userData._pin
      rec.stance = st && st.w > 0.5 ? (e[13] < 0.16 ? 'stance' : 'swing') : 'kamae'
      for (const ax of axes) {
        const w = worldDir(ax)
        rec.cur.push([wrap(yawOf(w) - bodyYaw) * 180 / Math.PI, pitchOf(w) * 180 / Math.PI])
      }
      // clip 前：从快照还原三骨再量（只读运算，量完 IK 后的值已存）
      const qUp = leg.up.quaternion.clone(), qKn = leg.knee.quaternion.clone(), qFt = leg.foot.quaternion.clone()
      leg.up.quaternion.copy(leg.up.userData._clipQ)
      leg.knee.quaternion.copy(leg.knee.userData._clipQ)
      leg.foot.quaternion.copy(leg.foot.userData._clipQ)
      foot.updateWorldMatrix(true, false)
      const e2 = foot.matrixWorld.elements
      const worldDir2 = (ax) => ({
        x: e2[0] * ax[0] + e2[4] * ax[1] + e2[8] * ax[2],
        y: e2[1] * ax[0] + e2[5] * ax[1] + e2[9] * ax[2],
        z: e2[2] * ax[0] + e2[6] * ax[1] + e2[10] * ax[2],
      })
      for (const ax of axes) {
        const w = worldDir2(ax)
        rec.clip.push([wrap(yawOf(w) - bodyYaw) * 180 / Math.PI, pitchOf(w) * 180 / Math.PI])
      }
      leg.up.quaternion.copy(qUp); leg.knee.quaternion.copy(qKn); leg.foot.quaternion.copy(qFt)
      out.push(rec)
    }
  }
  return out
})
await browser.close()

// 汇总：各候选轴在支撑期的 |yaw 偏差|（IK 后 vs IK 前）——挑出「IK 前最合理」
// 的轴看 IK 把它带歪多少
const names = ['+X', '-X', '+Z', '-Z']
const aggCur = [0, 0, 0, 0], aggClip = [0, 0, 0, 0], n = [0, 0, 0, 0]
for (const r of rows) {
  if (r.stance !== 'stance' && r.stance !== 'swing') continue
  for (let i = 0; i < 4; i++) {
    aggCur[i] += Math.abs(r.cur[i][0]); aggClip[i] += Math.abs(r.clip[i][0]); n[i]++
  }
}
console.log('axis | n | |yawOff| IK后 | IK前 | (pitch IK后均值)')
for (let i = 0; i < 4; i++) {
  if (!n[i]) continue
  let ps = 0
  for (const r of rows) if (r.stance === 'stance' || r.stance === 'swing') ps += r.cur[i][1]
  console.log(`${names[i]} | ${n[i]} | ${(aggCur[i] / n[i]).toFixed(1)}° | ${(aggClip[i] / n[i]).toFixed(1)}° | ${(ps / n[i]).toFixed(1)}°`)
}
// 逐帧明细（前 12 条）
console.log('sample rows (k, side, stance, cur[axis].yaw/pitch …):')
for (const r of rows.slice(0, 12)) console.log(JSON.stringify(r))
