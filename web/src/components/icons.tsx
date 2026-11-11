import { useState } from 'react'
import {
  Upload,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpLeft,
  BookMarked,
  Check,
  ChevronRight,
  Clock,
  Cloud,
  Camera,
  Copy,
  CornerDownRight,
  Database,
  Download,
  Ellipsis,
  Eye,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  HardDrive,
  History,
  House,
  Info,
  KeyRound,
  Library,
  Link2,
  Lock,
  LogOut,
  Menu,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  Share2,
  Sheet,
  Sparkles,
  TableOfContents,
  Trash2,
  Unlink,
  X,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react'

// One icon set (lucide) everywhere, with app-wide defaults for size and stroke.
const wrap = (I: LucideIcon) =>
  function Icon(props: LucideProps) {
    return <I size={18} strokeWidth={1.75} aria-hidden {...props} />
  }

export type IconType = ReturnType<typeof wrap>

export const IconUpload = wrap(Upload)
export const IconDoc = wrap(FileText)
export const IconFolder = wrap(Folder)
export const IconFolderOpen = wrap(FolderOpen)
export const IconBook = wrap(BookMarked)
export const IconLibrary = wrap(Library)
export const IconHome = wrap(House)
export const IconSearch = wrap(Search)
export const IconTrash = wrap(Trash2)
export const IconPlus = wrap(Plus)
export const IconMore = wrap(Ellipsis)
export const IconChevron = wrap(ChevronRight)
export const IconMenu = wrap(Menu)
export const IconBack = wrap(ArrowLeft)
export const IconHistory = wrap(History)
export const IconList = wrap(TableOfContents)
export const IconLogout = wrap(LogOut)
export const IconShare = wrap(Share2)
export const IconLink = wrap(Link2)
export const IconUnlink = wrap(Unlink)
export const IconSettings = wrap(Settings)
export const IconLock = wrap(Lock)
export const IconKey = wrap(KeyRound)
export const IconDownload = wrap(Download)
export const IconEdit = wrap(Pencil)
export const IconCopy = wrap(Copy)
export const IconSave = wrap(Save)
export const IconCamera = wrap(Camera)
export const IconDocPlus = wrap(FilePlus2)
export const IconFolderPlus = wrap(FolderPlus)
export const IconUp = wrap(ArrowUp)
export const IconDown = wrap(ArrowDown)
export const IconIndent = wrap(CornerDownRight)
export const IconOutdent = wrap(ArrowUpLeft)
export const IconClock = wrap(Clock)
export const IconSparkles = wrap(Sparkles)
export const IconArchive = wrap(Archive)
export const IconRestore = wrap(RotateCcw)
export const IconDatabase = wrap(Database)
export const IconDisk = wrap(HardDrive)
export const IconCloud = wrap(Cloud)
export const IconCheck = wrap(Check)
export const IconClose = wrap(X)
export const IconEye = wrap(Eye)
export const IconGlobe = wrap(Globe)
export const IconInfo = wrap(Info)
export const IconRefresh = wrap(RefreshCw)
export const IconSidebar = wrap(PanelLeft)
export const IconTable = wrap(Sheet)

/** Brand mark: stacked bamboo slips (简) on an accent tile. Inline so it follows the theme. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="16" fill="var(--logo)" />
      <g fill="var(--on-logo)">
        <rect x="14" y="15" width="7" height="34" rx="2.5" opacity="0.95" />
        <rect x="24.5" y="15" width="7" height="34" rx="2.5" opacity="0.85" />
        <rect x="35" y="15" width="7" height="34" rx="2.5" opacity="0.95" />
        <rect x="45.5" y="15" width="5" height="34" rx="2.5" opacity="0.6" />
      </g>
      <path d="M10 25h44M10 39h44" stroke="var(--logo)" strokeOpacity="0.55" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

/** Stable accent tone (0–5) for a repo, so each knowledge base gets its own colour. */
export function repoTone(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 6
}

const reIconValue = /^([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)$/

/** URL of a library icon ("tabler:book" → /icons/tabler/book.svg), or null for other values. */
export function iconSrc(value: string) {
  const m = reIconValue.exec(value)
  return m ? `/icons/${m[1]}/${m[2]}.svg` : null
}

/** Repo badge: uploaded image, library icon, emoji, or the initial on a tinted tile. */
export function RepoMark({ repo, className }: { repo: { id: string; name: string; icon?: string }; className: string }) {
  const [failedImage, setFailedImage] = useState('')
  const icon = repo.icon?.trim() ?? ''
  const isImage = icon.startsWith('/files/')
  const src = isImage ? null : iconSrc(icon)
  const glyph = (!isImage && !src && icon) || Array.from(repo.name.trim())[0]?.toUpperCase() || '库'
  return (
    <span className={className} style={{ '--tone': `var(--tone-${repoTone(repo.id)})` } as React.CSSProperties} aria-hidden>
      {isImage && failedImage !== icon ? (
        <img className="repo-mark-image" src={icon} alt="" onError={() => setFailedImage(icon)} />
      ) : src ? (
        <span className="repo-mark-icon" style={{ '--icon': `url("${src}")` } as React.CSSProperties} />
      ) : glyph}
    </span>
  )
}
