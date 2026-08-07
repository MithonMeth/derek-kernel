/**
 * Copies the three.js files the hero viewer needs out of node_modules into
 * public/vendor, preserving the relative paths the addon modules import.
 * Self-hosted rather than CDN: no third-party runtime dependency, nothing to
 * hash, and the page works with a strict connect-src.
 *
 * Re-run after bumping three: `npm run vendor -w @derek/web`.
 */
import { copyFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// three's exports map hides package.json, so resolve the entry point and
// walk up to the package root.
function packageRoot(entry) {
  let dir = dirname(entry);
  while (dir !== parse(dir).root) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "three") {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate the three package root");
}

const threeRoot = packageRoot(require.resolve("three"));
const version = JSON.parse(readFileSync(join(threeRoot, "package.json"), "utf8")).version;
const out = join(fileURLToPath(new URL(".", import.meta.url)), "public/vendor/three");

// GLTFLoader imports '../utils/...', so loaders/ and utils/ must stay siblings.
const FILES = [
  ["build/three.module.min.js", "three.module.min.js"],
  ["build/three.core.min.js", "three.core.min.js"],
  ["examples/jsm/loaders/GLTFLoader.js", "jsm/loaders/GLTFLoader.js"],
  ["examples/jsm/utils/BufferGeometryUtils.js", "jsm/utils/BufferGeometryUtils.js"],
  ["examples/jsm/utils/SkeletonUtils.js", "jsm/utils/SkeletonUtils.js"]
];

rmSync(out, { recursive: true, force: true });
for (const [from, to] of FILES) {
  const dest = join(out, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(threeRoot, from), dest);
}
console.log(`vendored three@${version} -> packages/web/public/vendor/three (${FILES.length} files)`);
