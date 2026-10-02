// 插件持久状态：游标、去重集、标记表、线程头、离开模式、发信计数。
// 单文件 JSON，原子写（tmp + rename），权限 0600。写入量很小，直接同步写。

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const VERSION = 1;
const MAX_SEEN = 1000;
const MAX_REFS = 10;

export function emptyState() {
  return {
    version: VERSION,
    imap: { uidValidity: null, lastUid: null },
    seen: [],
    tokens: {},
    threads: {},
    away: { on: false, since: null, changedAt: null },
    sent: [],
  };
}

export class StateStore {
  /** @param {string} dir 状态目录，例如 ~/.dsh/dsh-mail */
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, "state.json");
    this.data = emptyState();
    this.loadError = null;
  }

  load() {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        this.data = { ...emptyState(), ...parsed, version: VERSION };
        this.data.imap = { ...emptyState().imap, ...(parsed.imap ?? {}) };
        this.data.away = { ...emptyState().away, ...(parsed.away ?? {}) };
      }
    } catch (error) {
      // 状态文件损坏：保留原文件以便排查，用空状态继续（空状态会重新取基线，不会回放历史邮件）
      this.loadError = String(error?.message ?? error);
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      this.data = emptyState();
    }
    return this;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* ignore */
    }
    renameSync(tmp, this.file);
  }

  // ── 去重 ────────────────────────────────────────────────
  hasSeen(messageId) {
    return typeof messageId === "string" && messageId.length > 0 && this.data.seen.includes(messageId);
  }

  markSeen(messageId) {
    if (typeof messageId !== "string" || messageId.length === 0 || this.hasSeen(messageId)) return;
    this.data.seen.push(messageId);
    if (this.data.seen.length > MAX_SEEN) this.data.seen.splice(0, this.data.seen.length - MAX_SEEN);
  }

  // ── 标记表 token → sessionId ────────────────────────────
  rememberToken(token, sessionId) {
    this.data.tokens[token] = sessionId;
  }

  sessionForToken(token) {
    return this.data.tokens[token];
  }

  // ── 线程头：每个会话记住最近一封入站回信 ─────────────────
  rememberInbound(sessionId, { messageId, references }) {
    if (typeof messageId !== "string" || messageId.length === 0) return;
    const refs = Array.isArray(references) ? references.filter((r) => typeof r === "string") : [];
    const chain = [...refs.filter((r) => r !== messageId), messageId].slice(-MAX_REFS);
    this.data.threads[sessionId] = { lastInboundMessageId: messageId, references: chain, at: new Date().toISOString() };
  }

  threadFor(sessionId) {
    return this.data.threads[sessionId];
  }

  // ── 离开模式 ───────────────────────────────────────────
  setAway(on) {
    const now = new Date().toISOString();
    const prev = this.data.away.on === true;
    this.data.away = { on: on === true, since: on ? (prev ? this.data.away.since : now) : null, changedAt: now };
    return this.data.away;
  }

  // ── 发信频率 ──────────────────────────────────────────
  sentInLast(ms, now = Date.now()) {
    return this.data.sent.filter((t) => now - Date.parse(t) < ms).length;
  }

  recordSent(now = Date.now()) {
    this.data.sent.push(new Date(now).toISOString());
    // 只保留 24 小时
    this.data.sent = this.data.sent.filter((t) => now - Date.parse(t) < 24 * 3600 * 1000);
  }
}

/** 审计日志：一行一个 JSON 事件。失败不影响主流程。 */
export function appendAudit(dir, entry) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    /* 审计是辅助性的 */
  }
}
