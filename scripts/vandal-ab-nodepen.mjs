// 十四轮 A/B：vandal 去穿透表开/关 对照截图（掌跟锯齿区 + 袖口表投影区 + 全手）。
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { auditWeaponInPage } from '/Users/wangxiao/githubProjects/valorant-hold-training/scripts/arms-audit-fn.mjs'
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
const shot = async (tag) => {
  await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const buf = await page.screenshot()
  fs.writeFileSync(`out/vandal-ab-${tag}.png`, buf)
  const a = await page.evaluate(auditWeaponInPage, 'vandal')
  console.log(`${tag}: 嵌枪 ${a.pierceTotal}/可见 ${a.pierceVisible} 相交 ${a.intersectTris}/可见 ${a.intersectVisible} 指尖 ${a.fingertipMinMm} 腕锚 ${a.wristErrMm} 手尺 ${a.handScaleCm}`)
}
await shot('A-base')
await page.evaluate(async () => {
  const w = window.__game.weapons
  const OA = await import('/src/weapons/OfficialArms.js')
  if (!OA.ARMS_DEPENETRATE.__savedVandal) OA.ARMS_DEPENETRATE.__savedVandal = OA.ARMS_DEPENETRATE.vandal
  OA.ARMS_DEPENETRATE.vandal = {}
  w._armsPoseFor = null
  w.weaponMeshFor('vandal')
  return w._armsPoseFor
})
await page.waitForTimeout(500)
await shot('B-nodepen')
await page.evaluate(async () => {
  const w = window.__game.weapons
  const OA = await import('/src/weapons/OfficialArms.js')
  OA.ARMS_DEPENETRATE.vandal = OA.ARMS_DEPENETRATE.__savedVandal
  w._armsPoseFor = null
  w.weaponMeshFor('vandal')
})
await page.waitForTimeout(500)
await shot('C-restore')
await browser.close()
try { process.kill(-vite.pid) } catch {}
process.exit(0)
