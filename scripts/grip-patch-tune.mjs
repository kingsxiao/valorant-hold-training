// 握持润饰补丁调参器：对候选骨/本地轴/角度逐个设置 __GRIP_PATCH，等 3 帧，
// 截拇指/指尖区域小图，拼成带标签的对比图供目检选型。
// 用法：node scripts/grip-patch-tune.mjs --weapon=phantom --bone=L_Thumb1 \
//        --crop=880,680,180,130 --out=out/grip-tune
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const WEAPON = arg('weapon', 'phantom')
const BONE = arg('bone', 'L_Thumb1')
const [CX, CY, CW, CH] = arg('crop', '880,680,180,130').split(',').map(Number)
const OUTDIR = path.resolve(ROOT, arg('out', 'out/grip-tune'))
const log = (...a) => console.log('[tune]', ...a)

import sharp from 'sharp'
fs.mkdirSync(OUTDIR, { recursive: true })
import fs from 'node:fs'

const freePort = () => new Promise((res) => {
  const s = net.createServer(); s.unref()
  s.on('error', () => {})
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})
const PORT = await freePort()
const BASE = `http://127.0.0.1:${PORT}`
const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let viteErr = ''
vite.stderr.on('data', (d) => { viteErr += d })

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
let killed = false
const killVite = (sig) => { if (killed || !vite.pid) return; killed = true; try { process.kill(-vite.pid, sig) } catch {} }
try {
  const t0 = Date.now()
  for (;;) {
    if (vite.exitCode !== null) throw new Error(`vite 提前退出：${viteErr}`)
    try { if ((await fetch(BASE)).ok) break } catch {}
    if (Date.now() - t0 > 30000) throw new Error('vite 30s 未就绪')
    await new Promise((r) => setTimeout(r, 150))
  }
  log(`vite 就绪 ${BASE} (pid ${vite.pid})`)
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => log('[pageerror]', e.message))
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForFunction((wid) => {
    const w = window.__game?.weapons
    return !!w && !!w._armsAssets && !!w.activeCustomVm(wid)
  }, WEAPON, { timeout: 60000, polling: 250 })
  await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 15000 })
  await page.evaluate(() => {
    const g = window.__game
    g.bots.roundEndAt = 0; g.bots.countdownUntil = 1e12
    if (g.bots.hold) for (const s of g.bots.hold.slots ?? []) { s.bot = null; s.nextAt = 1e12 }
  })
  await page.evaluate((id) => window.__game.weapons.switchTo(id), WEAPON)
  await page.waitForFunction((id) => {
    const w = window.__game.weapons
    return w.currentId === id && !!w.officialArms && w._armsPoseFor === id && !w._pendingVmSwap
      && w.now >= w.equipUntil && w._armsEquipU === 1 && w.adsBlend === 0
      && (!w._armsAnim || !w._armsAnim.fire || w._armsAnim.fire.t === Infinity)
  }, WEAPON, { timeout: 20000, polling: 100 })
  await page.waitForTimeout(450)

  const shots = []
  const snap = async (label) => {
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const buf = await page.screenshot({ clip: { x: CX, y: CY, width: CW, height: CH } })
    const f = path.join(OUTDIR, label.replace(/[^\w.-]/g, '_') + '.png')
    fs.writeFileSync(f, buf)
    shots.push({ label, f })
  }

  await snap('00-ref')
  const AXES = { Xp: [1, 0, 0], Xn: [-1, 0, 0], Yp: [0, 1, 0], Yn: [0, -1, 0], Zp: [0, 0, 1], Zn: [0, 0, -1] }
  const ANGLES = [0.26, 0.52] // 15° / 30°
  for (const [axName, ax] of Object.entries(AXES)) {
    for (const a of ANGLES) {
      const q = [ax[0] * Math.sin(a / 2), ax[1] * Math.sin(a / 2), ax[2] * Math.sin(a / 2), Math.cos(a / 2)]
      await page.evaluate(({ wid, bone, pq }) => {
        globalThis.__GRIP_PATCH = { [wid]: { [bone]: pq } }
      }, { wid: WEAPON, bone: BONE, pq: q })
      await snap(`${BONE}_${axName}_${Math.round(a * 180 / Math.PI)}`)
    }
  }
  await page.evaluate(() => { delete globalThis.__GRIP_PATCH })
  await snap('99-reset')

  // 拼接对比图（列 = 候选，4 列一行，图上写标签）
  const tileW = CW * 3, tileH = CH * 3 + 18
  const cols = 4
  const rows = Math.ceil(shots.length / cols)
  const sheet = sharp({ create: { width: cols * tileW, height: rows * tileH, channels: 3, background: { r: 20, g: 20, b: 20 } } })
  const comps = []
  for (let k = 0; k < shots.length; k++) {
    const x = (k % cols) * tileW, y = Math.floor(k / cols) * tileH
    comps.push({ input: shots[k].f, left: x, top: y })
    const svg = Buffer.from(`<svg width="${tileW}" height="18"><rect width="100%" height="100%" fill="black"/><text x="4" y="13" font-size="12" fill="yellow" font-family="monospace">${shots[k].label}</text></svg>`)
    comps.push({ input: svg, left: x, top: y + tileH - 18 })
  }
  await sheet.composite(comps).png().toFile(path.join(OUTDIR, 'sheet.png'))
  log(`候选 ${shots.length} → ${path.join(OUTDIR, 'sheet.png')}`)
} finally {
  try { await browser.close() } catch {}
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
}
