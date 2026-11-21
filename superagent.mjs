#!/usr/bin/env node
/**
 * feishu-superagent 通用脚本层 —— 确定性 I/O，零依赖（Node >= 20），平台无关。
 * 设计原则（复刻 superagent 指南）：授权是代码不是提示词；先存储后动作；宿主拥有通信。
 *
 * 命令：
 *   poll                                     拉取新消息 → 确定性门禁 → 打印准入触发器 JSON（并推进游标）
 *   send --text "..." [--reply-to om_x]      机器人发消息/回复（markdown）
 *   issues create --json '{"records":[…]}'   批量建行（epic/task 字段映射见 SKILL）
 *   issues update --record recX --json '{…}' 更新行（状态流转/PR 回写）
 *   issues list                              列出全部行（摘要行）
 *   state [set --json '{…}']                 查看 / 合并补丁 PM 状态机
 *
 * 门禁规则（按序）：
 *   1. 机器人自己的消息 → 过滤（防循环）
 *   2. 发送者不在允许名单 → 忽略 not_on_allow_list
 *   3. @机器人，或 回复对象是机器人的消息（会话延续）→ 准入
 *   4. 其他 → 忽略 not_addressed
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'))
const STATE_PATH = join(HERE, 'pm-state.json')
const STORE_PATH = join(HERE, 'store.json')
const SEEN_LIMIT = 500

/** 引擎存储：tickets + outbox（先存储后动作；崩溃后 pending 项可见可重放）。 */
const loadStore = () => existsSync(STORE_PATH)
  ? JSON.parse(readFileSync(STORE_PATH, 'utf8'))
  : { tickets: {}, outbox: [] }
const saveStore = store => writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + '\n')

/** Outbox-first 执行：先落盘 pending → 执行 fn → 标记 done/failed。fn 需自身幂等（发送带幂等键/建行前查重）。 */
function act(store, op, payload, fn) {
  const id = `${op}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  store.outbox.push({ id, op, payload, state: 'pending', at: new Date().toISOString() })
  saveStore(store)
  try {
    const result = fn()
    const entry = store.outbox.find(e => e.id === id)
    entry.state = 'done'; entry.finishedAt = new Date().toISOString()
    saveStore(store)
    return result
  } catch (error) {
    const entry = store.outbox.find(e => e.id === id)
    entry.state = 'failed'; entry.error = String(error.message ?? error)
    saveStore(store)
    throw error
  }
}

const STATUS_TO_BI = { queued: '待确认', clarifying: '待澄清', working: '进行中', review: '待验收', merged: '已合并', done: '已提交', rejected: '已拒绝', cancelled: '已取消' }

/** Ticket → Bitable 行字段。 */
function ticketRow(t) {
  const row = { 标题: t.title, 类型: [t.kind === 'epic' ? 'epic' : 'task'], 状态: [STATUS_TO_BI[t.status] ?? '待确认'], 工单ID: t.id }
  if (t.priority) row.优先级 = [t.priority]
  if (t.role) row.负责角色 = [t.role]
  if (t.acceptance) row.验收标准 = t.acceptance
  if (t.note) row.拆解说明 = t.note
  if (t.epicId) row.父需求 = t.epicId
  if (t.dependsOn) row.依赖 = t.dependsOn
  if (t.sourceUrl) row.来源消息 = t.sourceUrl
  if (t.prUrl) row.PR链接 = t.prUrl
  return row
}

/** 同步 Ticket 状态到 Bitable 行（outbox-first；行不存在时静默跳过由建行动作负责）。 */
function syncTicketRecord(store, t) {
  if (!t.recordId) return
  act(store, 'record_update', { ticket: t.id, record: t.recordId, fields: { 状态: ticketRow(t).状态, ...(t.prUrl ? { PR链接: t.prUrl } : {}) } },
    () => lark(['base', '+record-batch-update', '--base-token', CONFIG.baseToken, '--table-id', CONFIG.tableId,
      '--json', JSON.stringify({ update_records: { [t.recordId]: { 状态: ticketRow(t).状态, ...(t.prUrl ? { PR链接: t.prUrl } : {}) } } })]))
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 退出码 ${res.status}: ${`${res.stdout ?? ''}${res.stderr ?? ''}`.slice(0, 400)}`)
  return `${res.stdout ?? ''}${res.stderr ?? ''}`
}

