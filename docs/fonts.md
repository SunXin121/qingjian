# 字体来源

青简的在线正文字体选项对照 [edgeever 字体目录](https://github.com/tianma-if/edgeever/blob/main/packages/shared/src/font-catalog-data.ts) 与 [早期正文字体目录](https://github.com/tianma-if/edgeever/blob/main/packages/shared/src/font-defaults.ts)，包含 24 款目录字体和 3 款早期字体。加载器为青简独立实现，不依赖 edgeever 的运行时代码。

字体在选中后从固定版本的公开来源加载；不会在打开设置时下载所有字体。字体文件保持原样，不转换或重新分片。浏览器可按 unicode-range 下载分片，并使用正常的 HTTP 缓存。字体来源无法访问时使用系统字体，可在设置中重试。西文字体未覆盖的中文字符也使用系统字体。字体请求不携带笔记正文。

| 来源 | 字体 | 授权信息 |
| --- | --- | --- |
| `@chinese-fonts/dyh@3.0.0` | 得意黑 | [Smiley Sans / OFL](https://github.com/atelier-anchor/smiley-sans) |
| `@chinese-fonts/lxgwwenkai@3.0.0` | 霞鹜文楷 | [LXGW WenKai / OFL](https://github.com/lxgw/LxgwWenKai) |
| `@chinese-fonts/zqfs@3.0.0` | 朱雀仿宋 | [Zhuque Fangsong / OFL](https://github.com/TrionesType/zhuque) |
| `@chinese-fonts/maple-mono-cn@2.0.0` | Maple Mono CN | [Maple Mono / OFL](https://github.com/subframe7536/maple-font) |
| `@fontsource/noto-sans-sc@5.3.1` | 思源黑体 Heavy | [Noto Sans CJK / OFL](https://github.com/notofonts/noto-cjk) |
| `@fontpkg/alibaba-pu-hui-ti-3-0@3.1.2` | 阿里巴巴普惠体、Heavy | [阿里巴巴字体授权](https://fonts.alibabagroup.com/)；原始 TTF，不修改 |
| `@fontpkg/alimama-shu-hei-ti@1.0.5` | 阿里妈妈数黑体 | [阿里巴巴字体授权](https://fonts.alibabagroup.com/)；原始 TTF，不修改 |
| `@fontpkg/you-she-biao-ti-hei@1.0.0` | 优设标题黑 | [优设字体](https://www.uisdc.com/)；原始 TTF，不修改 |
| edgeever `0da78f6ce8a4643b2dfb7afe9f7a5101472c4ffb`，`apps/web/public/poster-fonts` | 思源宋体、思源黑体、思源宋体 Heavy、抖音美好体、马善政楷书、江城圆体、站酷庆科黄油体、未来荧黑、站酷快乐体、Inter、Space Grotesk、DM Serif Display、Anton、Bebas Neue、JetBrains Mono | [原始字体版权和授权说明](https://github.com/tianma-if/edgeever/blob/0da78f6ce8a4643b2dfb7afe9f7a5101472c4ffb/packages/shared/src/poster-font-notices.ts)；保留字体容器内的版权和授权元数据 |
| edgeever `cb13c0759256caed174b4063845c7948d90fc1bd`，`apps/web/src/assets/fonts/editor-body` | 霞鹜文楷屏幕阅读版、霞鹜新致宋、Source Serif 4 | [随字体提供的 OFL / IPA 授权文件](https://github.com/tianma-if/edgeever/tree/cb13c0759256caed174b4063845c7948d90fc1bd/apps/web/src/assets/fonts/editor-body) |

在线资源优先使用 jsDelivr；npm 包以 unpkg 为备用，固定 Git 提交的文件以 GitHub Raw 为备用。本机字体和系统字体不产生在线字体请求。
