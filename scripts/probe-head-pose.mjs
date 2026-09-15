// 头部姿态探针：接管全部官方 bot（每英雄一只），逐状态（kamae/走N/跑N/横移E/W/
// 死亡前扑/尸体）同步驱动到稳态后截图 + 读 Head 骨世界俯仰，定位"头朝下"。
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
await page.waitForTimeout(2500)

// ---- 阶段 1：等官方 bot 入池（等数量稳定 2s），注入驱动 API ----
const botCount = await page.evaluate(async () => {
  const g = window.__game
  let last = -1, stable = 0
  for (let i = 0; i < 250; i++) {
    const n = g.bots?.bots?.filter(x => x._officialLo).length ?? 0
    if (n === last && n > 0) { if (++stable >= 10) return n } else stable = 0
    last = n
    await new Promise(r => setTimeout(r, 200))
  }
  return last
})
if (!botCount) { console.log('FATAL no official bot'); await browser.close(); process.exit(1) }
console.log('official bots in pool:', botCount)

await page.evaluate(() => {
  const g = window.__game
  // 完全手动驱动：清空波次调度 + 关地图重建 + 关回合计时
  if (g.bots.hold) for (const s of g.bots.hold.slots) { s.bot = null; s.nextAt = 1e12 }
  g.bots.onMapRebuilt = () => {}
  g.bots.roundEndAt = 0
  g.bots.countdownUntil = 0

  const dt = 1 / 128
  window.__probe = {
    bots: () => g.bots.bots.filter(x => x._officialLo),
    cam(near, pitch) { // 近景取景：站在 bot 正前方 3.5m（玩家会随 updateCamera 每帧重设相机）
      const map = g.bots.map ?? this.bots()[0].manager.map
      g.player.pos.set(g.player.pos.x, 0, map.peekLineZ + 3.5)
      g.player.prevPos.copy(g.player.pos)
      g.player.yaw = 0; g.player.pitch = pitch ?? 0.05
    },
    // 摆状态 + 同步驱动到稳态
    state(name, opts = {}) {
      const b = opts.idx !== undefined ? this.bots()[opts.idx] : this.bots()[0]
      const map = g.bots.map ?? b.manager.map
      const botX = g.player.pos.x, botZ = map.peekLineZ
      const drive = (ticks) => { for (let i = 0; i < ticks; i++) { b.manager.t += dt; g.bots.step(dt, 1) } }
      const setPeek = (o) => { b.peek = Object.assign({
        style: 'cross', dir: 1, phase: 'out', startX: botX - 8, endX: botX + 8,
        stopAt: 1, stopped: false, stopUntil: 0, holdX: botX, resolved: true, jiggleAt: 0 }, o) }
      b.active = true
      if (name === 'kamae') {
        g.CONFIG.bot.moveSpeed = 5.4
        b.place(botX, botZ, 'peek')
        setPeek({ style: 'pull', stopped: true, phase: 'hold', stopUntil: 1e9, holdX: botX, startX: botX, endX: botX })
        drive(400)
      } else if (name === 'walkN' || name === 'runN') {
        g.CONFIG.bot.moveSpeed = name === 'walkN' ? 3.0 : 5.4
        b.place(botX - 6, botZ, 'peek')
        setPeek({ style: 'cross', dir: 1, startX: botX - 6, endX: botX + 8, stopAt: 1, stopped: false })
        drive(name === 'walkN' ? 150 : 110)
      } else if (name === 'strafeE' || name === 'strafeW') {
        g.CONFIG.bot.moveSpeed = 4.5
        const dir = name === 'strafeE' ? 1 : -1
        b.place(botX - 5 * dir, botZ, 'peek')
        setPeek({ style: 'pull', dir, startX: botX - 5 * dir, endX: botX + 6 * dir, stopAt: 1, stopped: false })
        b._strafeSide = name === 'strafeE' ? 'E' : 'W'
        drive(180)
      } else if (name === 'death') {
        g.CONFIG.bot.moveSpeed = 5.4
        b.place(botX, botZ, 'peek')
        setPeek({ style: 'pull', stopped: true, phase: 'hold', stopUntil: 1e9, holdX: botX, startX: botX, endX: botX })
        drive(30)
        b._playerX = botX; b._playerZ = botZ + 1 // 玩家在 bot 正面
        b.startDeath()
        drive(opts.ticks ?? 160)
      }
      return this.info(b)
    },
    info(b) {
      b = b ?? this.bots()[0]
      b.mesh.updateMatrixWorld(true)
      const out = { hero: b.anim.walk.getClip().name.split('-')[0], mode: b.mode,
        meshY: +b.mesh.position.y.toFixed(3), meshRotY: +b.mesh.rotation.y.toFixed(2),
        velX: +(b.velX ?? 0).toFixed?.(2), bones: {} }
      b.mesh.traverse(o => {
        if (!o.isBone) return
        const n = o.name.replace(/_\d+$/, '')
        if (/^(Head|Neck|Spine\d?|Pelvis)$/.test(n)) {
          o.updateWorldMatrix(true, false)
          const e = o.matrixWorld.elements // 列主序：局部 +Y 在世界的方向 = (e4,e5,e6)
          out.bones[n] = {
            upWorldDeg: +(Math.acos(Math.max(-1, Math.min(1, e[5]))) * 180 / Math.PI).toFixed(1),
            y: +e[13].toFixed(3),
          }
        }
      })
      return out
    },
  }
})

// ---- 阶段 2：逐状态截图 ----
const STATES = ['kamae', 'walkN', 'runN', 'strafeE', 'strafeW', 'death:120', 'death:600']
for (let i = 0; i < Math.min(botCount, 4); i++) {
  for (const st of STATES) {
    const [name, tickStr] = st.split(':')
    const info = await page.evaluate(({ name, ticks, idx }) => {
      const r = window.__probe.state(name, { ticks: +ticks, idx })
      window.__probe.cam(true, name.startsWith('death') ? -0.32 : 0.05)
      return r
    }, { name, ticks: tickStr, idx: i })
    await page.screenshot({ path: `/tmp/headpose/${i}-${st}.png` })
    console.log(`bot#${i} ${st}:`, JSON.stringify(info))
  }
}
await browser.close()
