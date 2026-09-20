// 武器皮肤：键解析纯函数（skinMap）+ 皮肤 GLB 回归锁（Aristocrat 转换配方不回退）
//  - vmKeyFor：皮肤键 'vandal:aristocrat'，缺位回退武器本体（GLB 没加载不至于没枪）
//  - GLB 二进制 JSON chunk 直接解析（与 scripts/weapon-glb-patch.mjs 同口径）：
//    MRS 必须已摘（否则全黑剪影）、无 AEM 自发光挂接（默认皮肤曾整枪橘光）、
//    muzzle_flip 根节点旋转在位（枪口 +X → -X 作者系约定）
//  - P3 按需拉取：requestSkin 的触发条件/负缓存/在途去重/到货通知，以及皮肤
//    GLB 会话中途到货时 WeaponSystem 的增量装配路径（setSkin 先记账、
//    setCustomViewmodel 后到自动切换显隐）——这是唯一一条会话中途到货的
//    装配路径，不锁住就是裸奔
//  - 接线锁：Menu 点选触发 / main 第三条到货线与启动补拉 / 后台批不再整批拉皮肤
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 外设桩（flash-system.test.js 同款）：Textures（canvas 2D 程序化贴图 → 空
// 贴图组）/ GLTFLoader（requestSkin 走 parse(ArrayBuffer)，行为由 parseCtl
// 逐用例注入）/ document（baseURI 拼拉取 URL）/ fetch（逐用例记账与结果注入）
vi.mock('../src/world/Textures.js', () => ({
  Tex: new Proxy({}, { get: () => () => ({}) }),
}))
const parseCtl = { impl: null }
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { parse(buf, path, onLoad, onError) { (parseCtl.impl ?? ((b, p, onL) => onL(null)))(buf, path, onLoad, onError) } },
}))
vi.stubGlobal('document', { baseURI: 'http://vht.test/' })

import * as THREE from 'three'
import { SKINS, vmKeyFor, baseWeaponOf, sanitizeSkin, soundKindFor } from '../src/weapons/skinMap.js'
import { WeaponSystem } from '../src/weapons/WeaponSystem.js'

describe('skinMap 键解析', () => {
  it('default/空皮肤 → 武器本体键', () => {
    expect(vmKeyFor('vandal', 'default', {})).toBe('vandal')
    expect(vmKeyFor('vandal', null, {})).toBe('vandal')
    expect(vmKeyFor('phantom', 'aristocrat', {})).toBe('phantom') // 皮肤目录只登记 vandal
  })
  it('皮肤可用 → 皮肤键；缺位回退本体', () => {
    const avail = { vandal: {}, 'vandal:aristocrat': {} }
    expect(vmKeyFor('vandal', 'aristocrat', avail)).toBe('vandal:aristocrat')
    expect(vmKeyFor('vandal', 'aristocrat', { vandal: {} })).toBe('vandal')
  })
  it('baseWeaponOf 剥皮肤后缀；普通键原样', () => {
    expect(baseWeaponOf('vandal:aristocrat')).toBe('vandal')
    expect(baseWeaponOf('vandal:chaos')).toBe('vandal')
    expect(baseWeaponOf('phantom')).toBe('phantom')
  })
  it('sanitizeSkin 白名单外回退 default', () => {
    expect(sanitizeSkin('vandal', 'aristocrat')).toBe('aristocrat')
    expect(sanitizeSkin('vandal', 'chaos')).toBe('chaos')
    expect(sanitizeSkin('vandal', 'prime')).toBe('default')
    expect(sanitizeSkin('vandal', undefined)).toBe('default')
    expect(sanitizeSkin('phantom', 'aristocrat')).toBe('default')
  })
  it('皮肤目录：default 无文件，其余有 GLB 文件名（投放位，缺文件运行时回退本体）', () => {
    expect(SKINS.vandal.some(s => s.id === 'default' && !s.file)).toBe(true)
    for (const s of SKINS.vandal.filter(s => s.id !== 'default')) {
      expect(s.file).toMatch(/^viewmodel-vandal-[a-z0-9]+\.glb$/)
    }
  })
  it('混沌序曲在册：音效皮肤（GLB 投放位 + rifle_chaos 音色）', () => {
    const chaos = SKINS.vandal.find(s => s.id === 'chaos')
    expect(chaos, 'chaos 皮肤条目存在').toBeTruthy()
    expect(chaos.file).toBe('viewmodel-vandal-chaos.glb') // 投放位：仓库不带，缺位回退本体枪模
    expect(chaos.audio).toBe('rifle_chaos')
  })
})

