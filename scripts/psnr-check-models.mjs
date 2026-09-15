// 旧版 GLB（git 原始 PNG 贴图）vs 新版（再编码 JPEG/WebP）逐贴图 PSNR 体检。
// 纹理经 dedup/prune 后条目可能增减 → 按 (宽x高) 分组、组内按序配对；
// 数量不匹配的组报告出来人工看。用法：node scripts/psnr-check-models.mjs
import { NodeIO } from '@gltf-transform/core'
import { EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions'
import sharp from 'sharp'

const io = new NodeIO().registerExtensions([KHRMeshQuantization, EXTTextureWebP])

async function texProfile(file) {
  const doc = await io.read(file)
  const root = doc.getRoot()
  const role = new Map()
  const mark = (t, r) => { if (t && !role.has(t)) role.set(t, r) }
  for (const m of root.listMaterials()) {
    mark(m.getNormalTexture(), 'normal')
    mark(m.getBaseColorTexture(), 'color')
    mark(m.getEmissiveTexture(), 'color')
  }
  return root.listTextures().map(t => {
    const s = t.getSize()
    return { w: s[0], h: s[1], role: role.get(t) ?? 'data', bytes: Buffer.from(t.getImage()) }
  })
}

async function psnr(a, b) {
  const A = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const B = await sharp(b).ensureAlpha().resize(A.info.width, A.info.height).raw().toBuffer()
  let se = 0
  for (let i = 0; i < A.data.length; i += 4)
    for (let c = 0; c < 3; c++) { const d = A.data[i + c] - B[i + c]; se += d * d }
  const mse = se / (A.info.width * A.info.height * 3)
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse)
}

const files = process.argv.slice(2)
for (const name of files) {
  const oldT = await texProfile(`/tmp/orig-glb/${name}.glb`)
  const newT = await texProfile(`public/models/${name}.glb`)
  const groups = new Map()
  for (const t of oldT) {
    const k = `${t.w}x${t.h}`
    groups.get(k)?.old.push(t) ?? groups.set(k, { old: [t], new: [] })
  }
  const g2 = new Map()
  for (const t of newT) {
    const k = `${t.w}x${t.h}`
    if (!g2.has(k)) g2.set(k, [])
    g2.get(k).push(t)
  }
  console.log(`\n== ${name}`)
  for (const [k, g] of groups) {
    const ns = g2.get(k) ?? []
    if (ns.length !== g.old.length) console.log(`  [${k}] 数量不匹配 old:${g.old.length} new:${ns.length}（dedup/prune 并入，跳过该组）`)
    for (let i = 0; i < Math.min(g.old.length, ns.length); i++) {
      const p = await psnr(g.old[i].bytes, ns[i].bytes)
      console.log(`  [${k}][${ns[i].role}] ${(g.old[i].bytes.length / 1024) | 0}K→${(ns[i].bytes.length / 1024) | 0}K  PSNR:${p === Infinity ? 'inf' : p.toFixed(1)}dB`)
    }
  }
}
