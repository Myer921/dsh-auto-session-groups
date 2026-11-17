# dsh-auto-session-groups

按**会话内容**智能归档：每轮答完（或点一次「智能整理」/定时兜底扫描），把**提示词**
连同「当前工作区树」一起交给模型，模型返回一个 JSON 决策，插件据此把标题写成
`一级目录/二级标签/标题`（如 `修复/花屏定位`、`日常通用/咨询/吃什么`）。
侧栏 **dsh-better-workspace** 按 `/` 把它渲染成**该工作区内部的嵌套会话分组**——
分组只发生在工作区里面，不动工作区结构。

## 提示词驱动（这一版的核心）

归档规则**全部写在提示词里**，不是硬编码的关键词表。默认提示词在 `lib/rules.json`
的 `prompt` 字段，可在设置页整段改写。

模板支持三个占位符：

| 占位符 | 注入内容 |
|---|---|
| `{{WORKSPACE_TREE_JSON}}` | 当前工作区树：每个工作区的名字、路径、会话数、**已有分组与标签**（让模型优先复用而不是另起新名） |
| `{{SESSION_CONTEXT}}` | 本条会话摘录（标题 + `current_path` + 前 3 条用户消息 + 最近一条） |
| `{{DAILY_PROJECT}}` | 日常类会话统一归入的一级目录名（跟随设置里的「日常目录」） |

模板里没写 `{{SESSION_CONTEXT}}` 时，摘录会作为 user 消息单独发——两种写法都行。

模型必须返回纯 JSON：

```json
{
  "need_move": true,
  "target_project": "一级目录名称",
  "target_category": "二级标签名称",
  "new_title": "10字以内的简短摘要标题",
  "confidence": 0.95
}
```

解析器容忍 ```` ```json ```` 围栏、前后废话、字符串里的花括号；不是合法 JSON 就记
`bad-json` 失败，**不动标题**。

## 设置在哪（全部在 DSH 自己里面）

| 入口 | 路径 |
|---|---|
| 设置页 | 设置 → 插件 → **智能整理**（`settings.plugins.tab`） |
| 插件行配置 | 插件面板 → 本插件那一行 → 配置（`plugins.row.config`，key = `@local/dsh-auto-session-groups#auto-session-groups`） |

两个入口是**同一个组件**。页面上能改：

- **归档提示词**：整段可编辑的 textarea，带「＋ 插入占位符」按钮与「恢复默认」；
  留空 = 用 `lib/rules.json` 的默认提示词。页面底部显示工程/日常两套词库供参考。
- **分类模型**：provider / model 下拉（列的是当前真正注册着的 provider 与模型）→ 加入候选；
  候选有序，第一个能用的胜出；**留空 = 跟随每个会话自己选的模型**（失效时回落到部署默认模型）。
- **参与归档的工作区**：勾选；**一个都不勾 = 全部工作区**。
- **行为**：启用开关、允许模型新建一级目录、允许纠正已归档会话、一级目录与工作区同名时折叠、
  预演（只算不改）、日常目录名、`maxTokens` / `timeoutMs` / `concurrency`（1–8 并发闸门）/
  `sweepMs`（兜底扫描间隔，0 = 关）/ `maxTitleBytes`（标题字节上限，≤200）。
- **立即整理** / **预演一次**：跑一遍并列出「改了几条、预演几条、跳过几条、哪条失败」。

保存后**不需要重启 DSH、也不需要关开插件行**：所有 Config 字段都是 `.volatile()`，
写入走 `ctx.configEditor`（落到 profile 的插件 config），Loader 原地更新引用。

没有任何独立设置页、没有第二份状态文件。旧版本的 `lib/settings.json` 只在挂载时被
**一次性迁进**行 config，然后改名成 `settings.json.migrated-<时间戳>`。

## 归档规则（默认提示词做的事）

1. **一级目录**：工程/专项优先匹配工作区树里已有的项目名；日常类（办公、生活、常识、
   翻译、闲聊）统一归入 `日常通用`（可在设置里改名），**严禁新建零散目录**。
2. **二级标签**：工程侧 `开发/修复/部署/整理/调研/自省`，日常侧 `咨询/写作/规划/分析/闲聊`。
3. **纠偏与最小改动**：当前分类合理就 `need_move: false`；只有未分类或明显错位才移动。

插件侧的守卫（不依赖模型自觉）：

- `allowNewGroups=false` 时，模型给的一级目录若不在「工作区名 ∪ 已有分组 ∪ 日常目录」里，
  **丢弃这一层**，只保留二级标签，并记日志。
- `collapseOwnWorkspace=true` 时，一级目录与会话所在工作区同名就省掉这一层
  （工作区本身已经显示了，再套一层是重复）。
- `correctMisplaced=false` 时，标题已含 `/` 的一律不动。
- 拼出来的标题按 `maxTitleBytes` 截断（session-title 服务硬上限 80 字节）。

## 和 better-workspace 的契约（不改对方一行代码）

- 只用 `ctx.sessionTitle.rename(session, '一级/二级/标题')` 写标题，事件来源是 `user`——
  better-workspace 的 `groupsAllowedFor()` 只认 `user` / 未记录，所以它会放行成组。
- 依赖它默认打开的 `sessionTitleSlash`（把会话标题里的 `/` 拆成层级）。
- 标题为空跳过；标题已含 `/` 时按 `correctMisplaced` 决定动不动。

## 行为边界

