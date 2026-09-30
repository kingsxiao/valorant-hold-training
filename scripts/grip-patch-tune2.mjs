// 握持补丁组合试拍：给定补丁组（JSON 文件），逐个设置 __GRIP_PATCH → 截区域图 → 拼对比。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditWeaponInPage } from './arms-audit-fn.mjs'
import sharp from 'sharp'

const auditFn = auditWeaponInPage


const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const WEAPON = arg('weapon', 'vandal')
const [CX, CY, CW, CH] = arg('crop', '980,650,180,120').split(',').map(Number)
const CANDS = JSON.parse(fs.readFileSync(arg('cands'), 'utf8'))
const OUTDIR = path.resolve(ROOT, arg('out', 'out/grip-tune2'))
fs.mkdirSync(OUTDIR, { recursive: true })
const log = (...a) => console.log('[tune2]', ...a)

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
  const pierceOf = async () => page.evaluate((wid) => {
    // 审计同口径奇偶计数（45mm 带 + 30mm 桶 + +X 光线，六轮铁律②③）
    const g = window.__game
    const w = g.weapons
    const vm = w.activeCustomVm(wid)
    const arms = w.officialArms
    g.engine.vmScene.updateMatrixWorld(true)
    const verts = []
    const tris = []
    const inArmSubtree = (o) => { for (let p = o; p; p = p.parent) if (p === arms) return true; return false }
    const walkGun = (o) => {
      if (inArmSubtree(o)) return
      if (o.isMesh && o.geometry && o.geometry.attributes.position) {
        const pos = o.geometry.attributes.position
        const e = o.matrixWorld.elements
        const base = verts.length
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
          verts.push(e[0] * x + e[4] * y + e[8] * z + e[12],
                     e[1] * x + e[5] * y + e[9] * z + e[13],
                     e[2] * x + e[6] * y + e[10] * z + e[14])
        }
        const idx = o.geometry.index
        const n = idx ? idx.count : pos.count
        for (let t = 0; t < n; t += 3) {
          const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2
          tris.push(verts[base + ia * 3], verts[base + ia * 3 + 1], verts[base + ia * 3 + 2],
                    verts[base + ib * 3], verts[base + ib * 3 + 1], verts[base + ib * 3 + 2],
                    verts[base + ic * 3], verts[base + ic * 3 + 1], verts[base + ic * 3 + 2])
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
    const TCELL = 0.03
    const tBk = new Map()
    for (let t = 0; t < tris.length; t += 9) {
      const y0 = Math.min(tris[t + 1], tris[t + 4], tris[t + 7])
      const y1 = Math.max(tris[t + 1], tris[t + 4], tris[t + 7])
      const z0 = Math.min(tris[t + 2], tris[t + 5], tris[t + 8])
      const z1 = Math.max(tris[t + 2], tris[t + 5], tris[t + 8])
      for (let gy = Math.floor(y0 / TCELL); gy <= Math.floor(y1 / TCELL); gy++)
        for (let gz = Math.floor(z0 / TCELL); gz <= Math.floor(z1 / TCELL); gz++) {
          const k = gy + '|' + gz
          let a = tBk.get(k); if (!a) tBk.set(k, (a = [])); a.push(t)
        }
    }
    const nearGunVert = (x, y, z) => {
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL)
      let best = Infinity
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
        const a = vBk.get((cx + dx) + '|' + (cy + dy) + '|' + (cz + dz))
        if (!a) continue
        for (let j = 0; j < a.length; j++) {
          const i = a[j]
          const d = (verts[i] - x) ** 2 + (verts[i + 1] - y) ** 2 + (verts[i + 2] - z) ** 2
          if (d < best) best = d
        }
      }
      return Math.sqrt(best)
    }
    const insideGun = (x, y, z) => {
      const a = tBk.get(Math.floor(y / TCELL) + '|' + Math.floor(z / TCELL))
      if (!a) return false
      let count = 0
      for (let j = 0; j < a.length; j++) {
        const t = a[j]
        const ax = tris[t] - x, ay = tris[t + 1] - y, az = tris[t + 2] - z
        const bx = tris[t + 3] - x, by = tris[t + 4] - y, bz = tris[t + 5] - z
        const cx = tris[t + 6] - x, cy = tris[t + 7] - y, cz = tris[t + 8] - z
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az
        const det = e1z * e2y - e1y * e2z
        if (det > -1e-14 && det < 1e-14) continue
        const inv = 1 / det
        const u = (ay * e2z - az * e2y) * inv
        if (u < 0 || u > 1) continue
        const qxr = az * e1y - ay * e1z
        const v = qxr * inv
        if (v < 0 || u + v > 1) continue
        const qy = ax * e1z - az * e1x, qz = ay * e1x - ax * e1y
        const tHit = (e2x * qxr + e2y * qy + e2z * qz) * inv
        if (tHit > 1e-9) count++
      }
      return (count & 1) === 1
    }
    let pierce = 0
    const spots = []
    const walkArms = (o) => {
      if (o.isSkinnedMesh && o.geometry && o.geometry.attributes.position) {
        const pos = o.geometry.attributes.position
        const V3 = new o.position.constructor()
        const e = o.matrixWorld.elements
        for (let i = 0; i < pos.count; i++) {
          V3.fromBufferAttribute(pos, i)
          o.applyBoneTransform(i, V3)
          const x = e[0] * V3.x + e[4] * V3.y + e[8] * V3.z + e[12]
          const y = e[1] * V3.x + e[5] * V3.y + e[9] * V3.z + e[13]
          const z = e[2] * V3.x + e[6] * V3.y + e[10] * V3.z + e[14]
          if (nearGunVert(x, y, z) > 0.045) continue
          if (insideGun(x, y, z)) { pierce++; if (spots.length < 8) spots.push([i, +(nearGunVert(x, y, z) * 1000).toFixed(1), [x, y, z].map((v) => +v.toFixed(3))]) }
        }
      }
      for (const c of o.children) walkArms(c)
    }
    walkArms(arms)
    return { pierce, spots }
  }, WEAPON)
  const snap = async (label) => {
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const buf = await page.screenshot({ clip: { x: CX, y: CY, width: CW, height: CH } })
    const f = path.join(OUTDIR, label.replace(/[^\w.-]/g, '_') + '.png')
    fs.writeFileSync(f, buf)
    const p = await pierceOf()
    const official = await page.evaluate(auditFn, WEAPON)
    shots.push({ label: `${label} [tuner ${p.pierce} / official ${official.pierceTotal}]`, f })
    log(`${label}: tuner ${p.pierce} vs official ${official.pierceTotal}`)
  }
  await snap('00-ref')
  for (const c of CANDS) {
    await page.evaluate(({ wid, patch }) => { globalThis.__GRIP_PATCH = { [wid]: patch } }, { wid: WEAPON, patch: c.patch })
    await snap(c.name)
  }
  await page.evaluate(() => { delete globalThis.__GRIP_PATCH })
  await snap('99-reset')

  const TW = CW * 4, TH = CH * 4 + 18
  const cols = 3
  const rows = Math.ceil(shots.length / cols)
  const comps = []
  for (let k = 0; k < shots.length; k++) {
    const x = (k % cols) * TW, y = Math.floor(k / cols) * TH
    comps.push({ input: shots[k].f, left: x, top: y })
    const svg = Buffer.from(`<svg width="${TW}" height="18"><rect width="100%" height="100%" fill="black"/><text x="4" y="14" font-size="13" fill="yellow" font-family="monospace">${shots[k].label}</text></svg>`)
    comps.push({ input: svg, left: x, top: y + TH - 18 })
  }
  await sharp({ create: { width: cols * TW, height: rows * TH, channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .composite(comps).png().toFile(path.join(OUTDIR, 'sheet.png'))
  log(`候选 ${shots.length} → ${path.join(OUTDIR, 'sheet.png')}`)
} finally {
  try { await browser.close() } catch {}
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
}
