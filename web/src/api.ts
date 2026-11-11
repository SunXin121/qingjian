import type { HistoryEntry, Op, TableData } from './table/types'

export interface Repo {
  id: string
  name: string
  description: string
  icon: string
  sort: number
  doc_count: number
  created_at: number
  updated_at: number
}

export type NodeType = 'doc' | 'group' | 'table'

export interface TreeNode {
  id: string
  repo_id: string
  parent_id: string | null
  type: NodeType
  title: string
  sort: number
  created_at: number
  updated_at: number
}

export interface Doc extends TreeNode {
  markdown: string
  content_updated_at: number
}

export interface Version {
  id: number
  node_id: string
  title: string
  markdown?: string
  size: number
  created_at: number
}

export interface RecentDoc {
  id: string
  repo_id: string
  repo_name: string
  title: string
  type: NodeType
  updated_at: number
}

export interface TableSummary {
  id: string
  title: string
  repo_id: string
  repo_name: string
  views: { id: string; name: string; type: string }[]
}

export interface SearchHit extends RecentDoc {
  snippet: string
}

export interface TrashItem {
  kind: 'repo' | 'node'
  id: string
  type: string
  title: string
  repo_id: string
  repo_name: string
  deleted_at: number
}

export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  url: string
}

export interface Share {
  token: string
  target_type: 'node' | 'repo'
  target_id: string
  view_id: string | null
  node_type: string
  has_password: boolean
  expires_at: number | null
  enabled: boolean
  view_count: number
  created_at: number
  updated_at: number
  title: string
  repo_id: string
  repo_name: string
  target_alive: boolean
}

export interface ShareInfo {
  token: string
  type: 'node' | 'repo'
  title: string
  expires_at: number | null
  doc_id?: string
  node_type?: string
  repo?: { name: string; description: string; updated_at: number }
}

export interface PublicNode {
  id: string
  parent_id: string | null
  type: NodeType
  title: string
  sort: number
  updated_at: number
}

export interface PublicDoc {
  id: string
  title: string
  markdown: string
  updated_at: number
}

export interface StorageStats {
  attachments: number
  blobs: number
  logical_bytes: number
  stored_bytes: number
  unreferenced: number
  unreferenced_bytes: number
  docs: number
  versions: number
  db_bytes: number
  grace_hours: number
}

export type ImgbedChannel = '' | 'telegram' | 'cfr2' | 's3' | 'discord' | 'huggingface' | 'webdav'
export type ImgbedNameType = '' | 'default' | 'index' | 'origin' | 'short'

/** CloudFlare ImgBed settings; exports can upload their images there. */
export interface ImgbedConfig {
  url: string
  auth_code: string
  token: string
  channel: ImgbedChannel
  channel_name: string
  folder: string
  name_type: ImgbedNameType
}

/** A document or table found by title (for links between documents). */
export interface NodeRef {
  id: string
  repo_id: string
  repo_name: string
  type: 'doc' | 'table'
  title: string
  updated_at: number
}

/** Detail of the `qj-node-renamed` window event. */
export interface NodeRenamed {
  id: string
  type: NodeType
  from: string
  to: string
}

/** A document linking to a node, with the text around the link. */
export interface Backlink {
  id: string
  repo_id: string
  repo_name: string
  title: string
  updated_at: number
  snippet: string
}

export interface ClientConfig {
  version: string
  drawio_url: string
  max_upload_mb: number
  trash_days: number
  /** a PlantUML server is configured */
  plantuml: boolean
  /** an image host is configured (exports may upload to it) */
  imgbed: boolean
}

export class ApiError extends Error {
  status: number
  data: any
  constructor(status: number, message: string, data: any) {
    super(message)
    this.status = status
    this.data = data
  }
}

/** Fired whenever the server says we are not logged in. */
export const authEvents = new EventTarget()

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  const text = await res.text()
  let data: any
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/') && !url.startsWith('/api/s/')) authEvents.dispatchEvent(new Event('unauthorized'))
    throw new ApiError(res.status, data?.error || res.statusText || '请求失败', data)
  }
  return data as T
}

