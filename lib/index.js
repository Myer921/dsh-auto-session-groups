/**
 * @local/dsh-auto-session-groups — 宿主半
 *
 * 智能归档：每轮结束时读一次会话内容（标题 + 用户话 + 当前分类），把**提示词**
 * 连同「工作区树」一起交给模型，让模型返回一个 JSON 决策：
 *   { need_move, target_project, target_category, new_title, confidence }
 * 然后把结果写成 `一级目录/二级标签/标题`（source=user）——侧栏
 * dsh-better-workspace 按 `/` 把它渲染成「该工作区内部的嵌套会话分组」。
 *
 * 提示词是**可配置的**：默认值在 lib/rules.json 的 `prompt`，可在 DSH 设置里
 * 整段改写（设置 → 插件 → 智能整理）。模板里支持两个占位符：
 *   {{WORKSPACE_TREE_JSON}}  当前工作区树（工作区名、路径、会话数、已有分组）
 *   {{SESSION_CONTEXT}}      本条会话摘录（模板没写就作为 user 消息单独发）
 *
 * 模型失败就不动（宁可留空，也不瞎归类），原因写进日志。
 * 设置全部由 DSH 自己的设置界面读写（client.js：plugins.row.config /
 * settings.plugins.tab），持久化走 ctx.configEditor → profile 的插件 config。
 * 所有 Config 字段都是 `.volatile()`：编辑后原地生效，不重启插件。
 */

import { readFileSync, existsSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'auto-session-groups'
export const inject = ['sessions', 'sessionTitle', 'sessionProjections', 'llm', 'webServer']

/* ── 默认提示词与词库（lib/rules.json） ─────────────────────── */

const RULES_URL = new URL('./rules.json', import.meta.url)
let cachedRules

export function rules() {
  if (cachedRules === undefined) cachedRules = JSON.parse(readFileSync(RULES_URL, 'utf8'))
  return cachedRules
}

/** 生效提示词：设置里写了就用设置的，否则用 rules.json 的默认值。 */
export function effectivePrompt(cfg) {
  const custom = typeof cfg?.prompt === 'string' ? cfg.prompt.trim() : ''
  if (custom !== '') return custom
  return String(rules().prompt ?? '')
}

/* ── 配置读取（兼容 volatile 引用与普通值） ─────────────────── */

/** 读一个字段：volatile 字段是 `{ get() }` 引用，普通字段就是值。 */
function field(config, key, fallback) {
  const holder = config ?? {}
  const raw = holder[key]
  if (raw === undefined || raw === null) return fallback
  const value = typeof raw.get === 'function' ? raw.get() : raw
  return value === undefined || value === null ? fallback : value
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.map(entry => String(entry ?? '').trim()).filter(entry => entry !== '')
}

function positiveInt(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  const rounded = Math.floor(number)
  return max === undefined ? rounded : Math.min(rounded, max)
}

/**
 * 把一份（可能是 volatile 引用的）config 读成普通对象。
 * 所有业务代码只经这里读配置，改字段后立刻生效。
 */
export function readConfig(config) {
  return {
    enabled: field(config, 'enabled', true) !== false,
    models: stringList(field(config, 'models', [])),
    allowProviders: stringList(field(config, 'allowProviders', [])),
    workspaces: stringList(field(config, 'workspaces', [])),
    prompt: typeof field(config, 'prompt', '') === 'string' ? field(config, 'prompt', '') : '',
    dailyProject: String(field(config, 'dailyProject', rules().dailyProject ?? '日常通用') ?? '').trim(),
    allowNewGroups: field(config, 'allowNewGroups', false) === true,
    correctMisplaced: field(config, 'correctMisplaced', true) !== false,
    collapseOwnWorkspace: field(config, 'collapseOwnWorkspace', true) !== false,
    maxTitleBytes: Math.max(24, positiveInt(field(config, 'maxTitleBytes', 76), 76, 200)),
    maxTokens: positiveInt(field(config, 'maxTokens', 1536), 1536),
    timeoutMs: positiveInt(field(config, 'timeoutMs', 20000), 20000),
    concurrency: Math.max(1, positiveInt(field(config, 'concurrency', 2), 2, 8)),
    sweepMs: positiveInt(field(config, 'sweepMs', 300000), 300000),
    dryRun: field(config, 'dryRun', false) === true,
  }
}

/* ── 会话内容 → 文本 ─────────────────────────────────────────── */

/** 从一条会话事件里抠出用户正文。 */
function userTextOf(event) {
  if (event?.type !== 'user/message') return undefined
  const content = event.data?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join(' ')
    .trim()
  return text.length === 0 ? undefined : text
}

/**
 * 读会话内容摘录：标题 + 前几条用户消息 + 最后一条用户消息。
 * @returns {{title: string, first: string[], last: string | undefined}}
 */
export function contextOf(session, limit = 3, clip = 240) {
  const title = typeof session?.header?.title === 'string' ? session.header.title : ''
  const first = []
  let last
  let events = []
  try {
    events = session?.snapshotEvents?.() ?? []
  } catch {
    events = []
  }
  for (const event of events) {
    const text = userTextOf(event)
    if (text === undefined) continue
    last = text
    if (first.length < limit) first.push(text.slice(0, clip))
  }
  return { title, first, last: last?.slice(0, clip) }
}

/** 把摘录拼成给模型的输入（含 current_path，提示词里会引用它）。 */
export function contextPrompt(context) {
  const lines = [`标题：${context.title || '(无)'}`]
  lines.push(`own_workspace：${context.ownWorkspace ?? '(未知)'}`)
  lines.push(`current_path：${context.currentPath ?? (String(context.title ?? '').includes('/') ? context.title : '未分类')}`)
  context.first.forEach((text, index) => lines.push(`用户消息 ${index + 1}：${text}`))
  if (context.last !== undefined && !context.first.includes(context.last)) {
    lines.push(`最近一条用户消息：${context.last}`)
  }
  return lines.join('\n')
}

/** 模块级日志兜底：导出函数（不依赖 apply 闭包）也要能写日志。 */
function moduleLog(text) {
  console.log(text)
}

/* ── 提示词渲染 ─────────────────────────────────────────────── */

/** 把 {{KEY}} 占位符替换成实际内容；未知占位符原样保留。 */
export function renderPrompt(template, vars) {
  let out = String(template ?? '')
  for (const [key, value] of Object.entries(vars ?? {})) {
    out = out.split(`{{${key}}}`).join(String(value ?? ''))
  }
  return out
}

/* ── 模型输出 → 决策 ────────────────────────────────────────── */

/** 一个目录/标签段：去引号、去控制字符、不许含 `/`、长度上限。 */
export function cleanSegment(value, maxChars = 24) {
  if (typeof value !== 'string') return undefined
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .trim()
  if (text === '' || text.includes('/')) return undefined
  if ([...text].length > maxChars) return undefined
  return text
}

/**
 * 从模型回复里抠出 JSON 决策。容忍 ```json 围栏、前后废话、多余字段。
 * @returns {{needMove: boolean, project?: string, category?: string, title?: string, confidence?: number} | undefined}
 */
export function parseDecision(reply) {
  if (typeof reply !== 'string') return undefined
  let text = reply.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence !== null) text = fence[1].trim()
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let end = -1
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = index; break }
    }
  }
  if (end === -1) return undefined
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const confidence = Number(parsed.confidence)
  return {
    needMove: parsed.need_move === true,
    project: cleanSegment(parsed.target_project),
    category: cleanSegment(parsed.target_category),
    title: cleanSegment(parsed.new_title, 40),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined,
  }
}

