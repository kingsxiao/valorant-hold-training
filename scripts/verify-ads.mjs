// ADS 浏览器实测：右键开镜 → 数值探针（FOV/位姿/射速/移速/准星跟随）+ 截图对比
// 输入走 DEV 句柄直接写 input.mouse0/1（Playwright 合成点击建不起指针锁定，
// verify-feel 的成熟路径）
// 用法：node scripts/verify-ads.mjs [端口] [输出目录]
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const PORT = process.argv[2] ?? '5201'
const outDir = process.argv[3] ?? '/tmp/ads-shots'
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()) })
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })
console.log('clicked start')
await page.waitForTimeout(1200)

const setM = (m0, m1) => page.evaluate(([a, b]) => { window.__game.input.mouse0 = a; window.__game.input.mouse1 = b }, [m0, m1])

// 探针：枪口/抛壳口（后部参照）NDC（经 vm→camera 矩阵投影）。
// muzzleVm/rearVm = vmCamera 系投影（持枪 pass 的真实取景口径：原点固定、
// fovV=55° 恒定，不随 ADS 缩放 —— 开镜构图判读用这两个）
const probe = () => page.evaluate(() => {
  const g = window.__game
  const w = g.weapons
  const vm = w.activeCustomVm() ?? w.viewmodels[w.currentVmId]
  const proj = (p) => {
    const m = p.clone().applyMatrix4(vm.matrixWorld).applyMatrix4(g.engine.camera.matrixWorld)
    m.project(g.engine.camera)
    return [+m.x.toFixed(3), +m.y.toFixed(3)]
  }
  const projVm = (p) => {
    const m = p.clone().applyMatrix4(vm.matrixWorld)
    m.project(g.engine.vmCamera)
    return [+m.x.toFixed(3), +m.y.toFixed(3)]
  }
  return {
    weapon: w.currentId,
    adsHeld: w.adsHeld, adsBlend: +w.adsBlend.toFixed(3),
    fovH: +g.engine.fovH.toFixed(2), fovV: +g.engine.camera.fov.toFixed(2),
    holderPos: w.vmHolder.position.toArray().map(v => +v.toFixed(3)),
    holderRot: [w.vmHolder.rotation.x, w.vmHolder.rotation.y, w.vmHolder.rotation.z].map(v => +v.toFixed(3)),
    holderScale: +w.vmHolder.scale.x.toFixed(3),
    adsHolder: vm.userData.adsHolder?.toArray().map(v => +v.toFixed(3)) ?? null,
    muzzleNDC: proj(w.muzzleOffset),
    rearNDC: vm.userData.eject ? proj(vm.userData.eject) : null,
    muzzleVmNDC: projVm(w.muzzleOffset),
    rearVmNDC: vm.userData.eject ? projVm(vm.userData.eject) : null,
    patOff: { p: +w.patOff.p.toFixed(2), y: +w.patOff.y.toFixed(2) },
    crosshairTf: document.getElementById('crosshair').style.transform,
    punch: [+g.player.punchPitch.toFixed(4), +g.player.punchYaw.toFixed(4)],
    moveSpeed: +g.player.moveSpeed.toFixed(2),
    shots: g.bots.stats.shots,
  }
})

// ---- 1. 腰射基线 ----
await page.waitForTimeout(300)
console.log('HIP   ', JSON.stringify(await probe()))
await page.screenshot({ path: `${outDir}/01-hip.png` })

// ---- 0. 标定模式：只进 ADS 采位姿（CAL=1 时跳过开火/移动段）----
if (process.env.CAL === '1') {
  await setM(false, true)
  await page.waitForTimeout(450)
  console.log('ADS   ', JSON.stringify(await probe()))
  await page.screenshot({ path: `${outDir}/02-ads.png` })
  await setM(false, false)
  await browser.close()
  console.log('DONE cal')
  process.exit(0)
}

// ---- 2. 按住右键开镜（过渡 0.22s，等 500ms 到位）----
await setM(false, true)
await page.waitForTimeout(500)
console.log('ADS   ', JSON.stringify(await probe()))
await page.screenshot({ path: `${outDir}/02-ads.png` })

// ---- 3. ADS 开火：射速（应 8.775/s）+ 准星跟随 + punch ----
const t0 = await page.evaluate(() => window.__game.bots.stats.shots)
await setM(true, true)
await page.waitForTimeout(1100)
const t1 = await page.evaluate(() => window.__game.bots.stats.shots)
console.log('ADS FIRE shots=', t1 - t0, 'rate=', +((t1 - t0) / 1.1).toFixed(2), '/s (expect ~8.78)')
console.log('ADS SPRAY', JSON.stringify(await probe()))
await page.screenshot({ path: `${outDir}/03-ads-spray.png` })
await setM(false, true)
await page.waitForTimeout(700) // recoverTime 后弹道复位
console.log('ADS RECOVER', JSON.stringify(await probe()))

// ---- 4. ADS 移速惩罚：按住 W 跑（应 4.10 m/s）----
await page.keyboard.down('KeyW')
await page.waitForTimeout(900)
console.log('ADS MOVE ', JSON.stringify(await probe()))
await page.keyboard.up('KeyW')
await setM(false, false)

// ---- 5. 出镜回腰射 ----
await page.waitForTimeout(400)
console.log('BACK  ', JSON.stringify(await probe()))
await page.screenshot({ path: `${outDir}/04-back-hip.png` })

// ---- 6. 腰射开火对照：准星不跟随（crosshairTf 应无平移）----
await setM(true, false)
await page.waitForTimeout(700)
await setM(false, false)
console.log('HIP FIRE', JSON.stringify(await probe()))
await page.screenshot({ path: `${outDir}/05-hip-fire.png` })

await browser.close()
console.log('DONE')
