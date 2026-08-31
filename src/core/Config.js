// ============================================================================
// 全局数值配置 —— 所有"手感"参数集中在这里，便于对照调校
// 数值参考 Valorant 公开资料（移速 / 射速 / 伤害 / 灵敏度换算均为功能参数）。
// 建模与地图为程序化生成的原创近似（官方美术资产有版权，不能提取复用）。
// ============================================================================

export const CONFIG = {
  sim: {
    tickHz: 128,            // 逻辑帧率（与 Valorant 服务器 tick 一致，保证确定性手感）
    maxStepsPerFrame: 6,
  },

  movement: {
    runSpeed: 5.4,          // m/s 步枪全速奔跑（Valorant 主武器跑速）
    knifeSpeed: 6.75,       // m/s 持刀跑速
    walkMult: 0.5,          // Shift 静步 = 50%（且无声）
    crouchMult: 0.34,       // 蹲下移速 ≈ 1.8 m/s
    groundAccel: 55,        // m/s² 地面加速（~0.1s 达全速，接近游戏的急促加速感）
    groundDecel: 55,        // m/s² 松键滑行减速
    counterStrafeMult: 1.6, // 按反方向键时的额外减速倍率（急停/counter-strafe）
    airAccel: 4,            // 空中操控加速度
    gravity: 22,            // m/s²（跳跃高度 ≈0.79m、滞空 ≈0.54s，接近游戏跳跃弧线）
    jumpVel: 5.9,
    eyeHeight: 1.65,        // 站立视线高度
    crouchEyeHeight: 1.18,
    playerHeight: 1.8,      // 胶囊总高（探身/掩体尺寸以此为基准）
    crouchHeight: 1.28,
    playerRadius: 0.4,
    tagSlow: 0.72,          // 被子弹命中后的减速到 72%（tagging）
    tagDuration: 0.55,
    crouchLerpTime: 0.14,   // 蹲起过渡
  },

  mouse: {
    yawPerCount: 0.07,      // 灵敏度 1.0 时每计数 0.07°（与 Valorant 同换算：CS sens × 3.18）
    defaultSens: 0.4,
    pitchLimit: 89,
  },

  // ---- 武器（射速/伤害为公开资料值；散布与后坐力为调校近似）----
  weapons: {
    vandal: {
      name: 'Vandal', slot: 'primary', auto: true,
      fireRate: 9.75, magSize: 25, reserve: 75, reloadTime: 2.5, equipTime: 0.75,
      damage: { head: 160, body: 40, leg: 34 }, falloff: null,   // Vandal 全距离不变
      spread: { stand: 0.2, run: 4.5, walk: 1.1, crouchMult: 0.85, jump: 7 },
      recoil: { recoverTime: 0.4, viewPunch: 0.34 },             // 弹道后坐恢复
      moveSpeedMult: 1.0,
      sound: 'rifle',
    },
    phantom: {
      name: 'Phantom', slot: 'primary', auto: true,
      fireRate: 11, magSize: 30, reserve: 90, reloadTime: 2.5, equipTime: 0.75,
      damage: { head: 156, body: 39, leg: 33 },
      falloff: [                                                 // 距离衰减（Phantom 特性）
        { maxDist: 15, damage: { head: 156, body: 39, leg: 33 } },
        { maxDist: 30, damage: { head: 140, body: 35, leg: 30 } },
        { maxDist: Infinity, damage: { head: 124, body: 31, leg: 26 } },
      ],
      spread: { stand: 0.15, run: 4.0, walk: 0.9, crouchMult: 0.85, jump: 6.5 },
      recoil: { recoverTime: 0.38, viewPunch: 0.3 },
      moveSpeedMult: 1.0,
      sound: 'rifle',
    },
    sheriff: {
      name: 'Sheriff', slot: 'primary', auto: false,
      fireRate: 4, magSize: 6, reserve: 24, reloadTime: 2.25, equipTime: 0.75,
      damage: { head: 159, body: 55, leg: 46 }, falloff: null,
      spread: { stand: 0.25, run: 5.5, walk: 1.6, crouchMult: 0.85, jump: 8 },
      recoil: { recoverTime: 0.6, viewPunch: 0.9 },
      moveSpeedMult: 1.0,
      sound: 'handcannon',
    },
    classic: {
      name: 'Classic', slot: 'secondary', auto: false,
      burst: true,                                               // 右键三连发
      fireRate: 6.75, magSize: 12, reserve: 36, reloadTime: 1.75, equipTime: 0.75,
      damage: { head: 78, body: 26, leg: 22 }, falloff: null,
      spread: { stand: 0.4, run: 4.0, walk: 1.4, crouchMult: 0.85, jump: 6 },
      recoil: { recoverTime: 0.35, viewPunch: 0.45 },
      moveSpeedMult: 1.0,
      sound: 'pistol',
    },
    ghost: {
      name: 'Ghost', slot: 'secondary', auto: false,
      fireRate: 6.75, magSize: 15, reserve: 45, reloadTime: 1.5, equipTime: 0.75,
      damage: { head: 105, body: 30, leg: 26 }, falloff: null,
      spread: { stand: 0.12, run: 3.5, walk: 1.0, crouchMult: 0.85, jump: 5 },
      recoil: { recoverTime: 0.3, viewPunch: 0.35 },
      moveSpeedMult: 1.0,
      sound: 'pistol',
    },
    knife: {
      name: 'Tactical Knife', slot: 'melee', auto: false,
      fireRate: 1.33, magSize: Infinity, equipTime: 0.5,
      damage: { head: 50, body: 50, leg: 50 }, range: 1.9,
      moveSpeedMult: 1.25,                                       // 持刀 = 6.75 m/s
      sound: 'knife',
    },
  },

  // ---- 机器人（模拟真人 peek：与玩家同移速模型）----
  bot: {
    health: 100,
    moveSpeed: 5.4,         // Bot 拉出角度的横移速度 = 玩家全速
    walkSpeed: 2.7,
    accel: 55, decel: 55,   // 与玩家一致的启停（counter-strafe 急停）
    aimTimeMs: 450,         // Bot 完全可见后多少毫秒"击杀"你（对枪输了）
    hitFlashTime: 0.09,
    deathTime: 0.55,
    spawnGuardMs: 250,      // 出生保护（不可被击中）
  },

  // ---- 训练模式默认参数（可在菜单改）----
  training: {
    roundSeconds: 60,       // 30 / 60 / 120 / 0=无限
    peekDelayMinMs: 600,    // 架枪模式：Bot 出现前的随机等待
    peekDelayMaxMs: 2600,
    peekStopChance: 0.35,   // 横移中急停一瞬的概率（模拟真人 swing 抖动）
    flickCount: 1,          // 同时在场目标数
  },

  graphics: {
    maxPixelRatio: 2,
    shadows: false,         // 默认关（性能优先），菜单可开
    fovH: 103,              // Valorant 水平 FOV 103°（垂直随窗口比例换算）
    viewmodelFov: 55,       // 持枪视角独立垂直 FOV（CS/Valorant 同做法：与主 FOV 解耦，
                            // 枪/手臂比例不随主视野拉伸，且单独一趟渲染不穿墙）
  },

  colors: {
    sky: 0x9db8c9,
    fog: 0xb9c8d2,
  },
}

// ---- 后坐力弹道表（程序化生成的近似压枪轨迹：前段垂直上抬，中后段水平摆动）----
// 每项为该发子弹相对准心的累计偏移（度）。原创近似，非游戏数据提取。
export function makeSprayPattern(n = 25) {
  const pat = []
  let p = 0, y = 0, phase = 0
  for (let i = 0; i < n; i++) {
    if (i < 3) p += 0.18
    else if (i < 9) p += 0.62 - (i - 3) * 0.05
    else if (i < 13) p += 0.08
    else p -= 0.1
    if (i >= 8) {
      phase += 1
      y = Math.sin(phase * 0.9) * (0.5 + phase * 0.07)
    }
    pat.push({ p, y: i < 8 ? y : y * 0.9 })
  }
  return pat
}
