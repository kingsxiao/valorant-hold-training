// 蹲走速度档位 A/B 对照帧捕获：1.76m/s（clip 天然速率，近零滑步）vs
// 2.7m/s（本体 50% 跑速口径，步频 1.53×）。每档贴近镜头 4 帧连拍入
// docs/crouch-frames/{slow,fast}-N.png，供真人回填速度档位观感。
// 用法：node scripts/capture-crouch-frames.mjs [outDir=docs/crouch-frames]
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const outDir = process.argv[2] ?? 'docs/crouch-frames'
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

for (const [tag, speed] of [['slow', 1.76], ['fast', 2.7]]) {
  for (let shot = 1; shot <= 4; shot++) {
    await page.evaluate(async ({ speed, shot }) => {
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
      // bot 摆到玩家正前 2.5m（相机平视位）
      b.place(g.player.pos.x, g.player.pos.z - 2.5, 'peek')
      g.bots.params.crouchWalkSpeed = speed
      b.peek = { style: 'pull', dir: 1, phase: 'out', startX: g.player.pos.x, holdX: g.player.pos.x,
        endX: g.player.pos.x, stopAt: 1, stopped: false, stopUntil: 0, holdUntil: 1e9,
        resolved: true, jiggleAt: 0, crouchWalk: true, jumpPlanned: false, jumped: false }
      b.velX = speed
      // 热身到蹲走稳态（权重 1、相位锁定），再推进到本帧采样点
      const phaseTicks = Math.round((shot - 1) * 0.9333 / 4 / dt) // 每帧间隔 1/4 循环
      const total = 60 + phaseTicks
      for (let i = 0; i < total; i++) { b.manager.t += dt; g.bots.step(dt, 1) }
      b.mesh.updateMatrixWorld(true)
    }, { speed, shot })
    await page.screenshot({ path: `${outDir}/${tag}-${shot}.png` })
    console.log(`saved ${outDir}/${tag}-${shot}.png`)
  }
}
await browser.close()
console.log('DONE — slow=1.76m/s（clip 天然速率）/ fast=2.7m/s（本体 50% 跑速口径）')
