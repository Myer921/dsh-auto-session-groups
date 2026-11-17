/**
 * dsh-auto-session-groups 离线夹具（v0.7 提示词归档版）
 *
 * 假 ctx 真跑 apply()：验证提示词渲染、JSON 决策解析、标题拼装、
 * 纠偏开关、一级目录守卫、预演、失败冷却、设置写入、迁移、loopback。
 *
 * 运行：node test/smoke.mjs
 */

import { pathToFileURL } from 'node:url'
import { readdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'

const PLUGIN = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const mod = await import(pathToFileURL(`${PLUGIN}/lib/index.js`).href)

const fail = []
let pass = 0
function ok(name, condition, detail) {
  if (condition) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail.push(name); console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/* ── 配置存储（volatile 引用） ─────────────────────────── */
const store = {
  enabled: true,
  models: [],
  allowProviders: [],
  workspaces: [],
  prompt: '',
  dailyProject: '日常通用',
  allowNewGroups: false,
  correctMisplaced: true,
  collapseOwnWorkspace: true,
  maxTitleBytes: 76,
  maxTokens: 1536,
  timeoutMs: 20000,
  concurrency: 2,
  sweepMs: 0,
  dryRun: false,
}
const ref = key => ({ get: () => store[key] })
const config = new Proxy({}, { get: (_, key) => (key in store ? ref(key) : undefined) })

/* ── 会话 ─────────────────────────────────────────────── */
function makeSession(id, title, cwd = '/tmp/wsA') {
  return {
    id,
    header: { title, cwd },
    snapshotEvents: () => [
      { type: 'user/message', data: { content: [{ type: 'text', text: `${title} 的具体内容` }] } },
    ],
  }
}

const sessions = [
  makeSession('s1', '花屏问题排查'),
  makeSession('s2', '编译不过'),
  makeSession('s3', '旧项目/修复/已归档标题'),
  makeSession('s4', '今天吃什么'),
]
const renames = []
const routes = new Map()
let llmCalls = 0
let llmMode = 'ok'
let oscCount = 0
let lastSystem = ''
let lastMessages = []

const editor = { edit: async (entry, change) => { Object.assign(store, change({ ...store })) } }
const registry = {
  list: () => [
    { id: 'w1', path: '/tmp/wsA', title: 'wsA', sessionIds: ['s1', 's2', 's3', 's4'] },
    { id: 'w2', path: '/tmp/wsB', title: 'wsB', sessionIds: [] },
  ],
}

const ctx = {
  logger: { info: () => {} },
  fiber: { entry: { options: { id: 'auto-session-groups' } } },
  on: () => () => {},
  effect: fn => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
  get: key => (key === 'configEditor' ? editor : key === 'workspaceRegistry' ? registry : undefined),
  sessions: { list: () => sessions },
  sessionTitle: {
    get: session => ({ title: session.header.title }),
    rename: (session, title) => { renames.push([session.id, title]); session.header.title = title; return { title } },
  },
  sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: { provider: 'p-live', model: 'm-a' } } } }) },
  llm: {
    listProviders: () => [{ id: 'p-live' }, { id: 'p-dead' }],
    listModels: async id => (id === 'p-live' ? [{ id: 'm-a', name: 'M A' }] : []),
    stream: options => {
      llmCalls += 1
      lastSystem = options.system
      lastMessages = options.messages
      // 夹具按会话内容给不同决策（真模型也是这么干的）
      const seen = options.messages.map(m => m.content.map(c => c.text ?? '').join('')).join('\n')
      const pick = text => {
        if (text.includes('今天吃什么')) return '{"need_move":true,"target_project":"日常通用","target_category":"咨询","new_title":"吃什么","confidence":0.9}'
        if (text.includes('编译不过')) return '{"need_move":true,"target_project":"wsA","target_category":"修复","new_title":"编译报错","confidence":0.9}'
        if (text.includes('已归档标题')) return '{"need_move":false,"target_project":"旧项目","target_category":"修复","new_title":"已归档标题","confidence":0.95}'
        return '{"need_move":true,"target_project":"wsA","target_category":"修复","new_title":"花屏定位","confidence":0.95}'
      }
      return (async function* () {
        if (llmMode === 'throw') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'boom', message: '假装挂了' } } }
          return
        }
        if (llmMode === 'garbage') {
          yield { type: 'text-delta', text: '我觉得应该放到修复里' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (llmMode === 'fenced') {
          yield { type: 'text-delta', text: '```json\n{"need_move":true,"target_project":"wsA","target_category":"修复","new_title":"花屏定位","confidence":0.9}\n```' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (llmMode === 'nomove') {
          yield { type: 'text-delta', text: '{"need_move":false,"target_project":"wsA","target_category":"修复","new_title":"x","confidence":0.9}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (llmMode === 'crossws') {
          // 模型想把 AndroidDev 的会话塞进 Arm64-INIT
          yield { type: 'text-delta', text: '{"need_move":true,"target_project":"Arm64-INIT","target_category":"调研","new_title":"跨区错位","confidence":0.9}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (llmMode === 'wrongcat') {
          // 日常目录下用了工程标签
          yield { type: 'text-delta', text: '{"need_move":true,"target_project":"日常通用","target_category":"部署","new_title":"日常里塞部署","confidence":0.9}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (llmMode === 'badcat') {
          // 标签根本不在任何词库
          yield { type: 'text-delta', text: '{"need_move":true,"target_project":"wsA","target_category":"查问题","new_title":"旧词表残留","confidence":0.9}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (llmMode === 'oscillate') {
          // 每次给一个略不同的标题，模拟振荡
          oscCount += 1
          yield { type: 'text-delta', text: `{"need_move":true,"target_project":"wsA","target_category":"修复","new_title":"振荡标题${oscCount}","confidence":0.9}` }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (llmMode === 'newproject') {
          yield { type: 'text-delta', text: '{"need_move":true,"target_project":"全新项目","target_category":"开发","new_title":"新东西","confidence":0.8}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', text: pick(seen) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  },
  webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
}

/* ── 纯函数单测 ───────────────────────────────────────── */
console.log('\n[1] 纯函数')
ok('renderPrompt 替换占位符',
  mod.renderPrompt('A{{X}}B{{Y}}', { X: '1', Y: '2' }) === 'A1B2')
ok('renderPrompt 未知占位符原样保留',
  mod.renderPrompt('A{{NOPE}}B', { X: '1' }) === 'A{{NOPE}}B')
ok('parseDecision 纯 JSON',
  mod.parseDecision('{"need_move":true,"target_project":"wsA","target_category":"修复","new_title":"花屏","confidence":0.9}')?.project === 'wsA')
ok('parseDecision 带 ```json 围栏',
  mod.parseDecision('```json\n{"need_move":true,"target_project":"p","target_category":"c","new_title":"t"}\n```')?.project === 'p')
ok('parseDecision 前后有废话也能抠出来',
  mod.parseDecision('好的，结果如下：{"need_move":false} 以上。')?.needMove === false)
ok('parseDecision 非 JSON 返回 undefined',
  mod.parseDecision('我觉得应该放到修复里') === undefined)
ok('parseDecision 字符串里的花括号不干扰',
  mod.parseDecision('{"need_move":true,"new_title":"含 } 的标题","target_category":"修复"}')?.title === '含 } 的标题')
ok('parseDecision confidence 夹到 0..1',
  mod.parseDecision('{"need_move":true,"confidence":5}')?.confidence === 1)
ok('cleanSegment 拒绝含 / 的名字', mod.cleanSegment('a/b') === undefined)
ok('cleanSegment 去引号', mod.cleanSegment('「修复」') === '修复')
ok('cleanSegment 拒绝超长', mod.cleanSegment('一'.repeat(30)) === undefined)

ok('composeTitle 三段拼装',
  mod.composeTitle({ project: 'P', category: '修复', title: '花屏' }, { ownWorkspace: 'wsA', maxBytes: 76 }) === 'P/修复/花屏')
ok('composeTitle 与自身工作区同名时折叠',
  mod.composeTitle({ project: 'wsA', category: '修复', title: '花屏' }, { ownWorkspace: 'wsA', collapseOwnWorkspace: true, maxBytes: 76 }) === '修复/花屏')
ok('composeTitle 关掉折叠就保留',
  mod.composeTitle({ project: 'wsA', category: '修复', title: '花屏' }, { ownWorkspace: 'wsA', collapseOwnWorkspace: false, maxBytes: 76 }) === 'wsA/修复/花屏')
ok('composeTitle 没有 new_title 时退回原标题',
  mod.composeTitle({ project: 'P', category: '修复' }, { fallbackTitle: '原标题', maxBytes: 76 }) === 'P/修复/原标题')
ok('composeTitle 遵守字节上限',
  Buffer.byteLength(mod.composeTitle({ project: 'P', category: '修复', title: '很长的标题'.repeat(20) }, { maxBytes: 40 }) ?? '', 'utf8') <= 40)
ok('composeTitle 没有目录/标签返回 undefined',
  mod.composeTitle({ title: 'x' }, { maxBytes: 76 }) === undefined)
ok('truncateUtf8 不切坏码点',
  mod.truncateUtf8('鲸鱼娘', 7) === '鲸鱼')

/* ── 路由注册 ─────────────────────────────────────────── */
console.log('\n[2] apply 注册')
mod.apply(ctx, config)
ok('state 路由', routes.has('/dsh-auto-session-groups/api/state'))
ok('config 路由', routes.has('/dsh-auto-session-groups/api/config'))
ok('run 路由', routes.has('/dsh-auto-session-groups/api/run'))
ok('force 路由', routes.has('/dsh-auto-session-groups/api/force'))
ok('Config 非 null', mod.Config !== undefined)

function fakeReq(method, body = '{}', address = '127.0.0.1') {
  return {
    method,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
  }
}
function fakeRes() {
  const out = { code: 0, body: '', headers: {} }
  return {
    out,
    writeHead(code, headers) { out.code = code; out.headers = headers ?? {} },
    end(text) { out.body = text ?? '' },
  }
}
async function call(path, method, body, address) {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`没有路由 ${path}`)
  const res = fakeRes()
  await route.handler(fakeReq(method, body, address), res)
  let json
  try { json = JSON.parse(res.out.body) } catch { json = undefined }
  return { code: res.out.code, json, text: res.out.body }
}

/* ── state ────────────────────────────────────────────── */
console.log('\n[3] GET /api/state')
const state = await call('/dsh-auto-session-groups/api/state', 'GET')
if (state.code !== 200) console.log('    DEBUG state:', state.code, String(state.text).slice(0, 300))
ok('200', state.code === 200)
ok('writable=true（Proxy 抛错也能拿到 configEditor）', state.json.writable === true)
ok('workspaces 非空', (state.json.workspaces ?? []).length === 2)
ok('tree 含工作区名', (state.json.tree?.workspaces ?? []).some(w => w.name === 'wsA'))
// 新行为：只把「本工作区名」和「日常目录」记成合法一级目录。
// s3 的标题是「旧项目/修复/已归档标题」——旧项目既不是 wsA 也不是日常通用，
// 所以它不该再被喂回模型（否则错误自我强化）。
ok('tree 不再把跨区/历史错位分组当合法',
  !(state.json.tree?.workspaces ?? []).some(w => (w.groups ?? []).includes('旧项目')))
// 夹具里没有以 wsA/ 开头的会话，所以 groups 里不该出现 wsA；
// 真正要验的是「groups 只含本工作区名或日常目录」这条不变式。
const allGroups = (state.json.tree?.workspaces ?? []).flatMap(w => w.groups ?? [])
ok('tree 的 groups 只含本工作区名或日常目录',
  allGroups.every(g => g === 'wsA' || g === 'wsB' || g === '日常通用'),
  JSON.stringify(allGroups))
ok('prompt 非空（默认提示词）', typeof state.json.prompt === 'string' && state.json.prompt.length > 100)
ok('defaultPrompt 与 prompt 一致（未自定义）', state.json.defaultPrompt === state.json.prompt)
ok('categories 有工程与日常词库',
  (state.json.categories?.engineering ?? []).length === 6 && (state.json.categories?.daily ?? []).length === 5)
ok('placeholders 有三个', Object.keys(state.json.placeholders ?? {}).length === 3)

/* ── 主路径：归档 ─────────────────────────────────────── */
console.log('\n[4] POST /api/run 归档主路径')
const run1 = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
ok('200', run1.code === 200)
ok('扫到 4 条', run1.json.scanned === 4)
ok('改了 3 条（s3 已归档且分类合理→跳过）', (run1.json.renamed ?? []).length === 3, JSON.stringify(run1.json.renamed?.map(r => r.next)))
ok('s1 折叠自身工作区 → 修复/花屏定位',
  renames.some(([id, t]) => id === 's1' && t === '修复/花屏定位'), JSON.stringify(renames))
ok('提示词里注入了工作区树', lastSystem.includes('"workspaces"') && lastSystem.includes('wsA'))
ok('提示词里注入了会话摘录（模板没写 {{SESSION_CONTEXT}} 时走 user 消息）',
  lastMessages[0].content[0].text.includes('current_path'))
ok('提示词里没有残留占位符', !lastSystem.includes('{{WORKSPACE_TREE_JSON}}'))

/* ── 已归档 + 纠偏 ────────────────────────────────────── */
console.log('\n[5] 纠偏开关')
const before = renames.length
store.correctMisplaced = false
const run2 = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
ok('纠偏关闭时 s3 被跳过',
  (run2.json.skipped ?? []).some(entry => entry.id === 's3' && String(entry.skipped).includes('纠偏已关闭')))
ok('纠偏关闭时不产生新改名', renames.length === before)
store.correctMisplaced = true

/* ── 预演 ─────────────────────────────────────────────── */
console.log('\n[6] 预演')
sessions[0].header.title = '花屏问题排查-预演'
const beforeDry = renames.length
const run3 = await call('/dsh-auto-session-groups/api/run', 'POST', '{"dryRun":true}')
ok('预演有 plans', (run3.json.plans ?? []).length > 0)
ok('预演不改名', renames.length === beforeDry)

/* ── need_move=false ──────────────────────────────────── */
console.log('\n[7] need_move=false')
llmMode = 'nomove'
sessions[0].header.title = '花屏问题排查-不动'
const run4 = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
ok('need_move=false 进 skipped',
  (run4.json.skipped ?? []).some(entry => String(entry.skipped).includes('need_move=false')))
llmMode = 'ok'

/* ── 一级目录守卫 ─────────────────────────────────────── */
console.log('\n[8] 一级目录守卫')
llmMode = 'newproject'
store.allowNewGroups = false
sessions[1].header.title = '编译不过-守卫A'
const run5 = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
const s2 = (run5.json.renamed ?? []).find(entry => entry.id === 's2')
ok('allowNewGroups=false 时未知一级目录被丢弃', s2 !== undefined && !String(s2.next).startsWith('全新项目'), JSON.stringify(s2))
store.allowNewGroups = true
sessions[1].header.title = '编译不过-守卫B'
const run6 = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
const s2b = (run6.json.renamed ?? []).find(entry => entry.id === 's2')
ok('allowNewGroups=true 时允许新目录', s2b !== undefined && String(s2b.next).startsWith('全新项目'), JSON.stringify(s2b))
store.allowNewGroups = false
llmMode = 'ok'

/* ── 跨工作区 / 标签词库 / 振荡 ─────────────────────── */
console.log('\n[8b] 跨工作区与标签守卫')

// 跨工作区错位：wsA 的会话想进 wsB（另一个工作区名）
llmMode = 'crossws'
store.allowNewGroups = false
sessions[1].header.title = '编译不过-跨区'
const runX = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
const sx = (runX.json.renamed ?? []).find(entry => entry.id === 's2')
ok('跨工作区的一级目录被丢弃（不出现 wsB）',
  sx === undefined || !String(sx.next).startsWith('wsB'), JSON.stringify(sx))

// 日常目录下用工程标签
llmMode = 'wrongcat'
sessions[3].header.title = '今天吃什么-错标签'
const runY = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
const sy = (runY.json.renamed ?? []).find(entry => entry.id === 's4')
ok('日常目录下用工程标签被拒',
  sy === undefined || !String(sy.next).includes('日常通用/部署'), JSON.stringify(sy))

// 标签不在任何词库
llmMode = 'badcat'
sessions[0].header.title = '花屏问题排查-坏标签'
const runZ = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
const sz = (runZ.json.renamed ?? []).find(entry => entry.id === 's1')
ok('不在词库的二级标签被拒',
  sz === undefined || !String(sz.next).includes('查问题'), JSON.stringify(sz))
ok('被拒时进 skipped 并说明原因',
  (runZ.json.skipped ?? []).some(entry => String(entry.skipped).includes('合规的二级标签')))

// 振荡保护：连续改名 3 次后锁住
llmMode = 'oscillate'
oscCount = 0
sessions[2].header.title = '振荡测试'
const oscResults = []
for (let i = 0; i < 5; i += 1) {
  const r = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
  oscResults.push(r)
}
const oscRenamed = oscResults.reduce((n, r) => n + (r.json.renamed ?? []).filter(e => e.id === 's3').length, 0)
ok('振荡保护：5 次整理最多只改 3 次', oscRenamed <= 3, `实际改了 ${oscRenamed} 次`)
ok('振荡保护：锁住后进 skipped',
  oscResults.some(r => (r.json.skipped ?? []).some(e => String(e.skipped).includes('振荡保护'))))
llmMode = 'ok'

/* ── 失败与冷却 ───────────────────────────────────────── */
console.log('\n[9] 失败与冷却')
llmMode = 'throw'
sessions[0].header.title = '花屏问题排查-失败'
const beforeFail = renames.length
const run7 = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
ok('失败不改名', renames.length === beforeFail)
const callsAfterFail = llmCalls
const run8 = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
ok('冷却期内不再调模型', llmCalls === callsAfterFail, `${callsAfterFail} → ${llmCalls}`)
ok('冷却原因进 skipped', (run8.json.skipped ?? []).some(entry => String(entry.skipped).includes('cooldown')))

llmMode = 'garbage'
sessions[1].header.title = '编译不过-垃圾输出'
const run9 = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
ok('非 JSON 输出被记为失败', (run9.json.failed ?? []).length > 0 || (run9.json.skipped ?? []).length > 0)

llmMode = 'fenced'
sessions[3].header.title = '今天吃什么-围栏'
const run10 = await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
ok('```json 围栏也能解析', (run10.json.renamed ?? []).some(entry => entry.id === 's4'))
llmMode = 'ok'

/* ── 设置写入 ─────────────────────────────────────────── */
console.log('\n[10] POST /api/config')
const saved = await call('/dsh-auto-session-groups/api/config', 'POST', JSON.stringify({
  models: ['p-live/m-a'],
  concurrency: 3,
  prompt: '自定义提示词 {{WORKSPACE_TREE_JSON}}',
  dailyProject: '日常',
  correctMisplaced: false,
  collapseOwnWorkspace: false,
  maxTitleBytes: 60,
}))
ok('200', saved.code === 200, saved.text)
ok('models 落盘', JSON.stringify(store.models) === JSON.stringify(['p-live/m-a']))
ok('concurrency 落盘', store.concurrency === 3)
ok('prompt 落盘', store.prompt.includes('自定义提示词'))
ok('dailyProject 落盘', store.dailyProject === '日常')
ok('correctMisplaced 落盘', store.correctMisplaced === false)
ok('maxTitleBytes 落盘', store.maxTitleBytes === 60)

const bad = await call('/dsh-auto-session-groups/api/config', 'POST', JSON.stringify({ models: ['没有斜杠'] }))
ok('坏补丁 400', bad.code === 400)
const badNum = await call('/dsh-auto-session-groups/api/config', 'POST', JSON.stringify({ concurrency: -1 }))
ok('负数 400', badNum.code === 400)
const badType = await call('/dsh-auto-session-groups/api/config', 'POST', JSON.stringify({ prompt: 123 }))
ok('prompt 非字符串 400', badType.code === 400)

/* ── 自定义提示词生效 ─────────────────────────────────── */
console.log('\n[11] 自定义提示词生效')
sessions[0].header.title = '花屏问题排查-自定义提示词'
await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
ok('自定义提示词被使用', lastSystem.startsWith('自定义提示词'))
ok('自定义提示词里的占位符被替换', !lastSystem.includes('{{WORKSPACE_TREE_JSON}}'))

/* ── 强制整理 ─────────────────────────────────────────── */
console.log('\n[11b] 强制整理 /api/force')
store.correctMisplaced = false
store.dryRun = true
store.enabled = false
store.prompt = ''
sessions[0].header.title = '花屏问题排查'
sessions[2].header.title = '旧项目/修复/已归档标题'
const beforeForce = renames.length
const callsBeforeForce = llmCalls
const force1 = await call('/dsh-auto-session-groups/api/force', 'POST', '{}')
ok('强制整理 200（总开关关着也照做）', force1.code === 200, force1.text)
ok('强制整理 force=true', force1.json.force === true)
ok('强制整理绕过纠偏开关（已归档的也被重问）', llmCalls > callsBeforeForce, `${callsBeforeForce} → ${llmCalls}`)
ok('强制整理绕过 dryRun（真的改名）', renames.length > beforeForce, `${beforeForce} → ${renames.length}`)
ok('强制整理不受 need_move=false 阻挡',
  (force1.json.renamed ?? []).length > 0, JSON.stringify((force1.json.renamed ?? []).map(r => r.next)))
ok('强制整理没有 plans（不预演）', (force1.json.plans ?? []).length === 0)

// 冷却期内强制整理仍会重问
llmMode = 'throw'
sessions[1].header.title = '编译不过'
await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
const callsAfterCooldown = llmCalls
const force2 = await call('/dsh-auto-session-groups/api/force', 'POST', '{}')
ok('冷却期内强制整理仍重问模型', llmCalls > callsAfterCooldown, `${callsAfterCooldown} → ${llmCalls}`)
llmMode = 'ok'

// 缓存命中时普通整理不重问，强制整理重问
store.enabled = true
store.dryRun = false
store.correctMisplaced = true
sessions[0].header.title = '花屏问题排查'
await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
const callsCached = llmCalls
await call('/dsh-auto-session-groups/api/run', 'POST', '{}')
ok('普通整理命中缓存不重问', llmCalls === callsCached, `${callsCached} → ${llmCalls}`)
sessions[0].header.title = '花屏问题排查'
await call('/dsh-auto-session-groups/api/force', 'POST', '{}')
ok('强制整理忽略缓存重问', llmCalls > callsCached, `${callsCached} → ${llmCalls}`)

const forceRemote = await call('/dsh-auto-session-groups/api/force', 'POST', '{}', '10.0.0.5')
ok('强制整理非 loopback 403', forceRemote.code === 403)
const forceGet = await call('/dsh-auto-session-groups/api/force', 'GET')
ok('GET /api/force 405', forceGet.code === 405)

/* ── loopback / 方法 ──────────────────────────────────── */
console.log('\n[12] 安全与方法')
const remote = await call('/dsh-auto-session-groups/api/state', 'GET', undefined, '10.0.0.5')
ok('非 loopback 403', remote.code === 403)
const wrongMethod = await call('/dsh-auto-session-groups/api/config', 'GET')
ok('GET /api/config 405', wrongMethod.code === 405)
const wrongMethod2 = await call('/dsh-auto-session-groups/api/run', 'GET')
ok('GET /api/run 405', wrongMethod2.code === 405)

/* ── 迁移 ─────────────────────────────────────────────── */
console.log('\n[13] settings.json 迁移')
const legacyPath = `${PLUGIN}/lib/settings.json`
writeFileSync(legacyPath, JSON.stringify({ concurrency: 5, prompt: '旧提示词' }))
const migrated = await mod.migrateLegacySettings(ctx, () => {})
ok('迁移返回 true', migrated === true)
ok('原文件已改名', !existsSync(legacyPath))
ok('值已进行 config', store.concurrency === 5 && store.prompt === '旧提示词')
const leftovers = readdirSync(`${PLUGIN}/lib`).filter(name => name.startsWith('settings.json.migrated-'))
for (const name of leftovers) unlinkSync(`${PLUGIN}/lib/${name}`)
console.log(`  · 夹具残留清理：${leftovers.length} 个 .migrated 文件已删除`)

/* ── 结果 ─────────────────────────────────────────────── */
console.log(`\n结果：${pass} 通过，${fail.length} 失败`)
if (fail.length > 0) {
  console.log('失败项：')
  for (const name of fail) console.log(`  - ${name}`)
  process.exitCode = 1
}
