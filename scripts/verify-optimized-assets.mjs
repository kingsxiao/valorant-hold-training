// 资产优化后的浏览器实测：
//   1. 分阶段加载断言：开局即可玩（menu/round 不等后台批），Bot.customTemplates
//      后台到货增长到 4、weaponTemplates 补齐 phantom、皮肤键并入 customVms
//   2. 贴图再编码可用性：WebP/JPEG 贴图的 GLB 全部正常解码（console 无错误）
//   3. 游戏内截图：viewmodel + bot 视觉质量（贴图再编码前后人审比对用）
// 用法：node scripts/verify-optimized-assets.mjs [baseUrl] [outDir]
//   baseUrl 缺省 http://127.0.0.1:5199/（vite dev --port 5199）
import { chromium } from '/Users/wangxiao/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'

const base = process.argv[2] ?? 'http://127.0.0.1:5199/'
const outDir = process.argv[3] ?? '/tmp/opt-shots'
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  args: ['--window-size=1440,900', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

const t0 = Date.now()
await page.goto(base, { waitUntil: 'domcontentloaded' })

// 开局不阻塞：等 __game 就绪（模块初始化完成、菜单可见）
await page.waitForFunction(() => !!window.__game, { timeout: 20000 })
const menuReadyMs = Date.now() - t0
console.log(`[1] 模块就绪（菜单可用）: ${menuReadyMs}ms`)
await page.screenshot({ path: `${outDir}/01-menu.png` })

await page.getByRole('button', { name: '开始训练', exact: true }).first().click({ timeout: 8000 })
console.log('[2] 点击开始训练（此时关键批应已到，后台批可能在途）')
await page.waitForFunction(() => {
  const bots = window.__game?.bots?.bots ?? []
  return bots.some(b => b.active && b.mode !== 'corpse')
}, { timeout: 15000 }).catch(() => console.log('!! 无 active bot'))

// 后台批到货：模板池增长（≤30s；本地文件系统秒到，远端放宽）
const state1 = await page.evaluate(() => {
  const g = window.__game
  const Bot = g?.bots?.bots?.find(b => b)?.constructor
  return {
    templates: Bot?.customTemplates?.length ?? 0,
    weaponTpl: Object.keys(Bot?.weaponTemplates ?? {}),
    customVms: Object.keys(g?.weapons?.customVms ?? {}),
    skin: g?.weapons?.skin,
  }
})
console.log('[3] 开局即刻资产:', JSON.stringify(state1))

const grewOk = await page.waitForFunction(() => {
  const Bot = window.__game?.bots?.bots?.find(b => b)?.constructor
  return Bot?.customTemplates?.length >= 4 && Bot?.weaponTemplates?.phantom
}, { timeout: 30000, polling: 500 }).then(() => true).catch(() => false)
const state2 = await page.evaluate(() => {
  const g = window.__game
  const Bot = g?.bots?.bots?.find(b => b)?.constructor
  return {
    templates: Bot?.customTemplates?.length ?? 0,
    weaponTpl: Object.keys(Bot?.weaponTemplates ?? {}),
    customVms: Object.keys(g?.weapons?.customVms ?? {}),
    glove: !!g?.weapons?._gloveAssets,
  }
})
console.log(`[4] 后台批到货(${grewOk ? 'OK' : 'TIMEOUT'}):`, JSON.stringify(state2))

// 网络明细：各模型的传输字节数（再编码后的实际体积）
const res = await page.evaluate(() => performance.getEntriesByType('resource')
  .filter(r => r.name.includes('models/') || r.name.includes('.js'))
  .map(r => `${r.name.split('/').pop()}: ${Math.round((r.transferSize || r.encodedBodySize) / 1024)}K/${Math.round(r.duration)}ms`))
console.log('[5] 资源传输:\n   ' + res.join('\n   '))

await page.waitForTimeout(1200) // 等 bot 走位/枪模取景稳定
await page.screenshot({ path: `${outDir}/02-ingame.png` })
// 凑近看贴图：开一枪让枪口焰/枪身同帧，多采几张 bot 出场帧
for (let i = 0; i < 3; i++) {
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${outDir}/03-bot-${i}.png` })
}

console.log(`[6] console/page 错误: ${errors.length ? '\n   ' + errors.join('\n   ') : '无'}`)
await browser.close()
process.exit(errors.length ? 2 : 0)
