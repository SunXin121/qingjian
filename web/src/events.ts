import type { NodeRenamed } from './api'

/** Application events shared by React and DOM-based editor views. */
export interface AppEvents {
  'qj-nav': string
  'qj-tree-changed': string
  'qj-node-renamed': NodeRenamed
  'qj-editor-flush': void
  'qj-theme': void
  'qj-theme-mode': void
}

export function emitAppEvent<K extends keyof AppEvents>(name: K, ...args: AppEvents[K] extends void ? [] : [detail: AppEvents[K]]) {
  window.dispatchEvent(new CustomEvent(name, { detail: args[0] }))
}

/** Returns an unsubscribe function; callers never need to cast CustomEvent.detail. */
export function onAppEvent<K extends keyof AppEvents>(name: K, listener: (detail: AppEvents[K]) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<AppEvents[K]>).detail)
  window.addEventListener(name, handler)
  return () => window.removeEventListener(name, handler)
}
