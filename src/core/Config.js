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
    crouchLerpTime: 0.14,   // 蹲起过渡
  },

  mouse: {
    yawPerCount: 0.07,      // 灵敏度 1.0 时每计数 0.07°（与 Valorant 同换算：CS sens × 3.18）
    defaultSens: 0.4,
    pitchLimit: 89,
  },

  // ---- 武器（射速/伤害/散布为公开资料值，见 Fandom 维基数据挖掘表 2026-09 版；
  // 后坐力结构对齐公开补丁机制，幅度为调校近似）----
  // 弹药无限（架枪训练不中断节奏；弹道表 30 发后钳在末段，长时间连喷不影响判定）
  // spread 字段口径 = 维基 Spread values 表：stand/walk/run/jump 为总散布（度），
  // max 为持续连射散布上限，crouchMult 蹲姿乘数，crouchMove 蹲走加算惩罚
  // recoil.punchRecover = 视角上踢恢复速率（1/s，越重越慢）；protected = 水平
  // 保护弹数（前 N 发无横偏，v10.0 公开机制）；swingTime = 水平换向节拍（0.6s）；
  // runMult = 跑动垂直后坐乘数（v6.11: 1.5→1.8）
  weapons: {
    vandal: {
      name: 'Vandal', slot: 'primary', auto: true,
      fireRate: 9.75, magSize: Infinity, equipTime: 0.75,
      damage: { head: 160, body: 40, leg: 34 }, falloff: null,   // Vandal 全距离不变
      spread: { stand: 0.25, walk: 3.25, run: 6.25, jump: 10.25, crouchMult: 0.85, crouchMove: 0.8, max: 1.0 },
      recoil: { recoverTime: 0.4, viewPunch: 0.34, punchRecover: 10, protected: 6, swingTime: 0.6, runMult: 1.8 },
      moveSpeedMult: 1.0,
      vmKick: 0.032,                                             // 开火冲量（持枪模型后坐手感）
      sound: 'rifle',
    },
    phantom: {
      name: 'Phantom', slot: 'primary', auto: true,
      fireRate: 11, magSize: Infinity, equipTime: 0.75,
      damage: { head: 156, body: 39, leg: 33 },
      falloff: [                                                 // 距离衰减（v9.10：20m 起 ×0.897）
        { maxDist: 20, damage: { head: 156, body: 39, leg: 33 } },
        { maxDist: Infinity, damage: { head: 140, body: 35, leg: 30 } },
      ],
      spread: { stand: 0.2, walk: 3.2, run: 6.2, jump: 10.2, crouchMult: 0.85, crouchMove: 0.8, max: 0.9 },
      recoil: { recoverTime: 0.38, viewPunch: 0.3, punchRecover: 11, protected: 8, swingTime: 0.6, runMult: 1.8 },
      moveSpeedMult: 1.0,
      vmKick: 0.028,                                             // 消音枪开火冲量更轻（音画一致）
      suppressed: true,                                          // 消音视觉：枪口焰/曳光/枪口烟同步收敛
      sound: 'rifle_suppressed',
    },
    sheriff: {
      name: 'Sheriff', slot: 'primary', auto: false,
      fireRate: 4, magSize: Infinity, equipTime: 0.75,
      damage: { head: 159, body: 55, leg: 46 }, falloff: null,
      spread: { stand: 0.25, walk: 1.45, run: 3.25, jump: 7.25, crouchMult: 0.76, crouchMove: 0.5, max: 2.75 },
      recoil: { recoverTime: 0.6, viewPunch: 0.9, punchRecover: 5.5, protected: 6, swingTime: 0.6 },
      moveSpeedMult: 1.0,
      vmKick: 0.05,                                              // 左轮重锤感
      sound: 'handcannon',
    },
    classic: {
      name: 'Classic', slot: 'secondary', auto: false,
      burst: true,                                               // 右键三连发
      fireRate: 6.75, magSize: Infinity, equipTime: 0.75,
      damage: { head: 78, body: 26, leg: 22 }, falloff: null,
      spread: { stand: 0.4, walk: 1.5, run: 2.7, jump: 7.4, crouchMult: 0.75, crouchMove: 0.5, max: 1.8 },
      recoil: { recoverTime: 0.35, viewPunch: 0.45, punchRecover: 8, protected: 6, swingTime: 0.6 },
      moveSpeedMult: 1.0,
      vmKick: 0.03,
      sound: 'pistol',
    },
    ghost: {
      name: 'Ghost', slot: 'secondary', auto: false,
      fireRate: 6.75, magSize: Infinity, equipTime: 0.75,
      damage: { head: 105, body: 30, leg: 26 }, falloff: null,
      spread: { stand: 0.3, walk: 1.4, run: 2.6, jump: 7.3, crouchMult: 0.77, crouchMove: 0.5, max: 1.65 },
      recoil: { recoverTime: 0.3, viewPunch: 0.35, punchRecover: 8.5, protected: 6, swingTime: 0.6 },
      moveSpeedMult: 1.0,
      vmKick: 0.024,                                             // 消音手枪更轻
      suppressed: true,                                          // 消音视觉：枪口焰/曳光/枪口烟同步收敛
      sound: 'pistol_suppressed',
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
    aimTimeMs: 450,         // Bot 完全可见后超此时限未击杀 → 对枪失败（Bot 缩回，玩家无伤害）
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
    crossChance: 0.5,       // 每波风格：侧面跑过（贯穿缺口顺跑向）vs 横向拉出（肩peek 拉出对枪）
    pullJiggleChance: 0.3,  // 拉出波里"露头即缩"jiggle-peek 的概率（拉到中段折返）
    pullHoldMaxMs: 2400,    // 拉出后站定对枪的兜底时长（可见判负之外防挂场，如玩家挪位断 LOS）
  },

  graphics: {
    maxPixelRatio: 2,
    shadows: true,          // 默认开：静态几何已合并，阴影 pass 仅 ~10 draw call（实测无帧率损失）
    fovH: 103,              // Valorant 水平 FOV 103°（垂直随窗口比例换算）
    viewmodelFov: 55,       // 持枪视角独立垂直 FOV（CS/Valorant 同做法：与主 FOV 解耦，
                            // 枪/手臂比例不随主视野拉伸，且单独一趟渲染不穿墙）
  },

  colors: {
    sky: 0x9db8c9,
    fog: 0xb9c8d2,
  },
}

