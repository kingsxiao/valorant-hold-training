// 十四轮调参：vandal 左拇指落位——评审「光滑钩状悬空不接触护木」。先轴探测
// （L_Thumb2 绕 X/Y ±15°）看拇指尖朝向，再组合落位。落位判定：拇指贴护木侧
// 不悬空、不穿出可见轮廓。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditWeaponInPage } from './arms-audit-fn.mjs'
import sharp from 'sharp'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUTDIR = path.resolve(ROOT, 'out/vandal-thumb-tune')
fs.mkdirSync(OUTDIR, { recursive: true })
const log = (...a) => console.log('[vthumb]', ...a)
const q = (ax, deg) => { const r = deg * Math.PI / 360; const s = Math.sin(r); return ax === 'x' ? [s, 0, 0, Math.cos(r)] : ax === 'y' ? [0, s, 0, Math.cos(r)] : [0, 0, s, Math.cos(r)] }
const THUMB1 = { L_Thumb1: [0, 0, -0.21644, 0.976296] } // 十四轮拇指落位（保留）
const m = (d) => ({ L_Index2: q('x', d), L_Middle2: q('x', d), L_Ring2: q('x', d) })
const CUR = { ...m(40), ...THUMB1 }
const CANDS = [
  { name: '00-ref-m40', patch: { ...CUR } },
  { name: '30-m55', patch: { ...m(55), ...THUMB1 } },
  { name: '31-m65', patch: { ...m(65), ...THUMB1 } },
  { name: '32-m75', patch: { ...m(75), ...THUMB1 } },
  { name: '33-m55-hx-8', patch: { ...m(55), ...THUMB1, L_Hand: q('x', -8) } },
  { name: '34-m65-hx-8', patch: { ...m(65), ...THUMB1, L_Hand: q('x', -8) } },
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
  await page.waitForFunction(() => { const w = window.__game?.weapons; return !!w && !!w._armsAssets && !!w.activeCustomVm('vandal') }, null, { timeout: 60000, polling: 250 })
  await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 15000 })
  await page.evaluate(() => { const g = window.__game; g.bots.roundEndAt = 0; g.bots.countdownUntil = 1e12; if (g.bots.hold) for (const s of g.bots.hold.slots ?? []) { s.bot = null; s.nextAt = 1e12 } })
  await page.evaluate(() => window.__game.weapons.switchTo('vandal'))
  await page.waitForFunction((id) => {
    const w = window.__game.weapons
    return w.currentId === id && !!w.officialArms && w._armsPoseFor === id && !w._pendingVmSwap
      && w.now >= w.equipUntil && w._armsEquipU === 1 && w.adsBlend === 0
      && (!w._armsAnim || !w._armsAnim.fire || w._armsAnim.fire.t === Infinity)
  }, 'vandal', { timeout: 20000, polling: 100 })
  await page.waitForTimeout(450)

  // 拇指尖（L_Thumb3 顶点云质心近似→用骨节点即零偏移骨架会盲；改为拇指 *3 主权重顶点云的包围盒）
  const tipsOf = () => page.evaluate(() => {
    const g = window.__game
    const w = g.weapons
    const vm = w.activeCustomVm('vandal')
    const arms = w.officialArms
    g.engine.vmScene.updateMatrixWorld(true)
    const verts = []
    const inArmSubtree = (o) => { for (let p = o; p; p = p.parent) if (p === arms) return true; return false }
    const walkGun = (o) => {
      if (inArmSubtree(o)) return
      if (o.isMesh && o.geometry && o.geometry.attributes.position) {
        const pos = o.geometry.attributes.position
        const e = o.matrixWorld.elements
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
          verts.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14])
        }
      }
      for (const c of o.children) walkGun(c)
    }
    walkGun(vm)
    const CELL = 0.03
    const vBk = new Map()
    for (let i = 0; i < verts.length; i += 3) {
      const k = Math.floor(verts[i] / CELL) + '|' + Math.floor(verts[i + 1] / CELL) + '|' + Math.floor(verts[i + 2] / CELL)
      let a = vBk.get(k); if (!a) vBk.set(k, (a = [])); a.push(i)
    }
    const near = (x, y, z) => {
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL)
      let best = Infinity
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
        const a = vBk.get((cx + dx) + '|' + (cy + dy) + '|' + (cz + dz))
        if (!a) continue
        for (const i of a) {
          const d = (verts[i] - x) ** 2 + (verts[i + 1] - y) ** 2 + (verts[i + 2] - z) ** 2
          if (d < best) best = d
        }
      }
      return Math.sqrt(best)
    }
    // L_Thumb3 主权重顶点云质心 → 距枪面
    let sx = 0, sy = 0, sz = 0, n = 0, dmin = Infinity
    arms.traverse((o) => {
      if (!o.isSkinnedMesh) return
      const pos = o.geometry.attributes.position
      const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight
      const bones = o.skeleton.bones
      const e = o.matrixWorld.elements
      const V3 = new (Object.getPrototypeOf(arms.position).constructor)()
      for (let i = 0; i < pos.count; i++) {
        let top = -1, topW = -1
        for (let k = 0; k < 4; k++) { const wgt = sw.getComponent(i, k); if (wgt > topW) { topW = wgt; top = si.getComponent(i, k) } }
        if (bones[top]?.name !== 'L_Thumb3') continue
        V3.fromBufferAttribute(pos, i)
        o.applyBoneTransform(i, V3)
        const x = e[0] * V3.x + e[4] * V3.y + e[8] * V3.z + e[12]
        const y = e[1] * V3.x + e[5] * V3.y + e[9] * V3.z + e[13]
        const z = e[2] * V3.x + e[6] * V3.y + e[10] * V3.z + e[14]
        sx += x; sy += y; sz += z; n++
        const d = near(x, y, z)
        if (d < dmin) dmin = d
      }
    })
    return { centroid: n ? [+(sx / n).toFixed(4), +(sy / n).toFixed(4), +(sz / n).toFixed(4)] : null, minGunMm: +(dmin * 1000).toFixed(2), n }
  })

  const rows = []
  for (const c of CANDS) {
    await page.evaluate((patch) => { globalThis.__GRIP_PATCH = { vandal: patch } }, c.patch)
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const buf = await page.screenshot()
    const f = path.join(OUTDIR, c.name.replace(/[^\w.-]/g, '_') + '.png')
    fs.writeFileSync(f, buf)
    const a = await page.evaluate(auditWeaponInPage, 'vandal')
    const tip = await tipsOf()
    rows.push({ name: c.name, pierce: a.pierceTotal, pierceVis: a.pierceVisible, inter: a.intersectTris, interVis: a.intersectVisible, tipMin: a.fingertipMinMm, wrist: a.wristErrMm, hand: a.handScaleCm, thumb: tip })
    log(`${c.name}: 嵌枪 ${a.pierceTotal}/可见 ${a.pierceVisible} 相交 ${a.intersectTris}/可见 ${a.intersectVisible} 指尖 ${a.fingertipMinMm} 腕锚 ${a.wristErrMm} 手尺 ${a.handScaleCm} | 拇指尖云 n=${tip.n} 距枪min ${tip.minGunMm}mm 质心 ${JSON.stringify(tip.centroid)}`)
  }
  await page.evaluate(() => { delete globalThis.__GRIP_PATCH })

  const CW = 170, CH = 130, Z = 7
  const comps = []
  for (let k = 0; k < rows.length; k++) {
    const cropped = await sharp(path.join(OUTDIR, rows[k].name.replace(/[^\w.-]/g, '_') + '.png'))
      .extract({ left: 925, top: 680, width: CW, height: CH }).resize({ width: CW * Z, kernel: 'lanczos3' }).png().toBuffer()
    const x = (k % 2) * CW * Z, y = Math.floor(k / 2) * (CH * Z + 16)
    comps.push({ input: cropped, left: x, top: y })
    const svg = Buffer.from(`<svg width="${CW * Z}" height="16"><rect width="100%" height="100%" fill="black"/><text x="4" y="12" font-size="12" fill="yellow" font-family="monospace">${rows[k].name} p${rows[k].pierce}/${rows[k].pierceVis} i${rows[k].inter}/${rows[k].interVis} thumbGun${rows[k].thumb.minGunMm}mm</text></svg>`)
    comps.push({ input: svg, left: x, top: y + CH * Z })
  }
  const rowsN = Math.ceil(rows.length / 2)
  await sharp({ create: { width: 2 * CW * Z, height: rowsN * (CH * Z + 16), channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .composite(comps).png().toFile(path.join(OUTDIR, 'sheet.png'))
  log(`候选 ${rows.length} → ${path.join(OUTDIR, 'sheet.png')}`)
} finally {
  try { await browser.close() } catch {}
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
}
