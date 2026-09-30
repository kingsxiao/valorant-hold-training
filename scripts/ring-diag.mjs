// 十六轮诊断：phantom 指根黄色碎片（金戒指？）归属 + 指根-轨面穿切定位。
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
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForFunction(() => { const w = window.__game?.weapons; return !!w && !!w._armsAssets && !!w.activeCustomVm('phantom') }, null, { timeout: 60000, polling: 250 })
await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 15000 })
await page.evaluate(() => { const g = window.__game; g.bots.roundEndAt = 0; g.bots.countdownUntil = 1e12; if (g.bots.hold) for (const s of g.bots.hold.slots ?? []) { s.bot = null; s.nextAt = 1e12 } })
await page.evaluate(() => window.__game.weapons.switchTo('phantom'))
await page.waitForFunction((id) => { const w = window.__game.weapons; return !!w.officialArms && w._armsPoseFor === id }, 'phantom', { timeout: 20000, polling: 100 })
await page.waitForTimeout(450)
const r = await page.evaluate(() => {
  const g = window.__game
  const w = g.weapons
  const arms = w.officialArms
  g.engine.vmScene.updateMatrixWorld(true)
  const cam = g.engine.vmCamera
  const V3C = Object.getPrototypeOf(arms.position).constructor
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
      const bs = []
      for (let k = 0; k < 4; k++) bs.push({ n: bones[si.getComponent(i, k)]?.name, w: +sw.getComponent(i, k).toFixed(2) })
      bs.sort((a, b) => b.w - a.w)
      meta.push(bs.filter((b) => b.w > 0.05))
    }
  })
  // 评审黄碎片像素 (1030-1040, 745-755) 采样
  // 枪顶点也收集
  const gunV = []
  const inArmSubtree = (o) => { for (let q2 = o; q2; q2 = q2.parent) if (q2 === arms) return true; return false }
  const vm = w.activeCustomVm('phantom')
  const walkGun = (o) => {
    if (inArmSubtree(o)) return
    if (o.isMesh && o.geometry && o.geometry.attributes.position) {
      const pos = o.geometry.attributes.position
      const e = o.matrixWorld.elements
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
        gunV.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14])
      }
    }
    for (const c of o.children) walkGun(c)
  }
  walkGun(vm)
  const hits = []
  for (const [px, py] of [[966, 778], [964, 776], [968, 780]]) {
    const p = new V3C((px / 1440) * 2 - 1, -(py / 900) * 2 + 1, 0.5).unproject(cam)
    const o = cam.getWorldPosition(new V3C())
    const d = p.sub(o).normalize()
    let bestA = null, bestG = null
    for (let i = 0; i < armV.length / 3; i++) {
      const vx = armV[i * 3] - o.x, vy = armV[i * 3 + 1] - o.y, vz = armV[i * 3 + 2] - o.z
      const t = vx * d.x + vy * d.y + vz * d.z
      if (t < 0.05) continue
      const qx = vx - d.x * t, qy = vy - d.y * t, qz = vz - d.z * t
      const dist = Math.sqrt(qx * qx + qy * qy + qz * qz)
      if (dist < 0.012 && (!bestA || dist < bestA.dist)) bestA = { distMm: +(dist * 1000).toFixed(1), i, bones: meta[i] }
    }
    for (let i = 0; i < gunV.length / 3; i++) {
      const vx = gunV[i * 3] - o.x, vy = gunV[i * 3 + 1] - o.y, vz = gunV[i * 3 + 2] - o.z
      const t = vx * d.x + vy * d.y + vz * d.z
      if (t < 0.05) continue
      const qx = vx - d.x * t, qy = vy - d.y * t, qz = vz - d.z * t
      const dist = Math.sqrt(qx * qx + qy * qy + qz * qz)
      if (dist < 0.012 && (!bestG || dist < bestG.dist)) bestG = { distMm: +(dist * 1000).toFixed(1), i }
    }
    hits.push({ px, py, arm: bestA, gun: bestG })
  }
  // 全手 L_Ring0/1/2 顶点云的包围盒（戒指应挂 Ring 链）
  return { hits }
})
console.log(JSON.stringify(r.hits, null, 1))
await browser.close()
try { process.kill(-vite.pid) } catch {}
process.exit(0)
