import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SnapshotStore, SettingsStore, PortfolioStore, changedFields, planWaves, testEligibility, AzureReadClient, parseAnalysis, ReviewStore, refreshWorkspaceSource, syncLegacySource } from "../src/workflows/index.js";
import type { SourceContent, SourceIdentity, PrContext, SprintTask } from "../src/workflows/index.js";
const source: SourceIdentity = { provider: "azure_devops", organization: "org", project: "project", ticket_id: "123" };
const content = (text: string): SourceContent => ({ ticket: { description: text }, conversations: [] });
async function temporary(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cvg-workflow-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
test("captures only local changes, preserves versions on reversion and leaves baseline unchanged", async t => {
  const store = new SnapshotStore(await temporary(t));
  const first = await store.capture("CVG-001", source, async () => content("a"));
  assert.equal(first.snapshot.version, 1);
  assert.equal((await store.capture("CVG-001", source, async () => content("a"))).changed, false);
  await store.capture("CVG-001", source, async () => content("b"));
  await store.capture("CVG-001", source, async () => content("a"));
  const h = await store.history("CVG-001", source);
  assert.deepEqual(h.versions.map(v => v.version), [1, 2, 3]);
  assert.equal(h.baseline_version, 1);
  assert.equal(h.versions[0]?.content.ticket.description, "a");
  assert.equal((await store.useBaseline("CVG-001", source, 3, 1)).baseline_version, 3);
  await assert.rejects(store.useBaseline("CVG-001", source, 2, 1), /CONFLICT/);
});
test("concurrent captures share a file lock; failed capture never replaces complete content", async t => {
  const root = await temporary(t); const a = new SnapshotStore(root); const b = new SnapshotStore(root);
  await Promise.all([a.capture("CVG-001", source, async () => content("a")), b.capture("CVG-001", source, async () => content("a"))]);
  await assert.rejects(a.capture("CVG-001", source, async () => { throw new Error("comments failed"); }), /comments failed/);
  assert.equal((await a.history("CVG-001", source)).versions.length, 1);
  await assert.rejects(a.capture("../escape", source, async () => content("x")));
  assert.deepEqual(changedFields(content("a"), content("b")), ["ticket.description"]);
});
test("different organizations cannot collide; tampering is detected", async t => {
  const root = await temporary(t); const store = new SnapshotStore(root);
  await store.capture("CVG-001", source, async () => content("a"));
  assert.equal((await store.history("CVG-001", { ...source, organization: "another" })).versions.length, 0);
  const dirs = await fs.readdir(path.join(root, "CVG-001", "source-versions"));
  const file = path.join(root, "CVG-001", "source-versions", dirs[0]!, "v00000001.json");
  const json = JSON.parse(await fs.readFile(file, "utf8")); json.content.ticket.description = "tampered";
  await fs.writeFile(file, JSON.stringify(json));
  await assert.rejects(store.capture("CVG-001", source, async () => content("b")), /corrupto/);
});
test("headless and Studio share legacy migration and baseline projections without overwriting history", async t => {
  const root = await temporary(t); const dir = path.join(root, "CVG-001"); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "caso.json"), JSON.stringify({ tickets: [{ provider: "azure_devops", id: 123 }] }));
  await fs.writeFile(path.join(dir, "ticket-snapshot.json"), JSON.stringify(content("old").ticket));
  const captured = await refreshWorkspaceSource(root, "CVG-001", source, async () => content("new"));
  assert.equal(captured.snapshot.version, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "ticket-snapshot.json"), "utf8")).description, "old");
  const store = new SnapshotStore(root);
  await store.useBaseline("CVG-001", source, 2, 1);
  await syncLegacySource(root, "CVG-001", source);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "ticket-snapshot.json"), "utf8")).description, "new");
  assert.equal((await store.history("CVG-001", source)).versions[0]?.content.ticket.description, "old");
});
test("settings use optimistic concurrency and cannot disable human publication", async t => {
  const store = new SettingsStore(await temporary(t));
  assert.equal((await store.read()).pr_granularity, "task");
  const value = await store.update({ expected_revision: 0, pr_granularity: "subtask", max_parallel_tasks: 3 });
  assert.equal(value.publish_requires_human, true);
  await assert.rejects(store.update({ expected_revision: 0, pr_granularity: "task", max_parallel_tasks: 2 }), /CONFLICT/);
  await assert.rejects(store.update({ expected_revision: 1, pr_granularity: "task", max_parallel_tasks: 0 }));
});
test("portfolio keeps credentials as references and makes project ownership explicit", async t => {
  const store = new PortfolioStore(await temporary(t));
  let portfolio = await store.createCompany({ expected_revision: 0, id: "acme", name: "Acme SA" });
  portfolio = await store.createProject({ expected_revision: portfolio.revision, id: "acme-portal", name: "Portal", company_id: "acme", azure_devops: { organization: "acme-org", project: "Portal", auth_mode: "pat", credential_env: "CVG_ACME_PAT" } });
  assert.equal(portfolio.projects[0]?.company_id, "acme");
  assert.equal(portfolio.projects[0]?.azure_devops?.credential_env, "CVG_ACME_PAT");
  portfolio = await store.configureAzureDevOps({ expected_revision: portfolio.revision, project_id: "acme-portal", azure_devops: { organization: "acme-org", project: "Portal", auth_mode: "azure_cli" } });
  assert.equal(portfolio.projects[0]?.azure_devops?.auth_mode, "azure_cli");
  portfolio = await store.configureAgentRuntime({ expected_revision: portfolio.revision, project_id: "acme-portal", agent_runtime: { provider: "claude", profile_id: "claude-acme", label: "Claude Acme" } });
  assert.deepEqual(portfolio.projects[0]?.agent_runtime, { provider: "claude", profile_id: "claude-acme", label: "Claude Acme" });
  portfolio = await store.addRepository({ expected_revision: portfolio.revision, project_id: "acme-portal", id: "portal-api", name: "Portal API", remote_url: "https://dev.azure.com/acme/Portal/_git/Portal-API", local_path: "C:\\code\\cvg-projects\\acme\\acme-portal\\repos\\Portal-API", cloned_at: "2026-09-09T00:00:00.000Z" });
  assert.equal(portfolio.projects[0]?.repositories[0]?.name, "Portal API");
  portfolio = await store.addOperationalTask({ expected_revision: portfolio.revision, project_id: "acme-portal", workspace_id: "CVG-2026-0001", title: "Preparar entorno local", description: "Levantar dependencias." });
  assert.equal(portfolio.projects[0]?.operational_tasks[0]?.source, "local_operation");
  await assert.rejects(store.createProject({ expected_revision: portfolio.revision, name: "Sin secreto", azure_devops: { organization: "acme-org", project: "Portal", auth_mode: "pat" } }), /referencia/);
  await assert.rejects(store.createCompany({ expected_revision: 0, name: "Otro" }), /CONFLICT/);
});
test("dependency planner rejects cycles/missing IDs and respects concurrency", () => {
  const task = (id: string, deps: string[] = []): SprintTask => ({ id, workspace_id: id, title: id, depends_on: deps, priority: 1, stage: "captured" });
  assert.deepEqual(planWaves([task("b", ["a"]), task("a"), task("c")], 2), [["a", "c"], ["b"]]);
  assert.throws(() => planWaves([task("a", ["b"]), task("b", ["a"])], 2), /cíclicas/);
  assert.throws(() => planWaves([task("a", ["b"])], 2), /sin resolver/);
  assert.equal(testEligibility({ kind: "visual", execution_host: "remote", effect: "read_only", environment: "qa" }), "blocked");
  assert.equal(testEligibility({ kind: "api", execution_host: "local_pc", effect: "unknown", environment: "qa" }), "human_supervision_required");
  assert.equal(testEligibility({ kind: "api", execution_host: "local_pc", effect: "mutates_data", environment: "prod" }), "blocked");
});
test("Azure captures complete fields and paginated comments; protects host and project", async () => {
  const urls: string[] = [];
  const transport: typeof fetch = async input => {
    const u = new URL(String(input)); urls.push(u.toString());
    const body = u.pathname.endsWith("/comments")
      ? u.searchParams.has("continuationToken") ? { comments: [{ id: 2, text: "second" }] } : { comments: [{ id: 1, text: "first" }], continuationToken: "next" }
      : { id: 123, rev: 7, fields: { "System.TeamProject": "project", "System.Description": "x".repeat(5000), "Microsoft.VSTS.Common.AcceptanceCriteria": "criteria" }, relations: [{ rel: "parent" }] };
    return new Response(JSON.stringify(body));
  };
  const azure = new AzureReadClient({ organization: "org", project: "project", pat: "test" }, transport);
  const result = await azure.captureTicket("123");
  assert.equal(String(result.ticket.description).length, 5000);
  assert.equal(result.conversations.length, 2); assert.equal(urls.length, 4);
  assert.throws(() => azure.parsePrUrl("https://evil.com/org/project/_git/repo/pullrequest/1"));
  assert.throws(() => azure.parsePrUrl("https://dev.azure.com/other/project/_git/repo/pullrequest/1"));
  assert.equal(azure.parsePrUrl("https://dev.azure.com/org/project/_git/repo/pullrequest/1").id, 1);
});
const context: PrContext = { pr: { project: "project", repository: "repo", id: 1, title: "PR", url: "https://dev.azure.com/org/project/_git/repo/pullrequest/1", status: "active", author: "Someone", source_branch: "feature", target_branch: "main", created_at: "" }, description: "", source_commit: "a".repeat(40), target_commit: "b".repeat(40), base_commit: "c".repeat(40), iteration: 1, captured_at: "", limitations: [], files: [{ path: "/a.ts", original_path: "/a.ts", change_type: "edit", before: "a", after: "b", omitted_reason: null }] };
test("review rejects invented evidence locations and persists exact commits with stale detection", async t => {
  const analysis = { summary: "Report", findings: [], suggested_tests: ["test behavior"] };
  assert.throws(() => parseAnalysis(JSON.stringify({ ...analysis, findings: [{ path: "/missing", line: 1 }] }), context), /ubicación/);
  const store = new ReviewStore(await temporary(t));
  const client = { reviewContext: async () => context, readPr: async () => ({ source_commit: "d".repeat(40), target_commit: context.target_commit }) } as unknown as AzureReadClient;
  const review = await store.review(client, { project: "project", repository: "repo", id: 1 }, async prompt => { assert.match(prompt, /NO confiables/); return JSON.stringify(analysis); });
  assert.equal(review.status, "outdated");
  assert.equal((await store.read(review.id)).context.source_commit, context.source_commit);
  assert.equal((await store.list())[0]?.status, "unverified");
});