describe('soundKindFor（音效皮肤 → 开火音色）', () => {
  it('混沌序曲 → rifle_chaos（WeaponSystem._fireOne 消费，弹道不动）', () => {
    expect(soundKindFor('vandal', 'chaos')).toBe('rifle_chaos')
  })
  it('无 audio 字段的皮肤 / 默认皮肤 → null（用武器默认音色）', () => {
    expect(soundKindFor('vandal', 'default')).toBeNull()
    expect(soundKindFor('vandal', 'aristocrat')).toBeNull() // 有 GLB 无音效包：仍用本体音色
  })
  it('未知皮肤 / 其他武器（皮肤目录只登记 vandal）→ null', () => {
    expect(soundKindFor('vandal', 'ion')).toBeNull()
    expect(soundKindFor('phantom', 'chaos')).toBeNull()
    expect(soundKindFor('classic', 'chaos')).toBeNull()
  })
})

describe('Aristocrat 皮肤 GLB 转换配方回归', () => {
  const file = resolve('public/models/viewmodel-vandal-aristocrat.glb')
  let json = null
  try { json = parseGlbJson(file) } catch { /* 文件缺席（如 CI 未带资产）时跳过 */ }

  it.skipIf(!json)('AK 材质：MRS 已摘 + 无自发光挂接（防橘光/黑剪影回退）', () => {
    const ak = json.materials.find(m => /^AK_/i.test(m.name ?? ''))
    expect(ak, 'AK 材质存在').toBeTruthy()
    expect(ak.pbrMetallicRoughness?.metallicRoughnessTexture).toBeUndefined()
    expect(ak.pbrMetallicRoughness?.metallicFactor).toBeCloseTo(0.3, 5)
    expect(ak.pbrMetallicRoughness?.roughnessFactor).toBeCloseTo(0.5, 5)
    expect(ak.emissiveTexture).toBeUndefined()
    expect((ak.emissiveFactor ?? [0, 0, 0]).every(v => v === 0)).toBe(true)
  })

  it.skipIf(!json)('muzzle_flip 根节点旋转在位（枪口对齐 -X 作者系）', () => {
    const flip = (json.nodes ?? []).find(n => n.name === 'muzzle_flip')
    expect(flip, 'muzzle_flip 包装节点存在').toBeTruthy()
    expect(flip.rotation).toEqual([0, 1, 0, 0]) // XYZW：180° 绕 Y
    const sceneNode = json.scenes?.[0]?.nodes ?? []
    expect(sceneNode).toContain(json.nodes.indexOf(flip))
  })

  it.skipIf(!json)('官方 ArtDeco 贴图在位（AK/RedDot 漫反射 + 法线）', () => {
    const names = (json.images ?? []).map(i => i.name ?? '')
    expect(names.some(n => /AK_ArtDeco_DF/.test(n))).toBe(true)
    expect(names.some(n => /RedDot_ArtDeco_DF/.test(n))).toBe(true)
    expect(names.some(n => /ArtDeco_NM/.test(n))).toBe(true)
  })
})

function parseGlbJson(file) {
  const buf = readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not glb') // 'glTF'
  const jsonLen = buf.readUInt32LE(12)
  return JSON.parse(buf.slice(20, 20 + jsonLen).toString())
}

// ============================================================================
// P3：皮肤 GLB 按需拉取（UserAssets.requestSkin）
// 触发条件必须是「条目带 file」而不是「非 default」：默认皮肤恰是 chaos
// （Menu 出厂 + 存量迁移），而 chaos 是投放位（仓库无 GLB）——条件写反会让
// 默认用户每次点击都重发必然 404 的请求。负缓存/在途去重/到货通知在此锁死。
// ============================================================================
const flush = () => new Promise((r) => setTimeout(r, 0)) // 走空微任务队列（fetch/parse 链）

