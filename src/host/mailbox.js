// 邮箱收发层：通用 IMAP（imapflow）+ SMTP（nodemailer）+ 解析（mailparser）。
// 与 DSH 无关，便于单独测试。密码通过 getPassword(kind) 按需解析（不缓存明文到状态里）。

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

import { normalizeAddress } from "./auth.js";

const MAX_SOURCE_BYTES = 25 * 1024 * 1024; // 超过这个大小只解析头，不拉正文

/** 从 mailparser 的结果里拿第一条（最上面）某个头的原始值，已去掉头名与折行。 */
export function firstHeaderLine(parsed, name) {
  const key = name.toLowerCase();
  const hit = (parsed.headerLines ?? []).find((h) => h.key === key);
  if (!hit) return undefined;
  return hit.line.replace(/^[^:]+:\s*/, "").replace(/\r?\n[ \t]+/g, " ").trim();
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.length > 0) return v.split(/\s+/).filter(Boolean);
  return [];
}

/** 把 mailparser 结果整理成插件内部用的形状。 */
export function summarizeParsed(uid, parsed, size) {
  const fromAddr = parsed.from?.value?.[0]?.address ?? "";
  return {
    uid,
    size,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: asArray(parsed.references),
    from: normalizeAddress(fromAddr),
    fromDisplay: parsed.from?.text ?? fromAddr,
    to: parsed.to?.text ?? "",
    subject: parsed.subject ?? "",
    date: parsed.date ? parsed.date.toISOString() : null,
    text: typeof parsed.text === "string" ? parsed.text : "",
    hasHtml: typeof parsed.html === "string" && parsed.html.length > 0,
    authResults: firstHeaderLine(parsed, "authentication-results"),
    attachments: (parsed.attachments ?? []).map((a, index) => ({
      index,
      filename: a.filename ?? `attachment-${index + 1}`,
      contentType: a.contentType ?? "application/octet-stream",
      size: a.size ?? a.content?.length ?? 0,
      related: a.related === true, // 正文内嵌图片
    })),
  };
}

export class Mailbox {
  /**
   * @param {object} cfg { imap:{host,port,secure,user}, smtp:{host,port,secure,user}, sendAs }
   * @param {(kind: "imap"|"smtp") => Promise<string>} getPassword
   */
  constructor(cfg, getPassword) {
    this.cfg = cfg;
    this.getPassword = getPassword;
    this.active = new Set(); // 正在使用的 IMAP 连接（卸载时一并关掉）
    this.transport = null;
    this.closed = false;
  }

  /** 凭据轮换等场景：丢弃发信连接（IMAP 本来就是每次新建）。 */
  async reset() {
    try {
      this.transport?.close();
    } catch {
      /* ignore */
    }
    this.transport = null;
  }

