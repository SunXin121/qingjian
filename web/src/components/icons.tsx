import type { SVGProps } from 'react'

const base = (d: React.ReactNode) =>
  function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
        {d}
      </svg>
    )
  }

export const IconDoc = base(<><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>)
export const IconFolder = base(<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />)
export const IconBook = base(<><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z" /><path d="M4 19V5M8 7h7" /></>)
export const IconHome = base(<><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></>)
export const IconSearch = base(<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>)
export const IconTrash = base(<><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>)
export const IconPlus = base(<path d="M12 5v14M5 12h14" />)
export const IconMore = base(<><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>)
export const IconChevron = base(<path d="M9 6l6 6-6 6" />)
export const IconMenu = base(<path d="M4 6h16M4 12h16M4 18h16" />)
export const IconBack = base(<path d="M15 6l-6 6 6 6" />)
export const IconHistory = base(<><path d="M3 12a9 9 0 103-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>)
export const IconList = base(<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />)
export const IconLogout = base(<><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" /></>)
