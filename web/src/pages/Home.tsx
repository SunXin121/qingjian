import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, formatTime, nodePath, type RecentDoc } from '../api'
import { editRepoDialog, repoMenu } from '../components/RepoDialog'
import { IconClock, IconDoc, IconLibrary, IconMore, IconPlus, IconSearch, IconSparkles, IconTable, RepoMark } from '../components/icons'
import { Crumb, PageBody, RowIcon, RowList, rowClass, Section } from '../components/page'
import PageHeader, { Crumbs } from '../components/PageHeader'
import { Button, IconButton } from '../components/ui'
import { nodeTitle, useStore } from '../store'

export default function Home() {
  const { repos, loadRepos, setSearchOpen } = useStore()
  const [recent, setRecent] = useState<RecentDoc[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    loadRepos()
    api.recent().then(setRecent).catch(() => {})
  }, [loadRepos])

  const create = async () => {
    const v = await editRepoDialog()
    if (!v) return
    const r = await api.createRepo(v.name, v.description, v.icon)
    await loadRepos()
    navigate(`/r/${r.id}`)
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
      </PageHeader>
      <PageBody>
        <section className="relative overflow-hidden rounded-xl border border-line-subtle bg-surface p-5 shadow-card md:p-7">
          <div className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-[radial-gradient(closest-side,var(--accent-soft),transparent)]" />
          <div className="relative flex flex-col gap-5 md:flex-row md:items-end">
            <div className="min-w-0 flex-1">
              <div className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-inset px-2.5 py-1 text-[11.5px] font-medium text-ink-3">
                <IconSparkles width={13} height={13} className="text-accent" /> {today}
              </div>
              <h1 className="m-0 font-serif text-[28px] leading-tight font-bold tracking-[0.02em] text-ink md:text-[32px]">{greet}</h1>
              <p className="mt-2 mb-0 text-[13px] text-ink-3">记录、整理、沉淀，让每一条想法都有处安放。</p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button variant="primary" icon={<IconPlus width={15} height={15} />} onClick={create}>
                  新建知识库
                </Button>
                <Button icon={<IconSearch width={15} height={15} />} onClick={() => setSearchOpen(true)}>
                  搜索
                </Button>
              </div>
            </div>
            <div className="flex gap-2">
              {[
                [repos.length, '知识库'],
                [docCount, '文档'],
              ].map(([v, label]) => (
                <div key={label} className="flex min-w-24 flex-col items-center rounded-lg border border-line-subtle bg-editor px-4 py-3">
                  <span className="tabular text-[22px] leading-none font-semibold text-ink">{v}</span>
                  <span className="mt-1.5 text-[11.5px] text-ink-3">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <Section title="知识库" icon={<IconLibrary />} count={repos.length} className="mt-9">
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {repos.map((r) => (
              <Link
                key={r.id}
                to={`/r/${r.id}`}
                className="group relative flex items-start gap-3 rounded-lg border border-line-subtle bg-surface p-3.5 shadow-card transition-[border-color,box-shadow,transform] duration-(--dur-base) ease-out hover:-translate-y-px hover:border-line hover:shadow-pop"
              >
                <RepoMark repo={r} size={38} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-semibold text-ink">{r.name}</div>
                  <div className={'mt-0.5 line-clamp-1 text-[12px] ' + (r.description ? 'text-ink-3' : 'text-ink-4')}>{r.description || '暂无简介'}</div>
                  <div className="mt-2 flex items-center gap-3 text-[11.5px] text-ink-4 [&_svg]:mr-1 [&_svg]:inline">
                    <span className="tabular">
                      <IconDoc width={12} height={12} />
                      {r.doc_count} 篇
                    </span>
                    <span>
                      <IconClock width={12} height={12} />
                      {formatTime(r.updated_at)}
                    </span>
                  </div>
                </div>
                <IconButton
                  label="更多"
                  size="sm"
                  className="-mt-0.5 -mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 touch:opacity-100"
                  onClick={(e) => {
                    e.preventDefault()
                    repoMenu(e.currentTarget, r, loadRepos)
                  }}
                >
                  <IconMore width={15} height={15} />
                </IconButton>
              </Link>
            ))}
            {repos.length === 0 && (
              <button
                className="flex h-[86px] items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong text-[13px] text-ink-3 transition-colors hover:border-accent hover:text-accent"
                onClick={create}
              >
                <IconPlus width={15} height={15} /> 创建你的第一个知识库
              </button>
            )}
          </div>
        </Section>

        {recent.length > 0 && (
          <Section title="最近编辑" icon={<IconClock />}>
            <RowList>
              {recent.map((d) => (
                <Link key={d.id} to={nodePath(d)} className={rowClass}>
                  <RowIcon accent={d.type === 'table'}>{d.type === 'table' ? <IconTable /> : <IconDoc />}</RowIcon>
                  <span className="min-w-0 flex-1 truncate">{nodeTitle(d)}</span>
                  <span className="max-w-32 shrink-0 truncate rounded-full bg-inset px-2 py-0.5 text-[11px] text-ink-3 max-sm:hidden">{d.repo_name}</span>
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
