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
    // 分档跑速（Fandom 维基各武器页 infobox，2021→2026 稳定口径）：
    //   步枪/狙/重机枪 5.4 · 副武器与 SMG 5.73 · 霰弹枪 5.06 · 刀 6.75
    //   各枪实际跑速 = runSpeed × weapons.*.moveSpeedMult
    runSpeed: 5.4,          // m/s 基准跑速（= 步枪档）
    knifeSpeed: 6.75,       // m/s 持刀跑速（维基 Melee 页）
    walkMult: 0.628,        // Shift 静步 = 62.8%（≈3.39 m/s；Riot_Classick 官方实测
                            //   走路级精度门槛 = 61% 速度，与通行引用 3.39 m/s 互证）
    crouchMult: 0.34,       // 蹲下移速 ≈ 1.8 m/s
    // 地面启停 = 无畏契约摩擦模型（社区实测推导 + Riot 开发者 Riot_Classick 官方
    // 急停里程碑互证）：输入方向恒定加速；松键/降档/反向 = dv/dt = -(flat + drag·v)。
    // 反向键无额外减速加成（摩擦恒大于加速；官方实测 counter-strafe 仅省 ~10ms，非 CS 机制）
    groundAccel: 18.75,     // m/s² 持步枪实测加速（按目标速度等比缩放 → 各档位 ≈0.29s 达标）
    groundDecelFlat: 28.6,  // m/s² 恒定摩擦分量
    groundDecelDrag: 3.3,   // /s 速度比例阻尼（5.4→61% 0.055s / 25% 0.104s / 停稳
                            //   0.147s，复现官方里程碑 0.055/0.104/0.160）
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
  // recoil.punchRecover = 视角上踢恢复速率（1/s）：2026-09-11 实测标定为阶跃保持模型
//   （all-recoil 60fps 边缘追踪：停火后 +1.04° 偏移 750ms 内回稳 <1%、σ=0.1px 平直
//   → 上界 rate <0.013/s）→ 统一 0.01（保持语义，玩家自行下拉回中）
//   （每发 punch = 弹道增量 ×viewPunch×0.25，全弹匣视角累计 ≈1.0-1.5° 与弹道解耦）；
//   protected = 水平
  // 保护弹数（前 N 发无横偏，v10.0 公开机制）；swingTime = 水平换向节拍（0.6s）；
  // runMult = 跑动垂直后坐乘数（v6.11: 1.5→1.8）
  // ads 字段口径 = 维基 infobox Alt Fire + Spread values 表 Alternate Fire 行：
  //   zoom 缩放（主相机水平 FOV ÷ zoom）· fireRateMult 射速（altrate 90%）·
  //   moveMult 移速（76% = 4.104 m/s）· stand/crouch ADS 首发散布 ·
  //   maxStand/maxCrouch ADS 连射散布上限（注意略高于腰射：vandal 1.02 vs 1.0）·
  //   recoilMult 后坐削减幅度 —— 官方无公开数值（维基仅定性"Slight reduction"）。
//   实测（专集四 take 枪位分组 T1/T2=ADS、T3/T4=腰射，排序均值配对——素材中无
//   同墙同位配对：T1/T2 瞄点居中、T3/T4 瞄点偏左，位置不匹配）：ADS 列跨排序
//   均值 18.7° vs 腰射 19.4° → 0.964；配对 ratio {0.90, 1.00} 交叉 → 取 0.95
//   （离散 ±0.05；原 0.85 为 Riot 补丁 0.50 口径锚定，实测示其偏大）·
  //   time 开镜过渡时长 —— 60fps 胶片条逐帧精测（all-recoil 专集三事件：T1 进镜
