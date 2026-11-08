import { writeFileSync } from "node:fs";
import { engineCases, engineDigest } from "../tests/engine-cases.ts";
const out = {};
for (const c of engineCases()) out[c.name] = engineDigest(c.run());
writeFileSync("tests/fixtures/engine-golden.json", JSON.stringify(out, null, 2) + "\n");
console.log(out);