  /**
   * 每次操作新建一条 IMAP 连接，选中 INBOX，用完立即登出。
   *
   * 为什么不复用长连接：实测 AgentMail 的 IMAP 会话在 SELECT 之后视图是冻结的——
   * 新邮件已到（API 与新连接都能看到 UID 6），复用的那条连接 3 分钟后仍只看到 5 封，
   * 不发 EXISTS。每次新建连接让服务器返回当下的 EXISTS/UIDNEXT，对任何服务器都成立。
   */
  async withInbox(fn) {
    if (this.closed) throw new Error("mailbox closed");
    const { host, port, secure, user } = this.cfg.imap;
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass: await this.getPassword("imap") },
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      socketTimeout: 60_000,
    });
    client.on("error", () => {
      /* 错误由当前操作的 await 感知；这里只防止未处理事件崩进程 */
    });
    this.active.add(client);
    try {
      await client.connect();
      if (this.closed) throw new Error("mailbox closed");
      const lock = await client.getMailboxLock("INBOX");
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      this.active.delete(client);
      await client.logout().catch(() => {
        try {
          client.close();
        } catch {
          /* ignore */
        }
      });
    }
  }

  /** 兼容旧调用：没有长连接可丢。 */
  async dropImap() {}

  async close() {
    this.closed = true;
    for (const c of [...this.active]) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
    await this.reset();
  }

  /**
   * 收件箱当前最大的 UID（空邮箱为 0）。
   *
   * 不能用 SELECT 的 UIDNEXT 算：RFC 3501 里 UIDNEXT 是可选响应码，163 就不返回
   * （实测 `mailbox.uidNext === undefined`，`Number(undefined) - 1` 得到 NaN，
   * 之后拼出 "NaN:*" 这样的 sequence set 直接抛 InvalidSequenceSet）。
   * 也不能按序号取最后一封：163 对 `N:N`（如 `1:1`）返回空，只认 `1:*`。
   * 所以统一走 `1:*`（包含全部邮件）取最大 UID——空邮箱与各家服务器都适用。
   */
  async topUidLocked(client) {
    const exists = Number(client.mailbox?.exists ?? 0);
    if (!Number.isFinite(exists) || exists <= 0) return 0;
    let top = 0;
    for await (const m of client.fetch("1:*", { uid: true }, { uid: true })) {
      if (Number.isFinite(m.uid) && m.uid > top) top = m.uid;
    }
    return top;
  }

  /**
   * 拉取 lastUid 之后的新邮件。cursor 为 { uidValidity, lastUid }。
   * - 首次（lastUid=null）或 UIDVALIDITY 变化：只取基线，不返回邮件（不回放历史）。
   * @returns {Promise<{ cursor: {uidValidity:number,lastUid:number}, baselined: boolean, messages: object[] }>}
   */
  async fetchNew(cursor) {
    return this.withInbox(async (client) => {
      const box = client.mailbox;
      const uidValidity = Number(box.uidValidity);
      const top = await this.topUidLocked(client);
      if (cursor.lastUid == null || cursor.uidValidity !== uidValidity) {
        return { cursor: { uidValidity, lastUid: top }, baselined: true, messages: [] };
      }
      if (top <= cursor.lastUid) return { cursor: { uidValidity, lastUid: cursor.lastUid }, baselined: false, messages: [] };
      const metas = [];
      // 注意：`N:*` 在没有更大 UID 时会返回最大的那封，所以要再按 uid 过滤
      for await (const m of client.fetch(`${cursor.lastUid + 1}:*`, { uid: true, size: true }, { uid: true })) {
        if (m.uid > cursor.lastUid) metas.push({ uid: m.uid, size: m.size });
      }
      metas.sort((a, b) => a.uid - b.uid);
      const messages = [];
      for (const meta of metas) {
        messages.push(await this.fetchOneLocked(client, meta.uid, meta.size));
      }
      return { cursor: { uidValidity, lastUid: cursor.lastUid }, baselined: false, messages };
    });
  }

  async fetchOneLocked(client, uid, size, { withContent = false } = {}) {
    if (Number.isFinite(size) && size > MAX_SOURCE_BYTES) {
      const head = await client.fetchOne(String(uid), { uid: true, headers: true }, { uid: true });
      const parsed = await simpleParser(head?.headers ?? Buffer.alloc(0));
      const out = summarizeParsed(uid, parsed, size);
      out.text = `（邮件过大：${size} 字节，正文未解析）`;
      return out;
    }
    const msg = await client.fetchOne(String(uid), { uid: true, source: true, size: true }, { uid: true });
    if (!msg) throw new Error(`邮件 uid=${uid} 不存在`);
    const parsed = await simpleParser(msg.source);
    const out = summarizeParsed(uid, parsed, msg.size ?? size);
    if (withContent) out._attachments = parsed.attachments ?? [];
    return out;
  }

  /** 读取单封邮件（全文；withContent 时带附件二进制）。 */
  async read(uid, opts = {}) {
    return this.withInbox((client) => this.fetchOneLocked(client, Number(uid), undefined, opts));
  }

  /** 列出最近 n 封（只取信封，不拉正文）。 */
  async listRecent(n = 10) {
    return this.withInbox(async (client) => {
      const total = Number(client.mailbox.exists ?? 0);
      if (total === 0) return [];
      const start = Math.max(1, total - n + 1);
      const out = [];
      for await (const m of client.fetch(`${start}:*`, { uid: true, envelope: true, size: true, flags: true })) {
        out.push({
          uid: m.uid,
          date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
          from: normalizeAddress(m.envelope?.from?.[0]?.address ?? ""),
          subject: m.envelope?.subject ?? "",
          size: m.size,
          seen: m.flags?.has?.("\\Seen") ?? false,
        });
      }
      return out.sort((a, b) => b.uid - a.uid);
    });
  }

  async markSeen(uid) {
    try {
      await this.withInbox((client) => client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }));
    } catch {
      /* 已读标记是锦上添花，失败不影响 */
    }
  }

  async smtp() {
    if (this.transport) return this.transport;
    const { host, port, secure, user } = this.cfg.smtp;
    this.transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass: await this.getPassword("smtp") },
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
    });
    return this.transport;
  }

  /**
   * @param {{to:string, subject:string, text:string, inReplyTo?:string, references?:string[], attachments?:{path:string, filename?:string}[]}} mail
   */
  async send(mail) {
    const transport = await this.smtp();
    try {
      const info = await transport.sendMail({
        from: this.cfg.sendAs,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        inReplyTo: mail.inReplyTo,
        references: mail.references && mail.references.length > 0 ? mail.references : undefined,
        attachments: mail.attachments,
      });
      return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, response: info.response };
    } catch (error) {
      // 连接级错误时丢弃 transport，下次重建（例如密码轮换后）
      try {
        this.transport?.close();
      } catch {
        /* ignore */
      }
      this.transport = null;
      throw error;
    }
  }
}
