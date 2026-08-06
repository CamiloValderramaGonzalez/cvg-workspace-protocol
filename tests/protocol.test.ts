import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  AgentLoop,
  ContextAssembler,
  ProtocolError,
  StopCondition,
  WorkspaceStore,
  withFileLock,
} from "../src/index.js";
import type {
  CloseCaseInput,
  ContextDecisionInput,
  ProvenanceInput,
  StrongEvidenceRef,
} from "../src/index.js";

const provenance = {
  actor: "tester",
  actor_type: "human",
  source: "node-test",
} satisfies ProvenanceInput;

const reviewProvenance = {
  actor: "reviewer",
  actor_type: "human",
  source: "node-test-review",
} satisfies ProvenanceInput;

async function fixture(t: test.TestContext): Promise<{ root: string; store: WorkspaceStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cvg-protocol-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  let instant = Date.parse("2026-08-06T12:00:00.000Z");
  const store = new WorkspaceStore(root, { clock: () => new Date(instant++) });
  return { root, store };
}

test("E2E: caso, evidencia, contexto, memoria, chat y ensamblado determinista", async (t) => {
  const { root, store } = await fixture(t);
  const created = await store.createCase({
    case_id: "case-e2e",
    title: "Migrar CVG",
    objective: "Extraer un protocolo portable y verificable",
    status: "active",
    provenance,
  });
  assert.equal(created.revision, 0);

  const artifact = await store.addArtifact("case-e2e", {
    artifact_id: "artifact-proof",
    kind: "evidence",
    title: "Prueba",
    relative_path: "result.txt",
    content: "verified",
    provenance,
  }, { expected_revision: 0 });
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await store.verifyArtifact("case-e2e", artifact.artifact_id), true);

  const milestone = await store.createMilestone("case-e2e", {
    title: "Gate de evidencia",
    status: "pending",
    provenance,
  }, { expected_revision: 1 });
  await store.updateMilestone("case-e2e", milestone.milestone_id, {
    status: "validated",
    evidence_refs: [{ artifact_id: artifact.artifact_id, digest: artifact.digest }],
  }, provenance, { expected_revision: 2 });

  const initial = await store.proposeContext("case-e2e", {
    summary: "Contexto inicial",
    content: "Trabajar con contratos neutrales.",
    evidence_refs: [{ artifact_id: artifact.artifact_id, digest: artifact.digest }],
    base_version: 0,
    base_revision: 0,
    provenance,
  }, { expected_revision: 3 });
  await store.approveContext("case-e2e", initial.proposal_id, { provenance: reviewProvenance }, { expected_revision: 4 });

  const local = await store.addMemory("case-e2e", {
    scope: "case",
    classification: "decision",
    statement: "La evidencia es obligatoria para validar.",
    evidence_refs: [{ artifact_id: artifact.artifact_id }],
    confidence: 1,
    provenance,
  }, { expected_revision: 5 });
  await store.addMemory("case-e2e", {
    scope: "shared",
    shared_scope: "global",
    classification: "lesson",
    statement: "Los archivos derivados no son fuente canónica.",
    confidence: 0.95,
    provenance,
  }, { expected_revision: 6 });

  const thread = await store.createChatThread("case-e2e", { title: "Implementación", provenance }, { expected_revision: 7 });
  await store.appendChatMessage("case-e2e", thread.thread_id, {
    role: "user",
    content: "Ensamblar contexto",
    provenance,
  }, { expected_revision: 8 });
  await store.appendChatMessage("case-e2e", thread.thread_id, {
    role: "assistant",
    content: "Contexto ensamblado",
    provider: "neutral-provider",
    model: "neutral-model",
    provenance,
  }, { expected_revision: 9 });

  const replacement = await store.proposeContext("case-e2e", {
    summary: "Contexto revisado",
    content: "Incluir memoria durable y evidencia.",
    evidence_refs: [{ artifact_id: artifact.artifact_id, digest: artifact.digest }],
    supersedes_proposal_id: initial.proposal_id,
    base_version: initial.version,
    base_revision: 2,
    provenance,
  }, { expected_revision: 10 });
  await store.supersedeContext("case-e2e", replacement.proposal_id, { provenance: reviewProvenance }, { expected_revision: 11 });
  const revisedMemory = await store.supersedeMemory("case-e2e", local.memory_id, {
    classification: "decision",
    statement: "Validar exige evidencia resoluble e íntegra.",
    evidence_refs: [{ artifact_id: artifact.artifact_id, digest: artifact.digest }],
    confidence: 1,
    provenance,
  }, { expected_revision: 12 });

  const assembler = new ContextAssembler(store);
  const first = await assembler.assemble("case-e2e");
  const second = await assembler.assemble("case-e2e");
  assert.deepEqual(first, second);
  assert.equal(assembler.serialize(first), assembler.serialize(second));
  assert.equal(first.case.revision, 13);
  assert.deepEqual(first.source_revisions, { "case-e2e": 13 });
  assert.equal(first.active_context?.proposal_id, replacement.proposal_id);
  assert.deepEqual(first.case_memory.map((item) => item.memory_id), [revisedMemory.memory_id]);
  assert.equal(first.shared_memory.length, 1);
  assert.equal(first.chats[0]?.messages[1]?.provider, "neutral-provider");
  assert.deepEqual(first.events.map((event) => event.event_id), [...first.events.map((event) => event.event_id)].sort());

  const journal = await fs.readFile(path.join(root, "case-e2e", "journal.md"), "utf-8");
  assert.match(journal, /## Memoria durable/);
  assert.match(journal, /Validar exige evidencia/);
});

