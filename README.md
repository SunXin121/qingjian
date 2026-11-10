# 青简 Qingjian

个人自托管的在线知识库：打开网页就能记笔记，原生 Markdown + 所见即所得，桌面和手机都能看、能写。

- **编辑器**：Markdown 快捷语法、`/` 斜杠菜单、块拖拽、表格、任务列表、代码高亮、LaTeX 公式
- **绘图**：Mermaid、Graphviz 文本绘图（实时预览），Excalidraw 手绘画板（支持中文手写字体），draw.io 流程图，思维导图
- **提示块 / 折叠块**：信息、警告、成功、错误四种提示块和可折叠块，存储为 Obsidian / GitHub 兼容的 `> [!INFO]` 语法
- **附件**：粘贴 / 拖拽 / 菜单上传图片和任意文件，按内容去重
- **组织**：多知识库、多级目录树（桌面拖拽，手机菜单移动）、分组
- **多维表格**：目录中新建「多维表格」，12 种字段（文本、数字、单选 / 多选、日期、复选框、链接、附件、自动编号、创建 / 修改时间等），表格视图（冻结列、列宽、隐藏字段、统计栏、分组）和看板视图（拖拽卡片），每个视图独立的筛选 / 排序 / 分组；记录详情卡片（含修改记录）、键盘导航、拖拽整行调整顺序、表内搜索（Ctrl+F）、与 Excel 互相复制粘贴、填充柄、撤销 / 重做、CSV 导入导出；可用 `/` 菜单把某个视图嵌入文档
- **分享**：单篇文档、多维表格（可限定只看某个视图）或整个知识库生成只读链接（文档站样式），可设访问密码、有效期，随时关闭或重新生成
- **安全网**：自动保存、多标签页冲突检测、历史版本（预览 / 差异对比 / 恢复）、回收站（30 天）、定时备份到本地 / WebDAV / S3
- **搜索**：标题 + 正文全文搜索，支持中文，`Ctrl/⌘ + K`
- **导出**：单篇 Markdown，或整个知识库导出为 zip（Markdown + 附件，画板 / 流程图 / 思维导图转为 SVG 图片，多维表格导出为 CSV，文档中嵌入的表格转为 Markdown 表格）
- **深色模式**：跟随系统自动切换
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
| `QINGJIAN_DRAWIO_URL` | `https://embed.diagrams.net/` | draw.io 编辑器地址，可换成自建的 draw.io |
| `QINGJIAN_DRAWIO_DIR` | （空） | 本地 draw.io 静态文件目录，设置后由青简在 `/drawio/` 下提供，完全离线可用（见下文） |
| `QINGJIAN_BACKUP_*` | （空） | 自动备份，见下文 |

修改管理密码后，所有已登录的会话都会失效。

## 备份

全部数据都在 `data/` 目录下：

```
data/
├── qingjian.db       # SQLite（文档、多维表格、目录、版本、分享、索引）
└── files/            # 附件，按 sha256 分目录存放
```

### 自动备份

配置任意一个备份目标即可开启定时备份。每次备份会生成一份一致的数据库快照（`VACUUM INTO` + gzip），附件按内容寻址**增量上传**（同一文件只传一次，备份端的附件永不删除）。在「设置」页可以查看备份状态、手动触发备份。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `QINGJIAN_BACKUP_INTERVAL_HOURS` | `24` | 备份间隔（小时）；失败后 1 小时重试 |
| `QINGJIAN_BACKUP_KEEP` | `7` | 每个目标保留的数据库快照份数 |
| `QINGJIAN_BACKUP_DIR` | | 本地目录（比如挂载的另一块硬盘、NAS 共享目录） |
| `QINGJIAN_BACKUP_WEBDAV_URL` | | WebDAV 目录地址，如坚果云 `https://dav.jianguoyun.com/dav/qingjian/` |
| `QINGJIAN_BACKUP_WEBDAV_USER` / `_PASSWORD` | | WebDAV 账号 / 应用密码 |
| `QINGJIAN_BACKUP_S3_BUCKET` | | S3 存储桶（设置后启用 S3 备份） |
| `QINGJIAN_BACKUP_S3_ENDPOINT` | AWS | S3 兼容服务地址，如 `http://minio:9000`、`https://<account>.r2.cloudflarestorage.com` |
| `QINGJIAN_BACKUP_S3_REGION` | `us-east-1` | 区域（R2 填 `auto`） |
| `QINGJIAN_BACKUP_S3_PREFIX` | | 对象前缀，如 `qingjian/` |
| `QINGJIAN_BACKUP_S3_ACCESS_KEY` / `_SECRET_KEY` | | 访问密钥 |

