# 部署指南

纯静态单页应用（SPA），`npm run build` 产物在 `dist/`，**任意静态文件服务器可直接托管**，无需 Node 运行时、无后端、无环境变量。

## 产物构成（v6.x，2026-09 体积优化后）

| 文件 | 大小 | 缓存建议 |
| --- | --- | --- |
| `index.html` | ~1 KB | **不缓存**（每次都拿最新的资源 hash） |
| `assets/*.js/.css/.woff2` | ~840 KB（gzip 后 ~350 KB） | 带内容 hash，可 `immutable` 长缓存 |
| `models/*.glb` | ~4.1 MB（已量化预压缩） | 无 hash，`no-cache` 或短缓存（见下） |
| `sfx/README.txt`、`models/README.txt` | ~4 KB | 随意 |
| `robots.txt`、`llms.txt` | ~2 KB | 随意（SEO/爬虫与 AI 代理站点说明） |

首次加载全量约 **4.9 MB**（GLB 已预压缩；JS/CSS/字体 gzip 后约 **0.5 MB**）；二次访问命中缓存后几乎零下载。字体已自托管（原 Google Fonts 外链移除），**无任何第三方请求**，断网/内网环境完整可用。

要点：

- vite 配置 `base: './'`，全部资源为**相对路径**——部署在域名根、子目录（如 `https://user.github.io/repo/`）、甚至 `file://` 本地双击打开均可。
- `three.js` 独立 vendor chunk（~585 KB / gzip 147 KB）：业务代码更新时用户无需重新下载渲染库。
- `models/` 下的 GLB 文件名固定（供用户同名覆盖替换），因此**不带 hash**；`public/sfx/` 同理（可选的 drop-in 音效目录，探测 404 是正常回退行为，不是错误）。

## 方式一：nginx（自建 / VPS）

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;
    root /var/www/vht;
    index index.html;

    # 开启压缩（对 JS/CSS/HTML 收益最大；GLB 是二进制容器，gzip 仍有 ~10-20%）
    gzip on;
    gzip_comp_level 6;
    gzip_types text/css application/javascript application/wasm model/gltf-binary;
    # 有条件的话用 brotli 替代/叠加 gzip，JS 再省 ~15%

    # 带 hash 的构建产物：永久缓存
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # 用户可替换的 GLB（文件名固定无 hash）：协商缓存
    location /models/ {
        add_header Cache-Control "no-cache";   # 每次校验 ETag/Last-Modified
    }

    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # SPA 单页，未知路径回落首页
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

注意 `.glb` 的 MIME：nginx 默认不含 `model/gltf-binary`，上面已在 `gzip_types` 里注册；如遇下载而非加载，检查 `types` 配置。

上传：

```bash
npm run verify          # lint + 测试 + 构建三重门禁，过了再发
rsync -avz --delete dist/ user@server:/var/www/vht/
```

## 方式二：GitHub Pages

1. 仓库 Settings → Pages → Source 选 `GitHub Actions`（推荐，自动部署 `dist/`）；或 Source 选 `gh-pages` 分支 + 手动推送：

   ```bash
   npm run build
   npx gh-pages -d dist
   ```

2. 项目页地址形如 `https://<user>.github.io/<repo>/`——`base: './'` 已保证子路径下资源引用正确，无需改配置。

如需用 Actions 自动部署，在 `.github/workflows/` 加一个 job（上传 `actions/upload-pages-artifact@v3` + `actions/deploy-pages@v4`）即可，CI 门禁沿用现有 `ci.yml` 的 `npm run verify`。

## 方式三：Vercel / Netlify / Cloudflare Pages

零配置，全部识别 vite：

- **构建命令** `npm run build`，**产物目录** `dist`
- 这些平台默认对 hash 资源长缓存、`index.html` 不缓存，规则已符合上表
- Cloudflare Pages 建议开启 Brotli（默认开启）与 HTTP/3

## 方式四：Docker（nginx:alpine）

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

nginx:alpine 自带的默认配置已含 gzip 与 MIME；如需上面那套缓存头，把配置片段写入文件并 `COPY` 到 `/etc/nginx/conf.d/default.conf`。

## 浏览器要求与协议

- 桌面版 Chrome / Edge / Firefox（WebGL2 + Pointer Lock；Safari 未在测试范围）
- `localhost` 与 `https` 下 Pointer Lock / WebAudio 体验完整；避免在 `http://` + 公网 IP 部署（部分浏览器限制自动播放等 API）
- 无需任何服务器端逻辑：命中判定、弹道、统计全部在客户端固定 128Hz 逻辑帧运行

## 更新与回滚

- 发布 = 覆盖 `dist/`；hash 文件名互不冲突，可先传新文件再覆盖 `index.html`（原子切换）
- 回滚 = 恢复旧 `index.html`（hash 资源若未清理仍可直接引用）
- `models/*.glb` 更新后因为 `no-cache`，用户刷新即生效

## 附：GLB 模型压缩管线