export const api = {
  me: () => request<{ admin: boolean }>('GET', '/api/auth/me'),
  login: (password: string) => request<{ ok: boolean }>('POST', '/api/auth/login', { password }),
  logout: () => request('POST', '/api/auth/logout'),

  repos: () => request<Repo[]>('GET', '/api/repos'),
  repo: (id: string) => request<Repo>('GET', `/api/repos/${id}`),
  createRepo: (name: string, description = '', icon = '') => request<Repo>('POST', '/api/repos', { name, description, icon }),
  updateRepo: (id: string, patch: Partial<Pick<Repo, 'name' | 'description' | 'icon'>>) =>
    request<Repo>('PATCH', `/api/repos/${id}`, patch),
  deleteRepo: (id: string) => request('DELETE', `/api/repos/${id}`),
  tree: (repoId: string) => request<TreeNode[]>('GET', `/api/repos/${repoId}/tree`),

  createNode: (repo_id: string, parent_id: string | null, type: NodeType, title = '') =>
    request<TreeNode>('POST', '/api/nodes', { repo_id, parent_id, type, title }),
  /** Renames a node; with `prev`, editors showing links to it follow (see Editor.tsx). */
  renameNode: async (id: string, title: string, prev?: { type: NodeType; title: string }) => {
    const n = await request<TreeNode>('PATCH', `/api/nodes/${id}`, { title })
    if (prev && prev.title !== n.title)
      window.dispatchEvent(new CustomEvent<NodeRenamed>('qj-node-renamed', { detail: { id, type: prev.type, from: prev.title, to: n.title } }))
    return n
  },
  moveNode: (id: string, parent_id: string | null, sort: number) =>
    request('POST', `/api/nodes/${id}/move`, { parent_id, sort }),
  deleteNode: (id: string) => request('DELETE', `/api/nodes/${id}`),
  findNodes: (q: string) => request<NodeRef[]>('GET', `/api/nodes/find?q=${encodeURIComponent(q)}`),
  backlinks: (id: string) => request<Backlink[]>('GET', `/api/nodes/${id}/backlinks`),

  doc: (id: string) => request<Doc>('GET', `/api/docs/${id}`),
  saveDoc: (
    id: string,
    body: { markdown?: string; title?: string; base_updated_at?: number; force?: boolean; snapshot?: boolean },
  ) => request<{ updated_at: number; title: string }>('PUT', `/api/docs/${id}`, body),
  versions: (id: string) => request<Version[]>('GET', `/api/docs/${id}/versions`),
  version: (vid: number) => request<Version>('GET', `/api/versions/${vid}`),
  restoreVersion: (vid: number) => request<{ updated_at: number }>('POST', `/api/versions/${vid}/restore`),

  tables: () => request<TableSummary[]>('GET', '/api/tables'),
  table: (id: string) => request<TableData>('GET', `/api/tables/${id}`),
  tableOps: (id: string, ops: Op[]) => request<{ updated_at: number }>('POST', `/api/tables/${id}/ops`, { ops }),
  recordHistory: (id: string, rec: string, before?: number) =>
    request<{ entries: HistoryEntry[]; more: boolean }>('GET', `/api/tables/${id}/records/${rec}/history${before ? `?before=${before}` : ''}`),

  recent: () => request<RecentDoc[]>('GET', '/api/recent'),
  search: (q: string) => request<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),

  trash: () => request<TrashItem[]>('GET', '/api/trash'),
  restoreTrash: (kind: string, id: string) => request('POST', `/api/trash/${kind}/${id}/restore`),
  purgeTrash: (kind: string, id: string) => request('DELETE', `/api/trash/${kind}/${id}`),
  emptyTrash: () => request<{ purged: number }>('DELETE', '/api/trash'),

  shares: (target?: { target_type: string; target_id: string }) =>
    request<Share[]>('GET', '/api/shares' + (target ? `?target_type=${target.target_type}&target_id=${target.target_id}` : '')),
  createShare: (body: { target_type: 'node' | 'repo'; target_id: string; password?: string; expires_at?: number | null; view_id?: string | null }) =>
    request<Share>('POST', '/api/shares', body),
  updateShare: (token: string, patch: { password?: string; expires_at?: number | null; enabled?: boolean; view_id?: string | null }) =>
    request<Share>('PATCH', `/api/shares/${token}`, patch),
  regenerateShare: (token: string) => request<Share>('POST', `/api/shares/${token}/regenerate`),
  deleteShare: (token: string) => request('DELETE', `/api/shares/${token}`),

  storageStats: () => request<StorageStats>('GET', '/api/files/stats'),
  cleanupFiles: () => request<{ removed: number; freed_bytes: number }>('POST', '/api/files/cleanup'),
  imgbed: () => request<{ config: ImgbedConfig; uploaded: number }>('GET', '/api/imgbed'),
  saveImgbed: (c: ImgbedConfig) => request<ImgbedConfig>('PUT', '/api/imgbed', c),
  forgetImgbed: () => request<{ removed: number }>('POST', '/api/imgbed/forget'),
  config: () => request<ClientConfig>('GET', '/api/config'),
}

/** Visitor-side API for share links (no admin session). */
export const shareApi = {
  info: (token: string) => request<ShareInfo>('GET', `/api/s/${token}`),
  auth: (token: string, password: string) => request('POST', `/api/s/${token}/auth`, { password }),
  tree: (token: string) => request<PublicNode[]>('GET', `/api/s/${token}/tree`),
  doc: (token: string, id: string) => request<PublicDoc>('GET', `/api/s/${token}/docs/${id}`),
  table: (token: string, id: string) => request<TableData>('GET', `/api/s/${token}/tables/${id}`),
}

/** Renders PlantUML through the server (inside a share link: through the share). */
export function renderPlantUML(source: string) {
  const share = /^\/s\/([^/]+)/.exec(location.pathname)
  const url = share ? `/api/s/${share[1]}/plantuml` : '/api/plantuml'
  return request<{ svg: string; error?: boolean }>('POST', url, { source })
}

/** Path of a node's page in the admin UI. */
export const nodePath = (n: { id: string; repo_id: string; type?: string }) => `/r/${n.repo_id}/${n.type === 'table' ? 't' : 'd'}/${n.id}`

let configP: Promise<ClientConfig> | null = null
export function getConfig() {
  configP ??= api.config().catch((e) => {
    configP = null
    throw e
  })
  return configP
}

/** Drops the cached client config (after changing a setting it reports). */
export function resetConfig() {
  configP = null
}

export const shareURL = (token: string) => `${location.origin}/s/${token}`

export function uploadFile(file: Blob, name?: string, onProgress?: (ratio: number) => void): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('file', file, name ?? (file instanceof File ? file.name : 'file'))
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/files')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
    xhr.onload = () => {
      let data: any = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else reject(new ApiError(xhr.status, data?.error || '上传失败', data))
    }
    xhr.onerror = () => reject(new ApiError(0, '网络错误，上传失败', null))
    xhr.send(fd)
  })
}

export function formatTime(ms: number): string {
  const d = new Date(ms)
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const today = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.toDateString() === today.toDateString()) return `今天 ${hm}`
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === today.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}年${md}`
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