/* ── 工作区树（注入提示词） ─────────────────────────────────── */

/** 路径最后一段，作为工作区没有标题时的名字。 */
function baseName(path) {
  const text = String(path ?? '').replace(/[\\/]+$/, '')
  const at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return at === -1 ? text : text.slice(at + 1)
}

/**
 * 拼出注入提示词的工作区树：每个工作区的名字、路径、会话数、已有分组。
 * 已有分组从会话标题的 `/` 前缀里读，让模型优先复用而不是另起新名。
 */
export function buildWorkspaceTree(ctx, cfg, sessions) {
  const registry = service(ctx, 'workspaceRegistry')
  const dailyProject = cfg?.dailyProject ?? rules().dailyProject ?? '日常通用'
  const nodes = new Map()
  try {
    for (const row of registry?.list?.() ?? []) {
      if (typeof row?.path !== 'string') continue
      nodes.set(row.path, {
        name: typeof row.title === 'string' && row.title !== '' ? row.title : baseName(row.path),
        path: row.path,
        sessions: 0,
        groups: new Set(),
        categories: new Set(),
      })
    }
  } catch {
    /* 拿不到注册表就只靠会话 cwd 兜底 */
  }
  for (const session of sessions ?? []) {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') continue
    if (!nodes.has(cwd)) {
      nodes.set(cwd, { name: baseName(cwd), path: cwd, sessions: 0, groups: new Set(), categories: new Set() })
    }
    const node = nodes.get(cwd)
    node.sessions += 1
    let title = ''
    try {
      title = String(ctx.sessionTitle?.get?.(session)?.title ?? '')
    } catch {
      title = ''
    }
    const segs = title.split('/').map(part => part.trim()).filter(Boolean)
    // 只把「本工作区自己的名字」和「日常目录」记成合法一级目录。
    // 历史里跨工作区错位的分组（如 AndroidDev 下出现 Arm64-INIT）不再喂回模型，
    // 否则模型会照着错的名字继续复用，错误自我强化。
    if (segs.length >= 2) {
      const head = segs[0]
      if (head === node.name || head === dailyProject) node.groups.add(head)
    }
    if (segs.length >= 3) node.categories.add(segs[1])
  }
  return {
    dailyProject,
    workspaces: [...nodes.values()].map(node => ({
      name: node.name,
      path: node.path,
      sessions: node.sessions,
      groups: [...node.groups].sort(),
      categories: [...node.categories].sort(),
    })),
  }
}

/**
 * 合法的一级目录集合。
 *
 * 只认两样：**所有工作区的名字** + **日常目录**。
 * 不把历史分组算进来——历史分组里可能就躺着错位的名字（AndroidDev 下出现过
 * Arm64-INIT、Arm64-INIT 下出现过 开发），把它们当合法会让错误自我强化。
 * @param tree - buildWorkspaceTree 的产物
 * @param ownWorkspace - 本条会话所在工作区的名字（可选，用于额外放行）
 */
export function knownProjectNames(tree, ownWorkspace) {
  const names = new Set()
  for (const workspace of tree?.workspaces ?? []) {
    if (workspace.name) names.add(workspace.name)
  }
  if (tree?.dailyProject) names.add(tree.dailyProject)
  if (typeof ownWorkspace === 'string' && ownWorkspace !== '') names.add(ownWorkspace)
  return names
}

/* ── 标题拼装 ───────────────────────────────────────────────── */

/** 按 UTF-8 字节预算截断，不切坏码点。 */
export function truncateUtf8(text, maxBytes) {
  const input = String(text ?? '')
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let out = ''
  for (const ch of input) {
    const bytes = Buffer.byteLength(ch, 'utf8')
    if (used + bytes > maxBytes) break
    out += ch
    used += bytes
  }
  return out
}

/**
 * 决策 → 标题 `一级目录/二级标签/标题`。
 * - `collapseOwnWorkspace` 打开且一级目录就是会话自己所在工作区时，省掉这一层
 *   （工作区本身已经显示了，再套一层是重复）。
 * - 叶子优先用模型给的 new_title，没有就退回原标题。
 * - 总长度按 maxTitleBytes 截断，避免被 session-title 服务从中间切断。
 * @returns {string | undefined}
 */
