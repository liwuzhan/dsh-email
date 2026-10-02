// 构建：
//   src/host/**  + 邮件依赖（imapflow / nodemailer / mailparser） → lib/host.js（单文件 ESM bundle）
//   src/shell.js                                                → lib/index.js（入口薄壳，按 mtime 重新加载 host.js）
//   src/client.js                                               → lib/client.js（客户端，原样复制）
// 单文件的好处：装进 profile 不需要 pnpm install，也没有"依赖从哪个 node_modules 解析"的问题。

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "lib"), { recursive: true });

await build({
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
  logLevel: "warning",
});

copyFileSync(join(root, "src/shell.js"), join(root, "lib/index.js"));
copyFileSync(join(root, "src/client.js"), join(root, "lib/client.js"));
console.log("built lib/index.js (shell) + lib/host.js + lib/client.js");
