import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import plugin, { awayText, isSubagent } from "../src/host/index.js";

function fakeCtx(services = {}) {
  const tools = new Map();
  const guards = [];
  const contexts = [];
  const provided = new Map();
  const effects = [];
  const ctx = {
    tools: {
      register: (def) => {
        assert.ok(def.output && typeof def.output.render === "function", `${def.name} 必须声明 output`);
        tools.set(def.name, def);
      },
      guard: (g) => guards.push(g),
    },
    systemPrompt: { context: (c) => contexts.push(c) },
    provide: (name, value) => provided.set(name, value),
    effect: (fn) => effects.push(fn()),
    on: () => {},
    get: (name) => services[name],
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, tools, guards, contexts, provided, dispose: () => effects.forEach((d) => d?.()) };
}

const mainAgent = { id: "session-5ca08658-1b2c-4d3e-8f90-0123456789ab", session: { header: { cwd: "/w" } }, options: {} };
const subAgent = { id: "session-aaaaaaaa-1b2c-4d3e-8f90-0123456789ab", session: { header: { delegationDepth: 1, origin: "subagent" } }, options: {} };

test("isSubagent", () => {
  assert.equal(isSubagent(mainAgent), false);
  assert.equal(isSubagent(subAgent), true);
  assert.equal(isSubagent({ session: { header: {} }, options: { subagentDepth: 2 } }), true);
  assert.equal(isSubagent(undefined), false);
});

test("配置错误时仍注册全部工具，mail_status 说明原因，且不启动轮询", async () => {
  const f = fakeCtx();
  plugin.apply(f.ctx, { stateDir: mkdtempSync(join(tmpdir(), "dsh-mail-p-")) });
  assert.deepEqual([...f.tools.keys()].sort(), ["mail_attachment", "mail_list", "mail_read", "mail_send", "mail_status"]);
  const st = await f.tools.get("mail_status").execute({}, { agent: mainAgent });
  assert.equal(st.enabled, false);
  assert.ok(st.configErrors.length > 0);
  assert.equal(st.poll.running, false);
  await assert.rejects(f.tools.get("mail_send").execute({ subject: "x", body: "y" }, { agent: mainAgent }), /配置有误/);
  f.dispose();
});

test("guard 拒绝子代理调用邮件工具，放行主会话与其他工具", () => {
  const f = fakeCtx();
  plugin.apply(f.ctx, { stateDir: mkdtempSync(join(tmpdir(), "dsh-mail-p-")) });
  const g = f.guards[0];
  assert.match(g({ name: "mail_send", agent: subAgent }), /只对主会话开放/);
  assert.equal(g({ name: "mail_send", agent: mainAgent }), undefined);
  assert.equal(g({ name: "bash", agent: subAgent }), undefined);
  f.dispose();
});

test("离开模式：客户端接口切换 → 主会话提示随之变化，子代理为空；状态落盘可恢复", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-mail-p-"));
  const f = fakeCtx();
  plugin.apply(f.ctx, { stateDir });
  const ctxEntry = f.contexts[0];
  assert.equal(ctxEntry.name, "dsh-mail-away");
  assert.ok(Number.isFinite(ctxEntry.order));
  assert.match(ctxEntry.text({ agent: mainAgent }), /离开模式：关闭/);
  assert.equal(ctxEntry.text({ agent: subAgent }), "");

  const remote = f.provided.get("dshMail");
  assert.equal(remote.typertRemote.service, remote);
  const marker = Object.getPrototypeOf(remote)["@deepseek-ai/dsh-typert-protocol/remote-methods"];
  assert.deepEqual(marker.methods.map((m) => m.method), ["get", "setAway"]);
  assert.equal(remote.get().away, false);
  assert.equal(remote.setAway(true).away, true);
  assert.match(ctxEntry.text({ agent: mainAgent }), /离开模式：开启/);
  assert.doesNotMatch(ctxEntry.text({ agent: mainAgent }), /\{\{/, "不能出现插值语法");
  f.dispose();

  // 重载后状态保持
  const f2 = fakeCtx();
  plugin.apply(f2.ctx, { stateDir });
  assert.equal(f2.provided.get("dshMail").get().away, true);
  assert.equal(f2.provided.get("dshMail").setAway(false).away, false);
  f2.dispose();
});

test("awayText 两种状态", () => {
  assert.match(awayText({ on: true, since: "2026-10-02T03:00:00Z" }), /mail_send/);
  assert.match(awayText({ on: false }), /关闭/);
});
