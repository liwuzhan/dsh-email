// 准入：白名单 + Authentication-Results。
//
// 白名单是唯一的"认人"依据；认证头只回答"这封信的 From 能不能信"。
// 不能把"DMARC 通过"当白名单用——AgentMail 自己的通知信也是 dmarc=pass（选型报告 §4.2 坑 2）。
//
// 只信**最上面**那条 Authentication-Results：它由我们的收信服务器追加；
// 更下面的可能是发件方自己伪造塞进来的。

/** 规范化邮箱地址：小写、去空白、去尖括号。 */
export function normalizeAddress(value) {
  if (typeof value !== "string") return "";
  const m = /<([^>]+)>/.exec(value);
  return (m ? m[1] : value).trim().toLowerCase();
}

/**
 * 校验并规范化白名单。必填、禁通配、禁空串——配错时返回 error，调用方据此拒绝开启入站。
 * @returns {{ ok: true, list: string[] } | { ok: false, error: string }}
 */
export function validateAllowList(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "allowedFrom 必填：至少列出一个允许发信的邮箱地址" };
  }
  const list = [];
  for (const item of raw) {
    const addr = normalizeAddress(item);
    if (addr.length === 0) return { ok: false, error: "allowedFrom 不能包含空串" };
    if (/[*?]/.test(addr) || addr === "any" || addr === "all") {
      return { ok: false, error: `allowedFrom 禁止通配：${String(item)}` };
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
      return { ok: false, error: `allowedFrom 里有不是邮箱地址的项：${String(item)}` };
    }
    if (!list.includes(addr)) list.push(addr);
  }
  return { ok: true, list };
}

/**
 * 解析一条 Authentication-Results 头的值。
 * 例：`amazonses.com; spf=pass (...) ...; dkim=pass header.i=@qq.com; dmarc=pass header.from=qq.com;`
 */
export function parseAuthResults(value) {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const text = value.replace(/\([^)]*\)/g, " "); // 去掉注释，避免注释里的 "dkim=pass" 干扰
  const pick = (method) => {
    const re = new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-z]+)`, "gi");
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1].toLowerCase());
    return out;
  };
  const dmarcFrom = /dmarc\s*=\s*[a-z]+[^;]*?header\.from\s*=\s*([^\s;]+)/i.exec(text)?.[1]?.toLowerCase();
  return { spf: pick("spf"), dkim: pick("dkim"), dmarc: pick("dmarc"), dmarcFrom };
}

/**
 * 认证判定。
 * @param {string|undefined} topHeader 最上面一条 Authentication-Results 的值
 * @param {string} fromAddress 已规范化的发件地址
 * @param {"auto"|"strict"|"off"} mode
 * @returns {{ ok: boolean, reason: string }}
 */
export function judgeAuth(topHeader, fromAddress, mode = "auto") {
  if (mode === "off") return { ok: true, reason: "auth-check-off" };
  const parsed = parseAuthResults(topHeader);
  if (parsed === undefined) {
    return mode === "strict"
      ? { ok: false, reason: "缺少 Authentication-Results（strict 模式拒收）" }
      : { ok: true, reason: "no-auth-header" };
  }
  const domain = fromAddress.split("@")[1] ?? "";
  const has = (list, v) => list.includes(v);

  if (parsed.dmarc.length > 0) {
    if (has(parsed.dmarc, "fail")) return { ok: false, reason: "dmarc=fail" };
    if (has(parsed.dmarc, "pass")) {
      if (parsed.dmarcFrom && domain && parsed.dmarcFrom !== domain) {
        return { ok: false, reason: `dmarc 通过的域 ${parsed.dmarcFrom} 与发件域 ${domain} 不一致` };
      }
      return { ok: true, reason: "dmarc=pass" };
    }
  }
  const spfPass = has(parsed.spf, "pass");
  const dkimPass = has(parsed.dkim, "pass");
  if (spfPass || dkimPass) return { ok: true, reason: spfPass ? "spf=pass" : "dkim=pass" };
  const anyFail = parsed.spf.some((v) => v === "fail" || v === "softfail") || has(parsed.dkim, "fail");
  if (anyFail) return { ok: false, reason: `认证失败 spf=${parsed.spf.join(",") || "-"} dkim=${parsed.dkim.join(",") || "-"}` };
  return mode === "strict"
    ? { ok: false, reason: "认证结果不明确（strict 模式拒收）" }
    : { ok: true, reason: "auth-inconclusive" };
}
