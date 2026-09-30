// 十三轮调参：包握深度润饰——指尖团块越出轨顶轮廓（评审「指尖穿顶」残留类）。
// 双杠杆：*2 卷曲加深（X75→85/95）与 L_Hand 腕滚转（X/Y/Z 小角度）。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditWeaponInPage } from './arms-audit-fn.mjs'
import sharp from 'sharp'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUTDIR = path.resolve(ROOT, 'out/grip-deepen-tune')
fs.mkdirSync(OUTDIR, { recursive: true })
const log = (...a) => console.log('[deepen-tune]', ...a)
const q = (ax, deg) => { const r = deg * Math.PI / 360; const s = Math.sin(r); return ax === 'x' ? [s, 0, 0, Math.cos(r)] : ax === 'y' ? [0, s, 0, Math.cos(r)] : [0, 0, s, Math.cos(r)] }
const BASE = { // 十六轮定稿（收敛指列）
  L_Index1: [0, 0.358368, 0, 0.93358], L_Middle1: [0, 0.300706, 0, 0.953717], L_Ring1: [0, 0.34202, 0, 0.939693],
  L_Pinky1: [0, 0.173648, 0, 0.984808], L_Pinky2: [0.461749, 0, 0, 0.887011],
  L_Thumb2: [0, 0.21644, 0, 0.976296], L_Thumb3: [0, 0.130526, 0, 0.991445],
}
const m = (d) => ({ L_Index2: q('x', d), L_Middle2: q('x', d), L_Ring2: q('x', d) })
const tw = (d) => ({ L_Twist2: q('x', d) })
const CUR17 = { ...BASE, ...m(75), ...tw(8), L_Thumb2: q('x', 15) } // 十七轮烘焙态
const CANDS = [
  { name: '00-cur17', patch: CUR17 },
  // 掌缘小结节微调：腕/拇指基节 ±5-8° 微转
  { name: '10-hz+5', patch: { ...CUR17, L_Hand: q('z', 5) } },
  { name: '11-hz-5', patch: { ...CUR17, L_Hand: q('z', -5) } },
  { name: '12-hy+5', patch: { ...CUR17, L_Hand: q('y', 5) } },
  { name: '13-hy-5', patch: { ...CUR17, L_Hand: q('y', -5) } },
  { name: '14-t1z+6', patch: { ...CUR17, L_Thumb1: q('z', 6) } },
  { name: '15-t1z-6', patch: { ...CUR17, L_Thumb1: q('z', -6) } },
]

const freePort = () => new Promise((res) => { const s = net.createServer(); s.unref(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const PORT = await freePort()
const BASEURL = `http://127.0.0.1:${PORT}`
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
    try { if ((await fetch(BASEURL)).ok) break } catch {}
    if (Date.now() - t0 > 30000) throw new Error('vite 30s 未就绪')
    await new Promise((r) => setTimeout(r, 150))
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => log('[pageerror]', e.message))
  await page.goto(BASEURL + '/', { waitUntil: 'networkidle', timeout: 60000 })
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
  const hasHand = await page.evaluate(() => (window.__game.weapons._armsAnim?.bones ?? []).some((b) => b.node.name === 'L_Hand'))
  log('L_Hand 在动画骨列表:', hasHand)

  const rows = []
  for (const c of CANDS) {
    await page.evaluate((patch) => { globalThis.__GRIP_PATCH = { phantom: patch } }, c.patch)
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const buf = await page.screenshot()
    const f = path.join(OUTDIR, c.name.replace(/[^\w.-]/g, '_') + '.png')
    fs.writeFileSync(f, buf)
    const a = await page.evaluate(auditWeaponInPage, 'phantom')
    rows.push({ name: c.name, pierce: a.pierceTotal, pierceVis: a.pierceVisible, inter: a.intersectTris, interVis: a.intersectVisible, tipMin: a.fingertipMinMm, wrist: a.wristErrMm, hand: a.handScaleCm })
    log(`${c.name}: 嵌枪 ${a.pierceTotal}/可见 ${a.pierceVisible} 相交 ${a.intersectTris}/可见 ${a.intersectVisible} 指尖 ${a.fingertipMinMm} 腕锚 ${a.wristErrMm} 手尺 ${a.handScaleCm}`)
  }
  await page.evaluate(() => { delete globalThis.__GRIP_PATCH })

  // 指尖越轨区裁剪拼图（每个候选同区域 6x）
  const CW = 130, CH = 90, Z = 6
  const comps = []
  for (let k = 0; k < rows.length; k++) {
    const cropped = await sharp(path.join(OUTDIR, rows[k].name.replace(/[^\w.-]/g, '_') + '.png'))
      .extract({ left: 975, top: 685, width: CW, height: CH }).resize({ width: CW * Z, kernel: 'lanczos3' }).png().toBuffer()
    const x = (k % 3) * CW * Z, y = Math.floor(k / 3) * (CH * Z + 16)
    comps.push({ input: cropped, left: x, top: y })
    const svg = Buffer.from(`<svg width="${CW * Z}" height="16"><rect width="100%" height="100%" fill="black"/><text x="4" y="12" font-size="12" fill="yellow" font-family="monospace">${rows[k].name} p${rows[k].pierce}/${rows[k].pierceVis} i${rows[k].inter}/${rows[k].interVis}</text></svg>`)
    comps.push({ input: svg, left: x, top: y + CH * Z })
  }
  const rowsN = Math.ceil(rows.length / 3)
  await sharp({ create: { width: 3 * CW * Z, height: rowsN * (CH * Z + 16), channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .composite(comps).png().toFile(path.join(OUTDIR, 'sheet-tips.png'))
  log(`候选 ${rows.length} → ${path.join(OUTDIR, 'sheet-tips.png')}`)
} finally {
  try { await browser.close() } catch {}
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
}
