// 十五轮：phantom 扭曲治理扫描——回退 hx−20（腕反折/拇指蹼膜拉伸）与 twist+45
// （袖口漏斗镂空），袖口收敛候选 0/−15/−25。判据：无漏斗孔/无蹼膜/腕线自然；
// 可见口径 0；隐藏计数如实记录（不许为压数字保留致扭补丁）。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditWeaponInPage } from './arms-audit-fn.mjs'
import sharp from 'sharp'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUTDIR = path.resolve(ROOT, 'out/phantom-undo-tune')
fs.mkdirSync(OUTDIR, { recursive: true })
const log = (...a) => console.log('[ph-undo]', ...a)
const q = (ax, deg) => { const r = deg * Math.PI / 360; const s = Math.sin(r); return ax === 'x' ? [s, 0, 0, Math.cos(r)] : ax === 'y' ? [0, s, 0, Math.cos(r)] : [0, 0, s, Math.cos(r)] }
const CORE = { // 十一轮指姿（无 hx、无 twist）
  L_Index1: [0, 0.300706, 0, 0.953717], L_Middle1: [0, 0.300706, 0, 0.953717], L_Ring1: [0, 0.300706, 0, 0.953717],
  L_Index2: [0.608761, 0, 0, 0.793353], L_Middle2: [0.608761, 0, 0, 0.793353], L_Ring2: [0.608761, 0, 0, 0.793353],
  L_Pinky1: [0, 0.173648, 0, 0.984808], L_Pinky2: [0.461749, 0, 0, 0.887011],
  L_Thumb2: [0, 0.21644, 0, 0.976296], L_Thumb3: [0, 0.130526, 0, 0.991445],
}
const CUR = { ...CORE, L_Twist2: [0.382683, 0, 0, 0.92388], L_Hand: [-0.173648, 0, 0, 0.984808] } // 十三/十二轮现役
const CANDS = [
  { name: '00-cur(r12+r13)', patch: CUR },
  { name: '10-undoHx-tw0', patch: CORE },
  { name: '11-undoHx-tw-15', patch: { ...CORE, L_Twist2: q('x', -15) } },
  { name: '12-undoHx-tw-25', patch: { ...CORE, L_Twist2: q('x', -25) } },
  { name: '13-undoHx-tw+20', patch: { ...CORE, L_Twist2: q('x', 20) } },
]

const freePort = () => new Promise((res) => { const s = net.createServer(); s.unref(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const PORT = await freePort()
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
    try { if ((await fetch(`http://127.0.0.1:${PORT}`)).ok) break } catch {}
    if (Date.now() - t0 > 30000) throw new Error('vite 30s 未就绪')
    await new Promise((r) => setTimeout(r, 150))
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => log('[pageerror]', e.message))
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 60000 })
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

  // 袖口/腕区拼图
  const CW = 200, CH = 160, Z = 6
  const comps = []
  for (let k = 0; k < rows.length; k++) {
    const cropped = await sharp(path.join(OUTDIR, rows[k].name.replace(/[^\w.-]/g, '_') + '.png'))
      .extract({ left: 950, top: 730, width: CW, height: CH }).resize({ width: CW * Z, kernel: 'lanczos3' }).png().toBuffer()
    const x = (k % 2) * CW * Z, y = Math.floor(k / 2) * (CH * Z + 16)
    comps.push({ input: cropped, left: x, top: y })
    const svg = Buffer.from(`<svg width="${CW * Z}" height="16"><rect width="100%" height="100%" fill="black"/><text x="4" y="12" font-size="12" fill="yellow" font-family="monospace">${rows[k].name} p${rows[k].pierce}/${rows[k].pierceVis} i${rows[k].inter}/${rows[k].interVis}</text></svg>`)
    comps.push({ input: svg, left: x, top: y + CH * Z })
  }
  await sharp({ create: { width: 2 * CW * Z, height: Math.ceil(rows.length / 2) * (CH * Z + 16), channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .composite(comps).png().toFile(path.join(OUTDIR, 'sheet-cuff.png'))
  // 全手拼图
  const comps2 = []
  for (let k = 0; k < rows.length; k++) {
    const cropped = await sharp(path.join(OUTDIR, rows[k].name.replace(/[^\w.-]/g, '_') + '.png'))
      .extract({ left: 930, top: 640, width: 340, height: 260 }).resize({ width: 340 * 3, kernel: 'lanczos3' }).png().toBuffer()
    const x = (k % 2) * 340 * 3, y = Math.floor(k / 2) * (260 * 3 + 16)
    comps2.push({ input: cropped, left: x, top: y })
    comps2.push({ input: Buffer.from(`<svg width="${340 * 3}" height="16"><rect width="100%" height="100%" fill="black"/><text x="4" y="12" font-size="12" fill="yellow" font-family="monospace">${rows[k].name}</text></svg>`), left: x, top: y + 260 * 3 })
  }
  await sharp({ create: { width: 2 * 340 * 3, height: Math.ceil(rows.length / 2) * (260 * 3 + 16), channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .composite(comps2).png().toFile(path.join(OUTDIR, 'sheet-hand.png'))
  log(`候选 ${rows.length} → ${path.join(OUTDIR, 'sheet-cuff.png')} / sheet-hand.png`)
} finally {
  try { await browser.close() } catch {}
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
}
