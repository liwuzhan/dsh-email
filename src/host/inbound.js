// 入站：拉取 → 去重 → 准入（自环 / 白名单 / 认证头）→ 路由（主题标记）→ 注入 / 回执。
// 与 DSH 解耦：会话操作通过 sessions 适配器注入，便于用假实现测试。

import { judgeAuth } from "./auth.js";
import { formatBytes, stripQuoted, truncate } from "./body.js";
import { findToken, markerFor } from "./subject.js";

const MAX_ATTEMPTS = 3;

export function localTime(iso) {
  if (!iso) return "未知";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

/** 构造注入会话的正文：来源头 + 清洗后的正文。 */
export function composeInbound(m, cfg) {
  const body = truncate(stripQuoted(m.text || (m.hasHtml ? "（这封邮件只有 HTML 正文，可用 mail_read 查看）" : "")), cfg.maxBodyChars);
  const lines = [
    "【邮件】你的用户通过邮件发来以下消息（发件人已通过白名单校验）。",
    `发件人：${m.from}`,
    `时间：${localTime(m.date)}`,
    `主题：${m.subject}`,
  ];
  const files = m.attachments.filter((a) => !a.related);
  if (files.length > 0) {
    lines.push(`附件（未打开）：${files.map((a) => `#${a.index} ${a.filename}（${a.contentType}，${formatBytes(a.size)}）`).join("；")}`);
    lines.push(`  需要查看时调用 mail_attachment（uid=${m.uid}，index=附件编号）下载到本地。`);
  }
  if (body.truncated) lines.push(`正文过长已截断（原 ${body.originalChars} 字符），全文可用 mail_read（uid=${m.uid}）查看。`);
  lines.push("如需回复用户，请使用 mail_send（会自动回到这封邮件所在的线程）。");
  lines.push("────────");
  lines.push(body.text.length > 0 ? body.text : "（正文为空）");
  return lines.join("\n");
}

function replySubject(subject) {
  return /^(re|回复)\s*[:：]/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

export class Inbound {
  /**
   * @param {object} deps
   * @param {object} deps.cfg 规范化后的配置
   * @param {import('./state.js').StateStore} deps.state
   * @param {{ fetchNew: Function, markSeen: Function }} deps.mailbox
   * @param {{ findByToken(token): Promise<{sessionId:string}|{error:string, detail?:string}>,
   *           inject(sessionId, text, meta): Promise<{ok:true}|{ok:false, code:string, message:string}>,
   *           listRecentMain(n): Promise<{sessionId:string,title:string|null,cwd:string|null,updatedAt:string|null}[]> }} deps.sessions
   * @param {(mail: object) => Promise<void>} deps.reply 系统回执（不受模型控制）
   * @param {(entry: object) => void} deps.audit
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.attempts = new Map(); // uid → 失败次数（只在内存里）
  }

  /** 一轮拉取。返回本轮处理摘要。 */
  async pollOnce() {
    const cursor = { uidValidity: this.state.data.imap.uidValidity, lastUid: this.state.data.imap.lastUid };
    const res = await this.mailbox.fetchNew(cursor);
    if (res.baselined) {
      this.state.data.imap = { uidValidity: res.cursor.uidValidity, lastUid: res.cursor.lastUid };
      this.state.save();
      this.audit({ type: "baseline", cursor: res.cursor, reason: cursor.lastUid == null ? "首次启动" : "UIDVALIDITY 变化" });
      return { baselined: true, processed: 0 };
    }
    let processed = 0;
    for (const m of res.messages) {
      let decision;
      try {
        decision = await this.handle(m);
      } catch (error) {
        decision = { action: "retry", reason: String(error?.message ?? error) };
      }
      if (decision.action === "retry") {
        const n = (this.attempts.get(m.uid) ?? 0) + 1;
        this.attempts.set(m.uid, n);
        if (n < MAX_ATTEMPTS) {
          this.audit({ type: "inbound", uid: m.uid, action: "retry", attempt: n, reason: decision.reason });
          throw new Error(`处理邮件 uid=${m.uid} 失败（第 ${n} 次，稍后重试）：${decision.reason}`);
        }
        decision = { action: "failed", reason: `重试 ${n} 次仍失败：${decision.reason}` };
        await this.safeReply(m, `这封邮件没能送进 DSH 会话（${decision.reason}）。请稍后重发，或回到电脑前查看。`);
      }
      this.attempts.delete(m.uid);
      this.state.markSeen(m.messageId);
      this.state.data.imap.lastUid = Math.max(this.state.data.imap.lastUid ?? 0, m.uid);
      this.state.save();
      this.audit({
        type: "inbound",
        uid: m.uid,
        messageId: m.messageId,
        from: m.from,
        subject: m.subject,
        action: decision.action,
        reason: decision.reason,
        sessionId: decision.sessionId,
      });
      if (decision.action === "injected") await this.mailbox.markSeen(m.uid);
      processed += 1;
    }
    return { baselined: false, processed };
  }

  /** 单封邮件的处理决定。 */
  async handle(m) {
    const cfg = this.cfg;
    if (this.state.hasSeen(m.messageId)) return { action: "ignored", reason: "重复投递（Message-ID 已处理过）" };
    if (m.from === cfg.sendAs) return { action: "ignored", reason: "本插件自己发出的邮件" };
    if (!cfg.allowedFrom.includes(m.from)) return { action: "rejected", reason: "发件人不在白名单" };
    const auth = judgeAuth(m.authResults, m.from, cfg.authCheck);
    if (!auth.ok) return { action: "rejected", reason: `认证未通过：${auth.reason}` };

    const token = findToken(m.subject);
    if (token === undefined) {
      await this.replyNoMarker(m);
      return { action: "replied", reason: "主题里没有会话标记，已回复会话列表" };
    }
    const found = await this.sessions.findByToken(token);
    if ("error" in found) {
      const why = found.error === "ambiguous" ? `标记 ${markerFor(token)} 对应多个会话` : `找不到标记 ${markerFor(token)} 对应的会话（可能已删除）`;
      await this.safeReply(m, `${why}，这封邮件没有送进任何会话。${found.detail ? `\n${found.detail}` : ""}`);
      return { action: "replied", reason: why };
    }
    const text = composeInbound(m, cfg);
    const result = await this.sessions.inject(found.sessionId, text, {
      uid: m.uid,
      messageId: m.messageId,
      from: m.from,
      subject: m.subject,
    });
    if (!result.ok) {
      if (result.code === "transient") return { action: "retry", reason: result.message };
      await this.safeReply(m, `会话 ${markerFor(token)} 无法恢复（${result.code}：${result.message}），这封邮件没有送进会话。`);
      return { action: "replied", reason: `会话无法恢复：${result.code}`, sessionId: found.sessionId };
    }
    this.state.rememberToken(token, found.sessionId);
    this.state.rememberInbound(found.sessionId, { messageId: m.messageId, references: m.references });
    return { action: "injected", reason: auth.reason, sessionId: found.sessionId };
  }

  async replyNoMarker(m) {
    let list = [];
    try {
      list = await this.sessions.listRecentMain(10);
    } catch {
      /* 列表拿不到也要回执 */
    }
    const rows = list.map(
      (s) => `${markerFor(s.token)}  ${s.title ?? "（无标题）"}${s.cwd ? `\n    工作区：${s.cwd}` : ""}${s.updatedAt ? `\n    最近活动：${localTime(s.updatedAt)}` : ""}`,
    );
    await this.safeReply(
      m,
      [
        "这封邮件的主题里没有会话标记，所以没有送进任何 DSH 会话。",
        "",
        "用法：直接回复某个会话发给你的邮件即可；或者新写一封邮件，把下面某个标记放进主题（例如「[DSH#1234abcd] 继续跑测试」）。",
        "",
        rows.length > 0 ? `最近的会话：\n\n${rows.join("\n\n")}` : "（暂时列不出会话）",
      ].join("\n"),
    );
  }

  async safeReply(m, text) {
    try {
      await this.reply({
        to: m.from,
        subject: replySubject(m.subject || "（无主题）"),
        text: `${text}\n\n—— dsh-mail 自动回执`,
        inReplyTo: m.messageId ?? undefined,
        references: [...(m.references ?? []), ...(m.messageId ? [m.messageId] : [])],
      });
    } catch (error) {
      this.audit({ type: "reply-failed", uid: m.uid, error: String(error?.message ?? error) });
    }
  }
}
