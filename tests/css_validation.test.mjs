import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../tools/check-css.mjs", import.meta.url));
for (const [name, css, diagnostic] of [
  ["valid CSS with braces in strings", '.app { content: "{ /*"; width: min(100%, 430px); }', null],
  ["unclosed comment", ".app { width: 430px; }\n/* phone-shell overrides", /Unclosed comment/],
  ["unclosed block", ".app { width: 430px;", /Unclosed block/],
  ["unexpected closing block", ".app { width: 430px; }}", /Unexpected }/],
  ["merge separator", "=======\n.app { width: 430px; }", /merge-conflict marker/],
  ["merge opening", "<<<<<<< HEAD\n.app {}", /merge-conflict marker/],
  ["merge closing", ">>>>>>> branch\n.app {}", /merge-conflict marker/],
  ["diff3 ancestor", "||||||| ancestor\n.app {}", /merge-conflict marker/],
]) {
  test(`CSS validator: ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "busy-css-"));
    try {
      const fixture = join(dir, "fixture.css");
      writeFileSync(fixture, css);
      const result = spawnSync(process.execPath, [command, fixture], { encoding: "utf8" });
      assert.equal(result.status, diagnostic ? 1 : 0, result.stderr);
      if (diagnostic) assert.match(result.stderr, diagnostic);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
