// Mailbox 的服务器兼容性回归测试。
//
// 起因：163 邮箱的 SELECT 不返回 UIDNEXT（RFC 3501 里它是可选响应码），
// 原来的实现用 `Number(box.uidNext) - 1` 算基线 → NaN → 拼出 "NaN:*" →
// imapflow 抛 InvalidSequenceSet。这里用一个不返回 uidNext 的假客户端钉住行为。

import assert from "node:assert/strict";
import { test } from "node:test";

import { Mailbox } from "../src/host/mailbox.js";

/** 假 imapflow 客户端：只实现 fetchNew 用到的部分。 */
function fakeClient({ exists, uidValidity = 1, uidNext = undefined, messages = [] }) {
  return {
    mailbox: { path: "INBOX", exists, uidValidity, uidNext },
    async connect() {},
    async logout() {},
    close() {},
    async getMailboxLock() {
      return { release() {} };
    },
    // 反映 163 的真实行为：只认 `1:*` 这类范围，按序号取单封（N:N）返回空
    fetch(range, _query, _opts) {
      const rows = [];
      if (range === "1:*" || /^\d+:\*$/.test(range)) {
        const from = range === "1:*" ? 0 : Number(range.split(":")[0]);
        for (const m of messages) if (m.uid >= from) rows.push({ uid: m.uid, size: m.size, source: m.source });
      }
      // N:N 一律返回空（163 就是这样）
      return (async function* () {
        for (const r of rows) yield r;
      })();
    },
    async fetchOne(uid) {
      const m = messages.find((x) => x.uid === Number(uid));
      return m ? { uid: m.uid, size: m.size, source: m.source } : false;
    },
  };
}

function mailboxWith(client) {
  const mb = new Mailbox({ imap: { host: "h", port: 993, secure: true, user: "u" }, smtp: {}, sendAs: "u" }, async () => "p");
  mb.withInbox = (fn) => fn(client);
  return mb;
}

const raw = (subject, body) =>
  Buffer.from(`From: a@b.com\r\nTo: u@x.com\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@b>\r\n\r\n${body}\r\n`);

test("空邮箱且服务器不返回 UIDNEXT：基线为 0，不抛错", async () => {
  const mb = mailboxWith(fakeClient({ exists: 0 }));
  const r = await mb.fetchNew({ uidValidity: null, lastUid: null });
  assert.deepEqual(r, { cursor: { uidValidity: 1, lastUid: 0 }, baselined: true, messages: [] });
});

test("无 UIDNEXT、已有邮件：基线取最后一封的 UID（不回放历史）", async () => {
  const mb = mailboxWith(fakeClient({ exists: 2, messages: [{ seq: 2, uid: 7, size: 10, source: raw("b", "x") }] }));
  const r = await mb.fetchNew({ uidValidity: null, lastUid: null });
  assert.equal(r.baselined, true);
  assert.equal(r.cursor.lastUid, 7);
  assert.deepEqual(r.messages, []);
});

test("无 UIDNEXT、游标之后有新邮件：只取新的", async () => {
  const messages = [
    { seq: 1, uid: 7, size: 10, source: raw("old", "old") },
    { seq: 2, uid: 8, size: 10, source: raw("new", "new") },
  ];
  const mb = mailboxWith(fakeClient({ exists: 2, messages }));
  const r = await mb.fetchNew({ uidValidity: 1, lastUid: 7 });
  assert.equal(r.baselined, false);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].uid, 8);
  assert.equal(r.messages[0].subject, "new");
  assert.equal(r.cursor.lastUid, 7, "游标由调用方在处理成功后推进");
});

test("无 UIDNEXT、没有新邮件：不发起越界请求", async () => {
  const mb = mailboxWith(fakeClient({ exists: 1, messages: [{ seq: 1, uid: 7, size: 10, source: raw("a", "b") }] }));
  const r = await mb.fetchNew({ uidValidity: 1, lastUid: 7 });
  assert.deepEqual(r.messages, []);
});

test("有 UIDNEXT 的服务器行为不受影响（N:* 会回最大那封，需按 uid 过滤）", async () => {
  const messages = [{ seq: 1, uid: 7, size: 10, source: raw("a", "b") }];
  const mb = mailboxWith(fakeClient({ exists: 1, uidNext: 8, messages }));
  const r = await mb.fetchNew({ uidValidity: 1, lastUid: 7 });
  assert.deepEqual(r.messages, [], "uid=7 不该因为是 8:* 的返回值而被重复取出");
});

test("UIDVALIDITY 变化：重新取基线，不回放", async () => {
  const mb = mailboxWith(fakeClient({ exists: 1, uidValidity: 99, messages: [{ seq: 1, uid: 7, size: 10, source: raw("a", "b") }] }));
  const r = await mb.fetchNew({ uidValidity: 1, lastUid: 7 });
  assert.equal(r.baselined, true);
  assert.deepEqual(r.cursor, { uidValidity: 99, lastUid: 7 });
});
