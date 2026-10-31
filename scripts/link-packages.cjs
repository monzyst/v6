#!/usr/bin/env node
/**
 * Links the workspace packages into node_modules so that `@v6hf/*` resolves at
 * RUNTIME.
 *
 * Why this is needed: `tsconfig.json` declares `paths` for `@v6hf/*`, but those
 * only affect TYPECHECKING. Node's ESM resolver knows nothing about them, so a
 * compiled `dist/packages/phase2/src/boundary.js` that does
 * `import ... from "@v6hf/core"` will fail with ERR_MODULE_NOT_FOUND unless
 * `node_modules/@v6hf/core` actually exists.
 *
 * This script creates those links from `dist/`, which means it must run AFTER
 * `tsc`. It is wired as `postinstall` (so a fresh clone works) and is also
 * called at the end of `build:ts` (so a rebuild after a clean `dist/` works).
 *
 * Idempotent: re-running it replaces existing links.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCOPE = path.join(ROOT, "node_modules", "@v6hf");

const PACKAGES = ["core", "base-lane", "solana-lane", "phase2", "phase2-lane"];

function main() {
  const distRoot = path.join(ROOT, "dist", "packages");
  if (!fs.existsSync(distRoot)) {
    // Nothing to link yet. This is the normal state during `npm install` on a
    // fresh clone, before the first build. Not an error: `build:ts` calls this
    // again once `dist/` exists.
    console.log("link-packages: dist/ not built yet — skipping (build will link)");
    return;
  }

  fs.mkdirSync(SCOPE, { recursive: true });

  let linked = 0;
  for (const name of PACKAGES) {
    const target = path.join(distRoot, name, "src");
    if (!fs.existsSync(target)) {
      console.warn(`link-packages: no build output for @v6hf/${name} — skipping`);
      continue;
    }
    const linkPath = path.join(SCOPE, name);

    // Remove whatever is there (a stale link, or a real directory from a
    // previous npm install of a published package).
    try {
      const st = fs.lstatSync(linkPath);
      if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(linkPath);
      else fs.rmSync(linkPath, { recursive: true, force: true });
    } catch {
      /* does not exist */
    }

    // Relative link so the repo stays portable across machines and CI checkouts.
    const relative = path.relative(SCOPE, target);
    fs.symlinkSync(relative, linkPath, "dir");
    linked++;
  }

  console.log(`link-packages: linked ${linked}/${PACKAGES.length} package(s) into node_modules/@v6hf`);
}

main();
