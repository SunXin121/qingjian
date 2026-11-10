# Qingjian（青简）产品需求文档

> 个人自托管的在线知识库：打开网页就能记笔记，原生 Markdown + 所见即所得，支持多种绘图、附件、分享与多维表格。
> 版本：v1.0 · 2026-11-10

## 1. 定位与原则

- **单人使用**：无账号体系、无团队 / 空间 / 协同。仅用一个管理密码保护写操作。
- **数据不锁定**：正文以 Markdown 存储；复杂绘图（Excalidraw / draw.io / 思维导图）源数据作为附件单独存储，正文中引用，导出时转为图片链接。
- **低资源占用**：Go 单二进制 + SQLite + 本地文件，1C1G 可运行；重型服务（PlantUML）可选、默认关闭。
- **多端自适应**：桌面与手机浏览器均可**阅读和编辑**（不做原生 App / PWA）。

## 2. 已确认决策

| 项 | 结论 |
|---|---|
| 存储格式 | Markdown 正文 + 绘图 JSON 附件引用 |
| 语雀导入 | 不需要 |
| 终端 | 仅网页端；需要手机自适应，手机上可看可写 |
| 账号 | 无账号系统，单一管理密码（环境变量 `QINGJIAN_ADMIN_PASSWORD`） |
| 分享 | 访客只读；支持密码、有效期、随时撤销 |
| 多维表格 | 需要，参照飞书多维表格，分阶段实现 |
| 技术栈 | 不限，资源占用越低越好 → Go + SQLite + React |

## 3. 功能需求

优先级：P0 首版必须 / P1 第二阶段 / P2 以后 / ✗ 不做

### 3.1 访问控制
| 功能 | 优先级 | 说明 |
|---|---|---|
| 管理密码登录 | P0 | 环境变量配置；未配置时首次启动随机生成并打印到日志 |
| 长期会话 | P0 | 签名 Cookie，30 天；修改密码后旧会话失效 |
| 登录限流 | P0 | 单 IP 连续失败 5 次锁定 10 分钟 |
| CSRF 防护 | P0 | SameSite Cookie + Origin 校验 |
| TOTP 两步验证 | P2 | |

### 3.2 知识库与目录
| 功能 | 优先级 |
|---|---|
| 知识库增删改（名称、简介、图标） | P0 |
| 目录树：多级嵌套、拖拽排序 / 移动（桌面）、菜单移动（手机） | P0 |
| 节点类型：文档、分组、多维表格 | P0 / P0 / M3 |
| 首页：知识库列表 + 最近编辑 | P0 |
| 回收站（软删除，30 天自动清理） | P0 |
| 跨知识库移动 / 复制文档 | P1 |
| 收藏、标签 | P1 |
| 文档模板 | P2 |

### 3.3 编辑器
- 所见即所得 + Markdown 快捷输入；`/` 斜杠菜单；块拖拽（桌面）；选中浮动工具栏
- 自动保存（停止输入 1s 后）+ `Ctrl/⌘+S`；多标签页编辑冲突检测（409 提示）
- 文档大纲（桌面右侧 / 手机抽屉）

| 块 | 优先级 |
|---|---|
| 标题、粗斜体、删除线、行内代码、链接 | P0 |
| 有序 / 无序 / 任务列表、引用、分割线、表格 | P0 |
| 代码块（高亮、语言选择、复制） | P0 |
| 数学公式（KaTeX，行内 + 块级） | P0 |
| 图片（粘贴 / 拖拽 / 上传）、附件卡片 | P0 |
| 提示块（info/warn/success/error）、折叠块（`> [!TYPE]` 语法，兼容 Obsidian / GitHub） | P1 |
| 视频 / 音频、链接卡片、文档嵌入 | P2 |
| Markdown 源码模式切换 | P1 |

