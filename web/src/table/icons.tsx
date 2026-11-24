import {
  AlignLeft,
  ArrowLeftRight,
  ArrowUpDown,
  Calendar,
  CalendarDays,
  ChartGantt,
  CircleChevronDown,
  Clock,
  EyeOff,
  GalleryVerticalEnd,
  Gauge,
  Hash,
  Layers,
  Link2,
  ListChecks,
  ListFilter,
  ListOrdered,
  Mail,
  Maximize2,
  Paperclip,
  Phone,
  Redo2,
  Rows3,
  Search,
  Sigma,
  SlidersHorizontal,
  SquareCheck,
  SquareKanban,
  Star,
  Table2,
  Type,
  Undo2,
} from 'lucide-react'
import type { LucideIcon, LucideProps } from 'lucide-react'
import type { SpriteMap } from '@glideapps/glide-data-grid'
import type { FieldType } from './types'

const wrap = (I: LucideIcon) =>
  function Icon(props: LucideProps) {
    return <I size={18} strokeWidth={1.75} aria-hidden {...props} />
  }

export const IconBoard = wrap(SquareKanban)
export const IconGrid = wrap(Table2)
export const IconGallery = wrap(GalleryVerticalEnd)
export const IconCalendar = wrap(CalendarDays)
export const IconGantt = wrap(ChartGantt)
export const IconFilter = wrap(ListFilter)
export const IconGroup = wrap(Layers)
export const IconSort = wrap(ArrowUpDown)
export const IconUndo = wrap(Undo2)
export const IconRedo = wrap(Redo2)
export const IconEyeOff = wrap(EyeOff)
export const IconFields = wrap(SlidersHorizontal)
export const IconRowHeight = wrap(Rows3)
export const IconExpand = wrap(Maximize2)

const FIELD_ICON_MAP: Record<FieldType, LucideIcon> = {
  text: Type,
  longtext: AlignLeft,
  number: Hash,
  select: CircleChevronDown,
  multiselect: ListChecks,
  date: Calendar,
  checkbox: SquareCheck,
  url: Link2,
  attachment: Paperclip,
  autonumber: ListOrdered,
  created_time: Clock,
  modified_time: Clock,
  rating: Star,
  progress: Gauge,
  phone: Phone,
  email: Mail,
  formula: Sigma,
  link: ArrowLeftRight,
  lookup: Search,
  rollup: Sigma,
}

export function FieldTypeIcon({ type, size = 14, className, ...rest }: { type: FieldType; size?: number } & LucideProps) {
  const I = FIELD_ICON_MAP[type] ?? Type
  return <I size={size} strokeWidth={1.8} aria-hidden className={className} {...rest} />
}

const svgWrap = (color: string, inner: string) =>
  `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`

/**
 * Clean outline sprites for Glide Data Grid headers (replaces Glide's solid dark box sprites).
 * Note: Glide passes `theme.bgIconHeader` as `bgColor` in normal header state and `"white"` when selected.
 */
