// dsh-mail 入口薄壳（构建时原样复制为 lib/index.js）。
//
// 为什么要壳：desktop profile 不监视宿主模块（hmr.root 为空），且 Node ESM 按 URL 缓存模块，
// 所以改了实现代码、换一个 patch 条目 id 重新挂载，拿到的仍是旧代码。
// 壳在每次 apply 时按 lib/host.js 的 mtime 加查询串重新 import，实现"改代码 + 换条目 id 即生效、不重启 App"。
//
// ★ inject 必须声明在壳上（loader 读的是入口模块的导出），漏声明会让 ctx.systemPrompt 之类的访问直接抛。

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hostPath = join(dirname(fileURLToPath(import.meta.url)), "host.js");

export const name = "dsh-mail";
export const inject = ["tools", "systemPrompt"];

function note(entry) {
  try {
    const dir = join(homedir(), ".dsh", "dsh-mail");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, "loader.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`, {
      mode: 0o600,
    });
  } catch {
    /* 辅助性 */
  }
}

export async function apply(ctx, config) {
  let bust = "0";
  try {
    bust = String(statSync(hostPath).mtimeMs);
  } catch {
    /* 用固定值 */
  }
  try {
    const mod = await import(`${pathToFileURL(hostPath).href}?v=${bust}`);
    note({ event: "apply", bust });
    return mod.default.apply(ctx, config);
  } catch (error) {
    // 不让异常静默吞掉：落盘，再抛给 loader（loader 会把插件标记为失败）
    note({ event: "apply-failed", bust, error: String(error?.stack ?? error) });
    throw error;
  }
}

export default { name, inject, apply };
