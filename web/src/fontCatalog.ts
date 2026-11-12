/** Font metadata matching edgeever's body-font menu (24 catalog + 3 legacy choices).
 * Files are fetched unchanged from version-pinned sources, only after selection.
 * Sources and font licenses: docs/fonts.md.
 */
const POSTER = 'gh/tianma-if/edgeever@0da78f6ce8a4643b2dfb7afe9f7a5101472c4ffb/apps/web/public/poster-fonts/'
const BODY = 'gh/tianma-if/edgeever@cb13c0759256caed174b4063845c7948d90fc1bd/apps/web/src/assets/fonts/editor-body/'
export const ONLINE_FONTS = {
  wenkai: { label: '霞鹜文楷', path: '@chinese-fonts/lxgwwenkai@3.0.0/dist/LXGWWenKai-Regular/result.css' },
  zhuque: { label: '朱雀仿宋', path: '@chinese-fonts/zqfs@3.0.0/dist/ZhuqueFangsong-Regular/result.css' },
  'source-han-serif': { label: '思源宋体', path: POSTER + 'notoserif.woff2' },
  'source-han-sans': { label: '思源黑体', path: POSTER + 'notosans.woff2' },
  puhui: { label: '阿里巴巴普惠体', path: '@fontpkg/alibaba-pu-hui-ti-3-0@3.1.2/AlibabaPuHuiTi-3-55-Regular.ttf' },
  'maple-mono-cn': { label: 'Maple Mono CN', path: '@chinese-fonts/maple-mono-cn@2.0.0/dist/MapleMono-CN-Regular/result.css' },
  'wenkai-screen': { label: '霞鹜文楷屏幕阅读版', path: BODY + 'kai-screen.woff2' },
  'neo-zhi-song': { label: '霞鹜新致宋', path: BODY + 'zhi-song.woff2' },
  smiley: { label: '得意黑', path: '@chinese-fonts/dyh@3.0.0/dist/SmileySans-Oblique/result.css' },
  heavy: { label: '思源黑体 Heavy', path: '@fontsource/noto-sans-sc@5.3.1/900.css', weight: '900' },
  'puhui-heavy': { label: '阿里巴巴普惠体 Heavy', path: '@fontpkg/alibaba-pu-hui-ti-3-0@3.1.2/AlibabaPuHuiTi-3-105-Heavy.ttf', weight: '900' },
  youshe: { label: '优设标题黑', path: '@fontpkg/you-she-biao-ti-hei@1.0.0/%E4%BC%98%E8%AE%BE%E6%A0%87%E9%A2%98%E9%BB%91.ttf' },
  shuhei: { label: '阿里妈妈数黑体', path: '@fontpkg/alimama-shu-hei-ti@1.0.5/AlimamaShuHeiTi-Bold.ttf', weight: '700' },
  douyin: { label: '抖音美好体', path: POSTER + 'douyin.ttf' },
  mashan: { label: '马善政楷书', path: POSTER + 'mashan.woff2' },
  jiangcheng: { label: '江城圆体', path: POSTER + 'jiangcheng.woff2' },
  huangyou: { label: '站酷庆科黄油体', path: POSTER + 'huangyou.woff2' },
  glow: { label: '未来荧黑', path: POSTER + 'glow.woff2', weight: '900' },
  kuaile: { label: '站酷快乐体', path: POSTER + 'kuaile.woff2' },
  'source-han-serif-heavy': { label: '思源宋体 Heavy', path: POSTER + 'notoserif-heavy.woff2', weight: '900' },
  inter: { label: 'Inter', path: POSTER + 'inter.woff2' },
  spacegrotesk: { label: 'Space Grotesk', path: POSTER + 'spacegrotesk.woff2' },
  dmserif: { label: 'DM Serif Display', path: POSTER + 'dmserif.woff2' },
  anton: { label: 'Anton', path: POSTER + 'anton.woff2' },
  bebas: { label: 'Bebas Neue', path: POSTER + 'bebas.woff2' },
  jetbrains: { label: 'JetBrains Mono', path: POSTER + 'jetbrains.woff2' },
  'source-serif': { label: 'Source Serif 4', path: BODY + 'source-serif-4-regular.woff2' },
} as const
export type OnlineFont = keyof typeof ONLINE_FONTS
export const FONT_GROUPS = [
  { label: '中文阅读', ids: ['wenkai', 'zhuque', 'source-han-serif', 'source-han-sans', 'puhui', 'wenkai-screen', 'neo-zhi-song'] },
  { label: '中文展示', ids: ['smiley', 'heavy', 'puhui-heavy', 'youshe', 'shuhei', 'douyin', 'mashan', 'jiangcheng', 'huangyou', 'glow', 'kuaile', 'source-han-serif-heavy'] },
  { label: '西文与等宽', ids: ['inter', 'spacegrotesk', 'dmserif', 'anton', 'bebas', 'jetbrains', 'maple-mono-cn', 'source-serif'] },
] as const satisfies readonly { label: string; ids: readonly OnlineFont[] }[]
export const isOnlineFont = (id: string): id is OnlineFont => Object.hasOwn(ONLINE_FONTS, id)
export const onlineFontFamily = (id: OnlineFont) => `Qingjian ${id}`
export const ONLINE_FONT_OPTIONS = Object.fromEntries(Object.entries(ONLINE_FONTS).map(([id, font]) => [id, {
  label: font.label,
  stack: `"${onlineFontFamily(id as OnlineFont)}", var(--font-ui)`,
}])) as Record<OnlineFont, { label: string; stack: string }>

export function fontSourceUrls(path: string): string[] {
  return path.startsWith('gh/')
    ? [`https://cdn.jsdelivr.net/${path}`, `https://raw.githubusercontent.com/${path.slice(3).replace('@', '/')}`]
    : [`https://cdn.jsdelivr.net/npm/${path}`, `https://unpkg.com/${path}`]
}
export interface FontSubset { urls: string[]; weight: string; range: string }

/** Read font descriptors only; third-party styles never enter the page. */
export function parseFontStylesheet(css: string, path: string): FontSubset[] {
  const sources = fontSourceUrls(path)
  const base = sources[0]
  const directory = new URL('.', base).href
  const subsets: FontSubset[] = []
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
    const body = block[1]
    const file = /url\(\s*["']?([^\s"')]+\.woff2)["']?\s*\)/i.exec(body)?.[1]
    const weight = /font-weight\s*:\s*(\d+(?:\s+\d+)?)/i.exec(body)?.[1]
    const range = /unicode-range\s*:\s*([^;]+)/i.exec(body)?.[1].trim()
    if (!file || !weight || !range || !/^U\+[\da-f?]+(?:-[\da-f]+)?(?:\s*,\s*U\+[\da-f?]+(?:-[\da-f]+)?)*$/i.test(range)) continue
    try {
      const url = new URL(file, base)
      if (!url.href.startsWith(directory) || url.search || url.hash) continue
      subsets.push({ urls: sources.map(source => new URL(url.href.slice(directory.length), new URL('.', source)).href), weight, range })
    } catch { /* Ignore malformed font entries. */ }
  }
  if (!subsets.length) throw new Error('字体清单中没有可用字形')
  return subsets
}
