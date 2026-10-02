import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { judgeAuth, normalizeAddress, parseAuthResults, validateAllowList } from "../src/host/auth.js";
import { stripQuoted, truncate } from "../src/host/body.js";
import { StateStore } from "../src/host/state.js";
import { findToken, tokenForSession, withMarker } from "../src/host/subject.js";

// ── 主题标记 ─────────────────────────────────────────────
test("tokenForSession 取 UUID 前 8 位", () => {
  assert.equal(tokenForSession("session-5ca08658-1b2c-4d3e-8f90-0123456789ab"), "5ca08658");
  assert.equal(tokenForSession("5CA08658-1B2C-4D3E-8F90-0123456789AB"), "5ca08658");
  assert.match(tokenForSession("weird-id"), /^[0-9a-f]{8}$/);
  assert.equal(tokenForSession("weird-id"), tokenForSession("weird-id"));
});

test("findToken 能穿过 Re:/回复：前缀，大小写不敏感", () => {
  assert.equal(findToken("回复：[DSH#5ca08658] 构建完成"), "5ca08658");
  assert.equal(findToken("Re: Re: [dsh#5CA08658] x"), "5ca08658");
  assert.equal(findToken("没有标记"), undefined);
  assert.equal(findToken("[DSH#12345] 位数不够"), undefined);
});

test("withMarker 不重复加，并替换其他标记", () => {
  assert.equal(withMarker("构建完成", "aaaaaaaa"), "[DSH#aaaaaaaa] 构建完成");
  assert.equal(withMarker("[DSH#aaaaaaaa] 构建完成", "aaaaaaaa"), "[DSH#aaaaaaaa] 构建完成");
  assert.equal(withMarker("[DSH#bbbbbbbb] 构建完成", "aaaaaaaa"), "[DSH#aaaaaaaa] 构建完成");
  assert.equal(withMarker("", "aaaaaaaa"), "[DSH#aaaaaaaa]");
});

// ── 白名单 ───────────────────────────────────────────────
test("validateAllowList 必填、禁通配、规范化", () => {
  assert.equal(validateAllowList([]).ok, false);
  assert.equal(validateAllowList(undefined).ok, false);
  assert.equal(validateAllowList(["*"]).ok, false);
  assert.equal(validateAllowList(["*@qq.com"]).ok, false);
  assert.equal(validateAllowList([""]).ok, false);
  assert.equal(validateAllowList(["any"]).ok, false);
  assert.equal(validateAllowList(["not-an-email"]).ok, false);
  assert.deepEqual(validateAllowList(["Me <owner@QQ.com>", "owner@qq.com"]), {
    ok: true,
    list: ["owner@qq.com"],
  });
  assert.equal(normalizeAddress(" A@B.com "), "a@b.com");
});

// ── 认证头（真实样本，选型报告 §4.2）──────────────────────
const QQ_REAL =
  "amazonses.com; spf=pass (spfCheck: domain of qq.com designates 43.163.128.43 as permitted sender) client-ip=43.163.128.43; envelope-from=owner@qq.com; helo=xmbghk7.mail.qq.com; dkim=pass header.i=@qq.com; dmarc=pass header.from=qq.com;";

test("parseAuthResults 解析真实 QQ 来信", () => {
  const r = parseAuthResults(QQ_REAL);
  assert.deepEqual(r.spf, ["pass"]);
  assert.deepEqual(r.dkim, ["pass"]);
  assert.deepEqual(r.dmarc, ["pass"]);
  assert.equal(r.dmarcFrom, "qq.com");
});