//   #3→#14、T2 进镜 #11→#22、T2 出镜 #7→#18，全部 11 帧）：183ms ± 17ms（帧量化
//   ±1 帧）；与 30fps 素材粗测 ~165ms 在量化误差内一致
  // equipTime 口径 = 维基 equip 三档里的 Normal（常规切枪）：步枪/Sheriff 1.0 ·
  //   手枪 0.75 · 近战 0.6。Fast（技能后/滑铲后 0.6/0.45/0.3）与 Instant（特定
  //   能力交互 0.2/0.15/0）档位本训练器无对应路径——无技能/滑铲，切枪只有数字键
  weapons: {
    vandal: {
      name: 'Vandal', slot: 'primary', auto: true,
      fireRate: 9.75, magSize: Infinity, equipTime: 1.0,   // 维基 Normal 档（2026-09 复核）
      damage: { head: 160, body: 40, leg: 34 }, falloff: null,   // Vandal 全距离不变
      spread: { stand: 0.25, walk: 3.25, run: 6.25, jump: 10.25, crouchMult: 0.85, crouchMove: 0.8, max: 1.0 },
      recoil: { recoverTime: 0.4, viewPunch: 0.34, punchRecover: 0.01, protected: 6, swingTime: 0.6, runMult: 1.8,
                 climb: 18 },   // 25 发累计爬升（度）—— 纯腰射双确认样本 {16.1, 20.1}
                                 // 中值 18.1，区间 ±2.0°（四 take 枪位分组剔除 ADS 列后收窄）
      ads: {
        zoom: 1.25, fireRateMult: 0.9, moveMult: 0.76,
        stand: 0.157, crouch: 0.13, maxStand: 1.02, maxCrouch: 0.87,
        recoilMult: 0.95, time: 0.183,
      },
      moveSpeedMult: 1.0,
      vmKick: 0.004,                                             // 每发平移冲量 ×0.125 实测下修（60fps 帧级质心：
                                 // 官方开火中枪体质心 σ≈0.1px，每发平移踢 <1px@1080p）
      sound: 'rifle',
    },
    phantom: {
      name: 'Phantom', slot: 'primary', auto: true,
      fireRate: 11, magSize: Infinity, equipTime: 1.0,     // 维基 Normal 档（2026-09 复核）
      damage: { head: 156, body: 39, leg: 33 },
      falloff: [                                                 // 距离衰减（v9.10：20m 起 ×0.897）
        { maxDist: 20, damage: { head: 156, body: 39, leg: 33 } },
        { maxDist: Infinity, damage: { head: 140, body: 35, leg: 30 } },
      ],
      spread: { stand: 0.2, walk: 3.2, run: 6.2, jump: 10.2, crouchMult: 0.85, crouchMove: 0.8, max: 0.9 },
      recoil: { recoverTime: 0.38, viewPunch: 0.3, punchRecover: 0.01, protected: 8, swingTime: 0.6, runMult: 1.8,
                 climb: 17 },   // 独立实测：720p30 专集三样本列跨 {11.2°（最干净单列，
                                 // 疑部分弹匣=下界）, 18.6°, 22.0°（列顶修正后）} → [15.5,19.5]
                                 // 取 17（vandal 16 × 射速比 11/9.75=1.13 互证带内；水平
                                 // x 漂移实测 57px≈6.4° 峰峰与 vandal 125px 同量级）
      ads: {
        zoom: 1.25, fireRateMult: 0.9, moveMult: 0.76,
        stand: 0.11, crouch: 0.09, maxStand: 0.91, maxCrouch: 0.78,
        recoilMult: 0.95, time: 0.183,
      },
      moveSpeedMult: 1.0,
      vmKick: 0.0035,                                            // 消音更轻（同 ×0.125 实测下修）
      suppressed: true,                                          // 消音视觉：枪口焰/曳光/枪口烟同步收敛
      sound: 'rifle_suppressed',
    },
    sheriff: {
      name: 'Sheriff', slot: 'primary', auto: false,
      fireRate: 4, magSize: Infinity, equipTime: 1.0,      // 维基 Normal 档（2026-09 复核）
      damage: { head: 159, body: 55, leg: 46 },
      falloff: [                                                 // 30m 起 ×0.909（维基分距离表）
        { maxDist: 30, damage: { head: 159, body: 55, leg: 46 } },
        { maxDist: Infinity, damage: { head: 145, body: 50, leg: 42 } },
      ],
      spread: { stand: 0.25, walk: 1.45, run: 3.25, jump: 7.25, crouchMult: 0.76, crouchMove: 0.5, max: 2.75 },
      recoil: { recoverTime: 0.6, viewPunch: 0.9, punchRecover: 0.01, protected: 6, swingTime: 0.6,
                 climb: 33.8 },  // 三样本实测分离压枪差异：列跨 {22.1, 16.6, 20.2}°——
                                 // 16.6 具过度压枪特征（列跨最短+列底最浅 40px），22.1/20.2
                                 // 为无压枪特征对（深列底 77-80px）→ 取无压枪对均值 21.2 减
                                 // 展宽 2.2 → 6 发段 ≈18.9°；对内离散 ±0.95
      moveSpeedMult: 1.0,
      vmKick: 0.006,                                             // 左轮重锤感（×0.125 实测下修）
      sound: 'handcannon',
    },
    classic: {
      name: 'Classic', slot: 'secondary', auto: false,
      burst: true,                                               // 右键三连发
      fireRate: 6.75, magSize: Infinity, equipTime: 0.75,  // 维基 Normal 档（手枪 0.75/步枪 1.0/近战 0.6）
      damage: { head: 78, body: 26, leg: 22 },
      falloff: [                                                 // 30m 起 ×0.846（维基分距离表）
        { maxDist: 30, damage: { head: 78, body: 26, leg: 22 } },
        { maxDist: Infinity, damage: { head: 66, body: 22, leg: 18 } },
      ],
      spread: { stand: 0.4, walk: 1.5, run: 2.7, jump: 7.4, crouchMult: 0.75, crouchMove: 0.5, max: 1.8 },
      recoil: { recoverTime: 0.35, viewPunch: 0.45, punchRecover: 0.01, protected: 6, swingTime: 0.6,
                 climb: 16.1 },  // 双样本实测：列跨 {15.1, 17.3}°（11-12 孔计数吻合弹匣）减
                                 // 展宽 → 12 发段 ≈15.0° 中值；两样本一致性最好（±1.1）
      moveSpeedMult: 1.0611,                                      // 副武器跑速 5.73 m/s（维基 infobox）
      vmKick: 0.0037,
      sound: 'pistol',
    },
    ghost: {
      name: 'Ghost', slot: 'secondary', auto: false,
      fireRate: 6.75, magSize: Infinity, equipTime: 0.75, // 维基 Normal 档（手枪档）
      damage: { head: 105, body: 30, leg: 25 },
      falloff: [                                                 // 30m 起衰减（维基分距离表）
        { maxDist: 30, damage: { head: 105, body: 30, leg: 25 } },
        { maxDist: Infinity, damage: { head: 87, body: 25, leg: 21 } },
      ],
      spread: { stand: 0.3, walk: 1.4, run: 2.6, jump: 7.3, crouchMult: 0.77, crouchMove: 0.5, max: 1.65 },
      recoil: { recoverTime: 0.3, viewPunch: 0.35, punchRecover: 0.01, protected: 6, swingTime: 0.6,
                 climb: 20.7 },  // 双样本实测：列跨 {24.1, 18.1}°（10-12 孔计数吻合弹匣）减展宽
                                 // → 13 发段 ≈19.7° 中值；样本离散 ±3.0。仍为三枪最高——
                                 // 消音轻踢但连发爬升大，viewPunch 不反映弹道累计
      moveSpeedMult: 1.0611,                                      // 副武器跑速 5.73 m/s（维基 infobox）
      vmKick: 0.003,                                             // 消音手枪更轻（×0.125 实测下修）
      suppressed: true,                                          // 消音视觉：枪口焰/曳光/枪口烟同步收敛
      sound: 'pistol_suppressed',
    },
    knife: {
      name: 'Tactical Knife', slot: 'melee', auto: false,
      fireRate: 1.33, magSize: Infinity, equipTime: 0.6,  // 维基 Melee 页 Normal 档（Fast 0.3/Instant 0）
      damage: { head: 50, body: 50, leg: 50 }, range: 1.9,
      moveSpeedMult: 1.25,                                       // 持刀 = 6.75 m/s
      sound: 'knife',
    },
  },

  // ---- 机器人（模拟真人 peek：与玩家同移速/启停物理模型，见 core/GroundMotion.js）----
  bot: {
    health: 100,
    moveSpeed: 5.4,         // Bot 横移速度 = 持步枪跑速（Bot 持枪 5.4 档，与玩家对枪时同速）
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
    peekSide: 'left',       // Bot 出场侧：left / right 固定一侧练同向预瞄，random 保留两侧随机
    weaponSkin: 'default',  // Vandal 皮肤：default / aristocrat（官方商城 Aristocrat 收藏集，镀金）
    peekStopChance: 0.35,   // 横移中急停一瞬的概率（模拟真人 swing 抖动）
    crouchChance: 0.3,      // 急停瞬间转入蹲姿对枪的概率（本体对枪蹲：压低头部躲爆头线，
                            // 命中区随官方蹲姿根高 ×0.70 缩放，逼玩家下压准星）
    jumpChance: 0.18,       // 每波掷定跳 peek 的概率（中途随机进度起跳：官方 Jump 蹬伸 +
                            // 抛物线弧（命中区随 mesh 跟随）+ JumpLand 落地恢复）
    crouchWalkChance: 0.2,  // pull 波掷定蹲走拉出的概率（官方蹲走循环，命中区 ×0.70）
    crouchWalkSpeed: 2.7,   // 蹲走拉出移速（m/s）：本体口径 = 50% 跑速；播放松条可调
                            // （1.4-2.7）——步幅相位按速度自动派生，任意速度近零滑步。
                            // 观感回退预设档：1.76 = clip 天然速率（步频 1.9 步/s、
                            // 滑步趋零优先于移速口径；设置滑条实时切换对比）       // 每波掷定跳 peek 的概率（中途随机进度起跳：官方 Jump 蹬伸 +
                            // 抛物线弧（命中区随 mesh 跟随）+ JumpLand 落地恢复）
    crossChance: 0.5,       // 每波风格：侧面跑过（贯穿缺口顺跑向）vs 横向拉出（肩peek 拉出对枪）
    pullJiggleChance: 0.3,  // 拉出波里"露头即缩"jiggle-peek 的概率（拉到中段折返）
    pullHoldMaxMs: 2400,    // 拉出后站定对枪的兜底时长（可见判负之外防挂场，如玩家挪位断 LOS）
  },

  // ---- 闪光干扰（敌方投掷 1:1 数值，来源：Fandom 维基 2026-09 各技能页 + Deployment types）----
  // 通用致盲模型：维基定性描述的参数化近似 —— 直视满时长 / 背对轻微短暂 /
  // 超远距离免疫；到期后白屏 1 秒渐褪（1 秒为维基确认值）
  flash: {
    intervalMin: 9,        // 敌方闪光事件随机间隔（s）
    intervalMax: 17,
    firstMin: 5,           // GO 后首次闪光延迟（s）
    firstMax: 9,
    fullDist: 18,          // 距离衰减：≤18m 满时长，70m 线性归零（近似口径）
    zeroDist: 70,
    fovHalf: 51.5,         // 半水平 FOV（103°/2）：起爆点在视野内 = 直视
    backFactor: 0.08,      // 完全背对时长系数（"轻微短暂致盲"）
    angleExp: 2,           // 视野外随角度的衰减幂次
    fadeTime: 1,           // 致盲到期后白屏渐褪 1s（维基确认值）
    // KAY/O FLASH/drive：Class 2 投掷物（1800uu/s=18m/s、重力系数 0.3×9.8=2.94），
    // 总引信 1.6s；v10.06 起首次弹跳后改为 0.8s 引信（不延长剩余时间）；最大致盲 2.25s（v11.08 起双手同值）
    kayo: { speed: 18, gravity: 2.94, maxFuse: 1.6, bounceFuse: 0.8, telegraph: 0.3, maxBlind: 2.25, restitution: 0.32 },
    // Skye Guiding Light：导弹 18m/s 无重力、最长飞行 2s（v7.04）、到时自动起爆（v8.01）；
    // 最大致盲 1→2.25s 随飞行 0.75s 充能（v5.07，v10.00 修复生效）；手动激活后 0.3s 起爆（v3.06）。
    // 敌方操控近似：瞄点实时跟在玩家视线前方 2.2m，急转自然减速 → 到位后绕人盘旋
    // 等充能，充满即激活（拿到满 2.25s 的 pop flash）
    skye: { speed: 18, maxFlight: 2, chargeTime: 0.75, minBlind: 1, maxBlind: 2.25, activationWindup: 0.3, turnRate: 3.4, aimAhead: 2.2, popDist: 4.5 },
    // Phoenix Curveball：Fixed 路径导弹（无重力、左/右曲），cast→起爆 0.6s（v11.00）、
    // 最大致盲 1.5s（v5.01）。飞行速度无公开值：按对局观察 ~9m 落点 ÷ 0.6s ≈ 15m/s（README 已知边界）
    phoenix: { speed: 15, windup: 0.6, maxBlind: 1.5 },
    // Yoru Blindside：Class 3 投掷物（2900uu/s=29m/s、重力 0.45×9.8=4.41，Deployment
    // types 表）；飞行不可见也无声（v11.10 修"潜行中敌方可听"）——撞面才显形 +
    // 0.6s 预备（v2.06）；2s 未撞面消散（未确认值）；最大致盲 1.5s（v11.08，同时并入
    // 标准闪光衰减曲线 = 现有 blindDuration 模型）
    yoru: { speed: 29, gravity: 4.41, maxAir: 2, windup: 0.6, maxBlind: 1.5, restitution: 0.42 },
    // Breach Flashpoint：Placement 穿墙放置（部署距 35m / 穿墙深 10m，本图墙厚自动满足），
    // 到位后 0.5s 预备（v1.07）；最大致盲 2.25s（v11.08）
    breach: { windup: 0.5, maxBlind: 2.25 },
    // Reyna Leer：近视（非白闪）——Missile 穿地形到固定 10m 部署距（0.55s，未确认值），
    // 到位 0.4s 预备（v5.07）后施加近视 1.6s（看清瞳孔即持续命中，6m 视界，
    // game files）；100HP 可击毁（维基）。近视附带 Deafened：音频被闷（维基
    // Status Effect：Nearsight 者同时 deafened——脚步/枪声全糊，只能贴脸听）
    reyna: { deployDist: 10, travel: 0.55, arrivalWindup: 0.4, nearsight: 1.6, visionRadius: 6, hp: 100, radius: 0.32 },
    // Gekko Dizzy：Class 2 投掷（同 KAY/O 18m/s、g2.94）——0.65s 激活预备（未确认值）
    // 后减速悬停，活跃 1s（v9.08）内对 45m 视线内目标 0.35s 锁定（v7.12）喷等离子：
    // 溅射 2.5m，全屏遮蔽 2s = 1s 满效 + 1s 渐褪（game files；转身不可避——
    // 只判 LOS 不判朝向）；20HP 可击毁
    gecko: { speed: 18, gravity: 2.94, activationWindup: 0.65, acquireWindup: 0.35, active: 1, detect: 45, splash: 2.5, blindPotency: 1, blindFade: 1, hp: 20, radius: 0.34 },
  },

  graphics: {
    maxPixelRatio: 2,
    shadows: true,          // 默认开：静态几何已合并，阴影 pass 仅 ~10 draw call（实测无帧率损失）
    heatShimmer: true,      // 枪口热浪扭曲 pass（热量门控：仅开火后 ~1.8s 走 RT 路径，其余帧零成本；菜单画质可关）
    fovH: 103,              // Valorant 水平 FOV 103°（垂直随窗口比例换算）
    viewmodelFov: 55,       // 持枪视角独立垂直 FOV（CS/Valorant 同做法：与主 FOV 解耦，
                            // 枪/手臂比例不随主视野拉伸，且单独一趟渲染不穿墙）
  },

  colors: {
    sky: 0x9db8c9,
    fog: 0xb9c8d2,
  },
}