### 3.4 绘图
| 类型 | 实现 | 存储 | 优先级 |
|---|---|---|---|
| Mermaid | 前端 mermaid.js | 正文 ```` ```mermaid ```` 代码块 | P0 |
| Graphviz (DOT) | 前端 @viz-js/viz (WASM) | 正文 ```` ```dot ```` 代码块 | P0 |
| 手绘画板 | Excalidraw | 场景 JSON + SVG 预览均为附件，正文 ```` ```excalidraw ```` 引用块 | P0 |
| 流程图 / 架构图 | draw.io 嵌入（默认 embed.diagrams.net，可配置自托管静态资源） | 同上 | P1 |
| 思维导图 | simple-mind-map（原生 SVG 导出） | 同上 | P1 |
| PlantUML | 可选 plantuml-server 容器 | 代码块 | P2 |
| ECharts 图表 | 前端 | JSON 代码块 | P2 |

### 3.5 附件
| 功能 | 优先级 |
|---|---|
| 粘贴 / 拖拽 / 点击上传，进度显示 | P0 |
| 单文件大小上限可配（默认 100MB） | P0 |
| 本地存储，按 SHA-256 内容去重 | P0 |
| 图片、PDF、音视频在线预览 | P1 |
| 未引用附件清理、空间占用统计 | P1 |
| S3 / MinIO 存储后端 | P2 |

安全：附件 ID 为不可猜测的随机串；响应附带 `Content-Security-Policy: sandbox` 与 `nosniff`，防止上传的 SVG/HTML 执行脚本。

### 3.6 分享（M2）
| 功能 | 优先级 |
|---|---|
| 分享单篇文档 / 整个知识库（文档站样式，带目录） | P0 |
| 访问密码 | P0 |
| 有效期（永久 / 7 天 / 30 天 / 自定义） | P0 |
| 撤销、重新生成链接 | P0 |
| 分享管理页 | P1 |
| 访问计数 | P1 |
| 默认 `noindex` | P0 |
| 手机端阅读适配 | P0 |
| 自定义短链 / 独立域名 | P2 |

### 3.7 搜索
| 功能 | 优先级 |
|---|---|
| 全文搜索（标题 + 正文），中文支持，结果高亮 | P0 |
| `Ctrl/⌘+K` 快速跳转 | P0 |

实现：SQLite FTS5 `trigram` 分词；1~2 字查询回退 LIKE。

### 3.8 版本与数据安全
| 功能 | 优先级 |
|---|---|
| 历史版本（10 分钟一个快照 + 手动保存快照） | P0 |
| 版本预览与恢复 | P0 |
| 版本 diff | P1 |
| 定时备份（数据库 + 附件 → 本地 / WebDAV / S3） | P1 |

### 3.9 导入导出
| 功能 | 优先级 |
|---|---|
| 单篇导出 Markdown | P0 |
| 知识库导出 zip（Markdown + 附件，保留目录结构） | P0 |
| 导入 Markdown / zip | P2 |
| 导出 PDF | P2 |

### 3.10 多维表格（M3/M4）
**位置**：目录树中的独立节点类型；可作为视图块嵌入文档；可只读分享（密码、指定视图）。

| 字段类型 | 优先级 |
|---|---|
| 文本、多行文本、数字、单选、多选、日期、复选框、链接、附件、自动编号、创建 / 修改时间 | P0 |
| 评分、进度、电话、邮箱、关联（单 / 双向）、查找引用、汇总 | P1 ✅ |
| 公式 | P1 ✅ |
| 人员、群组 | ✗ |

| 视图 | 优先级 |
|---|---|
| 表格（冻结列、列宽、隐藏字段、统计栏） | P0 |
| 看板（按单选分组，拖拽） | P0 |
| 画册、日历 | P1 ✅ |
| 甘特 | P2 |
| 表单 | ✗ |

| 通用能力 | 优先级 |
|---|---|
| 每视图独立的筛选 / 排序 / 分组 | P0 |
| 记录详情卡片、键盘导航、Excel 复制粘贴、填充柄、拖拽整行调整顺序 | P0 |
| 撤销 / 重做、CSV 导入导出 | P0 |
| 表内搜索、记录修改历史 | P1 ✅ |
| Excel 导入导出 | P1 ✅ |
| 自动化、仪表盘 | P2 |

**实现要点**：Canvas 表格（Glide Data Grid / VisActor VTable）；`fields / views / records(JSON)` 通用存储；整表加载至浏览器，筛选排序公式在前端计算，后端仅存原始值、增量保存。
关联字段存储对方记录 ID 数组；双向关联由后端在同一事务内同步对方表格的配对字段；读取表格时一并返回关联到的表格（分享页仅返回计算所需的字段与记录）。公式 / 查找引用 / 汇总按列惰性计算，支持互相引用与跨表引用，检测循环引用。导出 Markdown / CSV 时后端渲染关联、查找引用与汇总的文本，公式值仅在浏览器中计算。Excel 读写在浏览器中完成（JSZip，按需加载）。

### 3.11 体验
| 功能 | 优先级 |
|---|---|
| 响应式布局：≥1024 三栏、768~1024 两栏、<768 单栏 + 抽屉侧栏 | P0 |
| 手机编辑：触控友好的工具栏、44px 点击区域、安全区适配 | P0 |
| 快捷键 | P0 |
| 深色模式（跟随系统） | P1 |
| 字数统计、更新时间 | P1 |

## 4. 非功能需求

| 项 | 要求 |
|---|---|
| 部署 | Docker Compose（GitHub Actions 自动构建多架构镜像，推送到 GHCR / Docker Hub）；HTTPS 由外部反向代理提供；也可直接运行二进制 |
| 资源 | 空闲内存 < 60MB（实测约 17MB）；镜像 < 100MB（实测 84MB，含内嵌前端与画板字体） |
| 性能 | 万字 + 数十图文档编辑流畅；首屏 < 2s；重型模块懒加载 |
| 安全 | Markdown 渲染防 XSS；上传类型 / 大小限制；随机分享 token |
| 备份 | 整个 `/data` 目录即全部数据 |
| 可迁移 | 全部数据可导出为标准 Markdown + 附件 |

## 5. 架构

```
浏览器（React + Vite，模块按需加载）
  Milkdown(Crepe) 编辑器 │ Excalidraw │ Mermaid │ Graphviz(WASM) │ 多维表格
        │ HTTPS（外部反向代理：Nginx / Caddy 等）
