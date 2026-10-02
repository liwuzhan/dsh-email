// 会话标记：主题里的 [DSH#xxxxxxxx]，xxxxxxxx = 会话 id 中 UUID 的前 8 位十六进制。
// 标记是路由的唯一依据——不靠"最近活跃会话"猜，也不靠自建 Message-ID 匹配
// （AgentMail 等服务会改写出站 Message-ID，实测见工程选型报告 §4.3）。

import { createHash } from "node:crypto";

const UUID_HEAD = /([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MARKER = /\[DSH#([0-9a-f]{8})\]/i;

/** 由会话 id 推出 8 位标记；非 UUID 形态的 id 退化为哈希前缀（仍然稳定）。 */
export function tokenForSession(sessionId) {
  const m = UUID_HEAD.exec(String(sessionId));
  if (m) return m[1].toLowerCase();
  return createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 8);
}

export function markerFor(token) {
  return `[DSH#${token}]`;
}

/** 在主题任意位置找第一个标记（回信会加 "Re:" / "回复：" 前缀）。 */
export function findToken(subject) {
  if (typeof subject !== "string") return undefined;
  const m = MARKER.exec(subject);
  return m ? m[1].toLowerCase() : undefined;
}

/** 给模型写的主题加上标记；已经带了同一个标记就不重复加，带了别的标记先去掉。 */
export function withMarker(subject, token) {
  const clean = String(subject ?? "").replace(new RegExp(MARKER.source, "gi"), "").trim();
  return clean.length > 0 ? `${markerFor(token)} ${clean}` : markerFor(token);
}
