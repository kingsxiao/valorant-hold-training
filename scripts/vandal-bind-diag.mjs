// 十四轮诊断：vandal 绑定位掌跟轮廓——锯齿是设计还是姿势所致。
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
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForFunction(() => { const w = window.__game?.weapons; return !!w && !!w._armsAssets && !!w.activeCustomVm('vandal') }, null, { timeout: 60000, polling: 250 })
await page.getByRole('button', { name: '开始训练', exact: true }).click({ timeout: 15000 })
await page.evaluate(() => { const g = window.__game; g.bots.roundEndAt = 0; g.bots.countdownUntil = 1e12; if (g.bots.hold) for (const s of g.bots.hold.slots ?? []) { s.bot = null; s.nextAt = 1e12 } })
await page.evaluate(() => window.__game.weapons.switchTo('vandal'))
await page.waitForFunction((id) => { const w = window.__game.weapons; return !!w.officialArms && w._armsPoseFor === id }, 'vandal', { timeout: 20000, polling: 100 })
await page.waitForTimeout(450)
const out = await page.evaluate(async () => {
  const g = window.__game
  const w = g.weapons
  if (w.officialArms) w.officialArms.visible = false
  for (const v of Object.values(w.customVms)) v.visible = false
  const { clone: cloneSkinned } = await import('/node_modules/three/examples/jsm/utils/SkeletonUtils.js')
  const root = cloneSkinned(w._armsAssets.scene)
  root.quaternion.identity(); root.position.set(0, 0, 0); root.scale.setScalar(1)
  g.engine.vmScene.add(root)
  root.updateMatrixWorld(true)
  const THREEBox = (await import('/node_modules/three/build/three.module.js')).Box3
  const V3C = Object.getPrototypeOf(g.engine.vmScene.position).constructor
  const bb = new THREEBox().setFromObject(root)
  const size = bb.getSize(new V3C()), center = bb.getCenter(new V3C())
  root.position.set(-center.x, -center.y, -size.x * 0.9)
  g.engine.vmScene.updateMatrixWorld(true)
  return { size: size.toArray().map((v) => +v.toFixed(2)) }
})
console.log('bind bbox:', JSON.stringify(out))
await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
fs.writeFileSync('out/diag-vandal-bind.png', await page.screenshot({ clip: { x: 200, y: 100, width: 1040, height: 700 } }))
console.log('ok')
await browser.close()
try { process.kill(-vite.pid) } catch {}
process.exit(0)
