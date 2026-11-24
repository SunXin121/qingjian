import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, formatTime, nodePath, type RecentDoc } from '../api'
import { editRepoDialog, repoMenu } from '../components/RepoDialog'
import {
  IconClock,
  IconDoc,
  IconDocPlus,
  IconForward,
  IconLibrary,
  IconMore,
  IconPlus,
  IconSearch,
  IconSparkles,
  IconTable,
  RepoMark,
} from '../components/icons'
import { Crumb, PageBody, RowIcon, RowList, rowClass, Section } from '../components/page'
import PageHeader, { Crumbs } from '../components/PageHeader'
import { Badge, Button, IconButton, Kbd } from '../components/ui'
import { nodeTitle, useStore } from '../store'

export default function Home() {
  const { repos, loadRepos, loadTree, setSearchOpen } = useStore()
  const [recent, setRecent] = useState<RecentDoc[]>([])
  const [creatingNote, setCreatingNote] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    loadRepos().catch(() => {})
    api.recent().then(setRecent).catch(() => {})
  }, [loadRepos])

  const createRepo = async () => {
    const v = await editRepoDialog()
    if (!v) return
    const r = await api.createRepo(v.name, v.description, v.icon)
    await loadRepos()
    navigate(`/r/${r.id}`)
  }

  const preferredRepo = useMemo(() => {
    if (!repos.length) return null
    return [...repos].sort((a, b) => b.updated_at - a.updated_at)[0]
  }, [repos])

  const quickNote = async () => {
    if (!preferredRepo) return createRepo()
    setCreatingNote(true)
    try {
      const n = await api.createNode(preferredRepo.id, null, 'doc')
      await loadTree(preferredRepo.id)
      navigate(nodePath(n))
    } finally {
      setCreatingNote(false)
    }
  }

  const hour = new Date().getHours()
  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  const docCount = repos.reduce((n, r) => n + r.doc_count, 0)

  return (
    <div>
      <PageHeader>
        <Crumbs>
          <Crumb>首页</Crumb>
        </Crumbs>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="inline-flex h-8 items-center gap-2 rounded-md border border-line-subtle bg-surface px-2.5 text-[12px] text-ink-3 shadow-sm transition-colors hover:border-line hover:text-ink max-sm:hidden"
        >
          <IconSearch width={13} height={13} />
          <span>搜索</span>
          <Kbd keys={['Ctrl', 'K']} />
        </button>
      </PageHeader>

      <PageBody>
        <section
          aria-label="概览与快捷操作"
          className="relative overflow-hidden rounded-2xl border border-line-subtle bg-surface p-5 shadow-card md:p-7"
        >
          <div className="pointer-events-none absolute -top-24 -right-16 size-80 rounded-full bg-[radial-gradient(closest-side,var(--accent-soft),transparent)]" />
          <div className="pointer-events-none absolute -bottom-24 -left-16 size-64 rounded-full bg-[radial-gradient(closest-side,var(--accent-softer),transparent)]" />

          <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0 flex-1">
              <div className="mb-2.5 inline-flex items-center gap-1.5 rounded-full border border-line-subtle bg-inset/80 px-2.5 py-1 text-[11.5px] font-medium text-ink-2">
                <IconSparkles width={13} height={13} className="text-accent" /> {today}
              </div>
              <h1 className="m-0 font-serif text-[28px] leading-tight font-bold tracking-[0.02em] text-ink md:text-[32px]">{greet}</h1>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {preferredRepo ? (
                  <>
                    <Button
                      variant="primary"
                      loading={creatingNote}
                      icon={<IconDocPlus width={15} height={15} />}
                      onClick={quickNote}
                      title={`在「${preferredRepo.name}」新建文档`}
                    >
                      新建笔记
                    </Button>
                    <Button icon={<IconPlus width={15} height={15} />} onClick={createRepo}>
                      新建知识库
                    </Button>
                  </>
                ) : (
                  <Button variant="primary" icon={<IconPlus width={15} height={15} />} onClick={createRepo}>
                    新建知识库
                  </Button>
                )}
                <Button variant="ghost" icon={<IconSearch width={15} height={15} />} className="sm:hidden" onClick={() => setSearchOpen(true)}>
                  搜索
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:flex">
              {[
                { value: repos.length, label: '知识库' },
                { value: docCount, label: '文档' },
              ].map(({ value, label }) => (
                <div
                  key={label}
                  className="flex min-w-25 flex-col items-center justify-center rounded-xl border border-line-subtle bg-editor/90 px-4 py-3 text-center"
                >
                  <span className="tabular text-[23px] leading-none font-semibold tracking-tight text-ink">{value}</span>
                  <span className="mt-1.5 text-[11.5px] font-medium text-ink-3">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <Section
          title="知识库"
          icon={<IconLibrary />}
          count={repos.length}
          className="mt-9"
          action={
            repos.length > 0 && (
              <Button size="sm" variant="ghost" icon={<IconPlus width={14} height={14} />} onClick={createRepo}>
                新建
              </Button>
            )
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {repos.map((r) => (
              <Link
                key={r.id}
                to={`/r/${r.id}`}
                data-repo-id={r.id}
                className="group relative flex flex-col justify-between gap-3 rounded-xl border border-line-subtle bg-surface p-4 shadow-card transition-[border-color,box-shadow,transform] duration-(--dur-base) ease-out hover:-translate-y-0.5 hover:border-line hover:shadow-pop"
              >
                <div className="flex items-start gap-3">
                  <RepoMark repo={r} size={38} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold text-ink transition-colors group-hover:text-accent">{r.name}</div>
                    {r.description && <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-3">{r.description}</div>}
                  </div>
                  <IconButton
                    label={`知识库「${r.name}」菜单`}
                    size="sm"
                    className="-mt-1 -mr-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 touch:opacity-100"
                    onClick={(e) => {
                      e.preventDefault()
                      repoMenu(e.currentTarget, r, loadRepos)
                    }}
                  >
                    <IconMore width={15} height={15} />
                  </IconButton>
                </div>
                <div className="flex items-center justify-between border-t border-line-subtle pt-2.5 text-[11.5px] text-ink-4">
                  <span className="tabular inline-flex items-center gap-1">
                    <IconDoc width={12} height={12} />
                    {r.doc_count} 篇
                  </span>
                  <span className="inline-flex items-center gap-1">
                    {formatTime(r.updated_at)}
                    <IconForward width={12} height={12} className="opacity-0 transition-opacity group-hover:opacity-70" />
                  </span>
                </div>
              </Link>
            ))}
            {repos.length === 0 && (
              <button
                type="button"
                className="flex min-h-[96px] items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface/50 p-5 text-[13px] font-medium text-ink-3 transition-colors hover:border-accent hover:bg-accent-softer hover:text-accent sm:col-span-2 lg:col-span-3"
                onClick={createRepo}
              >
                <IconPlus width={16} height={16} />
                <span>新建第一个知识库</span>
              </button>
            )}
          </div>
        </Section>

        {recent.length > 0 && (
          <Section title="最近编辑" icon={<IconClock />} count={recent.length}>
            <RowList>
              {recent.map((d) => (
                <Link key={d.id} to={nodePath(d)} className={rowClass}>
                  <RowIcon accent={d.type === 'table'}>{d.type === 'table' ? <IconTable /> : <IconDoc />}</RowIcon>
                  <span className="min-w-0 flex-1 truncate font-medium group-hover:text-accent">{nodeTitle(d)}</span>
                  {d.type === 'table' && (
                    <Badge tone="accent" className="max-sm:hidden">
                      表格
                    </Badge>
                  )}
                  <span className="max-w-36 shrink-0 truncate rounded-full bg-inset px-2.5 py-0.5 text-[11px] text-ink-3 max-sm:hidden">{d.repo_name}</span>
                  <span className="tabular w-24 shrink-0 text-right text-[11.5px] text-ink-4 max-sm:w-auto">{formatTime(d.updated_at)}</span>
                </Link>
              ))}
            </RowList>
          </Section>
        )}
      </PageBody>
    </div>
  )
}
