# 青简 Qingjian

个人自托管的在线知识库：打开网页就能记笔记，原生 Markdown + 所见即所得，桌面和手机都能看、能写。

- **编辑器**：Markdown 快捷语法、`/` 斜杠菜单、块拖拽、表格、任务列表、代码高亮、LaTeX 公式
- **绘图**：Mermaid、Graphviz 文本绘图（实时预览），Excalidraw 手绘画板（支持中文手写字体）
- **附件**：粘贴 / 拖拽 / 菜单上传图片和任意文件，按内容去重
- **组织**：多知识库、多级目录树（桌面拖拽，手机菜单移动）、分组
- **安全网**：自动保存、多标签页冲突检测、历史版本与恢复、回收站（30 天）
- **搜索**：标题 + 正文全文搜索，支持中文，`Ctrl/⌘ + K`
- **导出**：单篇 Markdown，或整个知识库导出为 zip（Markdown + 附件，画板转为 SVG 图片）
- **轻量**：Go 单二进制 + SQLite，运行时内存约 20MB

需求与路线图见 [docs/PRD.md](docs/PRD.md)。

## 部署

推送到 `main` 分支或打 `v*` 标签时，GitHub Actions 会自动构建 `linux/amd64` 和 `linux/arm64` 两种架构的镜像：

| 仓库 | 镜像 | 说明 |
|---|---|---|
| GitHub Container Registry | `ghcr.io/sunxin121/qingjian` | 默认推送，不需要额外配置 |
| Docker Hub | `<用户名>/qingjian` | 在仓库 Secrets 中配置 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN` 后自动推送 |

标签规则：`latest` 跟随 main 分支；`v1.2.3` 标签会生成 `1.2.3` 和 `1.2` 两个镜像标签；另外每次提交都会生成一个 `sha-xxxxxxx` 标签。

### Docker Compose

```bash
mkdir qingjian && cd qingjian
# 下载 docker-compose.yml 和 .env.example，然后：
cp .env.example .env      # 至少修改 QINGJIAN_ADMIN_PASSWORD
docker compose pull
docker compose up -d
```

默认只监听 `127.0.0.1:8080`，需要你在前面配一个反向代理来提供 HTTPS。管理密码会通过网络传输，所以**不要在公网上用明文 HTTP 访问**。如果镜像是私有的，先执行 `docker login ghcr.io`。

### 反向代理示例

Caddy：

```
note.example.com {
	encode zstd gzip
	request_body {
		max_size 120MB
	}
	reverse_proxy 127.0.0.1:8080
}
```

Nginx：

```nginx
server {
    listen 443 ssl http2;
    server_name note.example.com;
    # ssl_certificate / ssl_certificate_key ...
    client_max_body_size 120m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

使用反向代理时，在 `.env` 里设置 `QINGJIAN_TRUST_PROXY=1`。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `QINGJIAN_ADMIN_PASSWORD` | （空） | 管理密码。未设置时首次启动会随机生成一个并打印在日志中 |
| `QINGJIAN_ADDR` | `:8080` | 监听地址 |
| `QINGJIAN_DATA` | `./data` | 数据目录 |
| `QINGJIAN_MAX_UPLOAD_MB` | `100` | 单个附件大小上限 |
| `QINGJIAN_TRUST_PROXY` | （空） | 在反向代理后面运行时设为 `1`，用于识别真实 IP 和 HTTPS |
| `QINGJIAN_TRASH_DAYS` | `30` | 回收站保留天数 |

修改管理密码后，所有已登录的会话都会失效。

## 备份

全部数据都在 `data/` 目录下：

```
data/
├── qingjian.db       # SQLite（文档、目录、版本、索引）
└── files/            # 附件，按 sha256 分目录存放
```

建议定时备份。用 `sqlite3 data/qingjian.db ".backup backup.db"` 可以在线备份数据库，再把 `files/` 一起打包。

## 开发

需要 Go 1.26+ 和 Node 20+。

```bash
cd web && npm install && cd ..
make dev-server     # 终端 1：后端 :8080（默认密码 dev）
make dev-web        # 终端 2：前端 :5173，接口代理到 :8080
make build          # 生成 bin/qingjian（已内嵌前端）
```

## 目录结构

```
cmd/qingjian/        程序入口
internal/server/     HTTP API、鉴权、SQLite、附件、搜索、导出
web/                 React + Vite 前端（构建产物通过 embed 打包进二进制）
  src/editor/        Milkdown Crepe 编辑器、绘图预览、Excalidraw 画板
  src/pages/         首页 / 知识库 / 文档 / 回收站 / 登录
docs/PRD.md          需求文档
```

## 安全说明

- 除登录和健康检查外，所有接口都需要登录；写操作还会校验 Origin，防止跨站请求。
- 附件通过 20 位随机 ID 访问，响应带有 `CSP: sandbox` 和 `nosniff`，上传的 SVG 或 HTML 无法执行脚本。
- 附件链接本身就是访问凭证（知道链接即可访问），不要把附件链接公开发布。
