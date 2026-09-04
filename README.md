# 架枪训练 · Hold Angle Trainer（WebGL）

一个用 **Three.js (WebGL2)** 实现的第一人称架枪/对枪训练器。移动、武器数值按 Valorant 公开资料调校，目标是把"急停—开枪—压枪—反应"这套肌肉记忆在浏览器里练起来。

> **关于素材的说明**：Riot 的游戏资产（模型/贴图/音效）受版权保护，本项目**不提取、不打包、不复刻**官方资源。
>
> **当前内置的开源模型**（`public/models/`，均已 gltf-transform 量化压缩 + 贴图 JPEG 重编码，且无需解码器）：
> - `agent.glb` — ["X Bot"](https://github.com/mrdoob/three.js/tree/master/examples/models/gltf)（Mixamo，经 three.js 官方示例分发），训练靶按实际移速**加权混合 idle/walk/run 动画**，脚步频率与位移同步（加载时自动归一化到 1.8m）；备选 BrainStem 模型在仓库 `models-optional/`（不随部署分发），复制进 `public/models/` 改名即可换用
> - `viewmodel-vandal.glb` — ["AK-47 Kalashnikov" by Mateusz Woliński](https://sketchfab.com/3d-models/ak-47-kalashnikov-2da6b0332a5c4870a854ebea34eddfc3)（**CC-BY 4.0**，经 Objaverse 分发）：真实 PBR 木纹/金属贴图的经典 AKM，作 Vandal 第一人称枪模
> - `viewmodel-phantom.glb` — ["AK 47 Tactical Upgrade" by Mateusz Woliński](https://sketchfab.com/3d-models/ak-47-tactical-upgrade-b15d69e8a5a948819c8c388f97930b9c)（**CC-BY 4.0**，经 Objaverse 分发）：战术导轨 + 消音器造型（自带 bolt carrier / magazine 独立网格，枪机后坐用原生机件），作 Phantom 第一人称枪模。双枪各有按枪面射线实测收敛的逐指握姿，切枪自动重摆
> - `glove.glb` / `hands.glb` — ["Gloved Hand"] / ["Rigged FPS Arms" by J-Toastie](https://poly.pizza/m/XdHWM8uSAO)（Poly Pizza 分发，均 **CC-BY 3.0**；五指手套双手为第一人称主路径，hands 整臂做 IK 袖臂与后备；缺失时逐级回退程序化手臂）
> - 旧版单枪模 `viewmodel.glb`（Quaternius AK47，CC0）备份在 `models-optional/`，改名放回即回退；Sheriff/手枪/刀使用内置程序化模型（带枪机/套筒/转轮活动机件、解剖学分段手部动画）
>
> **替换成你自己的资产**（本地使用你拥有合法权利的文件）：同名覆盖 `public/models/*.glb` 后跑 `npm run optimize:models` 一键压缩；音效放 `public/sfx/`（文件名见目录内说明）。本项目与 Riot Games 无关。

## 运行

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run build    # 产物在 dist/
npm run preview
npm run verify   # lint + 单元测试 + 构建（CI 同款门禁）
npm run optimize:models  # 压缩 public/models/*.glb（换入自有模型后执行）
```

要求：桌面版 Chrome/Edge/Firefox（需要 WebGL2 + Pointer Lock），Node ≥ 18。

指针锁定优先请求 `unadjustedMovement`（绕过系统鼠标加速度/平滑，瞄准训练器的关键一致性），旧浏览器自动回退普通锁定。

## 部署

纯静态 SPA，`dist/` 可托管在任意静态服务器 / GitHub Pages / Vercel / Netlify / Cloudflare Pages / Docker。资源全部相对路径（`base: './'`），支持任意子路径部署；字体自托管，无第三方请求。全量约 3.3 MB（gzip ~1.1 MB）。缓存策略、nginx 配置样例与各平台步骤见 **[DEPLOY.md](DEPLOY.md)**。

## 操作

| 按键 | 功能 |
| --- | --- |
| `W A S D` | 移动（全速 5.4 m/s） |
| `Shift` | 静步（50% 速度，无声） |
| `Ctrl / C` | 蹲下（≈1.8 m/s，散布小幅优化） |
| `Space` | 跳跃 |
| `左键` | 开火（全自动武器按住） |
| `右键` | Classic 三连发 |
| `R` | 换弹 |
| `1 / 2 / 3` | 主武器 / 副武器 / 刀（持刀 6.75 m/s） |
| `ESC` | 暂停并呼出菜单 |

鼠标灵敏度与游戏同换算：**0.07°/count × 灵敏度**（即 CS 灵敏度 × 3.18 的关系），菜单里直接填你游戏内的灵敏度即可获得相同的 360° 距离。

**其它行为**：
- `ESC` 暂停时使用游戏时钟——回合计时、Bot 行为与死亡复活计时全部冻结，不会因暂停丢回合时间
- 弹匣+备弹全部打空 2.5s 后自动补满（模拟靶场随时买枪，无限时长回合不会卡死）
- 菜单「画质」区可调：分辨率缩放（50%~200%）、自适应分辨率（掉帧自动降最低 60%、恢复后回升）、阴影开关、FPS 面板显隐，设置持久化到 localStorage（隐私模式下静默降级为仅本次会话生效）
- 敌方枪声/脚步为 HRTF 空间音频（听者方位换算与相机矩阵严格一致，可听声辨位）
- WebGL 上下文丢失自动暂停并提示，恢复后重建材质继续

## 训练模式

只有一种纯粹的架枪对枪训练：开局 3 秒倒计时（GO 后才开始计时），随机延迟后 Bot 以全速从巷道缺口（A/B）拉出——带概率急停与"露头即缩"的 jiggle-peek（拉到中段折返缩回，逼你守住准星等第二拉）；在"反杀时间"内没打死就判负，练先开枪能力。中场木箱可换点位架枪，地面距离标线帮助测距。

**反馈与激励**：
- 击杀得分：击杀 100 + 爆头 50 + 连杀 ×25；个人最佳持久化（HUD 实时对比，破纪录时结算面板绿色高亮"新纪录！"）
- 连杀击杀确认音每级升半音（上限 +4），听觉反馈连杀节奏
- 准星随移动/开火实时扩张（动态误差可视化，对应游戏内"开火误差"选项，菜单可关）——收束时才是出手时机
- 对枪失败：Bot 原地开火还击（枪口焰/曳光 + 空间枪声）后缩回，屏幕边缘红弧指向受击来源方位
- 切枪机械上膛音、倒计时 tick/GO 提示音

HUD 实时显示：得分/最佳 / 击杀 / 对枪败 / 命中率 / 爆头率 / 反应时间（均值与最快）/ FPS 与 1% low / 当前移速。

## 数值对齐（`src/core/Config.js` 集中管理）

**移动**（公开资料值）：
- 全速 5.4 m/s（主武器）、持刀 6.75 m/s；静步 = 50%；蹲 ≈ 34%
- 加速/减速 55 m/s²：≈0.1s 达全速，松键 ≈0.1s 停稳；反向键 1.6× 减速（counter-strafe 急停）
- 被击中 tagging 减速到 72%（0.55s）
- 重力 22 m/s²、跳跃初速 5.9（顶点 ≈0.77m）
- 水平 FOV 103°（垂直随窗口比例换算，与游戏锁水平视场的做法一致）

**武器**（射速/伤害为公开资料值）：

| 武器 | 射速 | 弹匣 | 头/身/腿 | 备注 |
| --- | --- | --- | --- | --- |
| Vandal | 9.75/s | 25 | 160/40/34 | 全距离不衰减 |
| Phantom | 11/s | 30 | 156/39/33 | 15m/30m 分段衰减 |
| Sheriff | 4/s | 6 | 159/55/46 | 高散布惩罚 |
| Ghost | 6.75/s | 15 | 105/30/26 | |
| Classic | 6.75/s | 12 | 78/26/22 | 右键三连发 |

**手感机制**：
- 首发精度：静止 ≈0.2°，全速跑 ≈4.5°，跳跃大幅扩散；蹲下 ×0.85
- 后坐力：程序化生成的弹道表（前 8 发垂直爬升 → 中后段水平摆动），停火 0.4s 立即重置（鼓励点射/急停）；视角上踢仅为视觉，弹道由表驱动
- 持枪动画：枪机/套筒击发后坐回位、Sheriff 转轮分度+击锤、换弹时弹匣下落回插+上膛抽动、切枪从下方托起、静止呼吸微摆、挥刀弧线
- 逻辑帧固定 **128Hz**（与游戏服务器 tick 一致），渲染插值，鼠标视角渲染帧直通（零延迟）

## 架构

```
src/
  core/     Engine(渲染/双pass/固定步长循环/FPS统计/上下文恢复) · Config(全部数值) · Input(原始鼠标输入)
            Audio(WebAudio合成音效, HRTF听声辨位) · stats(统计口径) · Rng(可复现PRNG)
  player/   Player(移动模型/碰撞/视角)
  weapons/  WeaponSystem(状态机:开火/换弹/切枪/持枪动画) · ViewmodelFactory(程序化枪模+手臂建模)
            HandsRig(GLB手部IK式装配) · ballistics(伤害衰减/散布, 纯函数)
  world/    World(AABB碰撞+射线+命中球检测) · MapBuilder(程序化地图, 几何合并)
            FX(曳光/弹孔/枪口焰对象池) · Textures(程序化PBR纹理) · ModelTexturing(GLB贴图)
  entities/ Bot(命中球体/peek状态机/骨骼动画混合) · BotManager(架枪对枪轮次/统计)
  ui/       Crosshair(DOM准星) · HUD(节流更新+FPS图) · Menu(设置持久化) · ResultPanel(回合结算)

tests/      纯逻辑单元测试（Vitest）：碰撞/射线/弹道/伤害/散布/统计/PRNG/HRTF方位换算
```

质量保障：
- `npm run verify` = ESLint + Vitest（40 用例）+ 生产构建；GitHub Actions CI 对每次 push/PR 运行同款门禁
- 纯逻辑（弹道、散布、统计、碰撞、方位换算）全部抽成无渲染依赖的函数并覆盖测试
- 关键回归用例：HRTF 听者方位换算与 three.js 相机矩阵交叉验证（修复过一次前后颠倒）

性能设计（实测 100~145 FPS @2K，dev 模式）：
- 静态地图按材质合并，全场个位数 draw call；命中/视线为解析射线（不遍历网格）
- 曳光/弹孔/伤害数字全对象池，主循环零内存分配（复用向量）
- HUD 只在文本变化时写 DOM；碰撞/实体数据为扁平数组
- 程序化纹理的 Sobel 法线转换为行索引外提的热循环实现；首屏载入页覆盖初始化期（生产构建 ~350ms 就绪）
- 阴影默认关闭，菜单「画质」区可调分辨率缩放与阴影开关；构建时 three.js 独立成 vendor chunk（业务更新不重复下载渲染库）
- 打包体积：全量 ~3.3 MB（gzip ~1.1 MB）；GLB 量化压缩（KHR_mesh_quantization，GLTFLoader 原生支持）、字体自托管（无第三方请求）、无用的备份模型不进 dist（见 `scripts/optimize-models.mjs` 与 DEPLOY.md）

## 已知边界

- Bot 的还击由"反杀时间"判定 + 开火表现模拟（非真实弹道对射），无经济/买枪系统
- 后坐力弹道为调校近似，非逐帧提取的官方数据
- 只支持平地（无楼梯/台阶）
