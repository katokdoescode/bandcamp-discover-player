#!/usr/bin/env node
// Runs the live Bandcamp checks (tests/live) and keeps one GitHub issue per outcome:
//   - "changed": a check failed because Bandcamp's answer no longer has what the extension reads;
//   - "blocked": Bandcamp answered with its bot check or 429, so nothing could be checked.
// An open issue gets a comment only when the list of failures changes, and is closed
// once every check passes again.
//
// Env: GITHUB_TOKEN (issues: read and write on the repo; without it the report is only printed),
//      GITHUB_REPOSITORY (default katokdoescode/bandcamp-discover-player).
// Exit code: 0 all passed, 1 something changed, 2 blocked.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";

const REPORT_DIR = "live-report";
const REPO = process.env.GITHUB_REPOSITORY || "katokdoescode/bandcamp-discover-player";
const TOKEN = process.env.GITHUB_TOKEN;
const LABEL = "bandcamp-monitor";
const KINDS = {
  changed: {
    title: "Bandcamp changed something the extension relies on",
    intro: "The weekly live check found answers from Bandcamp that the extension can no longer read. The extension likely needs an update.",
  },
  blocked: {
    title: "Bandcamp monitor can't reach Bandcamp",
    intro: "Bandcamp answered the weekly live check with its bot check or a rate limit, so nothing could be checked. This says nothing about the extension.",
  },
};

rmSync(REPORT_DIR, { recursive: true, force: true });
const run = spawnSync("npx", ["vitest", "run", "--config", "vitest.live.config.ts"], { stdio: "inherit" });
if (!existsSync(`${REPORT_DIR}/results.json`)) {
  console.error("The live checks did not produce a report; exit code", run.status);
  process.exit(3);
}

const results = JSON.parse(readFileSync(`${REPORT_DIR}/results.json`, "utf8"));
const blockedReason = existsSync(`${REPORT_DIR}/blocked.txt`) ? readFileSync(`${REPORT_DIR}/blocked.txt`, "utf8").trim() : null;
const tests = results.testResults.flatMap((f) => f.assertionResults);
const failed = tests.filter((t) => t.status === "failed");
// A blocked run also fails the checks that waited on a blocked one ("needs …").
const isBlocked = (t) => /bot check|Client Challenge|HTTP 429|Skipped: |^AssertionError: needs /m.test(t.failureMessages.join("\n"));
const changed = failed.filter((t) => !(blockedReason && isBlocked(t)));
const status = changed.length ? "changed" : failed.length ? "blocked" : "ok";

const firstLine = (t) =>
  t.failureMessages
    .join("\n")
    .split("\n")
    .find((l) => l.trim())
    ?.replace(/\u001b\[[0-9;]*m/g, "")
    .trim() || "failed";
const name = (t) => [...t.ancestorTitles, t.title].join(" › ");
const list = (ts) => ts.map((t) => `- **${name(t)}**: ${firstLine(t)}`).join("\n");

const body = (kind) => {
  const lines = [KINDS[kind].intro, ""];
  if (kind === "changed") lines.push(list(changed), "");
  else lines.push(`> ${blockedReason || "Bandcamp blocked the checks."}`, "");
  lines.push(
    `${tests.length - failed.length} of ${tests.length} checks passed.`,
    "",
    "Run `npm run test:live` to see the details. The checks are in `tests/live/bandcamp.monitor.ts`.",
  );
  return lines.join("\n");
};

const report = status === "ok" ? `All ${tests.length} live checks passed.` : body(status);
console.log(`\n=== Bandcamp monitor: ${status} ===\n${report}\n`);

if (!TOKEN) {
  console.log("GITHUB_TOKEN is not set: no issue was filed.");
  process.exit(status === "ok" ? 0 : status === "changed" ? 1 : 2);
}

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok && res.status !== 422) throw new Error(`GitHub ${init.method || "GET"} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// The label exists once; 422 means it already does.
await gh("/labels", {
  method: "POST",
  body: JSON.stringify({ name: LABEL, color: "d93f0b", description: "Opened by the weekly Bandcamp live check" }),
});
const open = await gh(`/issues?state=open&labels=${LABEL}&per_page=20`);
const issueOf = (kind) => open.find((i) => i.title === KINDS[kind].title);

// Same failures as last time: say nothing new.
const fingerprint = (kind) => createHash("sha1").update(kind === "changed" ? changed.map(name).sort().join("|") : "blocked").digest("hex").slice(0, 12);
const mark = (kind) => `<!-- monitor:${fingerprint(kind)} -->`;

for (const kind of Object.keys(KINDS)) {
  const issue = issueOf(kind);
  if (kind === status) {
    const text = `${body(kind)}\n\n${mark(kind)}`;
    if (!issue) {
      const created = await gh("/issues", { method: "POST", body: JSON.stringify({ title: KINDS[kind].title, body: text, labels: [LABEL] }) });
      console.log("Opened", created.html_url);
      continue;
    }
    const comments = await gh(`/issues/${issue.number}/comments?per_page=100`);
    const last = comments.at(-1)?.body ?? issue.body ?? "";
    if (last.includes(mark(kind))) console.log("Unchanged since the last report:", issue.html_url);
    else {
      await gh(`/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: text }) });
      console.log("Commented on", issue.html_url);
    }
  } else if (issue && status !== "blocked") {
    // A blocked run can't tell whether a change was fixed, so it leaves "changed" open.
    await gh(`/issues/${issue.number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: status === "ok" ? `All ${tests.length} live checks pass again.` : "Bandcamp could be reached again." }),
    });
    await gh(`/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
    console.log("Closed", issue.html_url);
  }
}

process.exit(status === "ok" ? 0 : status === "changed" ? 1 : 2);
