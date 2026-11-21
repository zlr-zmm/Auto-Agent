// 飞书群轮询：调 superagent.mjs（确定性门禁），把准入消息变成 agent-autoloop 事件。
// 事件策略（控制 LLM 轮次）：
//   feishu.message — 每条准入消息一个事件（id=message_id，稳定）
//   loop.drive     — 仅当存在 queued 工单时发出（id=drive-<工单>-<状态>，状态不变不重发）
//   PR 合并回写（prs check）是确定性操作，由本脚本直接执行，不花 LLM 轮次
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const run = (args) => execFileSync(process.execPath, [join(HERE, "superagent.mjs"), ...args], {
  encoding: "utf8", maxBuffer: 32 * 1024 * 1024, cwd: HERE,
});

const cut = (text, length) => [...(text ?? "")].slice(0, length).join("");

let admitted = [];
try {
  admitted = JSON.parse(run(["poll"])).admitted ?? [];
} catch (error) {
  console.error(`poll 失败: ${error.message}`);
}

const events = admitted.map((t) => ({
  id: t.message_id,
  type: "feishu.message",
  subject: t.from.name,
  summary: cut(t.text, 200),
  detail: JSON.stringify(t),
  link: t.url,
}));

// 只有"待派发"的 queued 工单才需要 LLM 轮次；working/review 分别由该轮会话与人跟进
try {
  const lines = run(["ticket", "list"]).split("\n").filter(Boolean);
  for (const line of lines) {
    const m = /^(task-\S+)\s*\|\s*\S+\s*\|\s*(queued)\s*\|/.exec(line);
    if (m) events.push({ id: `drive-${m[1]}-${m[2]}`, type: "loop.drive", subject: m[1], summary: `${m[1]} 待派发执行` });
  }
} catch { /* ticket list 失败不阻塞消息事件 */ }

// PR merged/closed 回写与 epic 收口：确定性，直接做（epic 收口的群通知由 superagent.mjs 发出）
try {
  const closed = run(["prs", "check"]).trim();
  if (closed) console.log(closed);
} catch (error) {
  console.error(`prs check 失败: ${error.message}`);
}

console.log(`看了飞书群：${admitted.length} 条新消息，${events.length} 个事件`);
console.log("");
console.log("```agent-autoloop");
console.log(JSON.stringify({ events }));
console.log("```");
