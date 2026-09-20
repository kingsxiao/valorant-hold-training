// 资产到货即着色器预热（main.js prewarmTemplates）回归锁：
//  - 帮助函数行为：到货的模板根临时挂 scene → engine.prewarm() → 同步块内
//    立即摘除（渲染循环观察不到挂载中间态）；非 Object3D 入参（缺位资产/空池）
//    静默跳过，prewarm 照发——vmScene 侧（官方手臂/新枪模）的连带初始化
//    不依赖模板根是否非空
//  - 接线：关键批（.then）与后台批（onLate）两个到货回调都必须调它，且在
//    wireViewmodels / setOfficialArms 之后（材质先挂进场景再编译）——漏一处，
//    该批资产的首次使用就回到 ~100ms 着色器编译长帧（首轮交火卡顿）
//  - 底座：Engine.prewarm 必须仍编译主场景 + vmScene 两个场景（vmScene 侧的
//    手臂/枪模覆盖全靠第二个 compile）
// main.js 是 DOM/WebGL 绑定的启动模块（顶层即建 renderer），node 环境无法整量
// import——函数体从源码原样提取（非复刻）后针对假 engine 跑真实行为
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'

const read = (p) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', p), 'utf8')
const src = read('src/main.js')

const fnMatch = src.match(/^function prewarmTemplates\([\s\S]*?\n\}/m)
const engineSrc = read('src/core/Engine.js')

// 从 main.js 提取的 prewarmTemplates（绑定假 engine 后即真实线上代码）
const makePrewarm = (engine) => new Function('engine', `${fnMatch[0]}\nreturn prewarmTemplates`)(engine)

const segment = (from, to) => {
  const i = src.indexOf(from)
  expect(i, `main.js 应包含 ${from}`).toBeGreaterThanOrEqual(0)
  const j = src.indexOf(to, i)
  expect(j, `main.js 的 ${from} 之后应有 ${to}`).toBeGreaterThan(i)
  return src.slice(i, j)
}

describe('prewarmTemplates：挂上→预热→摘除', () => {
  it('prewarm 瞬间模板根已全部在场景内（compile 只遍历场景内对象），结束后脱离', () => {
    const seen = []
    const scene = new THREE.Scene()
    const a = new THREE.Object3D(); a.name = 'agent-jett'
    const b = new THREE.Object3D(); b.name = 'vandal-tpl'
    const engine = {
      scene,
      prewarm: () => seen.push(`jett:${scene.children.includes(a)},vandal:${scene.children.includes(b)}`),
    }

    makePrewarm(engine)(a, b)
    expect(seen, 'prewarm 执行时模板必须已挂上').toEqual(['jett:true,vandal:true'])
    expect(scene.children).toEqual([]) // 摘除干净，渲染循环观察不到挂载中间态
    expect(a.parent).toBeNull()
    expect(b.parent).toBeNull()
  })

  it('非 Object3D 入参静默跳过（缺位资产/空池）；无有效根时 prewarm 仍发（vmScene 连带不依赖模板根）', () => {
    const scene = new THREE.Scene()
    let prewarmCount = 0
    let midCount = -1 // prewarm 瞬间的场景内根数（挂/摘之外无法观察）
    const engine = {
      scene,
      prewarm: () => { prewarmCount++; midCount = scene.children.length },
    }
    const only = new THREE.Object3D(); only.name = 'phantom-tpl'

    makePrewarm(engine)(null, undefined, {}, 'vandal', only)
    expect(midCount).toBe(1) // 只有有效根被挂上
    expect(scene.children.length).toBe(0) // 结束后摘除
    expect(only.parent).toBeNull()
    makePrewarm(engine)() // 空入参：模板全缺位
    expect(prewarmCount).toBe(2) // 两次都补了 vmScene 侧的预热
    expect(scene.children.length).toBe(0)
  })
})

describe('到货回调接线（漏一处＝该批资产首次使用吃编译长帧）', () => {
  it('prewarmTemplates 函数体存在且完整（提取失败＝被改名/删除）', () => {
    expect(fnMatch, 'main.js 应定义 function prewarmTemplates').toBeTruthy()
  })

  it('关键批 .then：wireViewmodels 之后调 prewarmTemplates，英雄 root 与枪模模板都在入参里', () => {
    const then = segment('.then(({ agents, viewmodels, glove, hands }) => {', '}).catch(')
    const callAt = then.indexOf('prewarmTemplates(')
    expect(callAt).toBeGreaterThanOrEqual(0)
    expect(then.indexOf('wireViewmodels(viewmodels)'), '.then 内先接线枪模再预热').toBeLessThan(callAt)
    expect(then).toContain('.map(a => a.root)')
    expect(then).toContain('Object.values(Bot.weaponTemplates ?? {})')
  })

  it('后台批 onLate：setOfficialArms 之后调 prewarmTemplates（手臂先进 vmScene 再编译）', () => {
    const late = segment('loadUserAssets((assets) => {', '})\n  .then(')
    const callAt = late.indexOf('prewarmTemplates(')
    expect(callAt).toBeGreaterThanOrEqual(0)
    expect(late.indexOf('if (assets.fpArms) weapons.setOfficialArms'), 'onLate 内先装官方手臂再预热').toBeLessThan(callAt)
    expect(late).toContain('.map(t => t.root)')
    expect(late).toContain('Object.values(Bot.weaponTemplates ?? {})')
  })

  it('Engine.prewarm 仍编译主场景 + vmScene（vmScene 侧覆盖全靠第二个 compile）', () => {
    const start = engineSrc.indexOf('prewarm() {')
    expect(start, 'Engine.js 应定义 prewarm() 方法').toBeGreaterThanOrEqual(0)
    // 注：_recordFrame 首次出现在 start() 里（早于方法定义），必须从 start 之后找
    const prewarmBody = engineSrc.slice(start, engineSrc.indexOf('_recordFrame', start))
    expect(prewarmBody).toContain('this.renderer.compile(this.scene, this.camera)')
    expect(prewarmBody).toContain('this.renderer.compile(this.vmScene, this.vmCamera)')
  })
})
