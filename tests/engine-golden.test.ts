import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { engineCases, engineDigest } from "./engine-cases.js";
// Golden digests were produced by the pre-optimisation Decimal engine (quant-engine-0.1.0).
// Fills, ledger, equity curve, metrics and non-idle decisions must stay byte-identical.
const golden = JSON.parse(
  readFileSync(new URL("./fixtures/engine-golden.json", import.meta.url), "utf8"),
);
for (const c of engineCases())
  test(`engine output matches reference engine: ${c.name}`, () => {
    assert.equal(engineDigest(c.run()), golden[c.name]);
  });