// ---- 后坐力弹道表（程序化生成的压枪轨迹；幅度按实机素材实测标定）----
// 每项为该发子弹相对准心的累计偏移（度）。
// 幅度标定（2026-09-11，实机素材逐帧/几何测量 + 后坐比例锚定，多 take 交叉）：
//  - Vandal 18°：专集四 take 双确认后按枪位分组（T1/T2=ADS 剔除、T3/T4=腰射）：
//    纯腰射列跨 {17.5（主）, 21.3}° 减展宽 → climb 样本 {16.1, 20.1}，中值 18.1
//    → 区间 ±2.0°（混合样本期的 ±2.8° 由 ADS 列混入所致，分组后收窄）
//  - Phantom 17°：独立实测（720p30 专集三样本列跨 11.2°/18.6°/22.0°，最干净单列
//    为下界、全弹匣列为主样本），射速比互证（16×11/9.75≈18）带内取 17
//  - Sheriff 33.8 / Classic 16.1 / Ghost 20.7：手枪指南专集（720p30）多样本实测
//    （近静止窗+弹孔计数吻合弹匣+算法/视觉双确认）：Sheriff 三样本 {22.1, 16.6,
//    20.2}°按压枪特征分离（过度压枪样本剔除后无压枪对 21.2 均值）；Classic 双样本
//    {15.1, 17.3}°中值；Ghost 双样本 {24.1, 18.1}°中值（第二样本扫射子窗 7.4-8.1s
//    相位相关 (0,0) 完全静止——粗窗 -52px 为移动尾部均值，判据复核通过）。减展宽
//    → 弹匣段 ≈18.9/15.0/19.7°（climb 语义 25 发累计）。viewPunch 锚定与实测偏差
//    ±30% 且方向不定（Ghost 反向）——视觉踢感不反映弹道累计，实测优先
//  - 水平摆幅 ≈1.0° 单侧包络（随机化语义：Valorant 每次扫射的水平摆动方向/幅度
//    逐次随机——社区记载）。逐孔级复测（2026-09-11 受控标注，非列界判读）：
//    phantom t57.5 十三孔逐点标注 = 单调左漂 4px@原图 → 单侧 0.45°（与包络模型该
//    段预测 0.42° 精确吻合）；vandal T4 二十孔 x 恒定 ±0.7px → 近零实现（0.1°）。
//    实现观测带 [0.1, 2.4°]，包络取 1.0°±0.3（受污染上限读数支持 ~1-2）。先前
//    2.98° 标定已证伪（125px 自动剖面=边界污染、t66 57px=旧痕污染）；列形倾斜为
//    玩家偏航伪影（方向逐 take 相反），"先右后左"仅为结构先验（bo3.gg/VALTRAIN）
// 结构对齐公开补丁机制：
//  - prot：水平保护弹数——前 N 发纯垂直无横偏（v10.0 起公开机制：Vandal 6 / Phantom 8）
//  - swing：一次水平换向持续的弹数（补丁"Yaw switch time 0.6s"× 射速，Vandal ≈5.85）
// 垂直形状：前 9 发陡升 → 高位平台（垂直停住，压枪量不再增长）。平台期不允许
// 垂直回落——压枪过冲后还要反向上推的手感是错的，压到高点只管左右修。
// climb 参数 = 25 发累计垂直幅度（度）；垂直增量按 climb/4.03 等比缩放基线形状，
// 水平摆幅 = √比例 × 实测包络（vandal 列 x 展宽 125px/phantom 57px → 峰峰 5-8°）。
export function makeSprayPattern(n = 25, { prot = 6, swing = 5.9, climb = 16 } = {}) {
  const K = climb / 4.03 // 垂直比例尺（基线形状 25 发累计 4.03°）
  const H = Math.sqrt(K) // 水平比例尺
  const pat = []
  let p = 0
  for (let i = 0; i < n; i++) {
    if (i < 3) p += 0.18 * K
    else if (i < 9) p += (0.62 - (i - 3) * 0.05) * K
    else if (i < 13) p += 0.08 * K
    else p += 0.015 * K // 平台期微升：压枪量基本封顶，只留给水平摆动
    const t = (i - prot) / swing // 换向节拍相位：每 swing 发完成半次摆动
    // 方向：先向右漂再拉左 —— bo3.gg 记载 Phantom"vertical start with a rightward
    // lean, then horizontal pull left"，VALTRAIN 记载 Vandal 压枪"pull down then
    // micro-adjust down-left"（补偿左下 = 弹道右上漂）。y 正值 = 向左偏
    const y = i < prot ? 0 : -Math.sin(t * Math.PI) * (0.16 + Math.min(1.0, Math.max(0, t) * 0.10)) * H
    pat.push({ p, y })
  }
  return pat
}