备份目标里的结构：

```
db/qingjian-20261110-030000.db.gz    数据库快照（按 KEEP 轮转）
files/ab/cd/<sha256>                 附件
```

恢复：停止服务，把最新的快照解压为 `data/qingjian.db`，把 `files/` 整个目录复制到 `data/files/`，再启动即可。

> 数据库快照包含管理密码哈希和会话密钥，请妥善保管备份。

也可以不开自动备份，自己用 `sqlite3 data/qingjian.db ".backup backup.db"` 在线备份数据库，再把 `files/` 一起打包。

### 附件清理

删除文档里的图片后，附件文件不会立刻删除（历史版本可能还在引用）。在「设置 → 存储空间」可以看到未被任何文档、回收站和历史版本引用的附件，并一键清理。

## 分享

在文档页右上角的分享按钮，或知识库的「⋯」菜单中创建分享链接。访客只能只读浏览：

- 分享知识库时，访客看到带目录的文档站，文档之间的内部链接会自动跳转到分享页内。
- 分享多维表格时可以限定只公开某一个视图；访客可以在页面上临时筛选、排序，但不会保存，也不能修改数据。分享的文档里嵌入的表格对访客同样可见。
- 可设置访问密码（修改密码后已登录的访客需要重新输入）和有效期（永久 / 1 天 / 7 天 / 30 天 / 自定义）。
- 可以随时关闭、重新开启或重新生成链接（旧链接立即失效）；「分享管理」页列出所有分享和访问次数。
- 文档被删除后，分享自动失效；彻底删除时分享记录一并清除。
- 所有页面都带 `noindex`，不会被搜索引擎收录。

## draw.io 离线部署

默认使用官方的 `embed.diagrams.net` 嵌入式编辑器，图表数据只在你的浏览器和青简之间传递，不会上传到 draw.io。如果需要完全离线：

1. 从 [jgraph/drawio releases](https://github.com/jgraph/drawio/releases) 下载 `draw.war`，用 unzip 解压到某个目录（例如 `./drawio`）。
2. 挂载到容器并设置 `QINGJIAN_DRAWIO_DIR=/drawio`，青简会在 `/drawio/` 下提供这些静态文件。

或者运行官方的 `jgraph/drawio` 镜像，把 `QINGJIAN_DRAWIO_URL` 指向它。

## 开发

需要 Go 1.26+ 和 Node 20+。

```bash
cd web && npm install && cd ..
make dev-server     # 终端 1：后端 :8080（默认密码 dev）
make dev-web        # 终端 2：前端 :5173，接口代理到 :8080
make build          # 生成 bin/qingjian（已内嵌前端）
go test ./...       # 后端测试
```

## 目录结构

```
cmd/qingjian/        程序入口
internal/server/     HTTP API、鉴权、SQLite、附件、搜索、导出、分享、备份
web/                 React + Vite 前端（构建产物通过 embed 打包进二进制）
  src/editor/        Milkdown Crepe 编辑器、绘图预览、Excalidraw / draw.io / 思维导图、提示块
  src/table/         多维表格：数据模型与撤销、筛选排序分组引擎、Glide 表格视图、看板、记录卡片、文档嵌入
  src/pages/         首页 / 知识库 / 文档 / 多维表格 / 分享页 / 分享管理 / 设置 / 回收站 / 登录
docs/PRD.md          需求文档
```

## 安全说明

- 除登录、健康检查和分享页接口外，所有接口都需要登录；写操作还会校验 Origin，防止跨站请求。
- 分享链接使用 22 位随机 token；分享接口只返回该分享范围内的文档，密码用 PBKDF2 存储，验证失败同样受登录限流保护。
- 附件通过 20 位随机 ID 访问，响应带有 `CSP: sandbox` 和 `nosniff`，上传的 SVG 或 HTML 无法执行脚本。
- 附件链接本身就是访问凭证（知道链接即可访问），不要把附件链接公开发布。
