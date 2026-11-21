import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { context, digest, github, pages, repo, root, workDir } from './common.mjs'

const approvals = ['确认执行', '仅建单']
const options = [...approvals, '取消']
const directory = join(workDir, 'feishu-github')
const readyLabel = 'auto-agent-ready'
const workingLabel = 'auto-agent-working'
const isNumber = value => Number.isSafeInteger(value) && value > 0
const format = value => console.log(JSON.stringify(value))

function draftPath(topic) {
  return join(directory, digest(topic) + '.json')
}

function readDraft(topic) {
  const file = draftPath(topic)
  if (!existsSync(file)) return null
  const draft = JSON.parse(readFileSync(file, 'utf8'))
  if (draft.topic !== topic || draft.repo !== repo) throw new Error('草稿的话题或仓库与当前配置不一致')
  return draft
}

function writeDraft(draft) {
  mkdirSync(directory, { recursive: true })
  const file = draftPath(draft.topic)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(draft, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function requiredText(value, name, singleLine = false) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 需要填写文字`)
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (/<!--\s*auto-agent-|^\s*#{1,2}\s/m.test(text)) throw new Error(`${name} 包含保留标记或章节标题`)
  return singleLine ? text.replace(/\s+/g, ' ') : text
}

const intakeMarker = topic => `<!-- auto-agent-intake:${digest(topic)} -->`
const about = (topic, revision) => `auto-agent:${topic}:${revision}`

function contentFor(file, topic) {
  const input = JSON.parse(readFileSync(file, 'utf8'))
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('草稿需要 JSON 对象')
  const title = requiredText(input.title, 'title', true)
  const problem = requiredText(input.problem, 'problem')
  const scope = requiredText(input.scope, 'scope')
  const verification = requiredText(input.verification, 'verification')
  if (!Array.isArray(input.acceptance) || !input.acceptance.length) throw new Error('acceptance 至少需要一项')
  const acceptance = input.acceptance.map(item => `- ${requiredText(item, 'acceptance', true)}`)
  if (new Set(acceptance).size !== acceptance.length) throw new Error('acceptance 的每项验收标准必须不同')
  const dependencies = input.dependencies ?? []
  if (!Array.isArray(dependencies) || !dependencies.every(isNumber)) throw new Error('dependencies 需要 Issue 编号数组')
  if (input.parent !== undefined && !isNumber(input.parent)) throw new Error('parent 需要一个 Issue 编号')
  const sections = [
    `## 现状\n\n${problem}`,
    `## 范围\n\n${scope}`,
    `## 验收标准\n\n${acceptance.join('\n')}`,
    `## 验证方式\n\n${verification}`,
  ]
  if (dependencies.length) sections.push(`## 前置 Issue\n\n${[...new Set(dependencies)].map(number => `- #${number}`).join('\n')}`)
  if (input.parent) sections.push(`## 父 Issue\n\n- #${input.parent}`)
  const preview = sections.join('\n\n')
  if ([...title].length > 200 || [...preview].length > 4000) throw new Error('审批卡片标题最多 200 字，正文最多 4000 字')
  return { title, preview, body: `${intakeMarker(topic)}\n\n${preview}`, dependencies, parent: input.parent }
}

function matchingIssue(issue, topic) {
  return isNumber(issue?.number) && !issue.pull_request && issue.body?.startsWith(intakeMarker(topic) + '\n\n')
}

async function findIssue(draft) {
  if (draft.number) {
    const issue = await github(`issues/${draft.number}`)
    if (!matchingIssue(issue, draft.topic)) throw new Error('已关联的 Issue 缺少此话题的标记')
    return issue
  }
  const matches = pages('issues?state=all&per_page=100').filter(issue => matchingIssue(issue, draft.topic))
  if (matches.length > 1) throw new Error('有多个 Issue 使用同一个话题标记，请先确认关联')
  return matches[0]
}

function hasLabel(issue, label) {
  return issue.labels?.some(item => (typeof item === 'string' ? item : item.name) === label) ?? false
}

function active(issue) {
  return issue.state !== 'open' || hasLabel(issue, workingLabel) || hasLabel(issue, readyLabel)
}

function changedScope(issue) {
  return new Error(`Issue #${issue.number} 已进入执行或已关闭。请发起新的飞书需求。`)
}

function checkSourceLinks(draft) {
  const content = `${draft.title}\n${draft.body}`.replaceAll('&amp;', '&')
  if ([draft.sourceUrl, draft.lastSourceUrl].some(url => url && content.includes(url)) ||
      /https?:\/\/applink\.(?:feishu\.cn|larksuite\.com)\/client\/(?:message|chat)\//i.test(content)) {
    throw new Error('请从公开 Issue 草稿移除原始飞书消息链接')
  }
}

async function prepare(topic, file) {
  const { events } = context()
  const source = events.filter(event => event.source === 'feishu-intake' && event.type === 'feishu.message' && event.subject === topic).at(-1)
  if (!source) throw new Error('本轮没有这个话题的飞书消息')
  const next = contentFor(file, topic)
  const existing = readDraft(topic)
  const issue = existing && (existing.number || existing.publishingRevision) ? await findIssue(existing) : null
  if (issue && (active(issue) || existing.releasedRevision)) throw changedScope(issue)
  const same = existing?.title === next.title && existing?.body === next.body
  const revision = (existing?.revision ?? 0) + (same ? 0 : 1)
  const draft = { ...existing, ...next, topic, repo, revision,
    sourceUrl: existing?.sourceUrl || source.link, lastSourceUrl: source.link || existing?.lastSourceUrl }
  checkSourceLinks(draft)
  if (issue) draft.number = issue.number
  if (draft.number && (draft.dependencies.includes(draft.number) || draft.parent === draft.number)) {
    throw new Error('Issue 不能将自己作为前置或父 Issue')
  }
  writeDraft(draft)
  format({ topic, revision, ask: {
    title: draft.title, text: draft.preview, options, about: about(topic, revision), key: `intake-${digest(topic)}-${revision}`,
  } })
}

function issuedBody(draft) {
  return `${draft.body}\n\n<!-- auto-agent-approval:${digest(draft.body)} -->`
}

function notify(draft, issue) {
  if (draft.notified) return
  const key = digest(`${draft.topic}:issue:${issue.number}`).slice(0, 40)
  execFileSync(process.execPath, [join(root, 'superagent.mjs'), 'send', '--reply-to', draft.topic.slice('feishu:'.length),
    '--text', `已创建 GitHub Issue #${issue.number}\n${issue.html_url}`, '--idempotency-key', key],
  { timeout: 60_000, windowsHide: true, stdio: 'pipe' })
  draft.notified = true
  writeDraft(draft)
}

async function publish(topic, revision) {
  const draft = readDraft(topic)
  if (!draft || draft.revision !== revision) throw new Error('草稿版本已更新，请在当前审批卡片确认')
  const { answers } = context()
  const answer = answers.filter(item => item.about === about(topic, revision) && (item.choice === 0 || item.choice === 1) &&
    item.options?.[item.choice] === item.chosen && approvals[item.choice] === item.chosen).at(-1)
  if (!answer) throw new Error('本轮没有当前草稿的确认按钮回执')
  checkSourceLinks(draft)
  const execute = answer.chosen === approvals[0]
  const body = issuedBody(draft)
  let issue = await findIssue(draft)
  if (issue && (active(issue) || draft.releasedRevision)) {
    const launched = draft.releasedRevision === revision || hasLabel(issue, readyLabel) || hasLabel(issue, workingLabel)
    if (issue.title !== draft.title || issue.body !== body || execute !== launched) throw changedScope(issue)
  }

  draft.publishingRevision = revision
  writeDraft(draft)
  if (!issue) issue = await github('issues', { title: draft.title, body })
  else if (issue.title !== draft.title || issue.body !== body) issue = await github(`issues/${issue.number}`, { title: draft.title, body }, 'PATCH')
  if (!matchingIssue(issue, topic) || issue.title !== draft.title || issue.body !== body) {
    throw new Error('GitHub 返回的 Issue 与已确认草稿不一致')
  }
  draft.number = issue.number
  if (execute) draft.authorizedRevision = revision
  writeDraft(draft)
  if (execute && draft.releasedRevision !== revision && !hasLabel(issue, readyLabel) && !hasLabel(issue, workingLabel)) {
    if (issue.state !== 'open') throw changedScope(issue)
    const labels = await github(`issues/${issue.number}/labels`, { labels: [readyLabel] })
    if (!hasLabel({ labels }, readyLabel)) {
      throw new Error(`GitHub Issue #${issue.number} 缺少 ${readyLabel} 标签`)
    }
  }
  if (execute) draft.releasedRevision = revision
  delete draft.publishingRevision
  writeDraft(draft)
  notify(draft, issue)
  format({ topic, revision, issue: { number: issue.number, repo, url: issue.html_url }, execute })
}

try {
  const [action, ...args] = process.argv.slice(2)
  const { values } = parseArgs({ args, options: { topic: { type: 'string' }, file: { type: 'string' }, revision: { type: 'string' } } })
  const topic = values.topic
  if (!/^feishu:om_[A-Za-z0-9_-]{1,90}$/.test(topic ?? '')) throw new Error('需要有效的 --topic feishu:om_…')
  if (action === 'draft' && values.file && values.revision === undefined) await prepare(topic, values.file)
  else if (action === 'publish' && values.file === undefined && /^[1-9]\d*$/.test(values.revision ?? '') && isNumber(Number(values.revision))) {
    await publish(topic, Number(values.revision))
  } else throw new Error('用法：intake.mjs draft --topic <话题> --file <JSON> 或 publish --topic <话题> --revision <版本>')
} catch (error) {
  console.error(`飞书需求处理失败：${error.message}`)
  process.exitCode = 1
}
