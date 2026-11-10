import { ArrowUpDown, CalendarDays, ChartGantt, EyeOff, GalleryVerticalEnd, Layers, ListFilter, Redo2, SquareKanban, Table2, Undo2 } from 'lucide-react'
import type { LucideIcon, LucideProps } from 'lucide-react'

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
