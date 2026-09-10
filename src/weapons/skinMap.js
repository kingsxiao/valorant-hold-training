// 武器皮肤目录与键解析（纯函数，WeaponSystem 与设置面板/测试共用）。
// 皮肤枪模在 customVms 里的键形如 '<weapon>:<skin>'（vandal:aristocrat）；
// 底层武器（取景 FRAMING / GLOVE_POSES 握姿 / 机件推导）一律按 ':' 前的
// 武器 id 走 —— 皮肤是同一把枪的贴图/附件变体，全部标定与默认皮肤共用。
// 皮肤 GLB 来源：Rocklan 包官方 .blend（内部代号即皮肤系名，如 ArtDeco =
// 商城 Aristocrat 收藏集），管线 blend2glb.py → weapon-glb-patch.mjs --flip-y
// → optimize:models，与默认皮肤同约定（枪口 -X 作者系）。

export const SKINS = {
  vandal: [
    { id: 'default', label: '默认' },
    { id: 'aristocrat', label: 'Aristocrat（鎏金）', file: 'viewmodel-vandal-aristocrat.glb' },
  ],
}

// weaponId + 皮肤 id → customVms 键。皮肤不可用（GLB 缺失未挂载）时回退武器本体。
export function vmKeyFor(weaponId, skin, available) {
  if (!skin || skin === 'default') return weaponId
  const key = `${weaponId}:${skin}`
  return available && key in available ? key : weaponId
}

// 'vandal:aristocrat' → 'vandal'（普通键原样返回）
export function baseWeaponOf(key) {
  return String(key).split(':')[0]
}

// 设置面板/存档清洗：白名单外的皮肤 id 回退 default
export function sanitizeSkin(weaponId, skin) {
  return (SKINS[weaponId] ?? []).some(s => s.id === skin) ? skin : 'default'
}
