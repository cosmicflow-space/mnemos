import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

// Some loaders pull native/heavy deps through a `webpackIgnore`'d, string-built
// dynamic `require` so webpack can't trace into their binary fixtures
// (loader-pdf does this for pdf-parse; the embed path does it for transformers).
// Because webpack leaves those requires context-free, they resolve from the
// *bundle* location (apps/web) at runtime — and in `next dev` there is no
// standalone dependency trace to copy them in. So each MUST be a direct
// dependency of @mnemos/web, or PDF/embedding ingest silently fails in dev
// while still passing a production `standalone` build.
//
// Regression guard for the "pdf-parse unresolvable in next dev" bug.
const MUST_RESOLVE_FROM_WEB = ["pdf-parse", "@xenova/transformers"];

const requireFromWeb = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), "package.json"),
);

describe("webpackIgnore'd loader deps resolve from apps/web (next dev runtime)", () => {
  for (const pkg of MUST_RESOLVE_FROM_WEB) {
    it(`resolves ${pkg} from apps/web's own node_modules`, () => {
      expect(() => requireFromWeb.resolve(pkg)).not.toThrow();
    });
  }
});
