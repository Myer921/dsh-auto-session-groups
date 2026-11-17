/**
 * @local/dsh-auto-session-groups — client 半（浏览器）
 *
 * 三件事：
 *  1) **DSH 原生设置面**：把「智能整理」的设置页注册进
 *     - `plugins.row.config`（插件页里这一行的「配置」）
 *     - `settings.plugins.tab`（设置 → 插件 → 智能整理）
 *     同一个组件，两种入口。读写都走宿主 API，持久化由宿主写进行 config。
 *  2) **侧栏一键整理**：`sidebar.footer.action` 的 ✦ 按钮 → POST /api/run。
 *  3) 失败不拖垮侧栏：任何注册 / 请求失败都只 console.warn。
 *
 * 只用 react + fetch，不引任何包、不读别人的 DOM。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-auto-session-groups',
  factory: require => {
    const React = require('react')
    const e = React.createElement
    const module = { exports: {} }
    const exports = module.exports

    const ROW_KEY = '@local/dsh-auto-session-groups#auto-session-groups'
    const SELF_ID = 'auto-session-groups'
    const API = {
      state: '/dsh-auto-session-groups/api/state',
      config: '/dsh-auto-session-groups/api/config',
      run: '/dsh-auto-session-groups/api/run',
      force: '/dsh-auto-session-groups/api/force',
    }

    /* ── 小工具 ───────────────────────────────────────────── */

    async function getJson(url, init) {
      const response = await fetch(url, { credentials: 'same-origin', ...init })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error ?? `HTTP ${response.status}`)
      }
      return body
    }

    const post = (url, payload) => getJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    })

    const css = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-primary, inherit)' },
      section: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))' },
      h: { fontSize: '13px', fontWeight: 600, margin: 0 },
      sub: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8b9198)', margin: 0 },
      row: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 140px', minWidth: '120px' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8b9198)' },
      input: { height: '30px', padding: '0 8px', borderRadius: '6px', fontSize: '13px', font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-module-platform, rgba(128,128,128,.1))', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))' },
      button: { height: '30px', padding: '0 12px', borderRadius: '6px', cursor: 'pointer', font: 'inherit', fontSize: '13px', color: 'inherit', background: 'var(--dsw-alias-interactive-bg-secondary, rgba(128,128,128,.16))', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))' },
      primary: { height: '32px', padding: '0 16px', borderRadius: '6px', cursor: 'pointer', font: 'inherit', fontSize: '13px', fontWeight: 600, color: '#fff', background: 'var(--dsw-alias-state-business-primary, #2f6feb)', border: 'none' },
      danger: { height: '32px', padding: '0 16px', borderRadius: '6px', cursor: 'pointer', font: 'inherit', fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-state-error, #f06a6a)', background: 'transparent', border: '1px solid var(--dsw-alias-state-error, #f06a6a)' },
      mini: { height: '24px', padding: '0 8px', borderRadius: '5px', cursor: 'pointer', font: 'inherit', fontSize: '12px', color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))' },
      list: { display: 'flex', flexDirection: 'column', gap: '6px', margin: 0, padding: 0, listStyle: 'none' },
      item: { display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 0', borderBottom: '1px dashed var(--dsw-alias-border-l3, rgba(128,128,128,.2))' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
      check: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px' },
      status: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8b9198)' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success, #4cc38a)' },
      err: { fontSize: '12px', color: 'var(--dsw-alias-state-error, #f06a6a)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' },
      table: { width: '100%', borderCollapse: 'collapse' },
      th: { textAlign: 'left', fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-tertiary, #8b9198)', padding: '4px 6px' },
      td: { padding: '4px 6px', verticalAlign: 'middle' },
    }

    const read = (data, key, fallback) => (data && data[key] !== undefined ? data[key] : fallback)

    /** 状态 → 草稿。只保留页面可编辑的字段。 */
    function draftOf(config) {
      return {
        enabled: read(config, 'enabled', true) !== false,
        models: [...read(config, 'models', [])],
        workspaces: [...read(config, 'workspaces', [])],
        prompt: read(config, 'prompt', ''),
        dailyProject: read(config, 'dailyProject', '日常通用'),
        allowNewGroups: read(config, 'allowNewGroups', false) === true,
        correctMisplaced: read(config, 'correctMisplaced', true) !== false,
        collapseOwnWorkspace: read(config, 'collapseOwnWorkspace', true) !== false,
        dryRun: read(config, 'dryRun', false) === true,
        maxTitleBytes: read(config, 'maxTitleBytes', 76),
        maxTokens: read(config, 'maxTokens', 1536),
        timeoutMs: read(config, 'timeoutMs', 20000),
        concurrency: read(config, 'concurrency', 2),
        sweepMs: read(config, 'sweepMs', 300000),
      }
    }

    /* ── 设置页 ───────────────────────────────────────────── */

    function ConfigPage(props) {
      if (props?.view === 'summary') {
        return e('span', { style: css.status }, '用可编辑的提示词让模型把会话归档成「一级目录/二级标签/标题」')
      }
      return e(ConfigBody, null)
    }

    function ConfigBody() {
      const [snapshot, setSnapshot] = React.useState({ status: 'loading', data: null, error: null })
      const [draft, setDraft] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [run, setRun] = React.useState(null)
      const [provider, setProvider] = React.useState('')
      const [model, setModel] = React.useState('')

      const load = React.useCallback(async () => {
        setSnapshot(current => ({ ...current, status: 'loading', error: null }))
        try {
          const body = await getJson(API.state)
          setSnapshot({ status: 'ready', data: body, error: null })
          setDraft(draftOf(body.config))
          const first = (body.providers ?? [])[0]
          setProvider(current => current || (first ? first.id : ''))
          setModel(current => current || (first?.models?.[0]?.id ?? ''))
        } catch (error) {
          setSnapshot({ status: 'error', data: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const data = snapshot.data
      const patch = next => setDraft(current => ({ ...current, ...next }))

      const save = async () => {
        if (draft === null) return
        setBusy('save')
        setNotice(null)
        try {
          const body = await post(API.config, draft)
          setDraft(draftOf(body.config))
          setSnapshot(current => ({ ...current, data: { ...current.data, config: body.config } }))
          setNotice({ kind: 'ok', text: `已保存 · 生效模型 ${(body.config?.models ?? []).join(' , ') || '（跟随会话）'}` })
          void load()
        } catch (error) {
          setNotice({ kind: 'err', text: `保存失败：${error instanceof Error ? error.message : String(error)}` })
        } finally {
          setBusy(null)
        }
      }

      const organize = async (force = false) => {
        setBusy(force ? 'force' : 'run')
        setNotice(null)
        try {
          const body = force
            ? await post(API.force, {})
            : await post(API.run, { dryRun: draft?.dryRun === true })
          setRun(body)
          const changed = (body.renamed ?? []).length
          const planned = (body.plans ?? []).length
          const skipped = (body.skipped ?? []).length
          const failed = (body.failed ?? []).length
          setNotice({
            kind: 'ok',
            text: `${force ? '强制整理' : '整理'}：扫 ${body.scanned ?? 0} 条 · 改 ${changed} 条`
              + `${planned > 0 ? ` · 预演 ${planned} 条` : ''}`
              + `${skipped > 0 ? ` · 跳过 ${skipped} 条` : ''}`
              + `${failed > 0 ? ` · 失败 ${failed} 条` : ''}`,
          })
          void load()
        } catch (error) {
          setNotice({ kind: 'err', text: `${force ? '强制整理' : '整理'}失败：${error instanceof Error ? error.message : String(error)}` })
        } finally {
          setBusy(null)
        }
      }

      if (snapshot.status === 'loading' && draft === null) {
        return e('p', { style: css.status }, '读取中…')
      }
      if (snapshot.status === 'error') {
        return e('div', { style: css.root }, [
          e('p', { key: 'err', style: css.err }, `读取失败：${snapshot.error}`),
          e('p', { key: 'tip', style: css.sub }, '确认插件宿主半已挂载（改过宿主代码需要重启 DSH）后重试。'),
          e('button', { key: 'retry', type: 'button', style: css.button, onClick: () => void load() }, '重试'),
        ])
      }
      if (draft === null) return null

      const providers = data?.providers ?? []
      const providerModels = providers.find(entry => entry.id === provider)?.models ?? []
      const workspaces = data?.workspaces ?? []
      const writable = data?.writable !== false

      const addCandidate = () => {
        if (provider === '' || model === '') return
        const entry = `${provider}/${model}`
        if (draft.models.includes(entry)) {
          setNotice({ kind: 'err', text: `${entry} 已经在候选里了` })
          return
        }
        patch({ models: [...draft.models, entry] })
      }
      const moveCandidate = (index, delta) => {
        const models = [...draft.models]
        const target = index + delta
        if (target < 0 || target >= models.length) return
        ;[models[index], models[target]] = [models[target], models[index]]
        patch({ models })
      }
      const toggleWorkspace = (path, checked) => {
        const set = new Set(draft.workspaces)
        if (checked) set.add(path)
        else set.delete(path)
        patch({ workspaces: [...set] })
      }
      const promptText = draft.prompt.trim() === '' ? (data?.defaultPrompt ?? '') : draft.prompt
      const promptIsDefault = draft.prompt.trim() === ''
      return e('div', { style: css.root }, [
        /* 状态行 */
        e('p', { key: 'status', style: notice ? (notice.kind === 'ok' ? css.ok : css.err) : css.status },
          notice ? notice.text : `提示词 ${promptIsDefault ? '默认' : '自定义'} · 生效模型 ${(data?.config?.models ?? []).join(' , ') || '（跟随会话）'}`),

        /* 1. 分类模型 */
        e('section', { key: 'models', style: css.section }, [
          e('h3', { key: 'h', style: css.h }, '分类模型'),
          e('p', { key: 'sub', style: css.sub },
            '按顺序尝试，第一个能用的胜出；留空 = 跟随每个会话自己选的模型（不可用时回落到部署默认模型）。'),
          e('div', { key: 'pick', style: css.row }, [
            e('div', { key: 'p', style: css.field }, [
              e('label', { key: 'l', style: css.label }, 'provider'),
              e('select', {
                key: 's', style: css.input, value: provider,
                onChange: event => {
                  const next = event.target.value
                  setProvider(next)
                  const first = providers.find(entry => entry.id === next)?.models?.[0]?.id ?? ''
                  setModel(first)
                },
              }, providers.map(entry => e('option', { key: entry.id, value: entry.id },
                `${entry.id}（${entry.models?.length ?? 0} 个模型）`))),
            ]),
            e('div', { key: 'm', style: css.field }, [
              e('label', { key: 'l', style: css.label }, 'model'),
              e('select', {
                key: 's', style: css.input, value: model,
                onChange: event => setModel(event.target.value),
              }, providerModels.map(entry => e('option', { key: entry.id, value: entry.id },
                `${entry.name ?? entry.id} · ${entry.id}`))),
            ]),
            e('button', { key: 'add', type: 'button', style: css.button, onClick: addCandidate }, '＋ 加入候选'),
          ]),
          draft.models.length === 0
            ? e('p', { key: 'empty', style: css.sub }, '当前没有候选：跟随会话自己的模型。')
            : e('ul', { key: 'list', style: css.list }, draft.models.map((entry, index) => e('li', { key: entry, style: css.item }, [
              e('span', { key: 'n', style: css.status }, `${index + 1}.`),
              e('code', { key: 'c', style: { ...css.mono, flex: 1 } }, entry),
              e('button', { key: 'up', type: 'button', style: css.mini, onClick: () => moveCandidate(index, -1) }, '上移'),
              e('button', { key: 'down', type: 'button', style: css.mini, onClick: () => moveCandidate(index, 1) }, '下移'),
              e('button', {
                key: 'del', type: 'button', style: css.mini,
                onClick: () => patch({ models: draft.models.filter((_, at) => at !== index) }),
              }, '删除'),
            ]))),
        ]),

        /* 2. 参与的工作区 */
        e('section', { key: 'workspaces', style: css.section }, [
          e('h3', { key: 'h', style: css.h }, '参与归组的工作区'),
          e('p', { key: 'sub', style: css.sub }, '一个都不勾 = 全部工作区都参与；分组只发生在该工作区内部，不动工作区结构。'),
          workspaces.length === 0
            ? e('p', { key: 'none', style: css.sub }, '读不到工作区列表。')
            : e('div', { key: 'list', style: { display: 'grid', gap: '6px' } }, workspaces.map(entry => e('label', { key: entry.path, style: css.check }, [
              e('input', {
                key: 'i', type: 'checkbox',
                checked: draft.workspaces.includes(entry.path),
                onChange: event => toggleWorkspace(entry.path, event.target.checked),
              }),
              e('span', { key: 't' }, entry.title ?? entry.path),
              e('code', { key: 'p', style: css.mono }, entry.path),
              e('span', { key: 'n', style: css.status }, `${entry.sessions ?? 0} 条会话`),
            ]))),
        ]),

        /* 3. 归档提示词 */
        e('section', { key: 'prompt', style: css.section }, [
          e('h3', { key: 'h', style: css.h }, '归档提示词'),
          e('p', { key: 'sub', style: css.sub },
            '整段发给模型。支持两个占位符：{{WORKSPACE_TREE_JSON}}（当前工作区树）与 {{SESSION_CONTEXT}}（本条会话摘录）。'
            + '留空 = 用插件自带的默认提示词。'),
          e('div', { key: 'ph', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            Object.entries(data?.placeholders ?? {}).map(([key, desc]) => e('button', {
              key,
              type: 'button',
              style: css.mini,
              title: desc,
              onClick: () => patch({ prompt: `${draft.prompt}${draft.prompt === '' ? '' : '\n'}{{${key}}}` }),
            }, `＋ {{${key}}}`))),
          e('textarea', {
            key: 'box',
            style: {
              ...css.input,
              height: 'auto',
              minHeight: '260px',
              padding: '10px',
              lineHeight: 1.55,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '12px',
              resize: 'vertical',
              whiteSpace: 'pre',
            },
            spellCheck: false,
            value: promptText,
            onChange: event => patch({ prompt: event.target.value }),
          }),
          e('div', { key: 'actions', style: css.row }, [
            e('span', { key: 'len', style: css.status }, `${promptText.length} 字 · ${promptIsDefault ? '默认' : '自定义'}`),
            e('span', { key: 'gap', style: { flex: 1 } }),
            e('button', {
              key: 'reset', type: 'button', style: css.button,
              onClick: () => patch({ prompt: '' }),
            }, '恢复默认'),
          ]),
          e('p', { key: 'cats', style: css.sub },
            `工程词库：${(data?.categories?.engineering ?? []).join(' / ') || '(无)'}`
            + `　日常词库：${(data?.categories?.daily ?? []).join(' / ') || '(无)'}`),
        ]),

        /* 4. 行为 */
        e('section', { key: 'behaviour', style: css.section }, [
          e('h3', { key: 'h', style: css.h }, '行为'),
          e('div', { key: 'switches', style: { display: 'grid', gap: '6px' } }, [
            e('label', { key: 'enabled', style: css.check }, [
              e('input', {
                type: 'checkbox', checked: draft.enabled,
                onChange: event => patch({ enabled: event.target.checked }),
              }),
              e('span', null, '启用自动归组（每轮结束 + 定时兜底扫描）'),
            ]),
            e('label', { key: 'new', style: css.check }, [
              e('input', {
                type: 'checkbox', checked: draft.allowNewGroups,
                onChange: event => patch({ allowNewGroups: event.target.checked }),
              }),
              e('span', null, '允许模型新建一级目录（关掉时不在已知目录里的名字会被丢弃）'),
            ]),
            e('label', { key: 'fix', style: css.check }, [
              e('input', {
                type: 'checkbox', checked: draft.correctMisplaced,
                onChange: event => patch({ correctMisplaced: event.target.checked }),
              }),
              e('span', null, '允许纠正已归档的会话（关掉时标题含 / 的一律不动）'),
            ]),
            e('label', { key: 'collapse', style: css.check }, [
              e('input', {
                type: 'checkbox', checked: draft.collapseOwnWorkspace,
                onChange: event => patch({ collapseOwnWorkspace: event.target.checked }),
              }),
              e('span', null, '一级目录与会话所在工作区同名时省掉这一层（避免重复嵌套）'),
            ]),
            e('label', { key: 'dry', style: css.check }, [
              e('input', {
                type: 'checkbox', checked: draft.dryRun,
                onChange: event => patch({ dryRun: event.target.checked }),
              }),
              e('span', null, '预演：只算归组计划，不改任何标题'),
            ]),
          ]),
          e('div', { key: 'daily', style: { ...css.field, marginTop: '10px' } }, [
            e('label', { key: 'l', style: css.label }, '日常类会话归入的一级目录'),
            e('input', {
              key: 'i', type: 'text', style: css.input, value: draft.dailyProject,
              onChange: event => patch({ dailyProject: event.target.value }),
            }),
          ]),
          e('div', { key: 'numbers', style: { ...css.grid, marginTop: '10px' } }, [
            ['maxTokens', '输出上限', 64, 64],
            ['timeoutMs', '超时（毫秒）', 1000, 1000],
            ['concurrency', '并发请求数（1–8）', 1, 1],
            ['sweepMs', '兜底扫描间隔（0=关）', 0, 10000],
            ['maxTitleBytes', '标题字节上限（≤200）', 24, 4],
          ].map(([key, label, min, step]) => e('div', { key, style: css.field }, [
            e('label', { key: 'l', style: css.label }, label),
            e('input', {
              key: 'i', type: 'number', min, step, style: css.input, value: draft[key],
              onChange: event => {
                const value = Number(event.target.value)
                patch({ [key]: Number.isFinite(value) ? value : 0 })
              },
            }),
          ]))),
        ]),

        /* 5. 动作 */
        e('div', { key: 'actions', style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
          e('button', {
            key: 'save', type: 'button', style: css.primary,
            disabled: busy !== null || !writable,
            onClick: () => void save(),
          }, busy === 'save' ? '保存中…' : '保存'),
          e('button', {
            key: 'run', type: 'button', style: css.button,
            disabled: busy !== null,
            onClick: () => void organize(false),
          }, busy === 'run' ? '整理中…' : (draft.dryRun ? '预演一次' : '立即整理')),
          e('button', {
            key: 'force', type: 'button', style: css.danger,
            disabled: busy !== null,
            title: '忽略缓存、失败冷却、纠偏开关与预演，把所有会话重新问一遍模型并真改标题',
            onClick: () => {
              if (window.confirm('强制整理会忽略缓存与纠偏开关，把所有参与工作区的会话重新问一遍模型并直接改标题。继续？')) {
                void organize(true)
              }
            },
          }, busy === 'force' ? '强制整理中…' : '强制整理'),
          writable ? null : e('span', { key: 'ro', style: css.err }, '此 profile 不接受配置写入'),
        ]),

        run === null ? null : e('section', { key: 'result', style: css.section }, [
          e('h3', { key: 'h', style: css.h }, `上次整理结果 · 扫 ${run.scanned ?? 0} 条`),
          e('ul', { key: 'list', style: css.list }, [
            ...(run.renamed ?? []).map(entry => e('li', { key: `r:${entry.id}`, style: css.item }, [
              e('code', { key: 'c', style: { ...css.mono, flex: 1 } }, `${entry.title} → ${entry.next}`),
              e('span', { key: 'b', style: css.status }, entry.by ?? ''),
            ])),
            ...(run.plans ?? []).map(entry => e('li', { key: `p:${entry.id}`, style: css.item }, [
              e('code', { key: 'c', style: { ...css.mono, flex: 1 } }, `[预演] ${entry.title} → ${entry.next}`),
            ])),
            ...(run.ungrouped ?? []).map(entry => e('li', { key: `u:${entry.id}`, style: css.item }, [
              e('code', { key: 'c', style: { ...css.mono, flex: 1 } }, `${entry.title || entry.id} 不归组`),
              e('span', { key: 'b', style: css.status }, entry.by ?? ''),
            ])),
            ...(run.skipped ?? []).map(entry => e('li', { key: `s:${entry.id}`, style: css.item }, [
              e('code', { key: 'c', style: { ...css.mono, flex: 1 } }, `${entry.title || entry.id} 跳过`),
              e('span', { key: 'b', style: css.status }, entry.skipped ?? ''),
            ])),
            ...(run.failed ?? []).map(entry => e('li', { key: `f:${entry.id}`, style: css.item }, [
              e('code', { key: 'c', style: { ...css.mono, flex: 1 } }, `${entry.title || entry.id} 失败`),
              e('span', { key: 'b', style: css.err }, entry.failed ?? ''),
            ])),
          ]),
        ]),
      ])
    }

    /* ── 侧栏 ✦ 一键整理 ──────────────────────────────────── */

    const LABEL = '智能整理'
    const baseStyle = {
      flex: 'none',
      height: '28px',
      padding: '0 10px',
      borderRadius: '6px',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
      cursor: 'pointer',
      fontSize: '12px',
      lineHeight: '1',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      whiteSpace: 'nowrap',
    }

    const IDLE_TITLE = '按会话内容自动归档（模型 + 提示词）'

    function OrganizeButton() {
      const [state, setState] = React.useState({ busy: false, text: LABEL, title: IDLE_TITLE })
      const run = async (force) => {
        if (state.busy) return
        setState({ busy: true, text: '…', title: force ? '正在强制整理' : '正在整理' })
        try {
          const body = force ? await post(API.force, {}) : await post(API.run, {})
          const count = (body.renamed ?? []).length
          const planned = (body.plans ?? []).length
          const skipped = (body.skipped ?? []).length
          const failed = (body.failed ?? []).length
          setState({
            busy: true,
            text: `✓${count}`,
            title: `${force ? '强制整理' : '已整理'}：扫 ${body.scanned ?? 0} 条，改 ${count} 条`
              + `${planned > 0 ? `，预演 ${planned} 条` : ''}`
              + `${skipped > 0 ? `，跳过 ${skipped} 条` : ''}`
              + `${failed > 0 ? `，失败 ${failed} 条` : ''}`,
          })
        } catch (error) {
          setState({ busy: true, text: '!', title: `整理失败：${error instanceof Error ? error.message : String(error)}` })
        } finally {
          window.setTimeout(() => setState({ busy: false, text: LABEL, title: IDLE_TITLE }), 2500)
        }
      }
      const click = () => void run(false)
      const forceClick = event => {
        event.stopPropagation()
        event.preventDefault()
        if (state.busy) return
        if (!window.confirm('强制整理会忽略缓存、失败冷却、纠偏开关与预演，把所有参与工作区的会话重新问一遍模型并直接改标题。继续？')) return
        void run(true)
      }
      return e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '2px' } }, [
        e('button', {
          key: 'run',
          type: 'button',
          'data-agroup-btn': 'footer',
          onClick: click,
          title: state.title,
          'aria-label': LABEL,
          style: baseStyle,
        }, state.text),
        e('button', {
          key: 'force',
          type: 'button',
          'data-agroup-btn': 'footer-force',
          onClick: forceClick,
          title: '强制整理：忽略缓存与纠偏开关，全部重新问模型并真改',
          'aria-label': '强制整理',
          style: { ...baseStyle, padding: '0 6px', opacity: '0.7' },
        }, '⚡'),
      ])
    }

    /* ── 装配 ─────────────────────────────────────────────── */

    function apply(ctx) {
      const slots = ctx?.slots
      if (typeof slots?.inject !== 'function') {
        console.warn('[auto-session-groups] 没有 slots 服务，设置页与按钮都不注册')
        return
      }

      // 1) 插件页这一行的「配置」页
      try {
        slots.inject('plugins.row.config', () => slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
        }, ConfigPage))
      } catch (error) {
        console.warn('[auto-session-groups] plugins.row.config 注册失败:', error)
      }

      // 2) 设置 → 插件 → 智能整理 一页
      try {
        slots.inject('settings.plugins.tab', () => slots.register({
          name: 'settings.plugins.tab',
          id: SELF_ID,
          order: 60,
          label: () => LABEL,
        }, ConfigPage))
      } catch (error) {
        console.warn('[auto-session-groups] settings.plugins.tab 注册失败:', error)
      }

      // 3) 侧栏底部一键整理
      try {
        slots.inject('sidebar.footer.action', () => slots.register({
          name: 'sidebar.footer.action',
          id: SELF_ID,
          order: 30,
          label: () => LABEL,
        }, OrganizeButton))
      } catch (error) {
        console.warn('[auto-session-groups] sidebar.footer.action 注册失败:', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