test("gates: rutas, evidencia, metadata de chat y CAS concurrente", async (t) => {
  const { store } = await fixture(t);
  await store.createCase({
    case_id: "case-gates",
    title: "Gates",
    objective: "Rechazar escrituras inválidas",
    status: "active",
    provenance,
  });

  await assert.rejects(
    store.addArtifact("case-gates", {
      kind: "evidence",
      title: "Escape",
      relative_path: "../escape.txt",
      content: "no",
      provenance,
    }, { expected_revision: 0 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "UNSAFE_PATH",
  );
  assert.equal((await store.readCase("case-gates")).revision, 0);

  const milestone = await store.createMilestone("case-gates", {
    title: "No validar sin prueba",
    status: "pending",
    provenance,
  }, { expected_revision: 0 });
  await assert.rejects(
    store.updateMilestone("case-gates", milestone.milestone_id, { status: "validated" }, provenance, { expected_revision: 1 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_INPUT",
  );
  assert.equal((await store.readCase("case-gates")).revision, 1);

  const raced = await Promise.allSettled([
    store.appendEvent("case-gates", { event_type: "custom.race-first", provenance }, { expected_revision: 1 }),
    store.appendEvent("case-gates", { event_type: "custom.race-second", provenance }, { expected_revision: 1 }),
  ]);
  assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await store.readCase("case-gates")).revision, 2);

  await assert.rejects(
    store.appendEvent("case-gates", { event_type: "case.closed", provenance }, { expected_revision: 2 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_INPUT",
  );
  assert.equal((await store.readCase("case-gates")).revision, 2);

  const thread = await store.createChatThread("case-gates", { provenance }, { expected_revision: 2 });
  await assert.rejects(
    store.appendChatMessage("case-gates", thread.thread_id, {
      role: "assistant",
      content: "sin modelo",
      provenance,
    }, { expected_revision: 3 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_INPUT",
  );
  assert.equal((await store.readCase("case-gates")).revision, 3);

  const proposal = await store.proposeContext("case-gates", {
    summary: "Candidate context",
    content: "This still requires human review.",
    base_version: 0,
    base_revision: 0,
    provenance,
  }, { expected_revision: 3 });
  const automatedDecision = {
    provenance: {
      actor: "automated-reviewer",
      actor_type: "agent",
      source: "test-adapter",
    },
  } as unknown as ContextDecisionInput;
  await assert.rejects(
    store.approveContext("case-gates", proposal.proposal_id, automatedDecision, { expected_revision: 4 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    store.approveContext("case-gates", proposal.proposal_id, { provenance }, { expected_revision: 4 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_INPUT",
  );
  assert.equal((await store.readCase("case-gates")).revision, 4);
});

test("agent loop: runtime-neutral stop conditions and hard cap", async () => {
  const loop = new AgentLoop<Record<string, never>, { attempt: number }>();
  const steps = await loop.run(
    async (previous) => {
      const attempt = (previous?.output?.attempt ?? 0) + 1;
      return { index: -1, kind: "validate", ok: attempt === 3, output: { attempt } };
    },
    StopCondition.lastSucceeded(),
    {},
    { max_steps: 5 },
  );
  assert.equal(steps.length, 3);
  assert.equal(loop.succeeded, true);
  assert.equal(loop.attempts, 3);

  const capped = new AgentLoop<Record<string, never>, null>();
  await capped.run(
    () => ({ index: -1, kind: "retry", ok: false, output: null }),
    () => false,
    {},
    { max_steps: 2 },
  );
  assert.equal(capped.attempts, 2);
  assert.equal(capped.succeeded, false);
});

test("agent loop rejects concurrent runs on the same instance and remains reusable", async () => {
  const loop = new AgentLoop<Record<string, never>, string>();
  let enterStep!: () => void;
  const stepEntered = new Promise<void>((resolve) => { enterStep = resolve; });
  let releaseStep!: () => void;
  const stepGate = new Promise<void>((resolve) => { releaseStep = resolve; });
  const first = loop.run(
    async () => {
      enterStep();
      await stepGate;
      return { index: -1, kind: "first", ok: true, output: "first" };
    },
    StopCondition.maxSteps(1),
    {},
    { max_steps: 1 },
  );

  await stepEntered;
  try {
    await assert.rejects(
      loop.run(
        () => ({ index: -1, kind: "second", ok: true, output: "second" }),
        StopCondition.maxSteps(1),
        {},
        { max_steps: 1 },
      ),
      /already running/,
    );
  } finally {
    releaseStep();
  }
  assert.deepEqual(await first, [{ index: 0, kind: "first", ok: true, output: "first" }]);

  const reused = await loop.run(
    () => ({ index: -1, kind: "reused", ok: true, output: "reused" }),
    StopCondition.maxSteps(1),
    {},
    { max_steps: 1 },
  );
  assert.deepEqual(reused, [{ index: 0, kind: "reused", ok: true, output: "reused" }]);
});

test("create validates before mkdir and discarded cases reject canonical mutations", async (t) => {
  const { root, store } = await fixture(t);

  await assert.rejects(
    store.createCase({
      case_id: "case-initial-closed",
      title: "Invalid initial state",
      objective: "Must pass closure gates",
      status: "closed" as never,
      provenance,
    }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(fs.access(path.join(root, "case-initial-closed")));

  await assert.rejects(
    store.createCase({
      case_id: "case-retry-after-invalid",
      title: "   ",
      objective: "Validate before allocating storage",
      provenance,
    }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(fs.access(path.join(root, "case-retry-after-invalid")));

  await store.createCase({
    case_id: "case-retry-after-invalid",
    title: "Valid retry",
    objective: "The identifier remains usable",
    provenance,
  });
  const discarded = await store.updateCase(
    "case-retry-after-invalid",
    { status: "discarded" },
    provenance,
    { expected_revision: 0 },
  );
  await assert.rejects(
    store.addMemory("case-retry-after-invalid", {
      scope: "case",
      classification: "fact",
      statement: "Must not be written after discard",
      confidence: 1,
      provenance,
    }, { expected_revision: 1 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_TRANSITION",
  );
  assert.deepEqual(await store.readCase("case-retry-after-invalid"), discarded);
});

test("event and chat readers preserve JSONL order and context limits keep the newest item", async (t) => {
  const { root } = await fixture(t);
  const fixedClock = () => new Date("2026-08-06T12:00:00.000Z");
  let highCounter = 0;
  let lowCounter = 0;
  const first = new WorkspaceStore(root, {
    clock: fixedClock,
    id_generator: { next: (prefix) => `${prefix}_z${highCounter++}` },
  });
  const second = new WorkspaceStore(root, {
    clock: fixedClock,
    id_generator: { next: (prefix) => `${prefix}_a${lowCounter++}` },
  });

  await first.createCase({ case_id: "case-order", title: "Order", objective: "Preserve causality", provenance });
  await second.appendEvent(
    "case-order",
    { event_type: "custom.later", provenance },
    { expected_revision: 0 },
  );
  assert.deepEqual(
    (await first.listEvents("case-order")).map((event) => event.event_type),
    ["case.created", "custom.later"],
  );
  assert.deepEqual(
    (await new ContextAssembler(first).assemble("case-order", { event_limit: 1 })).events
      .map((event) => event.event_type),
    ["custom.later"],
  );

  const thread = await first.createChatThread(
    "case-order",
    { thread_id: "thread-order", provenance },
    { expected_revision: 1 },
  );
  await first.appendChatMessage("case-order", thread.thread_id, {
    message_id: "z-first",
    role: "user",
    content: "FIRST",
    provenance,
  }, { expected_revision: 2 });
  await first.appendChatMessage("case-order", thread.thread_id, {
    message_id: "a-second",
    role: "assistant",
    content: "SECOND",
    provider: "provider",
    model: "model",
    provenance,
  }, { expected_revision: 3 });

  assert.deepEqual(
    (await first.readChatMessages("case-order", thread.thread_id)).map((message) => message.content),
    ["FIRST", "SECOND"],
  );
  const assembled = await new ContextAssembler(first).assemble("case-order", { chat_message_limit: 1 });
  assert.deepEqual(assembled.chats[0]?.messages.map((message) => message.content), ["SECOND"]);
});

test("artifact collision preserves the existing immutable file", async (t) => {
  const { root, store } = await fixture(t);
  await store.createCase({ case_id: "case-collision", title: "Collision", objective: "Preserve bytes", provenance });
  const target = path.join(root, "case-collision", "artifacts", "artifact-fixed", "proof.txt");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "existing", "utf-8");

  await assert.rejects(
    store.addArtifact("case-collision", {
      artifact_id: "artifact-fixed",
      kind: "evidence",
      title: "Proof",
      relative_path: "proof.txt",
      content: "replacement",
      provenance,
    }, { expected_revision: 0 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "CONFLICT",
  );
  assert.equal(await fs.readFile(target, "utf-8"), "existing");
  assert.equal((await store.listArtifacts("case-collision")).length, 0);
});

test("filesystem lock serializes CAS across WorkspaceStore instances", async (t) => {
  const { root, store } = await fixture(t);
  const second = new WorkspaceStore(root);
  await store.createCase({ case_id: "case-cross-store", title: "CAS", objective: "Serialize writers", provenance });

  const raced = await Promise.allSettled([
    store.addMemory("case-cross-store", {
      memory_id: "memory-first",
      scope: "case",
      classification: "fact",
      statement: "first",
      confidence: 1,
      provenance,
    }, { expected_revision: 0 }),
    second.addMemory("case-cross-store", {
      memory_id: "memory-second",
      scope: "case",
      classification: "fact",
      statement: "second",
      confidence: 1,
      provenance,
    }, { expected_revision: 0 }),
  ]);

  assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await store.listMemory("case-cross-store")).length, 1);
  assert.equal((await store.readCase("case-cross-store")).revision, 1);
});

test("workspace read lock excludes mutations so snapshots cannot observe partial state", async (t) => {
  const { root, store } = await fixture(t);
  const second = new WorkspaceStore(root);
  await store.createCase({ case_id: "case-consistent-read", title: "Read lock", objective: "Exclude writers", provenance });

  let enterRead!: () => void;
  const readEntered = new Promise<void>((resolve) => { enterRead = resolve; });
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const consistentRead = store.withConsistentRead(async () => {
    const before = await store.readCase("case-consistent-read");
    enterRead();
    await readGate;
    const after = await store.readCase("case-consistent-read");
    assert.equal(after.revision, before.revision);
  });
  await readEntered;

  let mutationFinished = false;
  const mutation = second.addMemory("case-consistent-read", {
    memory_id: "memory-after-read",
    scope: "case",
    classification: "fact",
    statement: "visible only after the consistent read finishes",
    confidence: 1,
    provenance,
  }, { expected_revision: 0 }).then(() => { mutationFinished = true; });

  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(mutationFinished, false);
  releaseRead();
  await Promise.all([consistentRead, mutation]);
  assert.equal((await store.readCase("case-consistent-read")).revision, 1);
});

test("an active filesystem lock is never stolen merely because its lease age elapsed", async (t) => {
  const { root } = await fixture(t);
  const lockPath = path.join(root, "lease-test.lock");
  let enterOwner!: () => void;
  const ownerEntered = new Promise<void>((resolve) => { enterOwner = resolve; });
  let releaseOwner!: () => void;
  const ownerGate = new Promise<void>((resolve) => { releaseOwner = resolve; });

  const owner = withFileLock(lockPath, async () => {
    enterOwner();
    await ownerGate;
  }, { stale_ms: 20, retry_ms: 5, timeout_ms: 1_000 });
  await ownerEntered;
  await new Promise((resolve) => setTimeout(resolve, 50));

  let contenderEntered = false;
  const contender = withFileLock(lockPath, async () => {
    contenderEntered = true;
  }, { stale_ms: 20, retry_ms: 5, timeout_ms: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(contenderEntered, false);

  releaseOwner();
  await Promise.all([owner, contender]);
  assert.equal(contenderEntered, true);
});

test("multiple contenders reclaim one stale lock without overlapping", async (t) => {
  const { root } = await fixture(t);
  const lockPath = path.join(root, "stale-reclaim.lock");
  await fs.writeFile(lockPath, JSON.stringify({
    token: "dead-owner",
    pid: 2_147_483_647,
    created_at: "2000-01-01T00:00:00.000Z",
  }) + "\n", "utf-8");

  let active = 0;
  let maximumActive = 0;
  const contenders = Array.from({ length: 12 }, () => withFileLock(lockPath, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  }, { stale_ms: 0, retry_ms: 0, timeout_ms: 5_000 }));

  const settled = await Promise.allSettled(contenders);
  assert.deepEqual(settled.map((result) => result.status), Array(12).fill("fulfilled"));
  assert.equal(maximumActive, 1);
  await assert.rejects(fs.access(lockPath + ".reclaim"));
});

test("filesystem lock publishes complete owners during multi-process stale recovery", async (t) => {
  const { root } = await fixture(t);
  const lockPath = path.join(root, "atomic-owner.lock");
  const sentinelPath = path.join(root, "atomic-owner.sentinel");
  await fs.writeFile(lockPath, JSON.stringify({
    token: "dead-owner",
    pid: 2_147_483_647,
    created_at: "2000-01-01T00:00:00.000Z",
  }) + "\n", "utf-8");

  const lockModule = new URL("../src/lock.js", import.meta.url).href;
  const workerSource = `
    import * as fs from "node:fs/promises";
    import { setTimeout as delay } from "node:timers/promises";

    const lockPath = process.env.CVG_TEST_LOCK_PATH;
    const lockModule = process.env.CVG_TEST_LOCK_MODULE;
    const sentinelPath = process.env.CVG_TEST_SENTINEL_PATH;
    if (!lockPath || !lockModule || !sentinelPath) throw new Error("Missing lock worker configuration");
    const { withFileLock } = await import(lockModule);

    for (let index = 0; index < 8; index += 1) {
      await withFileLock(lockPath, async () => {
        let sentinel;
        try {
          sentinel = await fs.open(sentinelPath, "wx");
          await sentinel.writeFile(String(process.pid), "utf-8");
          await sentinel.sync();
          await delay(3);
        } finally {
          await sentinel?.close().catch(() => undefined);
          if (sentinel) await fs.rm(sentinelPath, { force: true });
        }
      }, { stale_ms: 0, retry_ms: 1, timeout_ms: 20_000 });
    }
  `;

  const runWorker = (): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
      env: {
        ...process.env,
        CVG_TEST_LOCK_MODULE: lockModule,
        CVG_TEST_LOCK_PATH: lockPath,
        CVG_TEST_SENTINEL_PATH: sentinelPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Lock worker exited with ${code}: ${stderr}`));
    });
  });

  await Promise.all(Array.from({ length: 6 }, () => runWorker()));
  await assert.rejects(fs.access(lockPath));
  await assert.rejects(fs.access(sentinelPath));
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.startsWith("atomic-owner.lock.")),
    [],
  );
});

test("artifact gates and reads reject tampered bytes", async (t) => {
  const { root, store } = await fixture(t);
  await store.createCase({ case_id: "case-tamper", title: "Tamper", objective: "Verify evidence", provenance });
  const artifact = await store.addArtifact("case-tamper", {
    artifact_id: "artifact-proof",
    kind: "evidence",
    title: "Proof",
    relative_path: "proof.txt",
    content: "valid",
    provenance,
  }, { expected_revision: 0 });
  const milestone = await store.createMilestone("case-tamper", {
    milestone_id: "milestone-proof",
    title: "Verify",
    status: "pending",
    provenance,
  }, { expected_revision: 1 });
  await fs.writeFile(path.join(root, "case-tamper", ...artifact.path.split("/")), "tampered", "utf-8");

  await assert.rejects(
    store.updateMilestone("case-tamper", milestone.milestone_id, {
      status: "validated",
      evidence_refs: [{ artifact_id: artifact.artifact_id }],
    }, provenance, { expected_revision: 2 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INTEGRITY_ERROR",
  );
  await assert.rejects(
    store.readArtifact("case-tamper", artifact.artifact_id),
    (error: unknown) => error instanceof ProtocolError && error.code === "INTEGRITY_ERROR",
  );
  assert.equal(await store.verifyArtifact("case-tamper", artifact.artifact_id), false);
  assert.equal((await store.readCase("case-tamper")).revision, 2);
});

test("stored identity validation prevents cross-case revision redirection", async (t) => {
  const { root, store } = await fixture(t);
  await store.createCase({ case_id: "case-a", title: "A", objective: "A", provenance });
  await store.createCase({ case_id: "case-b", title: "B", objective: "B", provenance });
  const case_file = path.join(root, "case-a", "case.json");
  const corrupted = JSON.parse(await fs.readFile(case_file, "utf-8")) as Record<string, unknown>;
  corrupted.case_id = "case-b";
  await fs.writeFile(case_file, JSON.stringify(corrupted), "utf-8");

  await assert.rejects(
    store.createMilestone("case-a", { title: "Must not write", provenance }, { expected_revision: 0 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INTEGRITY_ERROR",
  );
  assert.equal((await store.readCase("case-b")).revision, 0);
  assert.equal((await store.listMilestones("case-a")).length, 0);
});

test("runtime rejects identifiers outside the path-safe schema grammar and system chat", async (t) => {
  const { root, store } = await fixture(t);
  await assert.rejects(
    store.createCase({ case_id: "case#invalid", title: "Invalid", objective: "Reject ID", provenance }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_INPUT",
  );

  await store.createCase({
    case_id: "workspace-state",
    title: "Mutex namespace",
    objective: "Case identifiers cannot collide with internal mutex keys",
    provenance,
  });
  await store.appendEvent(
    "workspace-state",
    { event_type: "custom.mutex-namespace-verified", provenance },
    { expected_revision: 0 },
  );
  assert.equal((await store.readCase("workspace-state")).revision, 1);

  await store.createCase({ case_id: "case-chat-role", title: "Chat", objective: "Reject replay", provenance });
  const thread = await store.createChatThread("case-chat-role", { provenance }, { expected_revision: 0 });
  await assert.rejects(
    store.appendChatMessage("case-chat-role", thread.thread_id, {
      role: "system" as never,
      content: "do not persist",
      provenance,
    }, { expected_revision: 1 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_INPUT",
  );
  assert.equal((await store.readCase("case-chat-role")).revision, 1);

  await fs.appendFile(
    path.join(root, "case-chat-role", "chat", thread.thread_id + ".jsonl"),
    JSON.stringify({
      schema_version: "1.0.0",
      message_id: "message-imported-system",
      case_id: "case-chat-role",
      thread_id: thread.thread_id,
      role: "system",
      content: "untrusted replay",
      metadata: {},
      created_at: "2026-08-06T12:00:00.000Z",
      provenance: {
        actor: "importer",
        actor_type: "import",
        source: "test-import",
        occurred_at: "2026-08-06T12:00:00.000Z",
      },
    }) + "\n",
    "utf-8",
  );
  await assert.rejects(
    store.readChat("case-chat-role", thread.thread_id),
    (error: unknown) => error instanceof ProtocolError && error.code === "INTEGRITY_ERROR",
  );
});

test("closure gates cannot be bypassed through a direct status update", async (t) => {
  const { root, store } = await fixture(t);
  await store.createCase({
    case_id: "case-closure",
    title: "Closure gates",
    objective: "Close only after evidence-backed validation.",
    status: "active",
    provenance,
  });
  const validation = await store.addArtifact("case-closure", {
    artifact_id: "artifact-validation",
    kind: "test_run",
    title: "Validation run",
    relative_path: "validation.txt",
    content: "validated",
    provenance,
  }, { expected_revision: 0 });
  const milestone = await store.createMilestone("case-closure", {
    milestone_id: "milestone-validation",
    title: "Validate the fix",
    status: "pending",
    provenance,
  }, { expected_revision: 1 });
  await store.updateMilestone("case-closure", milestone.milestone_id, {
    status: "validated",
    evidence_refs: [{ artifact_id: validation.artifact_id, digest: validation.digest }],
  }, provenance, { expected_revision: 2 });
  const report = await store.addArtifact("case-closure", {
    artifact_id: "artifact-final-report",
    kind: "report",
    title: "Final report",
    relative_path: "final.md",
    content: "Objective met and validation scope recorded.",
    provenance,
  }, { expected_revision: 3 });
  await store.updateCase("case-closure", { status: "resolved" }, provenance, { expected_revision: 4 });

  await assert.rejects(
    store.updateCase("case-closure", { status: "closed" }, provenance, { expected_revision: 5 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_TRANSITION",
  );

  const closureInput = {
    criteria: [{
      criterion_id: "criterion-no-regression",
      description: "The validated path no longer reproduces the failure.",
      mandatory: true,
      disposition: "met",
      evidence_refs: [{ artifact_id: validation.artifact_id, digest: validation.digest }],
    }],
    validation_scope: {
      summary: "Controlled validation of the affected path.",
      environments: ["qa"],
      limitations: ["Production observation remains outside this controlled run."],
      evidence_refs: [{ artifact_id: validation.artifact_id, digest: validation.digest }],
    },
    residual_risks: [{
      risk_id: "risk-production-observation",
      description: "Production observation is outside the controlled validation.",
      impact: "A production-only regression could remain undetected by this controlled run.",
      disposition: "accepted",
      owner: "operator-1",
      rationale: "Monitor through the normal operational process.",
    }],
    memory_reviewed: true,
    context_reviewed: true,
    final_report_artifact_id: report.artifact_id,
    provenance,
  } satisfies CloseCaseInput;
  const closureCriterion = closureInput.criteria[0]!;

  await assert.rejects(
    store.closeCase("case-closure", {
      ...closureInput,
      residual_risks: [{ ...closureInput.residual_risks[0]!, impact: " " }],
    }, { expected_revision: 5 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_INPUT",
  );

  const mutableCaseBytes = await fs.readFile(path.join(root, "case-closure", "case.json"));
  const mutableCaseDigest = (
    "sha256:" + createHash("sha256").update(mutableCaseBytes).digest("hex")
  ) as `sha256:${string}`;
  await assert.rejects(
    store.closeCase("case-closure", {
      ...closureInput,
      criteria: [{
        ...closureCriterion,
        evidence_refs: [{ path: "case.json", digest: mutableCaseDigest }],
      }],
    }, { expected_revision: 5 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INTEGRITY_ERROR",
  );

  await assert.rejects(
    store.closeCase("case-closure", {
      ...closureInput,
      criteria: [{
        ...closureCriterion,
        evidence_refs: [
          { locator: "ticket-without-resolvable-bytes" } as unknown as StrongEvidenceRef,
        ],
      }],
    }, { expected_revision: 5 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INTEGRITY_ERROR",
  );

  const validationPath = path.join(root, "case-closure", ...validation.path.split("/"));
  await fs.writeFile(validationPath, "tampered", "utf-8");
  await assert.rejects(
    store.closeCase("case-closure", {
      ...closureInput,
      criteria: [{
        ...closureCriterion,
        evidence_refs: [{ artifact_id: report.artifact_id, digest: report.digest }],
      }],
      validation_scope: {
        ...closureInput.validation_scope,
        evidence_refs: [{ artifact_id: report.artifact_id, digest: report.digest }],
      },
    }, { expected_revision: 5 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INTEGRITY_ERROR",
  );
  await fs.writeFile(validationPath, "validated", "utf-8");

  const closed = await store.closeCase("case-closure", closureInput, { expected_revision: 5 });
  assert.equal(closed.status, "closed");
  assert.equal(closed.revision, 6);

  const closeEvent = (await store.listEvents("case-closure")).find((event) => event.event_type === "case.closed");
  assert.ok(closeEvent);
  assert.deepEqual(closeEvent.payload.criteria, [{
    criterion_id: "criterion-no-regression",
    description: "The validated path no longer reproduces the failure.",
    mandatory: true,
    disposition: "met",
    evidence_refs: [{ artifact_id: validation.artifact_id, digest: validation.digest }],
  }]);
  assert.deepEqual(closeEvent.payload.validation_scope, closureInput.validation_scope);
  assert.deepEqual(closeEvent.payload.residual_risks, closureInput.residual_risks);
  assert.equal(closeEvent.payload.memory_reviewed, true);
  assert.equal(closeEvent.payload.context_reviewed, true);
  assert.equal(closeEvent.payload.final_report_artifact_id, report.artifact_id);
  assert.equal(closeEvent.provenance.actor, provenance.actor);

  await assert.rejects(
    store.updateCase("case-closure", { summary: "Must remain frozen" }, provenance, { expected_revision: 6 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_TRANSITION",
  );
  await assert.rejects(
    store.addArtifact("case-closure", {
      kind: "attachment",
      title: "Late attachment",
      relative_path: "late.txt",
      content: "too late",
      provenance,
    }, { expected_revision: 6 }),
    (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_TRANSITION",
  );
  assert.deepEqual(await store.readCase("case-closure"), closed);
});
