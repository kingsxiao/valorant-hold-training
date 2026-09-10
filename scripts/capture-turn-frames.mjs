// Turn E/W 旋向比对材料捕获：确定性输出 E/W 转身 25%/50%/75% 三档中段帧
// （docs/turn-frames/{E,W}-{1,2,3}.png），供与本体录像对照判定踏步旋向。
// 姿态完全确定：直接设 mesh yaw 与 turn action 播放头到对应比例，不走实时 lerp。
// 用法：node scripts/capture-turn-frames.mjs [outDir=docs/turn-frames]
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const outDir = process.argv[2] ?? 'docs/turn-frames'
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })
await page.waitForTimeout(1500)

const PROGRESS = [
  { k: 1, ticks: 10 },
  { k: 2, ticks: 20 },
  { k: 3, ticks: 30 },
]
for (const side of ['E', 'W']) {
  // W=左转（+90°，startYaw −π/2 → 0）；E=右转（−90°，startYaw +π/4·2=π/2 → 0）
  const startYaw = side === 'E' ? Math.PI / 2 : -Math.PI / 2
  for (const { k, ticks } of PROGRESS) {
    await page.evaluate(async ({ side, startYaw, ticks }) => {
      const g = window.__game
      let b = null
      for (let i = 0; i < 300 && !b; i++) {
        b = (g?.bots?.bots ?? []).find(x => x._officialLo)
        if (!b) await new Promise(r => setTimeout(r, 200))
      }
      window.__tb = b
      g.bots.roundEndAt = 0
      g.bots.countdownUntil = 0
      const dt = 1 / 128
      // 目标朝向 = 面向玩家（玩家在 bot -Z 侧 → targetYaw 0）
      b.place(g.player.pos.x, g.player.pos.z - 2.5, 'peek')
      b.peek = { style: 'pull', dir: 1, phase: 'hold', startX: g.player.pos.x, holdX: g.player.pos.x,
        endX: g.player.pos.x, stopAt: 1, stopped: false, stopUntil: b.manager.now() + 999,
        holdUntil: 1e9, resolved: true, jiggleAt: 0, crouchWalk: false }
      b.velX = 0
      b._crouchPlanned = false
      b._turnKey = null
      b._turnW = 0
      b.mesh.rotation.y = startYaw
      // 自然演化 ticks：yaw lerp + 转身 clip 同步推进（与真实玩法同路径）
      for (let i = 0; i < ticks; i++) { b.manager.t += dt; g.bots.step(dt, 1) }
      b.mesh.updateMatrixWorld(true)
    }, { side, startYaw, ticks })
    await page.screenshot({ path: `${outDir}/${side}-${k}.png` })
    console.log(`saved ${outDir}/${side}-${k}.png (natural ${ticks} ticks)`)
  }
}
await browser.close()
console.log('DONE — 与本体录像对照：E 帧应读作「右转踏步」（从右肩位转入面向），W 帧镜像')