function ticketCreate() {
  const input = JSON.parse(arg('--json'))
  if (!input.id || !input.title || !input.kind) throw new Error('ticket 需要 id/title/kind')
  const store = loadStore()
  if (store.tickets[input.id]) throw new Error(`工单 ${input.id} 已存在`)
  const t = { status: 'queued', createdAt: new Date().toISOString(), ...input }
  store.tickets[t.id] = t
  act(store, 'record_create', { ticket: t.id }, () => {
    const out = lark(['base', '+record-batch-create', '--base-token', CONFIG.baseToken, '--table-id', CONFIG.tableId,
      '--json', JSON.stringify({ create_records: [ticketRow(t)] })])
    t.recordId = out.data?.record_id_list?.[0] ?? null
    saveStore(store)
  })
  saveStore(store)
  console.log(JSON.stringify({ ticket: t.id, record: t.recordId, status: t.status }))
}

function ticketUpdate() {
  const id = arg('--id')
  const patch = JSON.parse(arg('--json') ?? '{}')
  const store = loadStore()
  const t = store.tickets[id]
  if (!t) throw new Error(`工单 ${id} 不存在`)
  Object.assign(t, patch, { updatedAt: new Date().toISOString() })
  syncTicketRecord(store, t)
  saveStore(store)
  console.log(JSON.stringify({ ticket: t.id, status: t.status, record: t.recordId }))
}

function ticketList() {
  const store = loadStore()
  const status = arg('--status')
  for (const t of Object.values(store.tickets)) {
    if (status && t.status !== status) continue
    console.log(`${t.id} | ${t.kind} | ${t.status} | ${STATUS_TO_BI[t.status] ?? '-'} | ${t.title.slice(0, 36)} | rec:${t.recordId ?? '-'} | pr:${t.prNumber ?? '-'} | ${t.branch ?? ''}`)
  }
}

function ticketShow() {
  const t = loadStore().tickets[arg('--id')]
  if (!t) throw new Error('工单不存在')
  console.log(JSON.stringify(t, null, 2))
}

/** 为 task 工单准备隔离 worktree：分支 agent/<id>，目录 <HERE>/work/<id>。 */
function ticketPrepare() {
  const id = arg('--id')
  const store = loadStore()
  const t = store.tickets[id]
  if (!t) throw new Error(`工单 ${id} 不存在`)
  if (!CONFIG.repoPath) throw new Error('config.json 缺 repoPath')
  const dir = join(HERE, 'work', id)
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true })
    let base = 'origin/master'
    try { base = sh('git', ['-C', CONFIG.repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim() } catch { /* 新仓库未设远程 HEAD，用默认 */ }
    sh('git', ['-C', CONFIG.repoPath, 'worktree', 'add', '-b', `agent/${id}`, dir, base])
  }
  t.branch = `agent/${id}`
  t.worktree = dir
  t.status = 'working'
  syncTicketRecord(store, t)
  saveStore(store)
  console.log(JSON.stringify({ ticket: id, worktree: dir, branch: t.branch }))
}

/** 提交 worktree 并开真 PR（gh），回写待验收 + PR 链接，并通知群。 */
function ticketPr() {
  const id = arg('--id')
  const title = arg('--title') ?? `${id}: ${loadStore().tickets[id]?.title ?? ''}`
  const store = loadStore()
  const t = store.tickets[id]
  if (!t?.worktree) throw new Error('工单未 prepare（无 worktree）')
  act(store, 'pr_create', { ticket: id }, () => {
    sh('git', ['-C', t.worktree, 'add', '-A'])
    sh('git', ['-C', t.worktree, 'commit', '-m', title, '--allow-empty'])
    sh('git', ['-C', t.worktree, 'push', '-u', 'origin', t.branch])
    const url = sh('gh', ['pr', 'create', '--repo', CONFIG.githubRepo, '--head', t.branch, '--title', title,
      '--body', `This is by an automated agent, not a human.\n\nTicket: ${id}\nAcceptance: ${t.acceptance ?? '-'}`], { cwd: t.worktree }).trim().split('\n').pop()
    t.prUrl = url
    t.prNumber = Number(url.split('/').pop()) || null
  })
  t.status = 'review'
  syncTicketRecord(store, t)
  saveStore(store)
  act(store, 'send', { ticket: id, kind: 'pr-ready' }, () => {
    lark(['im', '+messages-send', '--chat-id', CONFIG.chatId, '--markdown', `📦 工单 **${t.id}** 已提交 PR 待验收：${t.title}\n${t.prUrl}\n表格状态已转「待验收」，合并后自动转「已合并」。`])
  })
  console.log(JSON.stringify({ ticket: id, pr: t.prUrl, number: t.prNumber, status: t.status }))
}