Go 单二进制（内嵌前端静态资源）
  ├─ REST API：auth / repos / nodes / docs / files / search / trash / export / shares / backup / tables
  ├─ SQLite（WAL）+ FTS5 trigram
  └─ /data/files（按 sha256 分目录存储）
```

## 6. 数据模型

```
settings      key, value
repos         id, name, description, icon, sort, created_at, updated_at, deleted_at
nodes         id, repo_id, parent_id, type(doc|group|table), title, sort, created_at, updated_at, deleted_at, trash_root
doc_contents  node_id, markdown, updated_at
doc_versions  id, node_id, title, markdown, created_at
docs_fts      FTS5(node_id, title, body) tokenize=trigram
attachments   id, sha256, name, mime, size, created_at
backup_blobs  target, sha256                                    (已上传到各备份目标的附件，M2)
shares        token, target_type(node|repo), target_id, view_id, password_hash, expires_at, enabled, options, view_count, created_at   (M2)
bt_fields     id, table_node_id, name, type, options(json), sort                                                                    (M3)
bt_views      id, table_node_id, name, type, config(json), sort                                                                     (M3)
bt_records    id, table_node_id, seq(自动编号), data(json), sort, created_at, updated_at                                            (M3)
bt_record_history  id, table_node_id, record_id, action(create|update|delete|restore), changes(json: 字段旧值 / 新值), created_at, updated_at   (M3)
```

## 7. 里程碑

| 阶段 | 内容 |
|---|---|
| **M1 文档核心** ✅ | 管理密码、知识库与目录树、Crepe 编辑器、代码 / 公式 / Mermaid / Graphviz / Excalidraw、图片附件、全文搜索、回收站、历史版本、Markdown 导出、响应式布局、Docker 部署 |
| **M2 分享与增强** ✅ | 分享（密码 / 有效期 / 管理）、draw.io、思维导图、提示块 / 折叠块、版本 diff、自动备份、深色模式、附件清理 |
| **M3 多维表格基础** ✅ | 表格 + 看板视图、P0 字段、筛选排序分组、复制粘贴、CSV、分享、嵌入文档 |
| **M4 多维表格进阶** ✅ | 关联 / 查找 / 汇总 / 公式、评分 / 进度 / 电话 / 邮箱、画册 / 日历、Excel |
| **M5** | 甘特、PlantUML、双链、AI 等 |