export const HEADER_SPRITES: SpriteMap = {
  'qj-text': ({ bgColor }) => svgWrap(bgColor, '<path d="M4.5 5.5V4h11v1.5M10 4v12M7.5 16h5"/>'),
  'qj-longtext': ({ bgColor }) => svgWrap(bgColor, '<path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h8.5"/>'),
  'qj-number': ({ bgColor }) => svgWrap(bgColor, '<path d="M4 7.5h12M4 12.5h12M8 3.5l-1.5 13M13.5 3.5L12 16.5"/>'),
  'qj-select': ({ bgColor }) => svgWrap(bgColor, '<circle cx="10" cy="10" r="6.5"/><path d="m7.5 9 2.5 2.5L12.5 9"/>'),
  'qj-multiselect': ({ bgColor }) => svgWrap(bgColor, '<path d="m3.5 6 1.5 1.5 2.5-2.5M10 6h6.5M3.5 13l1.5 1.5 2.5-2.5M10 13h6.5"/>'),
  'qj-date': ({ bgColor }) => svgWrap(bgColor, '<rect x="3.5" y="4.5" width="13" height="12" rx="2"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/>'),
  'qj-checkbox': ({ bgColor }) => svgWrap(bgColor, '<rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><path d="m7 10.2 2.1 2.1 4-4.2"/>'),
  'qj-url': ({ bgColor }) => svgWrap(bgColor, '<path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1.1 1.1"/><path d="M11.5 8.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1.1-1.1"/>'),
  'qj-attachment': ({ bgColor }) => svgWrap(bgColor, '<path d="m15.5 9.2-5.8 5.8a4 4 0 0 1-5.7-5.7l6-6a2.6 2.6 0 0 1 3.7 3.7l-6 6a1.3 1.3 0 0 1-1.8-1.8l5.3-5.3"/>'),
  'qj-autonumber': ({ bgColor }) => svgWrap(bgColor, '<path d="M4.5 6h2v8M4 14h3M11 8.5h5M13.5 6 16 8.5 13.5 11M11 14h5"/>'),
  'qj-time': ({ bgColor }) => svgWrap(bgColor, '<circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 1.8"/>'),
  'qj-rating': ({ bgColor }) => svgWrap(bgColor, '<path d="m10 3.2 2 4.1 4.5.65-3.25 3.17.77 4.48L10 13.5l-4.02 2.1.77-4.48L3.5 7.95l4.5-.65 2-4.1Z"/>'),
  'qj-progress': ({ bgColor }) => svgWrap(bgColor, '<circle cx="10" cy="10" r="6.5"/><path d="M10 10 13.2 6.8"/>'),
  'qj-phone': ({ bgColor }) => svgWrap(bgColor, '<path d="M6.3 3.8h2.2l1.1 2.8-1.4 1.1a9.5 9.5 0 0 0 4.1 4.1l1.1-1.4 2.8 1.1v2.2a1.6 1.6 0 0 1-1.7 1.6A12.8 12.8 0 0 1 4.7 5.5a1.6 1.6 0 0 1 1.6-1.7Z"/>'),
  'qj-email': ({ bgColor }) => svgWrap(bgColor, '<rect x="3" y="4.5" width="14" height="11" rx="2"/><path d="m3.5 5.5 6.5 5 6.5-5"/>'),
  'qj-formula': ({ bgColor }) => svgWrap(bgColor, '<path d="M14.5 4H6l4.2 6L6 16h8.5"/>'),
  'qj-link': ({ bgColor }) => svgWrap(bgColor, '<path d="M4 7.5h12M13 4.5l3 3-3 3M16 12.5H4M7 9.5l-3 3 3 3"/>'),
  'qj-lookup': ({ bgColor }) => svgWrap(bgColor, '<circle cx="9.2" cy="9.2" r="5.2"/><path d="m13.2 13.2 3.3 3.3"/>'),
  'qj-rollup': ({ bgColor }) => svgWrap(bgColor, `<path d="M15 4.5H5.5l4.5 5.5-4.5 5.5H15"/><circle cx="14.5" cy="10" r="1" fill="${bgColor}"/>`),
}

export const FIELD_SPRITE: Record<FieldType, string> = {
  text: 'qj-text',
  longtext: 'qj-longtext',
  number: 'qj-number',
  select: 'qj-select',
  multiselect: 'qj-multiselect',
  date: 'qj-date',
  checkbox: 'qj-checkbox',
  url: 'qj-url',
  attachment: 'qj-attachment',
  autonumber: 'qj-autonumber',
  created_time: 'qj-time',
  modified_time: 'qj-time',
  rating: 'qj-rating',
  progress: 'qj-progress',
  phone: 'qj-phone',
  email: 'qj-email',
  formula: 'qj-formula',
  link: 'qj-link',
  lookup: 'qj-lookup',
  rollup: 'qj-rollup',
}
