// 十四轮诊断：vandal 左手锯齿边/悬空拇指取证。
// A. 评审像素 (975-1030,776-812) 与拇指 (958-990,712-742) 射线反查臂顶点；
// B. vandal 去穿透表逐条世界位移实测（B_lin，round-1 同法）+ 接缝覆盖；
// C. 表顶点在屏幕上的投影位置（判断哪些在可见轮廓）。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
const ROOT = '/Users/wangxiao/githubProjects/valorant-hold-training'
const freePort = () => new Promise((res) => { const s = net.createServer(); s.unref(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const PORT = await freePort()
const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], { cwd: ROOT, detached: true, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 3000))
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForFunction(() => { const w = window.__game?.weapons; return !!w && !!w._armsAssets && !!w.activeCustomVm('vandal') }, null, { timeout: 60000, polling: 250 })
await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 15000 })
await page.evaluate(() => { const g = window.__game; g.bots.roundEndAt = 0; g.bots.countdownUntil = 1e12; if (g.bots.hold) for (const s of g.bots.hold.slots ?? []) { s.bot = null; s.nextAt = 1e12 } })
await page.evaluate(() => window.__game.weapons.switchTo('vandal'))
await page.waitForFunction((id) => { const w = window.__game.weapons; return w.currentId === id && !!w.officialArms && w._armsPoseFor === id && !w._pendingVmSwap && w.now >= w.equipUntil && w._armsEquipU === 1 && w.adsBlend === 0 }, 'vandal', { timeout: 20000, polling: 100 })
await page.waitForTimeout(450)
const r = await page.evaluate(async () => {
  const g = window.__game
  const w = g.weapons
  const arms = w.officialArms
  const OA = await import('/src/weapons/OfficialArms.js')
  g.engine.vmScene.updateMatrixWorld(true)
  const cam = g.engine.vmCamera
  const V3C = Object.getPrototypeOf(arms.position).constructor
  const out = { hits: [], table: [], screen: [] }
  // 收集臂顶点（live 几何=已施加表）+ 主权重骨
  const armV = []
  const meta = []
  arms.traverse((o) => {
    if (!o.isSkinnedMesh) return
    const pos = o.geometry.attributes.position
    const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight
    const bones = o.skeleton.bones
    const e = o.matrixWorld.elements
    const V3 = new V3C()
    for (let i = 0; i < pos.count; i++) {
      V3.fromBufferAttribute(pos, i)
      o.applyBoneTransform(i, V3)
      const x = e[0] * V3.x + e[4] * V3.y + e[8] * V3.z + e[12]
      const y = e[1] * V3.x + e[5] * V3.y + e[9] * V3.z + e[13]
      const z = e[2] * V3.x + e[6] * V3.y + e[10] * V3.z + e[14]
      armV.push(x, y, z)
      let top = -1, topW = -1
      for (let k = 0; k < 4; k++) { const wgt = sw.getComponent(i, k); if (wgt > topW) { topW = wgt; top = si.getComponent(i, k) } }
      meta.push({ bone: bones[top]?.name ?? '?', w: +topW.toFixed(2) })
    }
  })
  // A. 像素射线反查
  const pixels = [[980, 790], [1000, 800], [1015, 805], [990, 780], [970, 725], [975, 735]]
  for (const [px, py] of pixels) {
    const p = new V3C((px / 1440) * 2 - 1, -(py / 900) * 2 + 1, 0.5).unproject(cam)
    const o = cam.getWorldPosition(new V3C())
    const d = p.sub(o).normalize()
    let best = null
    for (let i = 0; i < armV.length / 3; i++) {
      const vx = armV[i * 3] - o.x, vy = armV[i * 3 + 1] - o.y, vz = armV[i * 3 + 2] - o.z
      const t = vx * d.x + vy * d.y + vz * d.z
      if (t < 0.05) continue
      const qx = vx - d.x * t, qy = vy - d.y * t, qz = vz - d.z * t
      const dist = Math.sqrt(qx * qx + qy * qy + qz * qz)
      if (dist < 0.006 && (!best || t < best.t)) best = { t: +t.toFixed(3), dist: +(dist * 1000).toFixed(1), i, ...meta[i] }
    }
    out.hits.push({ px, py, hit: best })
  }
  // B. vandal 表逐条世界位移 + 接缝
  const tbl = OA.ARMS_DEPENETRATE.vandal?.FP_Phoenix_S0_Skelmesh001
  const tmplByMesh = new Map()
  w._armsAssets.scene.traverse((o) => { if (o.isSkinnedMesh) tmplByMesh.set(o.name, o.geometry) })
  const tg = tmplByMesh.get('FP_Phoenix_S0_Skelmesh001')
  let live = null
  arms.traverse((o) => { if (o.isSkinnedMesh && o.name === 'FP_Phoenix_S0_Skelmesh001') live = o })
  const V3 = new V3C()
  const skinWorld = (geo, i) => {
    V3.fromBufferAttribute(geo.attributes.position, i)
    live.applyBoneTransform(i, V3)
    const e = live.matrixWorld.elements
    return new V3C(e[0] * V3.x + e[4] * V3.y + e[8] * V3.z + e[12], e[1] * V3.x + e[5] * V3.y + e[9] * V3.z + e[13], e[2] * V3.x + e[6] * V3.y + e[10] * V3.z + e[14])
  }
  const si = live.geometry.attributes.skinIndex, sw = live.geometry.attributes.skinWeight
  const bones = live.skeleton.bones
  for (const [i, dx, dy, dz] of tbl) {
    const g2 = tg.clone()
    g2.attributes.position.setXYZ(i, tg.attributes.position.getX(i) + dx, tg.attributes.position.getY(i) + dy, tg.attributes.position.getZ(i) + dz)
    g2.attributes.position.needsUpdate = true
    const a = skinWorld(tg, i), b = skinWorld(g2, i)
    const wDisp = a.distanceTo(b)
    const cur = skinWorld(live.geometry, i) // live = 已施加
    // 屏幕投影
    const ndc = new V3C(cur.x, cur.y, cur.z).project(cam)
    const px = +((ndc.x + 1) / 2 * 1440).toFixed(0), py = +((1 - ndc.y) / 2 * 900).toFixed(0)
    let top = -1, topW = -1
    for (let k = 0; k < 4; k++) { const wgt = sw.getComponent(i, k); if (wgt > topW) { topW = wgt; top = si.getComponent(i, k) } }
    // 接缝重复
    const px0 = tg.attributes.position.getX(i), py0 = tg.attributes.position.getY(i), pz0 = tg.attributes.position.getZ(i)
    const dups = []
    for (let j = 0; j < tg.attributes.position.count; j++) {
      if (j === i) continue
      const d2 = (tg.attributes.position.getX(j) - px0) ** 2 + (tg.attributes.position.getY(j) - py0) ** 2 + (tg.attributes.position.getZ(j) - pz0) ** 2
      if (d2 < 1e-10) dups.push(j)
    }
    out.table.push({ i, bone: bones[top]?.name, w: +topW.toFixed(2), wDispMm: +(wDisp * 1000).toFixed(2), screen: [px, py], dups: dups.length })
  }
  return out
})
console.log('== 评审像素射线命中 ==')
for (const h of r.hits) console.log(JSON.stringify(h))
console.log('== vandal 表世界位移 ==')
for (const t of r.table) console.log(JSON.stringify(t))
await browser.close()
try { process.kill(-vite.pid) } catch {}
process.exit(0)
