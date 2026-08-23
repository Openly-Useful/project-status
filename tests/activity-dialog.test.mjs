import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("dashboard polls the optional activity endpoint with active and unavailable backoff", () => {
  assert.match(appSource, /fetchJson\("\/api\/activity"\)/);
  assert.match(appSource, /return 1000/);
  assert.match(appSource, /return activity \? 5000 : 15000/);
  assert.match(appSource, /error\?\.status === 503/);
  assert.match(appSource, /RunGlance unavailable/);
  assert.match(appSource, /The readiness manifest below remains available and is not being presented as live work/);
});

test("expanded activity view accounts for running, finished, and swarm work without manifest substitution", () => {
  assert.match(appSource, /Running \{activity\.activeWork\.length\}/);
  assert.match(appSource, /Finished \{activity\.finishedWork\.length\}/);
  assert.match(appSource, /className="activity-swarm"/);
  assert.match(appSource, /Agent swarm/);
  assert.match(appSource, /This plan is derived from the manifest\. It is not a live workflow, agent, or elapsed-time feed/);
  assert.match(appSource, /<details className="readiness-plan">/);
});

test("final receipt exposes off, concise, and verified modes plus reproducible verification details", () => {
  assert.match(appSource, /\["off", "concise", "verified"\]/);
  assert.match(appSource, /Final summaries default to off/);
  assert.match(appSource, /Task result/);
  assert.match(appSource, /Project readiness/);
  assert.match(appSource, /role="table" aria-label="Verification results"/);
  assert.match(appSource, /<CopyButton value=\{command\}/);
  assert.match(appSource, /Remaining/);
  assert.doesNotMatch(appSource, /aria-live="polite"[^\n]*freshness|aria-live="polite"[^\n]*ageSeconds/);
});

test("activity and receipt surfaces retain mobile sheet, table, and no-color-independent state labels", () => {
  assert.match(styles, /\.live-summary/);
  assert.match(styles, /\.activity-swarm li/);
  assert.match(styles, /\.verification-table__row\[data-state="passed"\]/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.receipt-card__results/);
  assert.match(styles, /\.activity-work-card__state/);
});