仓库内置模型已经过 [gltf-transform](https://gltf-transform.dev/) 量化压缩（几何 f32 → 8~14bit，KHR_mesh_quantization，three.js GLTFLoader 原生支持、无需解码器；agent.glb 另删除了未使用的动画 clip），整体 -46% ~ -55%。

同名换入你自己的模型后，一键重新压缩：

```bash
npm run optimize:models          # 压缩 public/models/*.glb（原地覆盖）
```

注意脚本使用 `prune({ keepLeaves: true })` 保留空叶子节点——`Top_end`、`IndexTip.R.001` 等末端节点是手部 IK 装配的测量标记，被清掉会导致手套/手臂回退到程序化模型。

### 换入手部/枪模 GLB 后的贴图与法线管线（2026-09-08 新增）

很多免费 CC 模型（如 Poly Pizza 系）不带 TEXCOORD_0 或带逐面法线——贴图会被
three.js 静默忽略（只剩纯色）、表面面片化。换入自己的 glove/hands/viewmodel 后按需运行：

```bash
# 1) 模型无 UV（材质贴图不显示）→ 盒式投影生成（皱纹/噪点类贴图对投影接缝不敏感）：
node scripts/add-model-uvs.mjs public/models/glove.glb
# 2) 表面呈面片棱线（逐面法线）→ 按位置聚合平滑（50° 折角阈值保留机械硬边；
#    不动索引/蒙皮权重，穿插审计结果不受影响）：
node scripts/smooth-normals.mjs public/models/glove.glb
```

两脚本均幂等（已有 UV / 已平滑则无操作或效果一致），内置 GLB 已处理完毕。

## 附：无畏契约模型获取与转换管线（2026-09-08）

> ⚠ 下述资源均为**非官方游戏提取件，无再分发授权**——仅限个人本地使用，请自行决定是否推送到远端。

### 来源清单

| 内容 | 来源 | 路径/文件 |
|---|---|---|
| 英雄（jett/phoenix/sage/sova，带贴图+kamae 待机动画，UE 骨架） | GitHub 粉丝仓库 [Valorant-3D-Immersive-Guide](https://github.com/abdullah-nadeem-lodhi/Valorant-3D-Immersive-Guide)（Sketchfab 导出） | `dist/{jett,phoenix,sage,sova}/*_animated.glb` → 拷为 `public/models/agent-*.glb` |
| 武器（32 把 .blend：Vandal/Phantom/Sheriff/Classic/Ghost/Operator/Odin…含皮肤变体） | YouTube Rocklan 模型包的 Google Drive 文件夹 | `drive.google.com/drive/folders/17pJMWTGJloEFU86NE9sIOBlH4VB9rFVh` → `Weapons/` 子目录 |
| 武器纯几何（无 UV/贴图，仅素材备用） | GitHub [codex-vibe-fps](https://github.com/yseho031018/codex-vibe-fps) | `assets/models/weapons/*.glb` → `models-optional/weapons-raw/` |

已验证的死路：models-resource 的 Valorant 页面是空的（0 资源）；Sketchfab/Meshy 下载需登录；
Mega 链接（YouTube 描述里的各包）大多已失效；"skins changer" 类仓库是恶意软件勿碰。

### 下载要点（Drive）

1. **过盾/访问**：Drive 公开文件夹不需要登录，但 `models-resource` 等站有 Cloudflare——
   chrome-devtools MCP 的 Chrome 过不了盾（无感验证死循环），**Playwright 浏览器能过**。
2. **取文件 ID**：文件夹页面 DOM 里 `[data-id]` 属性即文件 ID（或 `drive.usercontent.google.com` 抓包）。
3. **直下**（单文件 <100MB 无需确认页）：
   ```bash
   curl -sL -C - --retry 5 -o Vandal.blend \
     "https://drive.usercontent.google.com/download?id=<文件ID>&export=download&confirm=t"
   ```
4. **断流坑**：CN 网络对 Google 直连易截断（Vandal 25.1MB 下成 24MB），截断的 .blend
   在 Blender 报 `Missing DNA block`——用 `-C -` 续传补齐即可。先 `ls -l` 对照 Drive 页面大小。

### .blend → GLB 转换配方（Blender 4.5 LTS headless）

Blender 安装：官方源 `download.blender.org` 对 CN 网络常 HTTP/2 中断，用 TUNA 镜像
`https://mirrors.tuna.tsinghua.edu.cn/blender/release/Blender4.5/blender-4.5.9-macos-arm64.dmg`。

```bash
# 转换脚本要点（完整版思路）：
/Applications/Blender.app/Contents/MacOS/Blender -b -P blend2glb.py -- 源.blend 出.glb
#   1) 删 LIGHT/CAMERA/EMPTY 对象 + 删 0 尺寸图像块（Render Result）
#   2) 选中全部 MESH → bpy.ops.export_scene.gltf(
#        use_selection=True, export_format='GLB', export_apply=True, export_animations=False)
#   3) 贴图（DF 漫反射/NM 法线/MRS ORM/AEM 自发光遮罩）会自动内嵌
```

转换后两个必须的修正（脚本用 @gltf-transform，项目自带依赖）：

1. **材质补丁**：Valorant 的 MRS 通道语义与 glTF ORM 不一致，导出结果全金属+全粗糙
   （= 纯黑剪影）。摘 `metallicRoughnessTexture`、写死 `metallicFactor 0.3 / roughnessFactor 0.5`
   （法线贴图保留）。注意漫反射贴图本来就是近黑的（Vandal 默认皮肤暗色系），黑 ≠ 损坏。
2. **枪口朝向**：截面法检测（两端各 8% 顶点，横截面小的一端 = 细枪管 = 枪口）。
   枪口在 +X 时绕 Y 翻 180°（`Node.setRotation([0,1,0,0])` + 平移 xy 取反）对齐本项目
   「-X = 枪口」作者系约定。

最后 `npm run optimize:models public/models/viewmodel-*.glb` 压缩（实测 -18% ~ -43%）。

### 扩枪

同一 Drive 文件夹里的其余武器（Sheriff/Classic/Ghost 等本训练器的手枪槽、或新槽位）
走完全相同的配方即可；材质/网格名是官方代号（Vandal=GN_AK、Phantom=GN_Carbine+Tritium
氚光自发光），可用于识别与特效挂点。
