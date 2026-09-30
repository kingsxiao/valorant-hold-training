// 十二轮诊断②：白布/掌跟锯齿区顶点定位（屏幕射线→臂顶点反查）+ 模板官方
// idle 原貌对照截图（无拟合、官方 Camera 骨位相机）。
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
await page.waitForFunction(() => { const w = window.__game?.weapons; return !!w && !!w._armsAssets && !!w.activeCustomVm('phantom') }, null, { timeout: 60000, polling: 250 })
await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 15000 })
await page.evaluate(() => { const g = window.__game; g.bots.roundEndAt = 0; g.bots.countdownUntil = 1e12; if (g.bots.hold) for (const s of g.bots.hold.slots ?? []) { s.bot = null; s.nextAt = 1e12 } })
await page.evaluate(() => window.__game.weapons.switchTo('phantom'))
await page.waitForFunction((id) => { const w = window.__game.weapons; return w.currentId === id && !!w.officialArms && w._armsPoseFor === id && !w._pendingVmSwap && w.now >= w.equipUntil && w._armsEquipU === 1 && w.adsBlend === 0 }, 'phantom', { timeout: 20000, polling: 100 })
await page.waitForTimeout(450)

const r = await page.evaluate(() => {
  const g = window.__game
  const w = g.weapons
  const arms = w.officialArms
  g.engine.vmScene.updateMatrixWorld(true)
  const cam = g.engine.vmCamera
  const V3C = Object.getPrototypeOf(arms.position).constructor
  // 白布带 + 掌跟锯齿区采样像素（1440x900 帧内）
  const pixels = [[1010, 800], [1030, 840], [1000, 770], [985, 745], [1060, 860]]
  // 收集臂顶点世界坐标 + 主权重骨 + rest 位
  const armV = []
  const meta = []
  const tmpl = new Map()
  w._armsAssets.scene.traverse((o) => { if (o.isSkinnedMesh) tmpl.set(o.name, o.geometry) })
  arms.traverse((o) => {
    if (!o.isSkinnedMesh) return
    const pos = o.geometry.attributes.position
    const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight
    const bones = o.skeleton.bones
    const e = o.matrixWorld.elements
    const tpos = tmpl.get(o.name)?.attributes.position
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
      meta.push({ bone: bones[top]?.name ?? '?', w: +topW.toFixed(2), rest: tpos ? [+tpos.getX(i).toFixed(3), +tpos.getY(i).toFixed(3), +tpos.getZ(i).toFixed(3)] : null })
    }
  })
  const hits = []
  for (const [px, py] of pixels) {
    const ndcX = (px / 1440) * 2 - 1, ndcY = -(py / 900) * 2 + 1
    const p = new V3C(ndcX, ndcY, 0.5).unproject(cam)
    const o = cam.getWorldPosition(new V3C())
    const d = p.sub(o).normalize()
    let best = null
    for (let i = 0; i < armV.length / 3; i++) {
      const vx = armV[i * 3] - o.x, vy = armV[i * 3 + 1] - o.y, vz = armV[i * 3 + 2] - o.z
      const t = vx * d.x + vy * d.y + vz * d.z
      if (t < 0.05) continue
      const qx = vx - d.x * t, qy = vy - d.y * t, qz = vz - d.z * t
      const dist = Math.sqrt(qx * qx + qy * qy + qz * qz)
      if (dist < 0.006 && (!best || t < best.t)) best = { t, dist, i, ...meta[i] }
    }
    hits.push({ px, py, hit: best })
  }
  return { hits }
})
console.log(JSON.stringify(r.hits, null, 1))
await browser.close()
try { process.kill(-vite.pid) } catch {}
process.exit(0)
