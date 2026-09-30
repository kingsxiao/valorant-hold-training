// 十一轮调参器：phantom 左手「整指包握」候选扫描——近节(*1)+中节(*2)联合卷指
// （十轮遗留①：九轮 X75 只卷中节 → 指列扇形/分段折断 + 左指尖悬空 13~15mm）。
// 每候选：设置 __GRIP_PATCH.phantom → 截左手区 → auditWeaponInPage 全口径
// （嵌枪/可见/相交/可见/指尖/腕锚/手尺）+ 逐指尖距枪面距离 → 拼对比图。
// 用法：node scripts/grip-wrap-tune.mjs --out out/grip-wrap-tune
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditWeaponInPage } from './arms-audit-fn.mjs'
import sharp from 'sharp'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const OUTDIR = path.resolve(ROOT, arg('out', 'out/grip-wrap-tune'))
const CX = 920, CY = 640, CW = 360, CH = 260
fs.mkdirSync(OUTDIR, { recursive: true })
const log = (...a) => console.log('[wrap-tune]', ...a)

const degQ = (deg) => { const r = deg * Math.PI / 360; return [Math.sin(r), 0, 0, Math.cos(r)] }
const degQy = (deg) => { const r = deg * Math.PI / 360; return [0, Math.sin(r), 0, Math.cos(r)] }
const THUMB = { L_Thumb2: [0, 0.21644, 0, 0.976296], L_Thumb3: [0, 0.130526, 0, 0.991445] } // 九轮定稿不动
// 候选：围绕 43（y35m75）细扫 + pinky 收拢组合
const CANDS = [
  { name: '00-ref', patch: { ...THUMB, L_Index2: degQ(75), L_Middle2: degQ(75), L_Ring2: degQ(75) } },
  { name: '50-y30m75', patch: { ...THUMB, L_Index1: degQy(30), L_Middle1: degQy(30), L_Ring1: degQy(30), L_Index2: degQ(75), L_Middle2: degQ(75), L_Ring2: degQ(75) } },
  { name: '51-y35m75', patch: { ...THUMB, L_Index1: degQy(35), L_Middle1: degQy(35), L_Ring1: degQy(35), L_Index2: degQ(75), L_Middle2: degQ(75), L_Ring2: degQ(75) } },
  { name: '52-y40m75', patch: { ...THUMB, L_Index1: degQy(40), L_Middle1: degQy(40), L_Ring1: degQy(40), L_Index2: degQ(75), L_Middle2: degQ(75), L_Ring2: degQ(75) } },
  { name: '53-y35m75-pinky20', patch: { ...THUMB, L_Index1: degQy(35), L_Middle1: degQy(35), L_Ring1: degQy(35), L_Index2: degQ(75), L_Middle2: degQ(75), L_Ring2: degQ(75), L_Pinky1: degQy(20), L_Pinky2: degQ(55) } },
  { name: '54-y35m75-pinky25', patch: { ...THUMB, L_Index1: degQy(35), L_Middle1: degQy(35), L_Ring1: degQy(35), L_Index2: degQ(75), L_Middle2: degQ(75), L_Ring2: degQ(75), L_Pinky1: degQy(25), L_Pinky2: degQ(65) } },
  { name: '55-y35m80-pinky20', patch: { ...THUMB, L_Index1: degQy(35), L_Middle1: degQy(35), L_Ring1: degQy(35), L_Index2: degQ(80), L_Middle2: degQ(80), L_Ring2: degQ(80), L_Pinky1: degQy(20), L_Pinky2: degQ(55) } },
  { name: '56-y30m75-pinky20', patch: { ...THUMB, L_Index1: degQy(30), L_Middle1: degQy(30), L_Ring1: degQy(30), L_Index2: degQ(75), L_Middle2: degQ(75), L_Ring2: degQ(75), L_Pinky1: degQy(20), L_Pinky2: degQ(55) } },
]

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
  await page.waitForFunction(() => {
    const w = window.__game?.weapons
    return !!w && !!w._armsAssets && !!w.activeCustomVm('phantom')
  }, null, { timeout: 60000, polling: 250 })
  await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 15000 })
  await page.evaluate(() => {
    const g = window.__game
    g.bots.roundEndAt = 0; g.bots.countdownUntil = 1e12
    if (g.bots.hold) for (const s of g.bots.hold.slots ?? []) { s.bot = null; s.nextAt = 1e12 }
  })
  await page.evaluate(() => window.__game.weapons.switchTo('phantom'))
  await page.waitForFunction((id) => {
    const w = window.__game.weapons
    return w.currentId === id && !!w.officialArms && w._armsPoseFor === id && !w._pendingVmSwap
      && w.now >= w.equipUntil && w._armsEquipU === 1 && w.adsBlend === 0
      && (!w._armsAnim || !w._armsAnim.fire || w._armsAnim.fire.t === Infinity)
  }, 'phantom', { timeout: 20000, polling: 100 })
  await page.waitForTimeout(450)

  // 网格顶点级指尖接触：每根左手指取「主权重骨 ∈ {F2,F3}」的臂顶点到枪面最近距离
  // （骨架零偏移：*3 骨节点与 *2 关节重合，骨节点度量对 *2 卷曲全盲——十轮探针结论）
  const tipsOf = () => page.evaluate(() => {
    const g = window.__game
    const w = g.weapons
    const vm = w.activeCustomVm('phantom')
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
    const out = {}
    arms.traverse((o) => {
      if (!o.isSkinnedMesh || !o.geometry.attributes.skinIndex) return
      const pos = o.geometry.attributes.position
      const si = o.geometry.attributes.skinIndex
      const sw = o.geometry.attributes.skinWeight
      const bones = o.skeleton.bones
      const e = o.matrixWorld.elements
      const V3 = new (Object.getPrototypeOf(arms.position).constructor)()
      const per = {} // finger -> min dist
      for (let i = 0; i < pos.count; i++) {
        let top = -1, topW = 0
        for (let k = 0; k < 4; k++) { const wgt = sw.getComponent(i, k); if (wgt > topW) { topW = wgt; top = si.getComponent(i, k) } }
        const bn = bones[top]?.name ?? ''
        const m = /^(L_(?:Index|Middle|Ring|Pinky)_[23])$/.exec(bn)
        if (!m) continue
        V3.fromBufferAttribute(pos, i)
        o.applyBoneTransform(i, V3)
        const x = e[0] * V3.x + e[4] * V3.y + e[8] * V3.z + e[12]
        const y = e[1] * V3.x + e[5] * V3.y + e[9] * V3.z + e[13]
        const z = e[2] * V3.x + e[6] * V3.y + e[10] * V3.z + e[14]
        const fing = bn.slice(0, -2) // L_Index 等
        const d = near(x, y, z)
        if (!(fing in per) || d < per[fing]) per[fing] = d
      }
      for (const [k, v] of Object.entries(per)) out[k] = +(v * 1000).toFixed(2)
    })
    return out
  })

  const rows = []
  for (const c of CANDS) {
    await page.evaluate((patch) => { globalThis.__GRIP_PATCH = { phantom: patch } }, c.patch)
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const buf = await page.screenshot() // 全帧，裁剪后置
    const f = path.join(OUTDIR, c.name.replace(/[^\w.-]/g, '_') + '.png')
    fs.writeFileSync(f, buf)
    const a = await page.evaluate(auditWeaponInPage, 'phantom')
    const tips = await tipsOf()
    const row = { name: c.name, pierce: a.pierceTotal, pierceVis: a.pierceVisible, inter: a.intersectTris,
      interVis: a.intersectVisible, tipMin: a.fingertipMinMm, wrist: a.wristErrMm, hand: a.handScaleCm, tips }
    rows.push(row)
    log(`${c.name}: 嵌枪 ${row.pierce}/可见 ${row.pierceVis} 相交 ${row.inter}/可见 ${row.interVis} 指尖min ${row.tipMin} 腕锚 ${row.wrist} 手尺 ${row.hand}`)
    log(`  左指尖(网格级): I=${tips.L_Index} M=${tips.L_Middle} R=${tips.L_Ring} P=${tips.L_Pinky}`)
  }
  await page.evaluate(() => { delete globalThis.__GRIP_PATCH })
  fs.writeFileSync(path.join(OUTDIR, 'rows.json'), JSON.stringify(rows, null, 2) + '\n')

  // 对比图：每候选裁剪左手区 2x 放大拼表
  const TW = CW * 2, TH = CH * 2 + 18
  const cols = 2
  const comps = []
  for (let k = 0; k < rows.length; k++) {
    const cropped = await sharp(rows[k] ? path.join(OUTDIR, rows[k].name.replace(/[^\w.-]/g, '_') + '.png') : '')
      .extract({ left: CX, top: CY, width: CW, height: CH }).resize({ width: TW, kernel: 'lanczos3' }).png().toBuffer()
    const x = (k % cols) * TW, y = Math.floor(k / cols) * TH
    comps.push({ input: cropped, left: x, top: y })
    const r = rows[k]
    const svg = Buffer.from(`<svg width="${TW}" height="18"><rect width="100%" height="100%" fill="black"/><text x="4" y="14" font-size="13" fill="yellow" font-family="monospace">${r.name} pierce${r.pierce}/v${r.pierceVis} inter${r.inter}/v${r.interVis}</text></svg>`)
    comps.push({ input: svg, left: x, top: y + TH - 18 })
  }
  const rowsN = Math.ceil(rows.length / cols)
  await sharp({ create: { width: cols * TW, height: rowsN * TH, channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .composite(comps).png().toFile(path.join(OUTDIR, 'sheet.png'))
  log(`候选 ${rows.length} → ${path.join(OUTDIR, 'sheet.png')}`)
} finally {
  try { await browser.close() } catch {}
  killVite('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  killVite('SIGKILL')
  log('清理完成')
}
