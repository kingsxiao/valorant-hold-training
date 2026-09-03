# 部署指南

纯静态单页应用（SPA），`npm run build` 产物在 `dist/`，**任意静态文件服务器可直接托管**，无需 Node 运行时、无后端、无环境变量。

## 产物构成（v6.x，2026-09 体积优化后）

| 文件 | 大小 | 缓存建议 |
| --- | --- | --- |
| `index.html` | ~1 KB | **不缓存**（每次都拿最新的资源 hash） |
| `assets/*.js/.css/.woff2` | ~800 KB | 带内容 hash，可 `immutable` 长缓存 |
| `models/*.glb` | ~2.0 MB | 无 hash，`no-cache` 或短缓存（见下） |
| `sfx/README.txt`、`models/README.txt` | ~4 KB | 随意 |

首次加载全量约 **3.3 MB**（gzip 后约 **1.1 MB**）；二次访问命中缓存后几乎零下载。字体已自托管（原 Google Fonts 外链移除），**无任何第三方请求**，断网/内网环境完整可用。

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
