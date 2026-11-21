// Adapted from the pinned Agent Autoloop delivery poller: read GitHub facts, then emit stable events.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { config, digest, github, pages, receiptBlock, repo, root, workDir } from './common.mjs'
import { approvedPlan } from './issue.mjs'

const url = number => 'https://github.com/' + repo + '/issues/' + number
const labels = item => new Set((item.labels ?? []).map(label => label.name))
const ready = issue => issue.state === 'open' && labels(issue).has('auto-agent-ready')
const completed = issue => issue.state === 'closed' && issue.state_reason === 'completed'

function event(number, type, key, detail) {
  return { id: 'issue-' + number + ':' + digest(repo + ':' + key), type, subject: '#' + number, link: url(number), detail: JSON.stringify(detail) }
}

async function waiting() {
  const events = []
  for (const issue of pages('issues?state=open&labels=auto-agent-ready,auto-agent-waiting&per_page=100')) {
    if (issue.pull_request || !ready(issue)) continue
    try {
      const plan = approvedPlan(issue)
      const prerequisites = await Promise.all(plan.dependencies.map(number => github('issues/' + number)))
      if (prerequisites.every(completed)) {
        events.push(event(issue.number, 'issue.ready', 'dependencies:' + plan.approval, { reason: '前置 Issue 已完成' }))
      }
    } catch (error) {
      console.error('跳过无法核对的 Issue #' + issue.number, error.message)
    }
  }
  return events
}

async function rework(issue, pr) {
  if (pr.state !== 'open' || pr.auto_merge || !ready(issue)) return
  const plan = approvedPlan(issue)
  const head = pr.head.sha
  if (!/^[a-f0-9]{40}$/.test(head)) return
  const job = config.workflow?.checkJob ?? 'check'
  const status = await github('commits/' + head + '/status')
  const failedDelivery = status.statuses?.find(check => check.context === 'delivery' && check.state === 'failure')
  if (labels(pr).has('deliver') && !failedDelivery) return
  const checks = await github('commits/' + head + '/check-runs?filter=latest&per_page=100')
  const failed = checks.check_runs?.find(check =>
    check.app?.slug === 'github-actions' && (check.name === job || check.name.startsWith(job + ' (')) &&
    ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(check.conclusion))
  if (failed || failedDelivery) {
    return event(issue.number, 'issue.revise', 'returned:' + pr.number + ':' + head + ':' + plan.approval, {
      reason: failedDelivery ? '交付退回，查看 PR 的审查记录及 CI' : '必需 CI 未通过',
      pr: pr.html_url,
      check: failed?.html_url,
    })
  }
}

function sourceTopics() {
  const dir = join(workDir, 'feishu-github')
  if (!existsSync(dir)) return new Map()
  return new Map(readdirSync(dir, { withFileTypes: true }).flatMap(file => {
    if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) return []
    try {
      const draft = JSON.parse(readFileSync(join(dir, file.name), 'utf8'))
      if (draft.repo === repo && Number.isSafeInteger(draft.number) && /^feishu:om_[a-zA-Z0-9_-]+$/.test(draft.topic)) {
        return [[draft.number, draft.topic.slice('feishu:'.length)]]
      }
    } catch (error) {
      console.error('暂时无法读取飞书话题关联', error.message)
    }
    return []
  }))
}

function report(issue, pr, topic) {
  if (!topic || pr.state !== 'closed') return
  const dir = join(workDir, 'feishu-github', 'notified')
  const key = digest(repo + ':pr-result:' + pr.number + ':' + (pr.merged_at ?? pr.closed_at) + ':' + issue.state).slice(0, 40)
  const sent = join(dir, key)
  if (existsSync(sent)) return
  const conclusion = pr.merged_at
    ? (issue.state === 'closed' ? 'PR 已合并，Issue 已关闭' : 'PR 已合并，Issue 仍开着')
    : 'PR 已关闭，未合并'
  const message = [conclusion, issue.html_url, pr.html_url].join('\n')
  execFileSync(process.execPath, [join(root, 'superagent.mjs'), 'send', '--reply-to', topic,
    '--text', message, '--idempotency-key', key], { timeout: 60_000, windowsHide: true, stdio: 'pipe' })
  mkdirSync(dir, { recursive: true })
  writeFileSync(sent, pr.html_url + '\n')
}

const events = await waiting()
const topics = sourceTopics()
for (const row of pages('issues?state=all&labels=auto-agent-pr&per_page=100')) {
  if (!row.pull_request) continue
  try {
    const pr = await github('pulls/' + row.number)
    const match = /^agent\/issue-([1-9]\d*)$/.exec(pr.head.ref)
    if (!match || pr.head.repo?.full_name.toLowerCase() !== repo.toLowerCase() ||
        !new RegExp('^Closes #' + match[1] + '[\\r]?$','m').test(pr.body ?? '')) continue
    const issue = await github('issues/' + match[1])
    const returned = await rework(issue, pr)
    if (returned) events.push(returned)
    report(issue, pr, topics.get(issue.number))
  } catch (error) {
    console.error('PR #' + row.number + ' 暂时无法核对', error.message)
  }
}

console.log('GitHub 依赖和返工复查完成')
// Rotate over the result set when it exceeds the upstream receipt size.
const offset = Math.floor(Date.now() / 180_000) % Math.max(1, Math.ceil(events.length / 100)) * 100
console.log(receiptBlock({ events: events.slice(offset, offset + 100) }))
