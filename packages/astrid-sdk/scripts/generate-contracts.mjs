#!/usr/bin/env node
/**
 * Generate `src/contracts.ts` from `wit-contracts/astrid-contracts.wit`.
 * Runs as a prebuild step so tsc compiles the result alongside the rest of
 * the SDK.
 *
 * Mirror of the Rust SDK's `contracts` module which is generated from the
 * same WIT file via the `wit_events!` proc macro.
 */

import { codegenWitEvents } from "@astrid-runtime/build/src/wit-codegen.mjs";
import { mkdir, copyFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(HERE, "..");

async function main() {
  // codegenWitEvents reads <dir>/wit/*.wit and writes <dir>/gen/*.d.ts.
  // We spoof a working directory inside the SDK package: copy
  // wit-contracts/astrid-contracts.wit into a temp `_gen-input/wit/` dir,
  // run codegen, then move the output to src/contracts.ts.
  const inputDir = join(PKG_DIR, "_gen-input");
  const witDir = join(inputDir, "wit");
  await mkdir(witDir, { recursive: true });
  await copyFile(
    join(PKG_DIR, "wit-contracts", "astrid-contracts.wit"),
    join(witDir, "astrid-contracts.wit"),
  );

  const result = await codegenWitEvents(inputDir);
  if (result.types === 0) {
    throw new Error("contracts codegen produced 0 types — wit file is empty or malformed");
  }

  const generated = join(inputDir, "gen", "astrid-contracts.d.ts");
  await assertExists(generated);
  const out = join(PKG_DIR, "src", "contracts.ts");
  // Emit as .ts (not .d.ts) so tsc treats it as a regular module. The
  // codegen output is types-only — no runtime — so it works either way,
  // but .ts keeps it visible to the regular build graph.
  await rename(generated, out);
  await rm(inputDir, { recursive: true });

  console.log(`generate-contracts: emitted ${result.types} type(s) → ${out}`);
}

async function assertExists(path) {
  try {
    await stat(path);
  } catch {
    throw new Error(`generate-contracts: expected output at ${path}, not found`);
  }
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
