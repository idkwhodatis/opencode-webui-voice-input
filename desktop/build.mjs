import { fileURLToPath } from "node:url";
import { build } from "esbuild";
// No JSX: mirrors the official preset's one-CJS/shared-module contract without
// installing a second copy of Solid or Effect into the host.
await build({
  entryPoints: [fileURLToPath(new URL("gui.js", import.meta.url))],
  outfile: fileURLToPath(new URL("dist/gui-experimental.cjs", import.meta.url)),
  bundle: true,
  format: "cjs",
  platform: "neutral",
  target: "es2022",
  external: ["@opencode/plugin/gui", "effect", "solid-js"],
  logLevel: "warning",
});
