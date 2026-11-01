import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
export function fingerprint(root) {
  const h = createHash("sha256");
  function add(path) {
    h.update(path);
    h.update("\0");
    h.update(readFileSync(join(root, path)));
    h.update("\0");
  }
  function walk(path) {
    for (const e of readdirSync(join(root, path), { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const p = join(path, e.name);
      if (e.isDirectory()) walk(p);
      else add(p);
    }
  }
  walk("src");
  walk("scripts");
  for (const p of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "cordis.patch.yml",
  ])
    add(p);
  return h.digest("hex");
}
export function needsBuild(root) {
  return (
    [
      "host/index.js",
      "host/tools.js",
      "host/rpc.js",
      "host/agent.js",
      "workers/backtest.js",
      "workers/lab.js",
      "client.js",
      "build-state.json",
    ].some((p) => !existsSync(join(root, "dist", p))) ||
    JSON.parse(readFileSync(join(root, "dist/build-state.json"), "utf8"))
      .fingerprint !== fingerprint(root)
  );
}
