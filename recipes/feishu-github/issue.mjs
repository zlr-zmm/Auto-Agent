import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { disableAuto } from "../../vendor/agent-autoloop/plugins/delivery/delivery.ts";
import {
  config, context, digest, gh, git, github, ledger, matches, pages, receiptBlock, repo, root,
  workDir,
} from "./common.mjs";

const checkout = resolve(root, config.repoPath ?? root);
const sha = /^[0-9a-f]{40}$/;
const issueSubject = /^#([1-9]\d*)$/;
const continuePrefix = "auto-agent-work:";
const hasLabel = (item, name) => item.labels?.some((label) => label.name === name);
const sameRepo = (name) => typeof name === "string" && name.toLowerCase() === repo.toLowerCase();
const text = (value) => typeof value === "string" && value.trim() !== "";
const oneLine = (value) => value.replace(/\s+/g, " ").trim();
const literal = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll("#", "&#35;").replaceAll("`", "&#96;");

function section(body, title, optional = false) {
  const sections = [...body.matchAll(/^## +(.+?) *\r?$/gm)];
  const entries = sections.filter((heading) => heading[1] === title);
  if (entries.length === 0 && optional) return [];
  if (entries.length !== 1) throw new Error(`Issue 需要恰好一节「${title}」。`);
  const heading = entries[0];
  const next = sections[sections.indexOf(heading) + 1];
  return body.slice(heading.index + heading[0].length, next?.index)
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function approvedPlan(issue) {
  const raw = issue.body ?? "";
  const approval = /\r?\n\r?\n<!-- auto-agent-approval:([a-f0-9]{64}) -->$/.exec(raw);
  const body = approval && raw.slice(0, approval.index);
  if (!body || digest(body) !== approval[1]) throw new Error("Issue 正文与批准的计划不一致。");
  const intake = [...body.matchAll(/^<!-- auto-agent-intake:[a-f0-9]{64} -->\r?$/gm)];
  if (intake.length !== 1 || intake[0].index !== 0) throw new Error("Issue 缺少唯一的需求归属标记。");
  const plan = body.slice(intake[0][0].length).trim();
  const criteria = section(plan, "验收标准").map((line) => {
    const item = /^[-*+]\s+(.+)$/.exec(line);
    if (!item) throw new Error("「验收标准」每行需要一条非空项目符号。");
    return item[1].trim();
  });
  if (!criteria.length || new Set(criteria).size !== criteria.length) {
    throw new Error("「验收标准」必须非空且每条不同。");
  }
  const lines = section(plan, "前置 Issue", true);
  const dependencies = lines.length === 1 && /^(?:[-*+]\s+)?无[。.]?$/.test(lines[0])
    ? []
    : lines.map((line) => {
      const number = Number(/^[-*+]\s+#([1-9]\d*)$/.exec(line)?.[1]);
      if (!Number.isSafeInteger(number) || number === issue.number) {
        throw new Error("「前置 Issue」每行填写一个形如 #123 的编号，且不能指向自身。");
      }
      return number;
    });
  return { body, approval: approval[1], criteria, dependencies: [...new Set(dependencies)] };
}

function runIssue(run) {
  const subjects = new Set();
  let cancelled = false;
  for (const event of run.events) {
    const bare = event.subject?.startsWith(`${repo}#`) ? event.subject.slice(repo.length) : event.subject;
    const number = Number(issueSubject.exec(bare ?? "")?.[1]);
    if (!Number.isSafeInteger(number)) throw new Error("本轮事件缺少配置仓库的有效 Issue 编号。");
    subjects.add(number);

    if (event.type === "card.answered") {
      const answer = run.answers?.find((item) => event.id === `card:${item.card}`);
      const about = `${continuePrefix}${repo}#${number}`;
      if (answer?.about !== about || !Number.isInteger(answer.choice) ||
          answer.options?.[answer.choice] !== answer.chosen) {
        throw new Error("本轮卡片回答未指向同一 Issue 的工作卡片选项。");
      }
      if (answer.chosen !== "继续") cancelled = true;
    } else if (
      (event.type !== "issues.opened" || !["github-workflow", "github"].includes(event.source)) &&
      (!["issue.ready", "issue.revise"].includes(event.type) || event.source !== "github-workflow")
    ) {
      throw new Error("本轮不属于 GitHub Issue 实施流程。");
    }
    if (event.type !== "card.answered" &&
        event.link?.toLowerCase() !== `https://github.com/${repo.toLowerCase()}/issues/${number}`) {
      throw new Error("Issue 事件链接与配置仓库不一致。");
    }
  }
  if (subjects.size !== 1) throw new Error("本轮必须只处理一个 Issue。");
  return { number: [...subjects][0], cancelled };
}

async function readIssue(number) {
  const issue = await github(`issues/${number}`);
  const author = config.workflow?.issueAuthor ?? gh(["api", "user", "--jq", ".login"]);
  if (issue.number !== number || issue.pull_request || !author || issue.user?.login !== author) {
    throw new Error("GitHub Issue 与配置的编号或可信创建者不一致。");
  }
  return issue;
}

function verifyApproval(issue) {
  if (issue.state !== "open" || !hasLabel(issue, "auto-agent-ready")) {
    throw new Error("Issue 必须处于开启状态并带有 auto-agent-ready 标签。");
  }
  const plan = approvedPlan(issue);
  const key = /^<!-- auto-agent-intake:([a-f0-9]{64}) -->/m.exec(plan.body)?.[1];
  const draft = JSON.parse(readFileSync(resolve(workDir, "feishu-github", key + ".json"), "utf8"));
  if (!sameRepo(draft.repo) || draft.number !== issue.number || digest(draft.topic) !== key ||
      draft.authorizedRevision !== draft.revision || draft.body !== plan.body || draft.title !== issue.title) {
    throw new Error("Issue 不符合本机记录的飞书批准版本。");
  }
  return plan;
}

async function pendingDependencies(plan) {
  const issues = await Promise.all(plan.dependencies.map((number) => github(`issues/${number}`)));
  return plan.dependencies.filter((number, index) => {
    const issue = issues[index];
    if (issue.number !== number || issue.pull_request) throw new Error(`前置项 #${number} 不是有效的 Issue。`);
    return issue.state !== "closed" || issue.state_reason !== "completed";
  });
}

async function setLabels(number, labels) {
  await github(`issues/${number}/labels`, { labels });
}

async function removeLabel(path, current, name) {
  if (!hasLabel(current, name)) return;
  try {
    await github(`issues/${current.number}/labels/${name}`, undefined, "DELETE");
  } catch (error) {
    if (hasLabel(await github(path), name)) throw error;
  }
}

function checkOrigin(root) {
  for (const args of [["--all"], ["--push", "--all"]]) {
    const urls = git(root, "remote", "get-url", ...args, "origin").split(/\r?\n/);
    const found = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(urls[0]);
    if (urls.length !== 1 || !sameRepo(found?.[1])) {
      throw new Error("工作目录的 origin 必须指向唯一的配置仓库。");
    }
  }
}

const real = (path) => realpathSync(path);
const commonGit = (root) => real(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));

function checkCheckout() {
  if (real(git(checkout, "rev-parse", "--show-toplevel")) !== real(checkout)) {
    throw new Error("repoPath 必须指向目标仓库根目录。");
  }
  checkOrigin(checkout);
}

function checkWorktree(path, branch) {
  if (real(workDir) !== resolve(real(root), "work") ||
      real(path) !== resolve(real(workDir), relative(workDir, path)) ||
      real(git(path, "rev-parse", "--show-toplevel")) !== real(path) ||
      commonGit(path) !== commonGit(checkout) ||
      git(path, "symbolic-ref", "HEAD") !== `refs/heads/${branch}`) {
    throw new Error("Issue 工作树的路径、仓库或分支不匹配。");
  }
  checkOrigin(path);
}

function remoteHead(branch) {
  const ref = `refs/heads/${branch}`;
  const result = git(checkout, "ls-remote", "--heads", "origin", ref);
  if (!result) return "";
  const [head, name] = result.split("\t");
  if (!sha.test(head) || name !== ref) throw new Error("无法核实远端 Issue 分支。");
  git(checkout, "fetch", "--no-tags", "origin", `+${ref}:refs/remotes/origin/${branch}`);
  if (git(checkout, "rev-parse", `refs/remotes/origin/${branch}`) !== head) {
    throw new Error("远端 Issue 分支在读取时变更，请重试。");
  }
  return head;
}

function updateMain() {
  git(checkout, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
}

function ancestor(path, base, head) {
  try {
    git(path, "merge-base", "--is-ancestor", base, head);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function openWorktree(path, branch, remote) {
  if (!existsSync(path)) {
    mkdirSync(workDir, { recursive: true });
    if (real(workDir) !== resolve(real(root), "work")) {
      throw new Error("工作树目录必须在配置仓库的 work 目录下。");
    }
    const local = git(checkout, "branch", "--list", "--format=%(refname:short)", branch);
    if (local) git(checkout, "worktree", "add", path, branch);
    else git(checkout, "worktree", "add", "-b", branch, path, remote || "origin/main");
  }
  checkWorktree(path, branch);
  if (!remote || ancestor(path, remote, "HEAD")) return true;
  if (!git(path, "status", "--porcelain", "--untracked-files=no") && ancestor(path, "HEAD", remote)) {
    git(path, "merge", "--ff-only", remote);
    return true;
  }
  return false;
}

const prMarker = (number) => `<!-- auto-agent-issue:#${number} -->`;

function verifyPR(pr, number, branch, head) {
  if (!sameRepo(pr.base?.repo?.full_name) || pr.base.ref !== "main" ||
      !sameRepo(pr.head?.repo?.full_name) || pr.head.ref !== branch ||
      !sha.test(pr.head.sha) || (head && pr.head.sha !== head) ||
      !pr.body?.split(/\r?\n/).includes(prMarker(number))) {
    throw new Error("现有 PR 与 Issue、目标仓库、分支或提交不一致。");
  }
  return pr;
}

async function findPR(number, branch) {
  const head = encodeURIComponent(`${repo.split("/")[0]}:${branch}`);
  const prs = await pages(`pulls?state=all&base=main&head=${head}&per_page=100`);
  if (prs.length > 1) throw new Error("Issue 分支关联多个 PR，需要人工确认。");
  if (prs.length === 0) return;
  return verifyPR(await github(`pulls/${prs[0].number}`), number, branch);
}

function readProof(file, plan) {
  const proof = JSON.parse(readFileSync(file, "utf8"));
  if (!text(proof?.summary) || !Array.isArray(proof.evidence) || !Array.isArray(proof.tests) ||
      !proof.tests.length || !Array.isArray(proof.review ?? [])) {
    throw new Error("提交凭证需要 summary、evidence、tests 和可选的 review。");
  }
  const evidence = new Map();
  for (const item of proof.evidence) {
    if (!plan.criteria.includes(item?.criterion) || !text(item.result) || evidence.has(item.criterion)) {
      throw new Error("每条验收凭证必须对应一条批准的标准，提供结果且不能重复。");
    }
    evidence.set(item.criterion, item.result);
  }
  if (evidence.size !== plan.criteria.length) throw new Error("提交凭证尚未覆盖所有验收标准。");
  if (proof.tests.some((item) => !text(item?.command) || !text(item?.result))) {
    throw new Error("每条测试凭证需要填写测试命令及实际结果。");
  }
  const review = new Map();
  for (const item of proof.review ?? []) {
    if (!Number.isSafeInteger(item?.number) || item.number < 1 || !text(item.result) || review.has(item.number)) {
      throw new Error("每条审查处理说明需要有效的发现编号与结果，且不能重复。");
    }
    review.set(item.number, oneLine(item.result));
  }
  return { summary: proof.summary, evidence, tests: proof.tests, review };
}

function dispositions(current, review) {
  let finding;
  const used = new Set();
  const record = current.record.split("\n").map((line) => {
    if (line.startsWith("第 ") && line.includes(" 轮（")) finding = undefined;
    const listed = /^(\d+)\. /.exec(line);
    if (listed) finding = Number(listed[1]);
    const handled = /^   处理：(.*)$/.exec(line);
    if (!handled || !review.has(finding)) return line;
    const result = review.get(finding);
    if (handled[1].trim() && handled[1].trim() !== result) {
      throw new Error(`审查项 ${finding} 已有不同的处理说明。`);
    }
    used.add(finding);
    return `   处理：${result}`;
  }).join("\n");
  if (review.size !== used.size || current.unhandled.some((number) => !used.has(number))) {
    throw new Error(`提交凭证需要为审查记录中尚未处理的每一项填写结果：${current.unhandled.join("、")}。`);
  }
  return record;
}

function pullBody(number, head, plan, proof, previous = "") {
  const current = ledger(previous);
  const record = dispositions(current, proof.review);
  const quoted = (value) => value.split(/\r?\n/).map((line) => `> ${literal(line)}`).join("\n");
  const body = [
    "This is by an automated agent, not a human.",
    "",
    `Closes #${number}`,
    prMarker(number),
    "",
    `提交：${head}`,
    `计划批准：${plan.approval}`,
    "",
    "## 实施摘要",
    quoted(proof.summary),
    "",
    "## 已批准的 Issue 计划",
    quoted(plan.body),
    "",
    "## 验收凭证",
    ...plan.criteria.map((criterion) => `- ${literal(criterion)} — ${literal(oneLine(proof.evidence.get(criterion)))}`),
    "",
    "## 测试",
    ...proof.tests.map(({ command, result }) => `- ${literal(oneLine(command))} — ${literal(oneLine(result))}`),
    ...(record ? ["", "## Codex 审查", "", record] : []),
    "",
  ].join("\n");
  const next = ledger(body);
  if (next.unhandled.length || current.rounds.map((round) => round.digest).join() !==
      next.rounds.map((round) => round.digest).join()) throw new Error("无法完整保留 Codex 审查记录。");
  return body;
}

function stage(path, file) {
  const exclusions = [];
  for (const proofPath of new Set([file, real(file)])) {
    const local = relative(path, proofPath);
    if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) continue;
    const name = local.split(sep).join("/");
    if (git(path, "diff", "--cached", "--name-only", "--", `:(literal)${name}`)) {
      throw new Error("提交凭证文件已暂存，请把它从 Issue 提交中移除。");
    }
    exclusions.push(`:(exclude,literal)${name}`);
  }
  git(path, "add", "-A", "--", ".", ...exclusions);
}

const protectedPaths = [
  ".github/**", ".codex/**", ".agent-autoloop/**", "ops/**", "recipes/**",
  "**/AGENTS.md", "**/SKILL.md", "superagent.mjs", "feishu-watch.ts", ".gitmodules",
  "config.example.json", "rules.workflow.example.json", ".gitignore", "vendor/agent-autoloop/**",
];

function reviewOnly(path) {
  const changes = git(path, "diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
    "origin/main...HEAD", "--").split("\0");
  if (!changes[0]) throw new Error("Issue 分支相对 main 没有改动。");
  const configured = config.workflow?.protectedPaths ?? [];
  if (!Array.isArray(configured) || !configured.every(text)) throw new Error("protectedPaths 配置不正确。");
  const patterns = [...protectedPaths, ...configured].map((pattern) => pattern.toLowerCase());
  const globs = patterns.map((pattern) => pattern.endsWith("/**") ? `${pattern}/*` : pattern);
  return changes.some((record, index) => {
    if (index % 2 === 0) return false;
    const name = record.toLowerCase();
    const modes = changes[index - 1].slice(1).split(" ", 2);
    return modes.some((mode) => !["000000", "100644"].includes(mode)) ||
      matches(name, globs) ||
      patterns.some((pattern) => pattern.endsWith("/**") && name === pattern.slice(0, -3));
  });
}

function card(run, number, path) {
  const title = `Issue #${number} 的工作树需要处理`;
  const message = `工作树的本地改动与远端分支不一致。请保留现有改动，核实 ${path} 后选择继续。`;
  if (!run.open?.some((item) => item.title === title)) {
    console.log(receiptBlock({ ask: [{
      key: `auto-agent-work-${number}`, title, text: message, options: ["继续", "暂不继续"],
      about: `${continuePrefix}${repo}#${number}`,
    }] }));
  }
  return message;
}

async function prepare(run, issue, plan, branch, path) {
  const pending = await pendingDependencies(plan);
  if (pending.length) {
    if (!hasLabel(issue, "auto-agent-waiting")) await setLabels(issue.number, ["auto-agent-waiting"]);
    return { status: "waiting", number: issue.number, pending, url: issue.html_url };
  }
  checkCheckout();
  const pr = await findPR(issue.number, branch);
  if (pr?.merged_at) return prResult("merged", issue.number, pr);
  if (pr && pr.state !== "open") return prResult("pr-closed", issue.number, pr);
  updateMain();
  if (!openWorktree(path, branch, remoteHead(branch))) {
    return { status: "blocked", number: issue.number, worktree: path, message: card(run, issue.number, path) };
  }
  const latest = await readIssue(issue.number);
  if (verifyApproval(latest).approval !== plan.approval) throw new Error("已批准的计划变更，请重新准备工作树。");
  if (!hasLabel(latest, "auto-agent-working")) await setLabels(issue.number, ["auto-agent-working"]);
  await removeLabel(`issues/${issue.number}`, latest, "auto-agent-waiting");
  return {
    status: "prepared", number: issue.number, worktree: path, branch,
    issue: { title: issue.title, body: plan.body, url: issue.html_url },
    approval: plan.approval, criteria: plan.criteria, dependencies: plan.dependencies,
    ...(pr && { pull: { number: pr.number, url: pr.html_url, head: pr.head.sha, review: ledger(pr.body).record } }),
  };
}

function prResult(status, issue, pr, onlyReview) {
  return { status, number: issue, pr: pr.number, url: pr.html_url, head: pr.head.sha, reviewOnly: onlyReview };
}

async function withdraw(pr, issue, branch) {
  const path = `pulls/${pr.number}`;
  const current = verifyPR(await github(path), issue, branch, pr.head.sha);
  if (current.state !== "open" || current.merged_at) throw new Error("现有 PR 已结束。");
  await removeLabel(path, current, "deliver");
  if (current.auto_merge) {
    await disableAuto(pr.number, {
      api: github,
      disableAuto: (number) => gh(["pr", "merge", String(number), "--repo", repo, "--disable-auto"]),
      wait: () => setTimeout(500),
    });
  }
  const checked = verifyPR(await github(path), issue, branch, pr.head.sha);
  if (checked.state !== "open" || checked.merged_at || checked.auto_merge !== null || hasLabel(checked, "deliver")) {
    throw new Error("无法确认现有 PR 已退出自动交付和 GitHub 自动合并。");
  }
}

async function submit(issue, plan, branch, path, file) {
  const autoDelivery = config.workflow?.autoDelivery === true;
  const number = issue.number;
  const proof = readProof(file, plan);
  const pending = await pendingDependencies(plan);
  if (pending.length) return { status: "waiting", number, pending, url: issue.html_url };
  checkCheckout();
  checkWorktree(path, branch);
  updateMain();
  const remote = remoteHead(branch);
  let pr = await findPR(number, branch);
  if (pr?.merged_at) return prResult("merged", number, pr);
  if (pr && pr.state !== "open") return prResult("pr-closed", number, pr);
  if ((pr && pr.head.sha !== remote) || (remote && !ancestor(path, remote, "HEAD"))) {
    throw new Error("远端分支已更新，请先核实 Issue 工作树与 PR。");
  }
  dispositions(ledger(pr?.body), proof.review);
  stage(path, file);
  if (repo.toLowerCase() === "zlr-zmm/auto-agent") {
    const staged = git(path, "diff", "--cached", "--name-only", "-z").split("\0");
    if (staged.some(file => /^(?:tests?|work)\//i.test(file) || /\.(?:test|spec)\.[cm]?[jt]s$/i.test(file))) {
      throw new Error("本项目的测试代码和验证产物留在本机，请从提交中移除。");
    }
  }
  if (git(path, "diff", "--cached", "--raw", "-z")) {
    git(path, "commit", "-m", `issue-#${number}: ${oneLine(issue.title).slice(0, 150)}`);
  }
  const head = git(path, "rev-parse", "HEAD");
  if (!sha.test(head)) throw new Error("无法读取 Issue 分支的完整提交编号。");
  const onlyReview = reviewOnly(path);
  const body = pullBody(number, head, plan, proof, pr?.body);
  if (autoDelivery && pr?.head.sha === head && pr.body?.trimEnd() === body.trimEnd()) {
    if (hasLabel(pr, "deliver") && !!hasLabel(pr, "deliver-review") === onlyReview) {
      return prResult("queued", number, pr, onlyReview);
    }
    const { statuses } = await github(`commits/${head}/status?per_page=100`);
    const delivery = statuses?.find((status) => status.context === "delivery");
    if (onlyReview && delivery?.state === "success" && delivery.description === "审查通过，未合并或发布") {
      return prResult("reviewed", number, pr, onlyReview);
    }
    if (delivery?.state === "failure") return prResult("delivery-failed", number, pr, onlyReview);
  }
  if (pr) await withdraw(pr, number, branch);
  if (remote !== head) {
    const ref = `refs/heads/${branch}`;
    git(path, "push", `--force-with-lease=${ref}:${remote}`, "origin", `${head}:${ref}`);
  }
  if (!pr) {
    try {
      pr = await github("pulls", { title: issue.title, head: branch, base: "main", body, draft: true });
    } catch (error) {
      pr = await findPR(number, branch);
      if (!pr) throw error;
    }
  }
  const prPath = `pulls/${pr.number}`;
  pr = verifyPR(await github(prPath), number, branch, head);
  const latestBody = pullBody(number, head, plan, proof, pr.body);
  if (pr.body?.trimEnd() !== latestBody.trimEnd()) {
    await github(prPath, { body: latestBody }, "PATCH");
  }
  const reviewLabel = autoDelivery && onlyReview;
  if (!reviewLabel) await removeLabel(prPath, pr, "deliver-review");
  if (!hasLabel(pr, "auto-agent-pr") || (reviewLabel && !hasLabel(pr, "deliver-review"))) {
    await setLabels(pr.number, reviewLabel ? ["auto-agent-pr", "deliver-review"] : ["auto-agent-pr"]);
  }
  const checked = verifyPR(await github(prPath), number, branch, head);
  if (checked.state !== "open" || checked.merged_at || checked.auto_merge !== null ||
      checked.body?.trimEnd() !== latestBody.trimEnd() || !hasLabel(checked, "auto-agent-pr") ||
      !!hasLabel(checked, "deliver-review") !== reviewLabel || hasLabel(checked, "deliver")) {
    throw new Error("无法核实 PR 正文、提交和交付标签。");
  }
  const latestPlan = verifyApproval(await readIssue(number));
  if (latestPlan.approval !== plan.approval || (await pendingDependencies(latestPlan)).length) {
    throw new Error("批准的 Issue 计划或前置事项已变更，PR 等待重新提交。");
  }
  if (!autoDelivery) return prResult(checked.draft ? "draft" : "pr-updated", number, checked, onlyReview);
  await setLabels(pr.number, ["deliver"]);
  const queued = verifyPR(await github(prPath), number, branch, head);
  if (!hasLabel(queued, "deliver") || !!hasLabel(queued, "deliver-review") !== onlyReview) {
    throw new Error("GitHub 未确认原生交付标签。");
  }
  return prResult("queued", number, queued, onlyReview);
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { file: { type: "string" } } });
  const [command] = positionals;
  if (positionals.length !== 1 || (command === "prepare" ? values.file !== undefined :
    command !== "submit" || !values.file)) throw new Error("用法：issue.mjs prepare 或 issue.mjs submit --file <proof.json>");
  const run = context();
  const { number, cancelled } = runIssue(run);
  if (cancelled) return { status: "paused", number };
  const issue = await readIssue(number);
  if (issue.state === "closed") return { status: "issue-closed", number, url: issue.html_url };
  const plan = verifyApproval(issue);
  const branch = `agent/issue-${number}`;
  const path = resolve(workDir, `issue-${number}`);
  return command === "prepare"
    ? prepare(run, issue, plan, branch, path)
    : submit(issue, plan, branch, path, resolve(values.file));
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await main()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
