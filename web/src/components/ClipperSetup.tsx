import { useEffect, useState, type FormEvent } from 'react'
import { api, type ClipperAIConfig, type ClipperSettings } from '../api'
import { Button, Field, Input, Loading, inputClass } from './ui'

const DEFAULT_AI: ClipperAIConfig = { enabled: false, provider: 'openai', base_url: 'https://api.openai.com/v1', model_id: '', api_key: '', max_output_tokens: 4096 }
const PROVIDER_URLS = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta' }

export default function ClipperSetup() {
  const [settings, setSettings] = useState<ClipperSettings | null>(null)
  const [ai, setAI] = useState<ClipperAIConfig>(DEFAULT_AI)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  const apply = (value: ClipperSettings) => {
    setSettings(value)
    setAI({ ...DEFAULT_AI, ...value.ai, api_key: '' })
  }
  const reload = async () => {
    setError('')
    try { apply(await api.clipperSettings()) }
    catch (e) { setError((e as Error).message || '无法读取剪藏设置') }
  }
  useEffect(() => { void reload() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const saveAI = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await api.saveClipperSettings(ai)
      apply(await api.clipperSettings())
      setStatus('视频摘要设置已保存。')
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <div className="mb-7 space-y-5">
      <section className="rounded-lg border border-line-subtle bg-surface p-5">
        <h2 className="m-0 text-[15px] font-semibold text-ink">连接浏览器扩展</h2>
        <p className="my-3 text-[13px] leading-relaxed text-ink-3">安装「青简网页剪藏」后，在扩展设置中填写本站地址和登录青简时使用的管理密码，测试连接并选择默认知识库。之后可以直接剪藏正文、右键选区或图片，也可以框选页面区域；文章图片会自动尝试存入附件。</p>
        <Field label="青简站点地址"><Input value={window.location.origin} readOnly onFocus={(e) => e.currentTarget.select()} /></Field>
        {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
        {status && <p role="status" className="mt-3 text-[13px] text-ink-2">{status}</p>}
        {!settings && (error ? <Button className="mt-3" onClick={reload}>重试</Button> : <Loading />)}
      </section>
      {settings && <details className="rounded-lg border border-line-subtle bg-surface p-5">
        <summary className="cursor-pointer text-[14px] font-semibold text-ink">视频摘要模型</summary>
        <form className="mt-4 space-y-4" onSubmit={saveAI}>
          <p className="text-[12px] leading-relaxed text-ink-3">YouTube / Bilibili 剪藏会保留页面可提供的字幕、时间戳与封面。启用摘要并配置模型后，扩展会直接向指定服务发送字幕；首次可能需要在扩展中允许访问模型站点。未配置或生成失败时仍保存字幕笔记。</p>
          <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" checked={ai.enabled} disabled={busy} onChange={(e) => setAI({ ...ai, enabled: e.target.checked })} />启用视频摘要</label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="服务协议"><select className={`${inputClass} h-10`} disabled={busy} value={ai.provider} onChange={(e) => { const provider = e.target.value as ClipperAIConfig['provider']; setAI({ ...ai, provider, base_url: PROVIDER_URLS[provider] }) }}><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option><option value="gemini">Google Gemini</option></select></Field>
            <Field label="模型名称"><Input value={ai.model_id} required={ai.enabled} disabled={busy} placeholder="例如 gpt-4.1-mini" onChange={(e) => setAI({ ...ai, model_id: e.target.value })} /></Field>
          </div>
          <Field label="模型服务地址"><Input type="url" value={ai.base_url} required={ai.enabled} disabled={busy} onChange={(e) => setAI({ ...ai, base_url: e.target.value })} /></Field>
          <Field label="模型 API 密钥" hint={ai.has_api_key && !ai.clear_api_key ? '已保存密钥，留空保持原值。' : '仅用于你授权的视频摘要请求。'}><Input type="password" autoComplete="new-password" value={ai.api_key} disabled={busy} onChange={(e) => setAI({ ...ai, api_key: e.target.value, clear_api_key: false })} /></Field>
          {ai.has_api_key && <label className="flex items-center gap-2 text-[12px] text-ink-3"><input type="checkbox" checked={ai.clear_api_key || false} disabled={busy} onChange={(e) => setAI({ ...ai, clear_api_key: e.target.checked })} />保存时清除现有密钥</label>}
          <Field label="最大输出 Token"><Input type="number" min={256} max={32768} step={1} value={ai.max_output_tokens} disabled={busy} onChange={(e) => setAI({ ...ai, max_output_tokens: Number(e.target.value) })} /></Field>
          <Button type="submit" disabled={busy}>保存模型设置</Button>
        </form>
      </details>}
      <p className="text-[12px] leading-relaxed text-ink-4">支持 Chrome、Edge 和 Firefox，保留 EdgeEver 的区域选择、站点适配、多语言及诊断功能。完整构建与安装步骤见项目 extension/README.md。扩展名为青简，采用上游 AGPL 开源实现。</p>
    </div>
  )
}
