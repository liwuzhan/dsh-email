import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { normalizeConfig } from "../src/host/config.js";
import { composeInbound, Inbound } from "../src/host/inbound.js";
import { StateStore } from "../src/host/state.js";

const QQ_PASS = "amazonses.com; spf=pass; dkim=pass header.i=@qq.com; dmarc=pass header.from=qq.com;";
const SID = "session-5ca08658-1b2c-4d3e-8f90-0123456789ab";

function setup({ sessions = {}, cfgOverride = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mail-in-"));
  const { cfg, errors } = normalizeConfig({
    imap: { host: "imap.x", user: "bot@agentmail.to", passRef: "AGENTMAIL_API_KEY" },
    smtp: { host: "smtp.x" },
    sendAs: "bot@agentmail.to",
    notifyTo: "owner@qq.com",
    allowedFrom: ["owner@qq.com"],
    stateDir: dir,
    ...cfgOverride,
  });
  assert.deepEqual(errors, []);
  const state = new StateStore(dir).load();
  const queue = [];
  const mailbox = {
    seen: [],
    async fetchNew(cursor) {
      if (cursor.lastUid == null) return { cursor: { uidValidity: 7, lastUid: 10 }, baselined: true, messages: [] };
      const messages = queue.splice(0).filter((m) => m.uid > cursor.lastUid);
      return { cursor, baselined: false, messages };
    },
    async markSeen(uid) {
      this.seen.push(uid);
    },
  };
  const injected = [];
  const replies = [];
  const audits = [];
  const sess = {
    async findByToken(token) {
      return token === "5ca08658" ? { sessionId: SID } : { error: "not-found" };
    },
    async inject(sessionId, text, meta) {
      injected.push({ sessionId, text, meta });
      return { ok: true };
    },
    async listRecentMain() {
      return [{ sessionId: SID, token: "5ca08658", title: "构建修复", cwd: "/w", updatedAt: "2026-10-02T03:00:00Z" }];
    },
    ...sessions,
  };
  const inbound = new Inbound({
    cfg,
    state,
    mailbox,
    sessions: sess,
    reply: async (m) => replies.push(m),
    audit: (e) => audits.push(e),
  });
  return { inbound, state, queue, mailbox, injected, replies, audits };
}

let uid = 10;
function mail(over = {}) {
  uid += 1;
  return {
    uid,
    messageId: `<m${uid}@qq.com>`,
    references: ["<orig@ses>"],
    from: "owner@qq.com",
    subject: "回复：[DSH#5ca08658] 构建完成",
    date: "2026-10-02T03:10:00Z",
    text: "继续跑集成测试\n\n------------------ 原始邮件 ------------------\n旧内容",
    hasHtml: false,
    authResults: QQ_PASS,
    attachments: [],
    ...over,
  };
}

test("首次启动只取基线，不回放历史", async () => {
  const t = setup();
  const r = await t.inbound.pollOnce();
  assert.equal(r.baselined, true);
  assert.equal(t.state.data.imap.lastUid, 10);
  assert.equal(t.injected.length, 0);
});

test("白名单 + 认证通过 + 有标记 → 注入原会话，剥离引用，记线程头，游标推进", async () => {
  const t = setup();
  await t.inbound.pollOnce();
  const m = mail();
  t.queue.push(m);
  await t.inbound.pollOnce();
  assert.equal(t.injected.length, 1);
  assert.equal(t.injected[0].sessionId, SID);
  assert.match(t.injected[0].text, /继续跑集成测试/);
  assert.doesNotMatch(t.injected[0].text, /旧内容/);
  assert.match(t.injected[0].text, /发件人：owner@qq.com/);
  assert.equal(t.state.data.imap.lastUid, m.uid);
  assert.equal(t.state.threadFor(SID).lastInboundMessageId, m.messageId);
  assert.equal(t.state.sessionForToken("5ca08658"), SID);
  assert.deepEqual(t.mailbox.seen, [m.uid]);
  assert.equal(t.replies.length, 0);
});

test("重复 Message-ID 不重复注入", async () => {
  const t = setup();
  await t.inbound.pollOnce();
  const m = mail();
  t.queue.push(m);
  await t.inbound.pollOnce();
  t.queue.push({ ...m, uid: m.uid + 100 });
  await t.inbound.pollOnce();
  assert.equal(t.injected.length, 1);
  assert.equal(t.audits.at(-1).action, "ignored");
});

test("非白名单：不注入、不回信", async () => {
  const t = setup();
  await t.inbound.pollOnce();
  t.queue.push(mail({ from: "attacker@evil.com", authResults: "mx; dmarc=pass header.from=evil.com" }));
  await t.inbound.pollOnce();
  assert.equal(t.injected.length, 0);
  assert.equal(t.replies.length, 0);
  assert.equal(t.audits.at(-1).action, "rejected");
});

test("白名单地址但 DMARC fail（伪造）：不注入、不回信", async () => {
  const t = setup();
  await t.inbound.pollOnce();
  t.queue.push(mail({ authResults: "mx; spf=fail; dkim=none; dmarc=fail header.from=qq.com" }));
  await t.inbound.pollOnce();
  assert.equal(t.injected.length, 0);
  assert.equal(t.replies.length, 0);
  assert.match(t.audits.at(-1).reason, /dmarc=fail/);
});

test("自己发出的邮件被忽略（防自环）", async () => {
  const t = setup({ cfgOverride: { allowedFrom: ["owner@qq.com", "bot@agentmail.to"] } });
  await t.inbound.pollOnce();
  t.queue.push(mail({ from: "bot@agentmail.to" }));
  await t.inbound.pollOnce();
  assert.equal(t.injected.length, 0);
  assert.equal(t.audits.at(-1).action, "ignored");
});

test("没有标记：不注入，回执带会话列表与线程头", async () => {
  const t = setup();
  await t.inbound.pollOnce();
  const m = mail({ subject: "在吗" });
  t.queue.push(m);
  await t.inbound.pollOnce();
  assert.equal(t.injected.length, 0);
  assert.equal(t.replies.length, 1);
  assert.equal(t.replies[0].to, "owner@qq.com");
  assert.equal(t.replies[0].subject, "Re: 在吗");
  assert.equal(t.replies[0].inReplyTo, m.messageId);
  assert.match(t.replies[0].text, /\[DSH#5ca08658\]  构建修复/);
});

test("标记找不到会话：回执说明，不注入", async () => {
  const t = setup();
  await t.inbound.pollOnce();
  t.queue.push(mail({ subject: "Re: [DSH#deadbeef] x" }));
  await t.inbound.pollOnce();
  assert.equal(t.injected.length, 0);
  assert.match(t.replies[0].text, /找不到标记 \[DSH#deadbeef\]/);
  assert.equal(t.replies[0].subject, "Re: [DSH#deadbeef] x");
});

test("暂时性失败：不推进游标、抛错等重试；第 3 次放弃并回执", async () => {
  let calls = 0;
  const t = setup({
    sessions: {
      async inject() {
        calls += 1;
        return { ok: false, code: "transient", message: "writer-held" };
      },
    },
  });
  await t.inbound.pollOnce();
  const m = mail();
  for (let i = 0; i < 2; i += 1) {
    t.queue.push(m);
    await assert.rejects(t.inbound.pollOnce(), /稍后重试/);
    assert.equal(t.state.data.imap.lastUid, 10, "失败时游标不动");
  }
  t.queue.push(m);
  await t.inbound.pollOnce();
  assert.equal(calls, 3);
  assert.equal(t.state.data.imap.lastUid, m.uid);
  assert.equal(t.replies.length, 1);
  assert.equal(t.audits.at(-1).action, "failed");
});

test("会话无法恢复（永久错误）：回执，不重试", async () => {
  const t = setup({
    sessions: {
      async inject() {
        return { ok: false, code: "session/not-found", message: "gone" };
      },
    },
  });
  await t.inbound.pollOnce();
  t.queue.push(mail());
  await t.inbound.pollOnce();
  assert.equal(t.replies.length, 1);
  assert.match(t.replies[0].text, /无法恢复/);
});

test("composeInbound：附件只列名、正文截断提示、内嵌图片不列", () => {
  const { cfg } = normalizeConfig({ maxBodyChars: 1000 });
  const text = composeInbound(
    mail({
      text: "x".repeat(1500),
      attachments: [
        { index: 0, filename: "log.txt", contentType: "text/plain", size: 2048, related: false },
        { index: 1, filename: "sig.png", contentType: "image/png", size: 10, related: true },
      ],
    }),
    cfg,
  );
  assert.match(text, /#0 log\.txt（text\/plain，2\.0 KB）/);
  assert.doesNotMatch(text, /sig\.png/);
  assert.match(text, /正文过长已截断（原 1500 字符）/);
});

test("配置校验：缺失项给出可读错误，notifyTo 不能等于 sendAs", () => {
  const { errors } = normalizeConfig({ sendAs: "a@x.com", notifyTo: "a@x.com", allowedFrom: ["*"] });
  assert.ok(errors.some((e) => e.includes("imap.host")));
  assert.ok(errors.some((e) => e.includes("notifyTo 不能等于 sendAs")));
  assert.ok(errors.some((e) => e.includes("禁止通配")));
});