export function composeTitle(decision, options = {}) {
  const maxBytes = options.maxBytes ?? 76
  const segs = []
  const project = decision?.project
  const category = decision?.category
  if (typeof project === 'string' && project !== '') {
    const own = options.ownWorkspace
    const sameAsOwn = typeof own === 'string' && own !== '' && project === own
    if (!(options.collapseOwnWorkspace !== false && sameAsOwn)) segs.push(project)
  }
  if (typeof category === 'string' && category !== '') segs.push(category)
  if (segs.length === 0) return undefined
  const prefix = `${segs.join('/')}/`
  const budget = maxBytes - Buffer.byteLength(prefix, 'utf8')
  if (budget <= 0) return undefined
  const source = typeof decision?.title === 'string' && decision.title !== ''
    ? decision.title
    : String(options.fallbackTitle ?? '')
  const leaf = truncateUtf8(source.trim(), budget).trim()
  if (leaf === '') return undefined
  return prefix + leaf
}

/* ── 路由 ───────────────────────────────────────────────────── */

/** 把 `provider/model` 拆成路由。 */
export function parseRoute(text) {
  if (typeof text !== 'string') return undefined
  const slash = text.indexOf('/')
  if (slash <= 0 || slash === text.length - 1) return undefined
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) }
}

/** 会话自己选的模型。 */
export function sessionRoute(ctx, session) {
  try {
    const snapshot = ctx.sessionProjections?.snapshot?.(session, ['modelSelection'])
    const chosen = snapshot?.values?.modelSelection?.next ?? snapshot?.values?.modelSelection?.lastUsed
    if (chosen?.provider !== undefined && chosen?.model !== undefined) {
      return { provider: chosen.provider, model: chosen.model }
    }
  } catch {
    /* 投影读不到就当没有 */
  }
  return undefined
}

/** 当前真正注册着的 provider id 集合；拿不到就返回 undefined（表示不做校验）。 */
export function knownProviders(ctx) {
  try {
    const list = ctx.llm?.listProviders?.() ?? []
    const ids = list
      .map(entry => (typeof entry === 'string' ? entry : entry?.id ?? entry?.provider?.id))
      .filter(Boolean)
    return ids.length === 0 ? undefined : new Set(ids)
  } catch {
    return undefined
  }
}

/** 部署默认模型（老会话路由失效时的兜底）。 */
export function defaultRoute(ctx) {
  try {
    const getter = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : ctx.agentDefaultModel
    const selection = getter?.currentSelection?.()
    const chosen = selection?.next ?? selection?.lastUsed ?? selection
    if (chosen?.provider !== undefined && chosen?.model !== undefined) {
      return { provider: chosen.provider, model: chosen.model }
    }
  } catch {
    /* 拿不到就算了 */
  }
  return undefined
}

/**
 * 候选路由：配置优先，其次会话自身；allowProviders 过一遍；
 * 最后剔除 provider 已经不存在的老路由（老会话里可能留着 `opencode-go` 这种旧 id）。
 */
export function candidateRoutes(ctx, session, cfg, dropped = []) {
  const allowed = cfg?.allowProviders ?? []
  const routes = (cfg?.models ?? []).map(parseRoute).filter(Boolean)
  const own = sessionRoute(ctx, session)
  if (own !== undefined) routes.push(own)
  const permitted = routes.filter(route => allowed.length === 0 || allowed.includes(route.provider))
  const known = knownProviders(ctx)
  if (known === undefined) return permitted
  const alive = []
  for (const route of permitted) {
    if (known.has(route.provider)) alive.push(route)
    else dropped.push(route.provider)
  }
  if (alive.length === 0) {
    const fallback = defaultRoute(ctx)
    if (fallback !== undefined && known.has(fallback.provider)) alive.push(fallback)
  }
  return alive
}

/** 给日志用的分类失败分类标签。 */
function failureKind(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('没有可用模型路由')) return 'no-route'
  if (message.includes('模型没吐正文')) return 'empty-reply'
  if (message.includes('不是合法 JSON')) return 'bad-json'
  if (message.includes('超时')) return 'timeout'
  return 'error'
}

/**
 * 让模型读会话内容并给出归档决策。任一候选成功即返回。
 * @returns {Promise<{decision?: object, route?: {provider: string, model: string}, raw: string}>}
 */
