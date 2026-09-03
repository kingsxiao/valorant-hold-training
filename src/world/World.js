// 世界碰撞：AABB 集合上的胶囊移动 + 光线投射（射线检测同时用于命中判定与视线遮挡）
// 全部为扁平数组运算，128Hz 下开销可忽略

// 射线 vs 球体（命中区域判定）：返回入射 t 或 null（未命中 / 球心在射线后方）
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz
  const tca = lx * dx + ly * dy + lz * dz
  if (tca < 0) return null
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca
  const r2 = r * r
  if (d2 > r2) return null
  return tca - Math.sqrt(r2 - d2)
}

export class World {
  constructor() {
    this.solids = []           // { x0,y0,z0, x1,y1,z1 }
  }

  addSolid(x0, y0, z0, x1, y1, z1) {
    this.solids.push({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), z1: Math.max(z0, z1) })
  }

  // 沿单轴移动并解算（分轴推进天然形成沿墙滑动）
  // 返回 { hit, boundary }，并原地修正 pos
  moveAxis(pos, r, h, axis, delta) {
    if (delta === 0) return { hit: false }
    pos[axis] += delta
    let hit = false, boundary = 0
    for (let i = 0; i < this.solids.length; i++) {
      const s = this.solids[i]
      if (pos.x + r <= s.x0 || pos.x - r >= s.x1) continue
      if (pos.z + r <= s.z0 || pos.z - r >= s.z1) continue
      if (pos.y + h <= s.y0 || pos.y >= s.y1) continue
      // 相交 —— 沿移动轴推出
      hit = true
      if (axis === 'y') {
        if (delta < 0) { boundary = s.y1; pos.y = boundary + 0.001 }
        else { boundary = s.y0; pos.y = boundary - h - 0.001 }
      } else {
        if (delta > 0) { boundary = s[axis + '0']; pos[axis] = boundary - r - 0.001 }
        else { boundary = s[axis + '1']; pos[axis] = boundary + r + 0.001 }
      }
    }
    return { hit, boundary }
  }

  // 射线 vs 所有 AABB，返回最近命中 { t, x,y,z, nx,ny,nz } 或 null
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let bestT = maxDist, best = null
    const idx = 1 / (dx || 1e-12), idy = 1 / (dy || 1e-12), idz = 1 / (dz || 1e-12)
    for (let i = 0; i < this.solids.length; i++) {
      const s = this.solids[i]
      let t1 = (s.x0 - ox) * idx, t2 = (s.x1 - ox) * idx
      let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2)
      let axis = 0
      t1 = (s.y0 - oy) * idy; t2 = (s.y1 - oy) * idy
      if (Math.min(t1, t2) > tmin) { tmin = Math.min(t1, t2); axis = 1 }
      tmax = Math.min(tmax, Math.max(t1, t2))
      t1 = (s.z0 - oz) * idz; t2 = (s.z1 - oz) * idz
      if (Math.min(t1, t2) > tmin) { tmin = Math.min(t1, t2); axis = 2 }
      tmax = Math.min(tmax, Math.max(t1, t2))
      if (tmax < Math.max(tmin, 0) || tmin > bestT || tmin < 0) continue
      bestT = tmin; best = { t: tmin, axis }
    }
    if (!best) return null
    const n = [0, 0, 0]
    n[best.axis] = (best.axis === 0 ? dx : best.axis === 1 ? dy : dz) > 0 ? -1 : 1
    return {
      t: best.t,
      x: ox + dx * best.t, y: oy + dy * best.t, z: oz + dz * best.t,
      nx: n[0], ny: n[1], nz: n[2],
    }
  }

  // 视线检测（点 a → 点 b 是否被几何遮挡）
  lineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const dist = Math.hypot(dx, dy, dz)
    if (dist < 1e-6) return true
    const hit = this.raycast(ax, ay, az, dx / dist, dy / dist, dz / dist, dist - 0.05)
    return !hit
  }
}