describe('requestSkin：按需拉取与负缓存', () => {
  const fetchLog = []
  const fetchCtl = { ok: false, status: 404 } // 默认 404 = chaos 投放位缺文件形态
  const glbScene = () => {
    const g = new THREE.Group()
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.9), new THREE.MeshStandardMaterial()))
    return g
  }

  beforeEach(() => {
    vi.resetModules() // 皮肤请求状态（skinRequests）是模块级：每用例重开一张白纸
    fetchLog.length = 0
    Object.assign(fetchCtl, { ok: false, status: 404 })
    parseCtl.impl = null
    vi.stubGlobal('fetch', async (url) => {
      fetchLog.push(String(url))
      return { ok: fetchCtl.ok, status: fetchCtl.status, arrayBuffer: async () => new ArrayBuffer(8) }
    })
  })

  it('default（无 file）与未知皮肤：不发任何请求', async () => {
    const { requestSkin } = await import('../src/core/UserAssets.js')
    requestSkin('default')
    requestSkin('ion')
    await flush()
    expect(fetchLog).toEqual([])
  })

  it('chaos 投放位缺文件（404）：只发一次，负缓存后重复请求不再重发', async () => {
    const { requestSkin, onSkinArrival } = await import('../src/core/UserAssets.js')
    const arrivals = []
    onSkinArrival((vm) => arrivals.push(vm))
    requestSkin('chaos') // 默认皮肤的启动补拉即此形态
    await flush()
    requestSkin('chaos') // 用户随后在菜单点 chaos（默认选中项）
    requestSkin('chaos')
    await flush()
    expect(fetchLog).toEqual(['http://vht.test/models/viewmodel-vandal-chaos.glb'])
    expect(arrivals).toEqual([]) // 失败路径不通知到货（main 不空跑接线）
  })

  it('aristocrat 到货：onSkinArrival 收到增量 viewmodels（仅皮肤键、归一化 Object3D）；再请求不重发', async () => {
    fetchCtl.ok = true; fetchCtl.status = 200
    parseCtl.impl = (buf, path, onLoad) => onLoad({ scene: glbScene() })
    const { requestSkin, onSkinArrival } = await import('../src/core/UserAssets.js')
    const arrivals = []
    onSkinArrival((vm) => arrivals.push(vm))
    requestSkin('aristocrat')
    await flush()
    expect(fetchLog).toEqual(['http://vht.test/models/viewmodel-vandal-aristocrat.glb'])
    expect(arrivals.length).toBe(1)
    // 增量：只带新键——wireViewmodels 靠 appliedVmKeys 过滤已接键，多带旧键会二次包裹枪体
    expect(Object.keys(arrivals[0])).toEqual(['vandal:aristocrat'])
    const vm = arrivals[0]['vandal:aristocrat']
    expect(vm?.isObject3D, '到货的是归一化后的枪模场景').toBe(true)
    requestSkin('aristocrat')
    await flush()
    expect(fetchLog.length).toBe(1) // 已到货：缓存命中，不重发
    expect(arrivals.length).toBe(1)
  })

  it('在途去重：请求未决时连发只发一次 fetch；到货后亦不重发', async () => {
    fetchCtl.ok = true; fetchCtl.status = 200
    let release = null
    parseCtl.impl = (buf, path, onLoad) => { release = () => onLoad({ scene: glbScene() }) }
    const { requestSkin } = await import('../src/core/UserAssets.js')
    requestSkin('chaos')
    requestSkin('chaos')
    requestSkin('chaos')
    await flush()
    expect(fetchLog.length).toBe(1) // 三次请求合并为一次在途 fetch
    release()
    await flush()
    requestSkin('chaos')
    await flush()
    expect(fetchLog.length).toBe(1) // 到货后同样命中缓存
  })

  it('损坏文件（parse 报错 / 空场景）同样负缓存，不通知到货', async () => {
    fetchCtl.ok = true; fetchCtl.status = 200
    parseCtl.impl = (buf, path, onLoad, onError) => onError(new Error('bad glb'))
    const { requestSkin, onSkinArrival } = await import('../src/core/UserAssets.js')
    const arrivals = []
    onSkinArrival((vm) => arrivals.push(vm))
    requestSkin('aristocrat')
    await flush()
    requestSkin('aristocrat')
    await flush()
    expect(fetchLog.length).toBe(1)
    expect(arrivals).toEqual([])
  })
})