/** 检查沙箱仓库 PR 事件：merged/closed → 工单终态 + epic 收口 + 一次性通知。 */
function prsCheck() {
  const store = loadStore()
  const list = JSON.parse(sh('gh', ['pr', 'list', '--repo', CONFIG.githubRepo, '--state', 'all', '--json', 'number,state,url,title', '--limit', '30']))
  for (const pr of list) {
    const t = Object.values(store.tickets).find(x => x.prNumber === pr.number)
    if (!t || t.status === 'merged' || t.status === 'cancelled') continue
    if (pr.state === 'MERGED') { t.status = 'merged' }
    else if (pr.state === 'CLOSED') { t.status = 'cancelled' }
    else continue
    t.updatedAt = new Date().toISOString()
    syncTicketRecord(store, t)
    saveStore(store)
    console.log(`${t.id}: PR #${pr.number} ${pr.state} → ${t.status}`)
  }
  // epic 收口：全部子 task 终态 → epic merged + 一次性群通知
  for (const epic of Object.values(store.tickets).filter(x => x.kind === 'epic' && x.status !== 'merged' && x.status !== 'cancelled')) {
    const tasks = Object.values(store.tickets).filter(x => x.epicId === epic.id)
    if (tasks.length && tasks.every(x => ['merged', 'done', 'cancelled', 'rejected'].includes(x.status))) {
      epic.status = 'merged'
      epic.updatedAt = new Date().toISOString()
      syncTicketRecord(store, epic)
      saveStore(store)
      act(store, 'send', { ticket: epic.id, kind: 'epic-done' }, () => {
        lark(['im', '+messages-send', '--chat-id', CONFIG.chatId, '--markdown', `🏁 需求 **${epic.title}** 全部子任务收口（${tasks.length} 个），epic 已转「已合并」。表格：${CONFIG.baseUrl}`])
      })
      console.log(`epic ${epic.id} 收口`)
    }
  }
}

const loadState = () => existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  : { cursorPosition: 0, seen: [], botMessageIds: [], threads: {}, ignored: 0 }
const saveState = state => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n')