- 同一会话同一标题成功判定一次就记住；**失败带冷却**（10 分钟，连续 3 次失败后 30 分钟），
  冷却期内的会话进 `skipped` 而不是 `ungrouped`，不会每轮重试烧额度。
- 归档请求有并发闸门（默认 2），sweep/手动/事件三条路共用。
- 失效 provider（老会话里可能留着 `opencode-go` 这种旧 id）会被 `llm.listProviders()` 剔除并记日志。
- 四条 HTTP 接口 `/dsh-auto-session-groups/api/{state,config,run,force}` **只允许 loopback**，非本机 403。
- `/api/run` 与 `/api/force` 的响应把每条会话分到五类：`renamed`（真改了）/ `plans`（预演）/
  `ungrouped`（模型回 `need_move:false` 或没给可用目录）/ `skipped`（已归档、标题为空、冷却中）/
  `failed`（异常）。

## 强制整理（`POST /api/force`）

普通整理**尊重**这些约束：结果缓存、失败冷却、`correctMisplaced=false`、`need_move=false`、`dryRun`。
强制整理**全部绕过**——它是用户显式按下的按钮，语义就是「别管你之前怎么想的，现在重新问一遍模型并真改」：

| 约束 | 普通整理 | 强制整理 |
|---|---|---|
| 结果缓存（同会话同标题） | 命中就不问 | 忽略，重新问 |
| 失败冷却（10/30 分钟） | 冷却期内不问 | 忽略，重新问 |
| `correctMisplaced=false`（标题含 `/` 不动） | 跳过 | 忽略，照样重判 |
| `need_move=false` | 跳过 | 忽略，按返回的目录/标签重拼 |
| `dryRun` | 只预演 | 忽略，真改 |
| `enabled=false`（总开关） | 409 拒绝 | **照做**（显式动作优先） |

入口：设置页「强制整理」按钮（带确认框）、侧栏 ✦ 旁的 ⚡ 按钮（带确认框）、`POST /api/force`。
日志前缀是 `强制整理：扫 N 条，改 M 条…`，与普通整理的 `手动整理：` 区分开。

## 调试

```bash
grep auto-session-groups ~/.dsh-next/dsh.log | tail
# 已挂载 rules v5 · 提示词归档 · 模型 (跟随会话) · 工作区 (全部工作区) · 提示词 1151 字（默认） · 日常目录 日常通用 · 纠偏 开 · 并发 2 · 预演 关 · 设置卡片 有（root=…）
# session-…: "花屏问题排查" → "修复/花屏定位"  [model:dsh-opencode-go/deepseek-v4.1-flash]
# session-…: 丢弃未知一级目录 "全新项目"（allowNewGroups=false）
# 路由 dsh-opencode-go/xxx 失败（empty-reply）：模型没吐正文（finish=error …)
# 手动整理：扫 18 条，改 3 条，跳过 12 条
```

归档失败的五个标签：`no-route`（没有可用路由）/ `empty-reply`（模型没吐正文）/
`bad-json`（输出不是合法 JSON）/ `timeout`（超时）/ `error`（其他）。

## 实测坑（2026-11-17，本机）

1. **宿主半改代码必须重启 DSH**：`plugin_manager set_plugin` 关开一次只重跑 `apply()`，
   **不重新 import**；改 `package.json` 的 `main`/`version` 也没用。client 半不受影响——
   bundle URL 带 `rev=<hash>`，刷新页面就拿到新版本。
2. `package.json` 的 `exports["."]` 0.5.0 曾指向不存在的 `./lib/host.js`（0.6.0 已修成 `./lib/index.js`）。
3. 宿主没有 `ctx.workspaces` 这个服务，工作区清单要读 `ctx.workspaceRegistry.list()`
   （`{id, path, title, sessionIds}`）——0.5.0 拿错了服务，勾选列表恒空。
4. `ctx.webServer` 必须写进 `inject`，否则 `cannot get property "webServer" without inject`。
5. 空回复的真根因是**老会话 `modelSelection` 里的 provider id 已失效**，不是 maxTokens 被推理吃光。
6. **取可选服务必须走 `ctx.get(name)`，不能先直接读属性**（0.6.0 踩过，已修）。
   cordis 的 Context 是 Proxy，读一个没写进 `inject` 的属性会**抛**
   `cannot get property "x" without inject`；写成
   `if (ctx?.[key] !== undefined) return ctx[key]; return ctx.get(key)` 时，
   异常被 `try/catch` 吞成 `undefined`，`ctx.get()` 那行成了死代码。
   实测表现：`GET /api/state` 里 `writable:false`（页面显示「此 profile 不接受配置写入」）
   + `workspaces: []`（工作区勾选列表空），而端点本身 200、设置页两个座位都挂上了。
   正确顺序：**先 `ctx.get(name)`，拿不到再退回直接读**。
7. **决策缓存要按「会话 + 标题」做键**（0.7.0 起）。只按标题做键时，两条不同会话
   撞同一个标题会互相污染；夹具里也踩到过——同一标题改完再跑会被缓存挡住，
   测试必须换新标题。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半：提示词渲染、JSON 决策解析、标题拼装、改名、并发闸门、三条 API、一次性迁移 |
| `lib/rules.json` | 默认提示词 + 两套词库 + 占位符说明 |
| `client.js` | 浏览器半：设置页（两个座位）+ 侧栏 ✦ 一键整理 |
| `cordis.patch.yml` | 插入插件行（`config: {}` = 全部工作区） |
| `locale/*.json` | 插件列表里的标题与说明 |
