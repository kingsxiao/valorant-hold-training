// 十二轮调参：L_Twist2 滚转候选——把官方袖扣带从「掌跟下拧麻花」滚回腕侧环扣。
// 只动袖筒皮肉权重顶点（带 0.8 权重挂 L_Twist2），手/指/腕锚/肘零改动。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditWeaponInPage } from './arms-audit-fn.mjs'
import sharp from 'sharp'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUTDIR = path.resolve(ROOT, 'out/cuff-roll-tune')
fs.mkdirSync(OUTDIR, { recursive: true })
const log = (...a) => console.log('[cuff-tune]', ...a)
const qx = (deg) => { const r = deg * Math.PI / 360; return [Math.sin(r), 0, 0, Math.cos(r)] }
const BASE_PATCH = { // 十一轮定稿（不含 L_Twist2）
  L_Index1: [0, 0.300706, 0, 0.953717], L_Middle1: [0, 0.300706, 0, 0.953717], L_Ring1: [0, 0.300706, 0, 0.953717],
  L_Index2: [0.608761, 0, 0, 0.793353], L_Middle2: [0.608761, 0, 0, 0.793353], L_Ring2: [0.608761, 0, 0, 0.793353],
  L_Pinky1: [0, 0.173648, 0, 0.984808], L_Pinky2: [0.461749, 0, 0, 0.887011],
  L_Thumb2: [0, 0.21644, 0, 0.976296], L_Thumb3: [0, 0.130526, 0, 0.991445],
}
const CANDS = [
  { name: '00-ref', patch: BASE_PATCH },
  ...[15, 30, 45, -15, -30, -45].map((d) => ({ name: `twist${d > 0 ? '+' : ''}${d}`, patch: { ...BASE_PATCH, L_Twist2: qx(d) } })),
]

const freePort = () => new Promise((res) => { const s = net.createServer(); s.unref(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const PORT = await freePort()
const BASE = `http://127.0.0.1:${PORT}`
const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
let viteErr = ''
vite.stderr.on('data', (d) => { viteErr += d })
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] })
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => log('[pageerror]', e.message))
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForFunction(() => { const w = window.__game?.weapons; return !!w && !!w._armsAssets && !!w.activeCustomVm('phantom') }, null, { timeout: 60000, polling: 250 })
  await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 15000 })
  await page.evaluate(() => { const g = window.__game; g.bots.roundEndAt = 0; g.bots.countdownUntil = 1e12; if (g.bots.hold) for (const s of g.bots.hold.slots ?? []) { s.bot = null; s.nextAt = 1e12 } })
  await page.evaluate(() => window.__game.weapons.switchTo('phantom'))
  await page.waitForFunction((id) => {
    const w = window.__game.weapons
    return w.currentId === id && !!w.officialArms && w._armsPoseFor === id && !w._pendingVmSwap
      && w.now >= w.equipUntil && w._armsEquipU === 1 && w.adsBlend === 0
      && (!w._armsAnim || !w._armsAnim.fire || w._armsAnim.fire.t === Infinity)
  }, 'phantom', { timeout: 20000, polling: 100 })
  await page.waitForTimeout(450)

  // L_Twist2 是否在动画骨列表 + 生效角
  const checkBones = await page.evaluate(() => {
    const w = window.__game.weapons
    const names = (w._armsAnim?.bones ?? []).map((b) => b.node.name)
    return { hasTwist2: names.includes('L_Twist2'), hasTwist1: names.includes('L_Twist1'), nBones: names.length }
  })
  log('动画骨：', JSON.stringify(checkBones))

  const Z = 5
  const rows = []
  for (const c of CANDS) {
    await page.evaluate((patch) => { globalThis.__GRIP_PATCH = { phantom: patch } }, c.patch)
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const buf = await page.screenshot()
    const f = path.join(OUTDIR, c.name.replace(/[^\w.-]/g, '_') + '.png')
    fs.writeFileSync(f, buf)
    const a = await page.evaluate(auditWeaponInPage, 'phantom')
    const applied = await page.evaluate(() => {
      const w = window.__game.weapons
      const rec = w._armsAnim?.bones?.find((b) => b.node.name === 'L_Twist2')
      if (!rec) return 'MISSING'
      const d = rec.node.quaternion.clone().multiply(rec.idle.clone().invert())
      return +(2 * Math.acos(Math.min(1, Math.abs(d.w))) * 180 / Math.PI).toFixed(1)
    })
    rows.push({ name: c.name, pierce: a.pierceTotal, pierceVis: a.pierceVisible, inter: a.intersectTris, interVis: a.intersectVisible, tipMin: a.fingertipMinMm, wrist: a.wristErrMm, hand: a.handScaleCm, applied })
    log(`${c.name}: 嵌枪 ${a.pierceTotal}/可见 ${a.pierceVisible} 相交 ${a.intersectTris}/可见 ${a.intersectVisible} 指尖 ${a.fingertipMinMm} 腕锚 ${a.wristErrMm} 手尺 ${a.handScaleCm} twist2生效角 ${applied}°`)
  }
  await page.evaluate(() => { delete globalThis.__GRIP_PATCH })

  const comps = []
  for (let k = 0; k < rows.length; k++) {
    const cropped = await sharp(path.join(OUTDIR, rows[k].name.replace(/[^\w.-]/g, '_') + '.png'))
      .extract({ left: 960, top: 740, width: 220, height: 160 }).resize({ width: 220 * Z, kernel: 'lanczos3' }).png().toBuffer()
    const x = (k % 2) * 220 * Z, y = Math.floor(k / 2) * (160 * Z + 16)
    comps.push({ input: cropped, left: x, top: y })
    const svg = Buffer.from(`<svg width="${220 * Z}" height="16"><rect width="100%" height="100%" fill="black"/><text x="4" y="12" font-size="12" fill="yellow" font-family="monospace">${rows[k].name} p${rows[k].pierce}/${rows[k].pierceVis} i${rows[k].inter}/${rows[k].interVis} t${rows[k].applied}°</text></svg>`)
    comps.push({ input: svg, left: x, top: y + 160 * Z })
  }
  const rowsN = Math.ceil(rows.length / 2)
  await sharp({ create: { width: 2 * 220 * Z, height: rowsN * (160 * Z + 16), channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .composite(comps).png().toFile(path.join(OUTDIR, 'sheet.png'))
  log(`候选 ${rows.length} → ${path.join(OUTDIR, 'sheet.png')}`)
} finally {
  try { await browser.close() } catch {}
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
}
