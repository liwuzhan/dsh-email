// 回信正文清洗：去掉客户端自动引用的原文，避免把我们自己发出的整封汇报再喂回会话。
// 规则是启发式的；如果清洗后什么都不剩，就退回原文（宁可多给，不能把指令吞掉）。

const CUT_LINE_PATTERNS = [
  /^-{2,}\s*原始邮件\s*-{2,}\s*$/, // QQ / Foxmail
  /^-{2,}\s*(?:original|原始)(?:\s+message)?\s*-{2,}\s*$/i, // QQ 英文版 / Outlook
  /^-{2,}\s*回复的原邮件\s*-{2,}\s*$/, // 163
  /^在.{0,120}写道\s*[:：]\s*$/, // Gmail / Apple Mail 中文
  /^On .{0,240}wrote:\s*$/i, // Gmail / Apple Mail 英文
  /^_{8,}\s*$/, // Outlook 分隔线
];

const HEADER_BLOCK_START = /^(?:发件人|From)\s*[:：]/i;
const HEADER_BLOCK_NEXT = /^(?:发送时间|日期|时间|Sent|Date|收件人|To|主题|Subject)\s*[:：]/i;

/** 剥离引用原文，返回新文本。 */
export function stripQuoted(text) {
  if (typeof text !== "string") return "";
  const lines = text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (CUT_LINE_PATTERNS.some((re) => re.test(line))) {
      cut = i;
      break;
    }
    // "On Tue, 1 Oct 2026 at 15:00, Foo <foo@x>" 换行后才 "wrote:" 的情况
    if (/^On .{0,240}$/i.test(line) && /wrote:\s*$/i.test((lines[i + 1] ?? "").trim())) {
      cut = i;
      break;
    }
    // Outlook 风格：「发件人: … / 发送时间: …」块
    if (HEADER_BLOCK_START.test(line) && lines.slice(i + 1, i + 4).some((l) => HEADER_BLOCK_NEXT.test(l.trim()))) {
      cut = i;
      break;
    }
  }
  const kept = lines
    .slice(0, cut)
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return kept.length > 0 ? kept : text.trim();
}

/** 按字符数截断，返回 { text, truncated, originalChars }。 */
export function truncate(text, maxChars) {
  const s = String(text ?? "");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || s.length <= maxChars) {
    return { text: s, truncated: false, originalChars: s.length };
  }
  return { text: s.slice(0, maxChars), truncated: true, originalChars: s.length };
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