test("judgeAuth 各分支", () => {
  assert.equal(judgeAuth(QQ_REAL, "owner@qq.com").ok, true);
  // dmarc 通过的域与发件域不一致 → 拒
  assert.equal(judgeAuth(QQ_REAL, "boss@163.com").ok, false);
  assert.equal(judgeAuth("mx.example; dmarc=fail header.from=qq.com", "owner@qq.com").ok, false);
  // 无头：auto 放行、strict 拒
  assert.equal(judgeAuth(undefined, "a@qq.com", "auto").ok, true);
  assert.equal(judgeAuth(undefined, "a@qq.com", "strict").ok, false);
  assert.equal(judgeAuth(undefined, "a@qq.com", "off").ok, true);
  // 无 dmarc：spf fail 且 dkim 不过 → 拒
  assert.equal(judgeAuth("mx; spf=fail smtp.mailfrom=qq.com; dkim=none", "a@qq.com").ok, false);
  assert.equal(judgeAuth("mx; spf=softfail; dkim=pass header.i=@qq.com", "a@qq.com").ok, true);
  // 注释里的 pass 不能骗过判定
  assert.equal(judgeAuth("mx; spf=fail (dkim=pass dmarc=pass) smtp.mailfrom=qq.com", "a@qq.com").ok, false);
  // 结果不明确
  assert.equal(judgeAuth("mx; spf=none; dkim=none", "a@qq.com", "auto").ok, true);
  assert.equal(judgeAuth("mx; spf=none; dkim=none", "a@qq.com", "strict").ok, false);
});

// ── 正文清洗 ─────────────────────────────────────────────
test("stripQuoted：QQ 原始邮件分隔线", () => {
  const t = "好的，继续跑测试。\n\n\n------------------ 原始邮件 ------------------\n发件人: bot@agentmail.to\n汇报全文……";
  assert.equal(stripQuoted(t), "好的，继续跑测试。");
});

test("stripQuoted：Gmail 中文/英文与 > 引用", () => {
  assert.equal(stripQuoted("收到\n\n在 2026年10月1日周三 15:00，DSH <bot@agentmail.to> 写道：\n> 汇报"), "收到");
  assert.equal(stripQuoted("ok go\n\nOn Tue, Oct 1, 2026 at 3:00 PM DSH <dsh@x.to>\nwrote:\n> old"), "ok go");
  assert.equal(stripQuoted("a\n> quoted\nb"), "a\nb");
});

test("stripQuoted：Outlook 头块；全被剥光时退回原文", () => {
  assert.equal(stripQuoted("继续\n\n发件人: DSH\n发送时间: 2026-10-01\n主题: x\n正文"), "继续");
  assert.equal(stripQuoted("> 只有引用"), "> 只有引用");
});

test("truncate", () => {
  assert.deepEqual(truncate("abcdef", 3), { text: "abc", truncated: true, originalChars: 6 });
  assert.deepEqual(truncate("abc", 3), { text: "abc", truncated: false, originalChars: 3 });
});

// ── 状态 ─────────────────────────────────────────────────
test("StateStore 原子落盘、0600、去重、线程、离开模式、频率", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mail-"));
  const s = new StateStore(dir).load();
  s.markSeen("<a@x>");
  s.markSeen("<a@x>");
  s.rememberToken("5ca08658", "session-5ca08658-x");
  s.rememberInbound("session-5ca08658-x", { messageId: "<r2@qq>", references: ["<o1@ses>", "<r2@qq>"] });
  const away = s.setAway(true);
  assert.equal(away.on, true);
  const since = away.since;
  assert.equal(s.setAway(true).since, since, "重复打开不改 since");
  s.recordSent();
  s.save();
  assert.equal(statSync(join(dir, "state.json")).mode & 0o777, 0o600);

  const s2 = new StateStore(dir).load();
  assert.equal(s2.hasSeen("<a@x>"), true);
  assert.equal(s2.data.seen.length, 1);
  assert.equal(s2.sessionForToken("5ca08658"), "session-5ca08658-x");
  assert.deepEqual(s2.threadFor("session-5ca08658-x").references, ["<o1@ses>", "<r2@qq>"]);
  assert.equal(s2.data.away.on, true);
  assert.equal(s2.sentInLast(3600_000), 1);
  assert.equal(s2.setAway(false).since, null);
});

test("StateStore 损坏文件被隔离，回到空状态", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mail-"));
  writeFileSync(join(dir, "state.json"), "{not json");
  const s = new StateStore(dir).load();
  assert.ok(s.loadError);
  assert.equal(s.data.imap.lastUid, null);
  s.save();
  assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).version, 1);
});
