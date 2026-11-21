import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const root = fileURLToPath(new URL('../../', import.meta.url))
export const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
export const repo = config.githubRepo
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || ['.', '..'].includes(repo.split('/')[1])) {
  throw new Error('请在 config.json 配置可信的 GitHub 仓库 owner/repo')
}

export const workDir = join(root, 'work')
export const upstreamDir = join(root, 'vendor', 'agent-autoloop')
export const digest = text => createHash('sha256').update(text).digest('hex')

const upstream = path => import(pathToFileURL(join(upstreamDir, path)).href)
const [api, project, input, review] = await Promise.all([
  upstream('plugins/delivery/github.ts'),
  upstream('plugins/delivery/project.ts'),
  upstream('plugins/delivery/input.ts'),
  upstream('plugins/delivery/review-ledger.ts'),
])

export const gh = api.gh
export const github = api.github(repo)
export const pages = path => api.pages(repo, path)
export const git = project.git
export const matches = project.matches
export const receiptBlock = input.receiptBlock
export const ledger = review.ledger

export function context() {
  const { AGENT_AUTOLOOP_RUN: run, AGENT_AUTOLOOP_CONTEXT: path } = process.env
  if (!path || !/^[1-9]\d*$/.test(run ?? '')) throw new Error('请由 Agent Autoloop 规则调用此命令')
  const home = config.workflow?.workerHome ?? join(homedir(), '.agent-autoloop')
  const runs = realpathSync(join(home, 'worker', 'runs'))
  const file = realpathSync(path)
  const [folder, name, ...extra] = relative(runs, file).split(sep)
  if (name !== 'context.json' || extra.length || !new RegExp('^' + run + '-[1-9]\\d*$').test(folder)) {
    throw new Error('本轮资料需来自已配置的 Worker 数据目录')
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}
