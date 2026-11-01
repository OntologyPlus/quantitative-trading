import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fingerprint } from "./freshness.mjs";
mkdirSync("dist", { recursive: true });
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  { stdio: "inherit" },
);
const engineHash = createHash("sha256")
  .update(
    [
      "src/engine/core.ts",
      "src/domain/conditions.ts",
      "src/engine/portfolio.ts",
      "src/domain/allocation.ts",
      "src/engine/backtest.ts",
      "src/domain/contracts.ts",
      "src/domain/schemas.ts",
      "src/host/paper.ts",
      "src/adapters/market.ts",
    ]
      .map((p) => readFileSync(p, "utf8"))
      .join("\0"),
  )
  .digest("hex");
await build({
  define: { __ENGINE_BUILD_HASH__: JSON.stringify(engineHash) },
  entryPoints: [
    "src/host/index.ts",
    "src/host/tools.ts",
    "src/host/rpc.ts",
    "src/host/agent.ts",
    "src/workers/backtest.ts",
    "src/workers/lab.ts",
  ],
  outdir: "dist",
  outbase: "src",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
});
const manifest = JSON.parse(readFileSync("package.json", "utf8")),
  client = await build({
    entryPoints: ["src/client/index.tsx"],
    outfile: "dist/client.js",
    bundle: true,
    platform: "browser",
    format: "cjs",
    target: "es2022",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime"],
    metafile: true,
    banner: {
      js: `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
    },
    footer: { js: "return module.exports;}});" },
  });
for (const path of Object.keys(client.metafile.inputs))
  if (/src\/(host|adapters|workers|engine)\//.test(path))
    throw Error(`宿主代码泄漏到浏览器: ${path}`);
writeFileSync(
  "dist/build-state.json",
  JSON.stringify({ fingerprint: fingerprint(process.cwd()) }),
);
console.log("Harness plugin, worker and client built.");