// ============================================================================
// 会话中途到货装配（WeaponSystem）：点选时 GLB 未到 → setSkin 只记账（解析键
// 回退本体）；皮肤 GLB 异步到货 → main 第三条到货线增量 setCustomViewmodel
// （只带皮肤键）→ weaponMeshFor 显隐自动切换。P3 新增的唯一一条会话中途
// 到货装配路径。
// ============================================================================
describe('WeaponSystem：皮肤 GLB 会话中途到货的增量装配', () => {
  const glbScene = () => {
    const g = new THREE.Group()
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.9), new THREE.MeshStandardMaterial()))
    return g
  }
  const makeWeapons = () => new WeaponSystem({
    camera: new THREE.PerspectiveCamera(),
    vmCamera: new THREE.PerspectiveCamera(),
    world: {}, bots: {}, fx: {}, audio: {},
    player: { moveSpeed: 0, crouchAmt: 0, grounded: true },
  })

  it('皮肤 GLB 缺位：setSkin 解析键回退本体（vmKeyFor），玩家枪不变', () => {
    const w = makeWeapons()
    w.setCustomViewmodel({ vandal: glbScene() })
    w.setSkin('aristocrat') // 点选时 GLB 未到：只记账 this.skin
    expect(w.activeCustomVm('vandal')).toBe(w.customVms.vandal)
    expect(w.customVms.vandal.visible).toBe(true)
    expect(w.customVms['vandal:aristocrat']).toBeUndefined()
  })

  it('到货后增量 setCustomViewmodel（只带皮肤键）：玩家枪自动切皮肤件，本体隐藏', () => {
    const w = makeWeapons()
    w.setCustomViewmodel({ vandal: glbScene() })
    w.setSkin('aristocrat')
    w.setCustomViewmodel({ 'vandal:aristocrat': glbScene() }) // 第三条到货线的增量接线
    const skin = w.customVms['vandal:aristocrat']
    expect(skin, '皮肤键进 customVms').toBeTruthy()
    expect(w.activeCustomVm('vandal')).toBe(skin) // vmKeyFor 命中皮肤键
    expect(skin.visible, 'weaponMeshFor 末尾显隐已切到皮肤件').toBe(true)
    expect(w.customVms.vandal.visible).toBe(false)
    // 枪口点位跟随激活件（FX.muzzle 枪口焰/点光定位用）
    expect(w.muzzleOffset.toArray()).toEqual(skin.userData.muzzle.toArray())
    w.setSkin('aristocrat') // 幂等：到货后 applyAll 重跑 setSkin 不丢皮肤
    expect(w.activeCustomVm('vandal')).toBe(skin)
    expect(skin.visible).toBe(true)
  })

  it('切回 default：皮肤键留存于池但不激活（投放位文件到过就不碍事）', () => {
    const w = makeWeapons()
    w.setCustomViewmodel({ vandal: glbScene() })
    w.setCustomViewmodel({ 'vandal:aristocrat': glbScene() })
    w.setSkin('default')
    expect(w.activeCustomVm('vandal')).toBe(w.customVms.vandal)
    expect(w.customVms.vandal.visible).toBe(true)
    expect(w.customVms['vandal:aristocrat'].visible).toBe(false)
  })
})

// ============================================================================
// 接线锁（源码顺序锁，手法同 prewarm-arrival.test.js）：Menu 点选触发 /
// main 第三条到货线 + 启动补拉 / 后台批摘除皮肤整批拉取
// ============================================================================
describe('按需拉取接线锁', () => {
  const read = (p) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', p), 'utf8')

  it('Menu 皮肤按钮 onclick 触发 requestSkin(s.id)', () => {
    const src = read('src/ui/Menu.js')
    const seg = src.slice(src.indexOf('[data-group=weaponSkin]'))
    const onClick = seg.slice(0, seg.indexOf('skBox.appendChild'))
    expect(onClick, '皮肤按钮点击应触发按需拉取').toContain('requestSkin(s.id)')
  })

  it('main 第三条到货线：onSkinArrival → wireViewmodels → prewarmTemplates（顺序锁）', () => {
    const src = read('src/main.js')
    const i = src.indexOf('onSkinArrival((viewmodels) => {')
    expect(i, 'main.js 应注册 onSkinArrival 第三条到货线').toBeGreaterThanOrEqual(0)
    const j = src.indexOf('wireViewmodels(viewmodels)', i)
    const k = src.indexOf('prewarmTemplates(', j)
    expect(j, '到货回调先增量接线枪模（尾部补 applyWeaponSkin）').toBeGreaterThan(i)
    expect(k, '接线后到货即预热').toBeGreaterThan(j)
  })

  it('main 启动补拉：requestSkin(state.cfg.weaponSkin)（localStorage 恢复皮肤在本会话的唯一触发路径）', () => {
    expect(read('src/main.js')).toContain('requestSkin(state.cfg.weaponSkin)')
  })

  it('UserAssets 后台批不再整批拉皮肤 GLB（按需化的收益本体：默认 chaos 用户省 1.9MB 传输 + 34.5MB VRAM）', () => {
    const src = read('src/core/UserAssets.js')
    const batch = src.slice(src.indexOf('const rest = await Promise.all'), src.indexOf('onLate(out)'))
    expect(batch).not.toContain('SKIN_GLB')
    expect(src).toContain('export function requestSkin')
  })
})