export async function classifyWithModel(ctx, session, context, cfg, tree) {
  const dropped = []
  const routes = candidateRoutes(ctx, session, cfg, dropped)
  if (dropped.length > 0) {
    moduleLog(`[auto-session-groups] 忽略失效 provider：${[...new Set(dropped)].join(', ')}`)
  }
  if (routes.length === 0) {
    throw new Error(
      `没有可用模型路由（失效 ${[...new Set(dropped)].join(', ') || '无'}；检查设置里的分类模型 / provider 白名单）`,
    )
  }
  const template = effectivePrompt(cfg)
  if (template.trim() === '') throw new Error('提示词为空：请在设置里填写，或点「恢复默认」')
  const sessionContext = contextPrompt(context)
  const system = renderPrompt(template, {
    WORKSPACE_TREE_JSON: JSON.stringify(tree, null, 2),
    SESSION_CONTEXT: sessionContext,
    DAILY_PROJECT: cfg?.dailyProject ?? tree?.dailyProject ?? '',
  })
  // 模板里没写 {{SESSION_CONTEXT}} 时，把摘录作为 user 消息单独发
  const inlineContext = template.includes('{{SESSION_CONTEXT}}')
  const messages = inlineContext
    ? [{
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: '请按系统提示归档下面这条会话。' }],
      source: { kind: 'dsh-auto-session-groups' },
    }]
    : [{
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: sessionContext }],
      source: { kind: 'dsh-auto-session-groups' },
    }]
  let lastError
  for (const route of routes) {
    const controller = new AbortController()
    const timeoutMs = cfg?.timeoutMs ?? 20000
    const timer = setTimeout(() => controller.abort(new Error('分类超时')), timeoutMs)
    try {
      let text = ''
      let finish
      let failureDetail
      const stream = ctx.llm.stream({
        ...route,
        messages,
        system,
        // 推理模型会把 max_tokens 全花在 thinking 上、content 留空（finish=length）。
        maxTokens: cfg?.maxTokens ?? 1536,
        signal: controller.signal,
        ...(session?.id === undefined ? {} : { sessionId: session.id }),
        purpose: 'auto-session-groups',
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk?.type === 'finish') {
          finish = chunk.reason?.kind ?? 'finish'
          const failure = chunk.reason?.failure
          if (failure !== undefined) {
            failureDetail = `${failure.code ?? '?'}: ${failure.message ?? ''}`.slice(0, 300)
          }
          break
        }
      }
      if (text.trim().length === 0) {
        throw new Error(
          `模型没吐正文（finish=${finish ?? 'unknown'}`
          + `${failureDetail === undefined ? '' : `，失败 ${failureDetail}`}`
          + `，预算 maxTokens=${cfg?.maxTokens ?? 1536}）`,
        )
      }
      const raw = text.trim()
      const decision = parseDecision(raw)
      if (decision === undefined) throw new Error(`模型输出不是合法 JSON：${raw.slice(0, 200)}`)
      return { decision, route, raw }
    } catch (error) {
      lastError = error
      moduleLog(`[auto-session-groups] 路由 ${route.provider}/${route.model} 失败（${failureKind(error)}）：${
        error instanceof Error ? error.message : String(error)
      }`)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new Error('所有候选模型都失败了')
}

/* ── Config（全部 volatile：改完原地生效，不重启插件） ───────── */

/** 解析 schemastery：逐个根试，全部失败时把原因带回去。 */
function resolveSchema() {
  const fromFile = fileURLToPath(new URL('../../../', import.meta.url)) // ~/.dsh-next/
  const roots = [
    process.env.DSH_PROFILE_DIR && join(process.env.DSH_PROFILE_DIR, 'package.json'),
    process.env.DSH_HOME && join(process.env.DSH_HOME, 'profiles', 'web', 'package.json'),
    join(fromFile, 'profiles', 'web', 'package.json'),
    process.env.DSH_INSTALL_DIR && join(process.env.DSH_INSTALL_DIR, 'package.json'),
    join(fromFile, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ].filter(Boolean)
  const failures = []
  for (const root of roots) {
    try {
      const loaded = createRequire(root)('@deepseek-ai/schemastery')
      const schema = loaded?.default ?? loaded
      if (typeof schema === 'function') return { schema, root }
      failures.push(`${root}=不是函数(${typeof schema})`)
    } catch (error) {
      failures.push(`${root}=${error?.code ?? (error instanceof Error ? error.message : String(error))}`)
    }
  }
  return { schema: undefined, failures }
}

const { schema: Schema, root: schemaRoot, failures: schemaFailures } = resolveSchema()

export const Config = Schema === undefined
  ? undefined
  : Schema.object({
    enabled: Schema.boolean().default(true).volatile()
      .description('总开关：关掉后不再自动归档'),
    models: Schema.array(Schema.string()).default([]).volatile()
      .description('归档用的模型候选，按顺序尝试，写成 provider/model；留空 = 跟随会话自己选的模型'),
    allowProviders: Schema.array(Schema.string()).default([]).volatile()
      .description('provider 白名单，留空 = 不限制'),
    workspaces: Schema.array(Schema.string()).default([]).volatile()
      .description('参与归档的工作区绝对路径，留空 = 全部工作区'),
    prompt: Schema.string().default('').volatile()
      .description('归档提示词；留空 = 用 lib/rules.json 的默认提示词。支持 {{WORKSPACE_TREE_JSON}} 与 {{SESSION_CONTEXT}} 占位符'),
    dailyProject: Schema.string().default('日常通用').volatile()
      .description('日常类会话统一归入的一级目录名'),
    allowNewGroups: Schema.boolean().default(false).volatile()
      .description('允许模型新建一级目录；关掉时不在已知目录里的名字会被丢弃'),
    correctMisplaced: Schema.boolean().default(true).volatile()
      .description('允许模型纠正已经分过类的会话（标题已含 / 时仍可被移动）'),
    collapseOwnWorkspace: Schema.boolean().default(true).volatile()
      .description('一级目录与会话所在工作区同名时省掉这一层，避免重复嵌套'),
    maxTitleBytes: Schema.natural().default(76).volatile()
      .description('拼出来的标题字节上限（session-title 服务硬上限 80）'),
    maxTokens: Schema.natural().default(1536).volatile()
      .description('归档请求输出上限；太小会被推理 token 吃光，导致空回复'),
    timeoutMs: Schema.natural().default(20000).volatile()
      .description('单次归档请求超时（毫秒）'),
    concurrency: Schema.natural().default(2).volatile()
      .description('同时进行的归档请求数上限，1–8'),
    sweepMs: Schema.natural().default(300000).volatile()
      .description('兜底扫描间隔（毫秒），0 = 关闭'),
    dryRun: Schema.boolean().default(false).volatile()
      .description('预演：只算归档计划，不改标题'),
  })

/* ── 旧 settings.json：一次性迁进行 config 后弃用 ───────────── */

const LEGACY_SETTINGS_URL = new URL('./settings.json', import.meta.url)

const MIGRATABLE = [
  'enabled', 'models', 'allowProviders', 'workspaces', 'allowNewGroups',
  'maxTokens', 'timeoutMs', 'concurrency', 'sweepMs', 'prompt', 'dailyProject',
]

/**
 * settings.json 曾经是第二条来源。现在只把它当迁移输入：补进行 config，
 * 成功后改名 settings.json.migrated-<时间戳>，之后不再读。
 */
export async function migrateLegacySettings(ctx, log = () => {}) {
  let legacy
  try {
    if (!existsSync(LEGACY_SETTINGS_URL)) return false
    legacy = JSON.parse(readFileSync(LEGACY_SETTINGS_URL, 'utf8'))
  } catch (error) {
    log(`[auto-session-groups] 旧 settings.json 读不动，跳过迁移：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  if (legacy === null || typeof legacy !== 'object') return false
  const patch = {}
  for (const key of MIGRATABLE) if (legacy[key] !== undefined) patch[key] = legacy[key]
  const entry = ctx?.fiber?.entry
  const editor = service(ctx, 'configEditor')
  if (entry === undefined || editor === undefined) {
    log('[auto-session-groups] 旧 settings.json 还在，但本 profile 没有 configEditor，暂不迁移')
    return false
  }
  try {
    await editor.edit(entry, current => ({ ...current, ...patch }))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(fileURLToPath(LEGACY_SETTINGS_URL), fileURLToPath(new URL(`./settings.json.migrated-${stamp}`, import.meta.url)))
    log(`[auto-session-groups] 旧 settings.json 已迁进行 config 并改名（${Object.keys(patch).join(', ')}）`)
    return true
  } catch (error) {
    log(`[auto-session-groups] 旧 settings.json 迁移失败，保留原文件：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/* ── 服务获取 / 设置写入 ────────────────────────────────────── */

/**
 * 取一个服务。
 *
 * 顺序很重要：**先 `ctx.get(name)`，再退回直接读属性**。
 * cordis 的 Context 是 Proxy，读一个没写进 `inject` 的属性会**抛**
 * `cannot get property "x" without inject`——所以「先直接读、抛了再 get」
 * 的写法永远拿不到 configEditor / workspaceRegistry，表现为
 * 「此 profile 不接受配置写入」和工作区列表恒空。`ctx.get` 是 reflect 的
 * 公开方法，不需要 inject，才是正确入口。
 */
function service(ctx, key) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get(key) : undefined
    if (viaGet !== undefined) return viaGet
  } catch {
    /* get 不可用就退回直接读 */
  }
  try {
    return ctx?.[key]
  } catch {
    return undefined
  }
}

/** 模型目录：providers + 每个 provider 的 models（缓存 60s）。 */
let catalogCache = { at: 0, value: [] }
export async function modelCatalog(ctx, force = false) {
  if (!force && Date.now() - catalogCache.at < 60000) return catalogCache.value
  const catalog = []
  try {
    const providers = ctx.llm?.listProviders?.() ?? []
    for (const provider of providers) {
      const id = String(provider?.id ?? provider?.provider ?? provider?.name ?? '')
      if (id === '') continue
      let models = []
      try {
        models = await ctx.llm.listModels(id)
      } catch {
        models = []
      }
      catalog.push({ id, models: models.map(model => ({ id: model.id, name: model.name })) })
    }
  } catch {
    /* 列不出来就返回已有的 */
  }
  catalogCache = { at: Date.now(), value: catalog }
  return catalog
}

/** 工作区清单：给页面勾选（宿主服务是 workspaceRegistry）。 */
export function workspaceChoices(ctx) {
  const registry = service(ctx, 'workspaceRegistry')
  try {
    const rows = registry?.list?.() ?? []
    return rows
      .filter(row => typeof row?.path === 'string')
      .map(row => ({
        path: row.path,
        title: typeof row.title === 'string' && row.title !== '' ? row.title : row.path,
        sessions: Array.isArray(row.sessionIds) ? row.sessionIds.length : 0,
      }))
  } catch {
    return []
  }
}

const BOOLEAN_KEYS = ['enabled', 'allowNewGroups', 'correctMisplaced', 'collapseOwnWorkspace', 'dryRun']
const NUMERIC_KEYS = ['maxTokens', 'timeoutMs', 'concurrency', 'sweepMs', 'maxTitleBytes']
const STRING_KEYS = ['prompt', 'dailyProject']

/** 校验页面提交的补丁；不合法抛错（页面直接显示原文）。 */
export function validatePatch(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置必须是对象')
  const clean = {}
  for (const key of BOOLEAN_KEYS) {
    if (!(key in input)) continue
    if (typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
    clean[key] = input[key]
  }
  for (const key of NUMERIC_KEYS) {
    if (!(key in input)) continue
    const value = Number(input[key])
    if (!Number.isInteger(value) || value < 0) throw new Error(`${key} 必须是非负整数`)
    if (key === 'concurrency') clean[key] = Math.min(Math.max(value, 1), 8)
    else if (key === 'maxTitleBytes') clean[key] = Math.min(Math.max(value, 24), 200)
    else clean[key] = value
  }
  for (const key of STRING_KEYS) {
    if (!(key in input)) continue
    if (typeof input[key] !== 'string') throw new Error(`${key} 必须是字符串`)
    clean[key] = input[key]
  }
  if ('models' in input) {
    if (!Array.isArray(input.models)) throw new Error('models 必须是数组')
    clean.models = input.models.map(String).map(entry => {
      const parts = entry.split('/')
      if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
        throw new Error(`模型候选 "${entry}" 不合法，应为 provider/model`)
      }
      return entry
    })
  }
  if ('allowProviders' in input) {
    if (!Array.isArray(input.allowProviders)) throw new Error('allowProviders 必须是数组')
    clean.allowProviders = input.allowProviders.map(String)
  }
  if ('workspaces' in input) {
    if (!Array.isArray(input.workspaces)) throw new Error('workspaces 必须是数组')
    clean.workspaces = input.workspaces.map(String).map(entry => {
      if (!entry.startsWith('/')) throw new Error(`工作区必须是绝对路径：${entry}`)
      return entry
    })
  }
  return clean
}

/* ── 并发闸门 ───────────────────────────────────────────────── */

/** 简单信号量：同时最多 limit 个任务。 */
export function createLimiter(limit) {
  const max = Math.max(1, Number(limit) || 1)
  let active = 0
  const waiting = []
  const wake = () => {
    while (active < max && waiting.length > 0) {
      active += 1
      const run = waiting.shift()
      run()
    }
  }
  return task => new Promise((resolve, reject) => {
    waiting.push(() => {
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1
          wake()
        })
    })
    wake()
  })
}

/* ── 主流程 ──────────────────────────────────────────────────── */

const ROUTE_RUN = '/dsh-auto-session-groups/api/run'
const ROUTE_FORCE = '/dsh-auto-session-groups/api/force'
const ROUTE_STATE = '/dsh-auto-session-groups/api/state'
const ROUTE_CONFIG = '/dsh-auto-session-groups/api/config'

const FAILURE_COOLDOWN_MS = 10 * 60 * 1000
const FAILURE_COOLDOWN_LONG_MS = 30 * 60 * 1000
const FAILURE_RETRY_MAX = 3
const DECIDED_LIMIT = 500

export function apply(ctx, config) {
  const read = () => readConfig(config)
  const log = text => {
    try {
      ctx.logger?.info?.(text)
    } catch {
      /* logger 缺失不算错 */
    }
    console.log(text)
  }

  const cfg = read()
  if (!cfg.enabled) {
    log('[auto-session-groups] 已关闭（enabled=false）；设置里打开后无需重启')
  }

  /** 同一会话同一标题的判定结果：成功的永久记住；失败的带冷却，可以重试。 */
  const decided = new Map()
  const inFlight = new Set()
  let lastRun = null

  /**
   * 振荡保护：同一会话在窗口期内被改名的次数。
   *
   * 实测踩过：一条会话在「部署/cc-switch 本地部署」和「部署/cc-switch 部署」
   * 之间来回改了 74 次——模型每次给的 new_title 都略有不同，而插件每次都照改。
   * 现在同一会话在 OSCILLATION_WINDOW_MS 内改名超过 OSCILLATION_LIMIT 次就锁住，
   * 只记日志不再动它；强制整理可以解锁（用户显式要求）。
   */
  const renameHistory = new Map()
  const OSCILLATION_WINDOW_MS = 30 * 60 * 1000
  const OSCILLATION_LIMIT = 3

  const oscillationLocked = sessionId => {
    const stamps = (renameHistory.get(sessionId) ?? []).filter(at => Date.now() - at < OSCILLATION_WINDOW_MS)
    renameHistory.set(sessionId, stamps)
    return stamps.length >= OSCILLATION_LIMIT
  }
  const noteRename = sessionId => {
    const stamps = (renameHistory.get(sessionId) ?? []).filter(at => Date.now() - at < OSCILLATION_WINDOW_MS)
    stamps.push(Date.now())
    renameHistory.set(sessionId, stamps)
  }

  const rememberDecided = (key, value) => {
    if (decided.size >= DECIDED_LIMIT) {
      let oldestKey
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [candidate, entry] of decided) if (entry.at < oldestAt) { oldestAt = entry.at; oldestKey = candidate }
      if (oldestKey !== undefined) decided.delete(oldestKey)
    }
    decided.set(key, value)
  }

  /** 这条会话要不要参与：工作区过滤（空 = 全部）。 */
  const participating = session => {
    const current = read()
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return false
    if (current.workspaces.length === 0) return true
    return current.workspaces.includes(cwd)
  }

  /** 按并发数缓存的信号量（改设置后不用重建连接池）。 */
  const limiters = new Map()
  const limiterOf = concurrency => {
    const size = Math.max(1, Math.min(Number(concurrency) || 1, 8))
    if (!limiters.has(size)) limiters.set(size, createLimiter(size))
    return limiters.get(size)
  }

  /** 会话自己所在工作区的显示名（用于 collapseOwnWorkspace）。 */
  const ownWorkspaceName = (session, tree) => {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string') return undefined
    const hit = (tree?.workspaces ?? []).find(workspace => workspace.path === cwd)
    return hit?.name ?? baseName(cwd)
  }

  /**
   * 让模型给出归档决策。
   * @param force 强制整理：跳过结果缓存与失败冷却，一定重新问一次模型。
   */
  const decide = async (session, context, tree, force = false) => {
    const key = `${session?.id ?? '?'}::${context.title}`
    const cached = decided.get(key)
    if (!force) {
      if (cached?.decision !== undefined) return cached
      if (cached?.failures > 0) {
        const cooldown = cached.failures >= FAILURE_RETRY_MAX ? FAILURE_COOLDOWN_LONG_MS : FAILURE_COOLDOWN_MS
        if (Date.now() - cached.at < cooldown) {
          return { decision: undefined, by: `cooldown(${cached.failures} 次失败，稍后重试)` }
        }
      }
    }
    const current = read()
    try {
      const { decision, route, raw } = await classifyWithModel(ctx, session, context, current, tree)
      const result = {
        decision,
        by: `model:${route?.provider}/${route?.model}`,
        raw,
        at: Date.now(),
        failures: 0,
      }
      rememberDecided(key, result)
      return result
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const failures = (cached?.failures ?? 0) + 1
      rememberDecided(key, { decision: undefined, by: `model-failed(${failureKind(error)}: ${reason})`, at: Date.now(), failures })
      log(`[auto-session-groups] ${session?.id}: 归档失败第 ${failures} 次（${failureKind(error)}）：${reason}`)
      return { decision: undefined, by: `model-failed(${failureKind(error)}: ${reason})`, failures }
    }
  }

  /**
   * 处理一条会话。
   * @returns {Promise<undefined | {id: string, title: string, next?: string, by?: string, skipped?: string, failed?: string, planned?: boolean}>}
   */
  const settle = async (session, options = {}) => {
    if (!participating(session)) return undefined
    if (inFlight.has(session.id)) return undefined
    inFlight.add(session.id)
    try {
      const snapshot = ctx.sessionTitle?.get?.(session)
      const title = snapshot?.title
      if (typeof title !== 'string' || title.trim() === '') {
        return { id: session.id, title: '', skipped: '标题为空' }
      }
      const current = read()
      const force = options.force === true
      const classified = title.includes('/')
      if (classified && !current.correctMisplaced && !force) {
        return { id: session.id, title, skipped: '已归档（纠偏已关闭）' }
      }
      const context = contextOf(session)
      context.title = title
      context.currentPath = classified ? title : '未分类'
      const sessions = ctx.sessions?.list?.() ?? []
      const tree = buildWorkspaceTree(ctx, current, sessions)
      context.ownWorkspace = ownWorkspaceName(session, tree)
      const { decision, by, raw } = await decide(session, context, tree, force)
      if (decision === undefined) {
        // 冷却期不是「模型说不用归档」，单独标出来，别混进 ungrouped
        if (String(by).startsWith('cooldown')) {
          return { id: session.id, title, skipped: by, by }
        }
        log(`[auto-session-groups] ${session.id}: 不归档（模型回 ${JSON.stringify(String(raw ?? '').slice(0, 120))} · ${by}）`)
        return { id: session.id, title, by }
      }
      if (decision.needMove !== true && !force) {
        return { id: session.id, title, skipped: '分类已合理（need_move=false）', by }
      }
      const own = ownWorkspaceName(session, tree)
      // 一级目录守卫：不允许新建时，未知名字丢弃（只保留二级标签）
      let project = decision.project
      if (project !== undefined && current.allowNewGroups !== true) {
        const known = knownProjectNames(tree, own)
        if (!known.has(project)) {
          log(`[auto-session-groups] ${session.id}: 丢弃未知一级目录 "${project}"（allowNewGroups=false）`)
          project = undefined
        }
      }
      // 二级标签守卫：必须在词库里，且与一级目录的类别对得上
      let category = decision.category
      if (category !== undefined) {
        const vocab = rules().categories ?? {}
        const engineering = new Set(vocab.engineering ?? [])
        const daily = new Set(vocab.daily ?? [])
        const isDaily = project === undefined ? false : project === tree.dailyProject
        const allowed = isDaily ? daily : engineering
        if (!allowed.has(category)) {
          log(`[auto-session-groups] ${session.id}: 丢弃不合规二级标签 "${category}"`
            + `（${isDaily ? '日常' : '工程'}词库不含它）`)
          category = undefined
        }
      }
      if (category === undefined) {
        return { id: session.id, title, skipped: '模型没给出合规的二级标签', by }
      }
      const next = composeTitle(
        { ...decision, project, category },
        {
          ownWorkspace: own,
          collapseOwnWorkspace: current.collapseOwnWorkspace,
          fallbackTitle: title,
          maxBytes: current.maxTitleBytes,
        },
      )
      if (next === undefined) {
        return { id: session.id, title, skipped: '模型没给出可用的目录/标签', by }
      }
      if (next === title) {
        return { id: session.id, title, skipped: '无需改动', by }
      }
      // 振荡保护：短时间内反复改名就锁住（强制整理可解锁）
      if (!force && oscillationLocked(session.id)) {
        log(`[auto-session-groups] ${session.id}: 振荡保护，跳过（30 分钟内已改 ${OSCILLATION_LIMIT} 次）`)
        return { id: session.id, title, skipped: '振荡保护（短时间内改名过多）', by }
      }
      // 强制整理一律真改，不受 dryRun 影响
      const dryRun = force ? false : (options.dryRun ?? current.dryRun)
      if (dryRun) {
        log(`[auto-session-groups] 预演 ${session.id}: "${title}" → "${next}"  [${by}]`)
        return { id: session.id, title, next, by, planned: true }
      }
      ctx.sessionTitle.rename(session, next)
      noteRename(session.id)
      log(`[auto-session-groups] ${session.id}: "${title}" → "${next}"  [${by}]`)
      return { id: session.id, title, next, by }
    } catch (error) {
      log(`[auto-session-groups] skip ${session?.id}: ${error instanceof Error ? error.message : String(error)}`)
      return { id: session?.id, title: '', failed: error instanceof Error ? error.message : String(error) }
    } finally {
      inFlight.delete(session.id)
    }
  }

  /** 扫一遍参与工作区的会话，按并发闸门串起来。 */
  const sweepSessions = async (options = {}) => {
    const current = read()
    // 强制整理是用户显式动作，即使总开关关着也照做
    if (!current.enabled && options.force !== true) return { scanned: 0, results: [], disabled: true }
    let sessions = []
    try {
      sessions = ctx.sessions?.list?.() ?? []
    } catch (error) {
      log(`[auto-session-groups] 扫描失败: ${error instanceof Error ? error.message : String(error)}`)
      return { scanned: 0, results: [], error: error instanceof Error ? error.message : String(error) }
    }
    const mine = sessions.filter(participating)
    const limit = limiterOf(current.concurrency)
    const results = await Promise.all(mine.map(session => limit(() => settle(session, options))))
    return { scanned: mine.length, results: results.filter(entry => entry !== undefined), total: sessions.length }
  }

  // 会话事件挂在 agent 作用域，根 ctx 必须 global 才收得到
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    if (!read().enabled) return
    void sweepOne(session)
  }, { global: true })

  /** turn/end 只处理这一条（避免每轮都全量刷）。 */
  async function sweepOne(session) {
    const current = read()
    if (!current.enabled) return
    try {
      await limiterOf(current.concurrency)(() => settle(session))
    } catch (error) {
      log(`[auto-session-groups] turn/end 处理失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 兜底扫描：每 15 秒醒一次，按 sweepMs 门限决定要不要真扫
  let lastSweep = Date.now()
  let lastScanKey = ''
  const timer = setInterval(() => {
    const current = read()
    if (!current.enabled) return
    if (current.sweepMs <= 0) return
    if (Date.now() - lastSweep < current.sweepMs) return
    lastSweep = Date.now()
    void (async () => {
      const { scanned, results, total } = await sweepSessions()
      const key = `${total ?? 0}/${scanned}`
      if (key !== lastScanKey) {
        lastScanKey = key
        log(`[auto-session-groups] 扫描：活会话 ${total ?? '?'} 条，参与归档 ${scanned} 条`)
      }
      const renamed = results.filter(entry => entry.next !== undefined)
      if (renamed.length > 0) log(`[auto-session-groups] 兜底扫描归档 ${renamed.length} 条`)
    })()
  }, 15000)
  ctx.effect(() => () => clearInterval(timer))

  /* ── HTTP：设置读写 + 立即整理（全部 loopback-only） ────────── */

  const webServer = ctx.webServer ?? service(ctx, 'webServer')
  if (typeof webServer?.register === 'function') {
    const loopbackOnly = (req, res) => {
      const address = req.socket?.remoteAddress ?? ''
      const ok = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
      if (!ok) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('loopback only')
      }
      return ok
    }
    const sendJson = (res, code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const readBody = async req => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return {}
      return JSON.parse(text)
    }

    // 读：当前配置 + 模型目录 + 工作区 + 提示词 + 上次整理结果
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_STATE,
      async handler(req, res) {
        if (!loopbackOnly(req, res)) return
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        try {
          const current = read()
          const sessions = ctx.sessions?.list?.() ?? []
          return sendJson(res, 200, {
            ok: true,
            config: current,
            prompt: effectivePrompt(current),
            defaultPrompt: String(rules().prompt ?? ''),
            categories: rules().categories ?? {},
            placeholders: rules().placeholders ?? {},
            tree: buildWorkspaceTree(ctx, current, sessions),
            providers: await modelCatalog(ctx),
            workspaces: workspaceChoices(ctx),
            entryId: ctx?.fiber?.entry?.options?.id ?? null,
            writable: service(ctx, 'configEditor') !== undefined,
            lastRun,
          })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'auto-session-groups: state')

    // 写：改行 config（persist 到 profile 的插件 config，volatile 原地生效）
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_CONFIG,
      async handler(req, res) {
        if (!loopbackOnly(req, res)) return
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        try {
          const editor = service(ctx, 'configEditor')
          const entry = ctx?.fiber?.entry
          if (editor === undefined || entry === undefined) {
            return sendJson(res, 503, { ok: false, error: '这个 profile 不接受配置写入（configEditor 不可用）' })
          }
          const patch = validatePatch(await readBody(req))
          await editor.edit(entry, current => ({ ...current, ...patch }))
          const current = read()
          log(`[auto-session-groups] 设置已保存: ${JSON.stringify({
            models: current.models,
            workspaces: current.workspaces,
            promptChars: effectivePrompt(current).length,
            dailyProject: current.dailyProject,
            correctMisplaced: current.correctMisplaced,
            dryRun: current.dryRun,
            concurrency: current.concurrency,
          })}`)
          return sendJson(res, 200, { ok: true, config: current, saved: Object.keys(patch) })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'auto-session-groups: config')

    /** 把 settle 结果分成五类，两个整理端点共用。 */
    const summarise = (scanned, results) => {
      const renamed = results.filter(entry => entry.next !== undefined && entry.planned !== true)
      const plans = results.filter(entry => entry.planned === true)
      const skipped = results.filter(entry => entry.skipped !== undefined)
      const ungrouped = results.filter(entry => entry.skipped === undefined && entry.next === undefined && entry.failed === undefined)
      const failed = results.filter(entry => entry.failed !== undefined)
      return { scanned, renamed, plans, skipped, ungrouped, failed }
    }

    /** 两个整理端点共用的执行体。 */
    const runOrganise = async (req, res, { force }) => {
      if (!loopbackOnly(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      try {
        let body = {}
        try {
          body = await readBody(req)
        } catch {
          body = {}
        }
        const options = { force }
        if (!force && (body?.dryRun === true || body?.dryRun === false)) options.dryRun = body.dryRun
        const { scanned, results, disabled, error } = await sweepSessions(options)
        if (disabled === true) return sendJson(res, 409, { ok: false, error: '插件已关闭（enabled=false）' })
        if (error !== undefined) return sendJson(res, 500, { ok: false, error })
        const summary = summarise(scanned, results)
        lastRun = {
          at: Date.now(),
          force,
          scanned,
          renamed: summary.renamed.length,
          planned: summary.plans.length,
          skipped: summary.skipped.length,
          failed: summary.failed.length,
        }
        log(`[auto-session-groups] ${force ? '强制整理' : '手动整理'}：扫 ${scanned} 条，改 ${summary.renamed.length} 条`
          + `${summary.plans.length > 0 ? `，预演 ${summary.plans.length} 条` : ''}`
          + `${summary.skipped.length > 0 ? `，跳过 ${summary.skipped.length} 条` : ''}`
          + `${summary.failed.length > 0 ? `，失败 ${summary.failed.length} 条` : ''}`)
        return sendJson(res, 200, { ok: true, force, ...summary })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }

    // 立即整理：跑一遍并回报结果（支持预演）
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_RUN,
      handler: (req, res) => runOrganise(req, res, { force: false }),
    }), 'auto-session-groups: run')

    // 强制整理：忽略缓存/冷却/纠偏开关/need_move/预演，一律重新问模型并真改
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_FORCE,
      handler: (req, res) => runOrganise(req, res, { force: true }),
    }), 'auto-session-groups: force')

    log(`[auto-session-groups] 设置接口：GET ${ROUTE_STATE} · POST ${ROUTE_CONFIG} · POST ${ROUTE_RUN} · POST ${ROUTE_FORCE}`)
  } else {
    log('[auto-session-groups] webServer 不可用：设置页与「立即整理」按钮都会失效')
  }

  const initial = read()
  log(
    `[auto-session-groups] 已挂载 rules v${rules().version ?? '?'} · 提示词归档 · `
    + `模型 ${initial.models.join(' , ') || '(跟随会话)'} · `
    + `工作区 ${initial.workspaces.join(' , ') || '(全部工作区)'} · `
    + `提示词 ${effectivePrompt(initial).length} 字${initial.prompt.trim() === '' ? '（默认）' : '（自定义）'} · `
    + `日常目录 ${initial.dailyProject} · 纠偏 ${initial.correctMisplaced ? '开' : '关'} · `
    + `并发 ${initial.concurrency} · 预演 ${initial.dryRun ? '开' : '关'} · `
    + `设置卡片 ${Config === undefined ? `无（${schemaFailures.join(' | ') || '未找到候选根'}）` : `有（root=${schemaRoot}）`}`,
  )

  // 旧 settings.json 一次性迁移（失败只记日志，不影响其它功能）
  void migrateLegacySettings(ctx, log).catch(() => {})
}
