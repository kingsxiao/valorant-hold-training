// 武器皮肤：键解析纯函数（skinMap）+ 皮肤 GLB 回归锁（Aristocrat 转换配方不回退）
//  - vmKeyFor：皮肤键 'vandal:aristocrat'，缺位回退武器本体（GLB 没加载不至于没枪）
//  - GLB 二进制 JSON chunk 直接解析（与 scripts/weapon-glb-patch.mjs 同口径）：
//    MRS 必须已摘（否则全黑剪影）、无 AEM 自发光挂接（默认皮肤曾整枪橘光）、
//    muzzle_flip 根节点旋转在位（枪口 +X → -X 作者系约定）
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SKINS, vmKeyFor, baseWeaponOf, sanitizeSkin } from '../src/weapons/skinMap.js'

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
    expect(baseWeaponOf('phantom')).toBe('phantom')
  })
  it('sanitizeSkin 白名单外回退 default', () => {
    expect(sanitizeSkin('vandal', 'aristocrat')).toBe('aristocrat')
    expect(sanitizeSkin('vandal', 'prime')).toBe('default')
    expect(sanitizeSkin('vandal', undefined)).toBe('default')
    expect(sanitizeSkin('phantom', 'aristocrat')).toBe('default')
  })
  it('皮肤目录：default 无文件，其余有 GLB 文件名', () => {
    expect(SKINS.vandal.some(s => s.id === 'default' && !s.file)).toBe(true)
    for (const s of SKINS.vandal.filter(s => s.id !== 'default')) {
      expect(s.file).toMatch(/^viewmodel-vandal-[a-z0-9]+\.glb$/)
    }
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
