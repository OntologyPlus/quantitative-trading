import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { needsBuild } from "./freshness.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const binary = join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js");
if (!existsSync(binary)) {
  console.error("请先运行 npm run setup。");
  process.exit(1);
}
if (needsBuild(root)) {
  const built = spawnSync(process.execPath, [join(root, "scripts/build.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
const dir = join(root, ".runtime");
mkdirSync(dir, { recursive: true });
const patch = join(dir, "quant.patch.yml"),
  q = JSON.stringify;
writeFileSync(
  patch,
  `- insert:
    - id: quant-service
      name: ${q(join(root, "dist/host/index.js"))}
      config:
        dataDirectory: ${q(join(root, ".quant-data"))}
    - id: quant-rpc
      name: ${q(join(root, "dist/host/rpc.js"))}
    - id: preset-quant
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: quant-research
        name: 量化研究助手
        description: 从交易假设到可核对的回测和现货模拟盘
        order: 10
        plugins:
          - id: quant-tools
            name: ${q(join(root, "dist/host/tools.js"))}
`,
);
console.log(
  "请选择预设「量化研究助手」，打开右栏「量化工作台」。数据保存在 .quant-data；模型与登录沿用 Harness。",
);
const child = spawn(
  process.execPath,
  [
    binary,
    "--profile",
    "web",
    "--patch",
    patch,
    "--host",
    "127.0.0.1",
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: "inherit", env: process.env },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
