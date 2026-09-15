// 腿部动作评审：接管一只官方 bot，玩家正前 2.8m 横移跑（5.4m/s），一个步态
// 周期定格 6 相位连拍 + 量测盆骨世界侧倾（含/不含 mesh.rotation.z 双重侧倾对照）。
// 用法：node scripts/capture-strafe-lean.mjs [outDir=/tmp/strafe-lean] [mode=both|lean|nolean]
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const outDir = process.argv[2] ?? '/tmp/strafe-lean'
const mode = process.argv[3] ?? 'both'
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
  // 接管调度（并行会话/memory 教训：否则波次/地图重建会换掉驱动对象）
  for (const s of g.bots.hold?.slots ?? []) { s.bot = null; s.nextAt = 1e12 }
  g.bots.onMapRebuilt = () => {}
  return { pool: last }
})
console.log('pool:', JSON.stringify(setup))

async function driveAndShoot(tag, neutralLean) {
  for (let shot = 0; shot < 6; shot++) {
    await page.evaluate(async ({ shot, neutralLean }) => {
      const g = window.__game
      // 每次从头驱动：同一只 bot、同一相位基准（帧间可比）
      const b = window.__tb ??= g.bots.bots.find(x => x._officialLo)
      const dt = 1 / 128
      b.place(g.player.pos.x - 1.0, g.player.pos.z - 2.8, 'peek')
      b.peek = { style: 'pull', dir: 1, phase: 'out', startX: b.pos.x, turnX: b.pos.x + 8,
        endX: b.pos.x, jiggleAt: 0, crouchWalk: false }
      b.velX = 5.4
      if (neutralLean) {
        // 屏蔽 mesh 级侧倾：每步后强制归零（对照「纯官方 clip 侧倾」）
        const orig = g.bots.step.bind(g.bots)
        g.bots.step = (dt2, a) => { orig(dt2, a); b.mesh.rotation.z = 0 }
        window.__restore = () => { g.bots.step = orig }
      }
      const ticks = 60 + Math.round((shot / 6) * 0.6 / dt) // 0.6s = runE 整周期
      for (let i = 0; i < ticks; i++) g.bots.step(dt, 1)
      window.__restore?.()
      b.mesh.updateMatrixWorld(true)
      // 量测：盆骨世界侧倾（up 向量与世界 Y 的 X 分量）+ mesh 侧倾
      const pelvis = b._strafeRig.hips
      pelvis.updateWorldMatrix(true, false)
      const e = pelvis.matrixWorld.elements
      // 盆骨局部 up ≈ 世界矩阵作用后的 (0,1,0)：取矩阵第二列
      const upx = e[0 * 4 + 1], upy = e[1 * 4 + 1], upz = e[2 * 4 + 1]
      window.__m = {
        phase: shot, meshRollDeg: +(b.mesh.rotation.z * 180 / Math.PI).toFixed(1),
        pelvisRollDeg: +(Math.atan2(upx, upy) * 180 / Math.PI).toFixed(1),
        strafeSide: b._strafeSide, strafeW: +((b._strafeW ?? 0).toFixed(2)),
        runW: +((b._runW ?? 0).toFixed(2)),
        hero: b.anim.walk.getClip().name.split('-')[0],
        kneeL: +(Math.acos(Math.max(-1, Math.min(1, e[5] /*占位*/))) * 0).toFixed(0),
      }
    }, { shot, neutralLean })
    const m = await page.evaluate(() => window.__m)
    await page.screenshot({ path: `${outDir}/${tag}-${shot}.png` })
    console.log(JSON.stringify(m))
  }
}

if (mode === 'both' || mode === 'lean') await driveAndShoot('lean', false)
if (mode === 'both' || mode === 'nolean') await driveAndShoot('nolean', true)
await browser.close()
console.log('DONE →', outDir)
