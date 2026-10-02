// 真机冒烟：用 ~/.dsh/.credentials.yaml 的 refs.<REF> 连真实邮箱，验证 Mailbox 收信层。
// 默认只读（列表 + 读最新一封 + 取基线），不发信、不打已读标记。
// 用法：node scripts/smoke-mailbox.mjs <REF> <user> <imapHost>
//   node scripts/smoke-mailbox.mjs DSH_MAIL_PASSWORD me@example.com imap.example.com

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { judgeAuth } from "../src/host/auth.js";
import { stripQuoted } from "../src/host/body.js";
import { Mailbox } from "../src/host/mailbox.js";
import { findToken } from "../src/host/subject.js";

const [ref, user, imapHost] = process.argv.slice(2);
if (!ref || !user || !imapHost) {
  console.error("用法：node scripts/smoke-mailbox.mjs <凭据引用名> <邮箱账号> <IMAP 主机>");
  process.exit(2);
}

function loadRef(name) {
  const text = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (s.startsWith(`${name}:`)) return s.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(`credentials.yaml 里找不到 ${name}`);
}

const pass = loadRef(ref);
const mb = new Mailbox(
  { imap: { host: imapHost, port: 993, secure: true, user }, smtp: { host: "-", port: 465, secure: true, user }, sendAs: user },
  async () => pass,
);

try {
  const t0 = Date.now();
  const recent = await mb.listRecent(5);
  console.log(`listRecent(5) ${Date.now() - t0}ms:`);
  for (const m of recent) console.log(`  uid=${m.uid} ${m.date} ${m.from} | ${m.subject}`);

  const base = await mb.fetchNew({ uidValidity: null, lastUid: null });
  console.log("baseline:", base.cursor, "baselined=", base.baselined);

  // 用 lastUid-2 当游标，验证"取新邮件"路径（只读）
  const back = await mb.fetchNew({ uidValidity: base.cursor.uidValidity, lastUid: Math.max(0, base.cursor.lastUid - 2) });
  console.log(`fetchNew(lastUid-2) → ${back.messages.length} 封`);
  for (const m of back.messages) {
    console.log(`  uid=${m.uid} from=${m.from} token=${findToken(m.subject) ?? "-"} subject=${m.subject}`);
    console.log(`    auth=${JSON.stringify(judgeAuth(m.authResults, m.from))} attachments=${m.attachments.length}`);
    console.log(`    body: ${JSON.stringify(stripQuoted(m.text).slice(0, 120))}`);
  }
} finally {
  await mb.close();
}