/** 运行 lark-cli；剥离进度行，从第一个 '{' 起解析 JSON；失败抛出可读错误。 */
function lark(args) {
  const res = spawnSync(CONFIG.larkCli, [...args, '--as', 'bot'], {
    env: { ...process.env, LARKSUITE_CLI_CONFIG_DIR: CONFIG.configDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (res.status !== 0) throw new Error(`lark-cli 退出码 ${res.status}: ${text.slice(0, 500)}`)
  const start = text.indexOf('{')
  if (start < 0) return { raw: text }
  const parsed = JSON.parse(text.slice(start))
  if (parsed.ok === false) throw new Error(`lark-cli 拒绝: ${JSON.stringify(parsed.error).slice(0, 500)}`)
  return parsed
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}

/** 拉取新消息并应用门禁。首次运行（无状态文件）只建立游标，不重放历史。 */
function poll() {
  const firstRun = !existsSync(STATE_PATH)
  const state = loadState()
  const out = lark(['im', '+chat-messages-list', '--chat-id', CONFIG.chatId])
  const messages = out.data?.messages ?? []
  if (firstRun && messages.length) {
    state.seen = messages.map(m => m.message_id)
    state.cursorPosition = Math.max(...messages.map(m => Number(m.message_position)))
    saveState(state)
    console.log(JSON.stringify({ initialized: true, cursorPosition: state.cursorPosition, admitted: [] }, null, 2))
    return
  }
  const fresh = messages
    .filter(m => !state.seen.includes(m.message_id) && Number(m.message_position) > state.cursorPosition)
    .sort((a, b) => Number(a.message_position) - Number(b.message_position))
  const admitted = []
  for (const m of fresh) {
    state.seen.push(m.message_id)
    if (state.seen.length > SEEN_LIMIT) state.seen.splice(0, state.seen.length - SEEN_LIMIT)
    state.cursorPosition = Math.max(state.cursorPosition, Number(m.message_position))
    if (m.deleted) continue
    const senderId = m.sender?.id ?? ''
    if (senderId === CONFIG.botOpenId || m.sender?.sender_type !== 'user') continue // 规则1：自身/机器人
    if (!CONFIG.allowedOpenIds.includes(senderId)) { state.ignored++; continue }    // 规则2：名单
    const mentionsBot = (m.mentions ?? []).some(x => x.id === CONFIG.botOpenId)
    const repliesBot = m.parent_id != null && state.botMessageIds.includes(m.parent_id) // 规则3：会话延续
    if (!mentionsBot && !repliesBot) { state.ignored++; continue }                  // 规则4
    admitted.push({
      message_id: m.message_id, position: m.message_position, at: m.create_time,
      from: { id: senderId, name: m.sender.name }, text: m.content,
      mentionsBot, repliesBot, url: m.message_app_link, parent_id: m.parent_id ?? null,
    })
  }
  saveState(state)
  console.log(JSON.stringify({ admitted, cursorPosition: state.cursorPosition, ignoredTotal: state.ignored }, null, 2))
}

function send() {
  const text = arg('--text')
  if (!text) throw new Error('需要 --text')
  const replyTo = arg('--reply-to')
  const args = replyTo
    ? ['im', '+messages-reply', '--message-id', replyTo, '--markdown', text]
    : ['im', '+messages-send', '--chat-id', CONFIG.chatId, '--markdown', text]
  const out = lark(args)
  const id = out.data?.message_id
  const state = loadState()
  if (id) { state.botMessageIds.push(id); if (state.botMessageIds.length > 200) state.botMessageIds.splice(0, state.botMessageIds.length - 200) }
  saveState(state)
  console.log(JSON.stringify({ sent: true, message_id: id }))
}

function issuesCreate() {
  const json = arg('--json')
  if (!json) throw new Error('需要 --json')
  const records = JSON.parse(json).records
  const out = lark(['base', '+record-batch-create', '--base-token', CONFIG.baseToken, '--table-id', CONFIG.tableId,
    '--json', JSON.stringify({ create_records: records })])
  console.log(JSON.stringify({ created: out.data?.record_id_list ?? [], rev: out.data?.rev }))
}

function issuesUpdate() {
  const record = arg('--record')
  const json = arg('--json')
  if (!record || !json) throw new Error('需要 --record 与 --json')
  const out = lark(['base', '+record-batch-update', '--base-token', CONFIG.baseToken, '--table-id', CONFIG.tableId,
    '--json', JSON.stringify({ update_records: { [record]: JSON.parse(json) } })])
  console.log(JSON.stringify({ updated: [record], rev: out.data?.rev }))
}

function issuesList() {
  const out = lark(['base', '+record-list', '--base-token', CONFIG.baseToken, '--table-id', CONFIG.tableId])
  const file = out.record_file
  if (!file) { console.log(JSON.stringify({ rows: [] })); return }
  const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  for (const r of rows) console.log(`${r.record_id} | ${r['类型'] ?? '-'} | ${(r['状态'] ?? ['-'])[0] ?? '-'} | ${String(r['标题'] ?? '').slice(0, 40)} | 工单:${r['工单ID'] ?? '-'} | PR:${r['PR链接'] ?? '-'}`)
}

function state() {
  if (process.argv.includes('set')) {
    const patch = JSON.parse(arg('--json') ?? '{}')
    const state = loadState()
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'threads' && typeof v === 'object') Object.assign(state.threads ??= {}, v)
      else state[k] = v
    }
    saveState(state)
    console.log(JSON.stringify({ merged: Object.keys(patch) }))
  } else console.log(JSON.stringify(loadState(), null, 2))
}

const cmd = process.argv[2]
try {
  if (cmd === 'poll') poll()
  else if (cmd === 'send') send()
  else if (cmd === 'issues') { const sub = process.argv[3]; if (sub === 'create') issuesCreate(); else if (sub === 'update') issuesUpdate(); else if (sub === 'list') issuesList(); else throw new Error(`未知子命令 ${sub}`) }
  else if (cmd === 'state') state()
  else if (cmd === 'ticket') { const sub = process.argv[3]; if (sub === 'create') ticketCreate(); else if (sub === 'update') ticketUpdate(); else if (sub === 'list') ticketList(); else if (sub === 'show') ticketShow(); else if (sub === 'prepare') ticketPrepare(); else if (sub === 'pr') ticketPr(); else throw new Error(`未知子命令 ${sub}`) }
  else if (cmd === 'prs') { if (process.argv[3] === 'check') prsCheck(); else throw new Error('用法: prs check') }
  else if (cmd === 'outbox') console.log(JSON.stringify(loadStore().outbox, null, 2))
  else { console.error('用法: superagent.mjs poll|send|issues <sub>|state [set]|ticket <sub>|prs check|outbox'); process.exit(1) }
} catch (error) {
  console.error(`失败: ${error.message}`)
  process.exit(1)
}
