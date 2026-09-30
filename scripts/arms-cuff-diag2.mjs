// 十二轮诊断③：官方姿态原貌对照——模板场景按 phantom_idle 首帧摆姿势，将官方
// Camera 骨对齐 vmCamera 后截图（= 官方取景下的官方姿态）；另拍我们当前取景
// 同模板（拟合前）侧貌。隐藏现有臂/枪避免混入。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
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
const setup = () => page.evaluate(() => {
  const g = window.__game
  const w = g.weapons
  // 隐藏现役臂+枪
  if (w.officialArms) w.officialArms.visible = false
  for (const v of Object.values(w.customVms)) v.visible = false
  // 模板克隆 + phantom_idle 首帧姿势（attachOfficialArms 同法）
  return (async () => {
    const THREE = await import('/node_modules/three/build/three.module.js')
    const { clone: cloneSkinned } = await import('/node_modules/three/examples/jsm/utils/SkeletonUtils.js')
    const root = cloneSkinned(w._armsAssets.scene)
    const byName = {}
    root.traverse((o) => { if (o.name) byName[o.name] = o })
    const clip = w._armsAssets.animations.find((a) => a.name === 'phantom_idle')
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.')
      const node = byName[track.name.slice(0, dot)]
      if (!node) continue
      const prop = track.name.slice(dot + 1)
      const v = track.values
      if (prop === 'quaternion') node.quaternion.set(v[0], v[1], v[2], v[3])
      else if (prop === 'position') node.position.set(v[0], v[1], v[2])
    }
    root.quaternion.identity(); root.position.set(0, 0, 0); root.scale.setScalar(1)
    g.engine.vmScene.add(root)
    g.engine.vmScene.updateMatrixWorld(true)
    // 官方 Camera 骨 → vmCamera 位（原点无旋转）：root.matrix = C⁻¹
    const camBone = byName['Camera']
    if (!camBone) return 'NO Camera bone'
    const C = camBone.matrixWorld.clone()
    const Cinv = C.invert()
    root.matrix.copy(Cinv)
    root.matrix.decompose(root.position, root.quaternion, root.scale)
    g.engine.vmScene.updateMatrixWorld(true)
    // Camera 骨的朝向信息（供判断镜像/翻面）
    const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camBone.getWorldQuaternion(new THREE.Quaternion()))
    return { ok: true, camBoneDir: camDir.toArray().map((v) => +v.toFixed(3)), scaleHint: root.scale.x.toFixed(3) }
  })()
})
console.log('setup:', JSON.stringify(await setup()))
await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
fs.writeFileSync('out/diag-official-cam-view.png', await page.screenshot())
console.log('官方取景截图 → out/diag-official-cam-view.png')
await browser.close()
try { process.kill(-vite.pid) } catch {}
process.exit(0)
