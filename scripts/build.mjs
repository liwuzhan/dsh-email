// 构建：
//   src/host/**  + 邮件依赖（imapflow / nodemailer / mailparser） → lib/host.js（单文件 ESM bundle）
//   src/shell.js                                                → lib/index.js（入口薄壳，按 mtime 重新加载 host.js）
//   src/client.js                                               → lib/client.js（客户端，原样复制）
//   打进 bundle 的每个第三方包的许可证原文                          → lib/THIRD_PARTY_LICENSES.txt
// 单文件的好处：装进 profile 不需要 pnpm install，也没有"依赖从哪个 node_modules 解析"的问题。

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "lib"), { recursive: true });
rmSync(join(root, "lib/host.js.LEGAL.txt"), { force: true });

const result = await build({
  entryPoints: [join(root, "src/host/index.js")],
  outfile: join(root, "lib/host.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // 依赖里有 CJS 的动态 require（node 内置模块），ESM 产物需要一个 require
  banner: {
    js: "import { createRequire as __dshMailCreateRequire } from 'node:module'; const require = __dshMailCreateRequire(import.meta.url);",
  },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

// 从 metafile 收集被打包的第三方包（node_modules/<name> 或 node_modules/@scope/<name>）
const pkgDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) pkgDirs.add(join(root, m[1]));
}
const sections = [];
for (const dir of [...pkgDirs].sort()) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = licFile ? readFileSync(join(dir, licFile), "utf8").trim() : `(no license file shipped; package.json license: ${pkg.license ?? "unknown"})`;
  sections.push(`${"=".repeat(78)}\n${pkg.name}@${pkg.version} — ${pkg.license ?? "unknown"}\n${"=".repeat(78)}\n\n${text}\n`);
}
writeFileSync(
  join(root, "lib/THIRD_PARTY_LICENSES.txt"),
  `lib/host.js bundles the following third-party packages.\n\n${sections.join("\n")}`,
);

copyFileSync(join(root, "src/shell.js"), join(root, "lib/index.js"));
copyFileSync(join(root, "src/client.js"), join(root, "lib/client.js"));
console.log(`built lib/index.js (shell) + lib/host.js + lib/client.js + THIRD_PARTY_LICENSES.txt (${pkgDirs.size} packages)`);
