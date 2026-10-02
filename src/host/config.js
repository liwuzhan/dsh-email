// 配置规范化与校验（手写，不依赖 schemastery）。
// 配错时不抛异常，返回 errors：插件仍然加载、mail_status 可用，只是入站/出站被禁用并说明原因。

import { homedir } from "node:os";
import { join } from "node:path";

import { normalizeAddress, validateAllowList } from "./auth.js";

const REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

function server(raw, fallback, defaults, label, errors) {
  const src = { ...(fallback ?? {}), ...(raw ?? {}) };
  const host = typeof src.host === "string" ? src.host.trim() : "";
  if (host.length === 0) errors.push(`${label}.host 必填`);
  const secure = src.secure === undefined ? defaults.secure : src.secure === true;
  const port = Number.isInteger(src.port) ? src.port : secure ? defaults.securePort : defaults.plainPort;
  const user = typeof src.user === "string" ? src.user.trim() : "";
  if (user.length === 0) errors.push(`${label}.user 必填`);
  const passRef = typeof src.passRef === "string" ? src.passRef.trim() : "";
  if (!REF.test(passRef)) errors.push(`${label}.passRef 必须是凭据引用名（如 DSH_MAIL_PASSWORD），实际值放在 ~/.dsh/.credentials.yaml 的 refs: 段`);
  return { host, port, secure, user, passRef };
}

/**
 * @returns {{ cfg: object, errors: string[] }}
 */
export function normalizeConfig(raw = {}) {
  const errors = [];
  const imap = server(raw.imap, undefined, { secure: true, securePort: 993, plainPort: 143 }, "imap", errors);
  // smtp 的 user/passRef 缺省沿用 imap
  const smtp = server(raw.smtp, { user: imap.user, passRef: imap.passRef }, { secure: true, securePort: 465, plainPort: 587 }, "smtp", errors);

  const sendAs = normalizeAddress(raw.sendAs ?? imap.user);
  if (!/^[^@\s]+@[^@\s]+$/.test(sendAs)) errors.push("sendAs 必须是本插件发信用的邮箱地址");
  const notifyTo = normalizeAddress(raw.notifyTo);
  if (!/^[^@\s]+@[^@\s]+$/.test(notifyTo)) errors.push("notifyTo 必填：你收信的邮箱地址（人是谁）");
  if (notifyTo.length > 0 && notifyTo === sendAs) errors.push("notifyTo 不能等于 sendAs：notifyTo 是人收信的地址，sendAs 是插件自己的地址");

  const allow = validateAllowList(raw.allowedFrom);
  if (!allow.ok) errors.push(allow.error);

  const authCheck = ["auto", "strict", "off"].includes(raw.authCheck) ? raw.authCheck : "auto";
  const num = (v, d, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);

  return {
    errors,
    cfg: {
      imap,
      smtp,
      sendAs,
      notifyTo,
      allowedFrom: allow.ok ? allow.list : [],
      authCheck,
      pollSeconds: num(raw.pollSeconds, 20, 5, 3600),
      maxBodyChars: num(raw.maxBodyChars, 32768, 1000, 1_000_000),
      maxSendPerHour: num(raw.maxSendPerHour, 30, 1, 1000),
      stateDir: typeof raw.stateDir === "string" && raw.stateDir.length > 0 ? raw.stateDir : join(homedir(), ".dsh", "dsh-mail"),
    },
  };
}

/** 给 mail_status 看的配置摘要：不含任何密钥值。 */
export function describeConfig(cfg) {
  return {
    imap: `${cfg.imap.user} @ ${cfg.imap.host}:${cfg.imap.port}${cfg.imap.secure ? " (TLS)" : ""} · 凭据 ${cfg.imap.passRef}`,
    smtp: `${cfg.smtp.user} @ ${cfg.smtp.host}:${cfg.smtp.port}${cfg.smtp.secure ? " (TLS)" : ""} · 凭据 ${cfg.smtp.passRef}`,
    sendAs: cfg.sendAs,
    notifyTo: cfg.notifyTo,
    allowedFrom: cfg.allowedFrom,
    authCheck: cfg.authCheck,
    pollSeconds: cfg.pollSeconds,
    maxSendPerHour: cfg.maxSendPerHour,
    stateDir: cfg.stateDir,
  };
}