// ---- 后坐力弹道表（程序化生成的近似压枪轨迹）----
// 每项为该发子弹相对准心的累计偏移（度）。幅度为原创近似（Riot 不公布角度值），
// 结构对齐公开补丁机制：
//  - prot：水平保护弹数——前 N 发纯垂直无横偏（v10.0 起公开机制：Vandal 6 / Phantom 8）
//  - swing：一次水平换向持续的弹数（补丁"Yaw switch time 0.6s"× 射速，Vandal ≈5.85）
// 垂直形状：前 9 发陡升 → 高位平台（垂直停住，压枪量不再增长）。平台期不允许
// 垂直回落——压枪过冲后还要反向上推的手感是错的，压到高点只管左右修。
export function makeSprayPattern(n = 25, { prot = 6, swing = 5.9 } = {}) {
  const pat = []
  let p = 0
  for (let i = 0; i < n; i++) {
    if (i < 3) p += 0.18
    else if (i < 9) p += 0.62 - (i - 3) * 0.05
    else if (i < 13) p += 0.08
    else p += 0.015 // 平台期微升：压枪量基本封顶，只留给水平摆动
    const t = (i - prot) / swing // 换向节拍相位：每 swing 发完成半次摆动
    const y = i < prot ? 0 : Math.sin(t * Math.PI) * (0.4 + Math.min(1.7, Math.max(0, t) * 0.16))
    pat.push({ p, y })
  }
  return pat
}
