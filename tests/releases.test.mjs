import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CURRENT, RELEASES } from "../web/app/releases.js";

// web/app/releases.js is the app's only version source: these checks keep it well formed.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const KINDS = ["Features", "Improvements", "Fixes", "UI Updates"];
const parts = (v) => v.split(".").map(Number);
const newer = (a, b) => { const [x, y] = [parts(a), parts(b)]; const i = x.findIndex((n, k) => n !== y[k]); return i >= 0 && x[i] > y[i]; };

test("the current version is the newest release", () => {
  assert.equal(CURRENT, RELEASES[0]);
  for (const r of RELEASES.slice(1)) assert.ok(newer(CURRENT.version, r.version), `${CURRENT.version} > ${r.version}`);
});

test("releases are semantic versions, newest first, with real calendar dates", () => {
  assert.ok(RELEASES.length > 0);
  for (const r of RELEASES) {
    assert.match(r.version, SEMVER, r.version);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, r.version);
    assert.equal(new Date(`${r.date}T00:00:00Z`).toISOString().slice(0, 10), r.date, `${r.version}: ${r.date} is not a real date`);
  }
  RELEASES.slice(1).forEach((r, i) => {
    const prev = RELEASES[i];
    assert.ok(newer(prev.version, r.version), `${prev.version} is listed before ${r.version}`);
    assert.ok(prev.date >= r.date, `${prev.version} (${prev.date}) predates ${r.version} (${r.date})`);
  });
});

test("every release says what changed, in the known categories", () => {
  for (const r of RELEASES) {
    assert.ok(r.title?.trim() && r.summary?.trim(), `${r.version} needs a title and summary`);
    const kinds = Object.keys(r.changes ?? {});
    assert.ok(kinds.length > 0, `${r.version} lists no changes`);
    for (const k of kinds) {
      assert.ok(KINDS.includes(k), `${r.version}: unknown category "${k}"`);
      assert.ok(r.changes[k].length > 0 && r.changes[k].every((c) => typeof c === "string" && c.trim()), `${r.version}: empty ${k}`);
    }
  }
});

test("reconstructed releases name the commits they cover", () => {
  for (const r of RELEASES.filter((x) => x.commits)) assert.match(r.commits, /^[0-9a-f]{7}–[0-9a-f]{7}$/, r.version);
});

test("no other file states the app version", () => {
  // The page and manifest take the version from releases.js, so a release only edits that file.
  for (const file of ["web/index.html", "web/manifest.webmanifest", "package.json"]) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /"version"\s*:|\bv\d+\.\d+\.\d+\b/, file);
  }
});
