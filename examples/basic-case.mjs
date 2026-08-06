import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ContextAssembler, WorkspaceStore } from "@cvg/workspace-protocol";

const root = process.argv[2] ?? await fs.mkdtemp(path.join(os.tmpdir(), "cvg-workspace-protocol-example-"));
const store = new WorkspaceStore(root);
const provenance = {
  actor: "example-operator",
  actor_type: "human",
  source: "basic-case-example",
};
const reviewer = {
  actor: "example-reviewer",
  actor_type: "human",
  source: "basic-case-example-review",
};

const caseRecord = await store.createCase({
  title: "Intermittent checkout timeout",
  objective: "Identify an evidence-backed cause and a bounded validation plan.",
  status: "active",
  provenance,
});

const evidence = await store.addArtifact(caseRecord.case_id, {
  kind: "evidence",
  title: "Reproduction summary",
  relative_path: "reproduction.txt",
  content: "30/30 timeouts correlated with payment latency above 10 seconds.",
  provenance,
}, { expected_revision: 0 });

const milestone = await store.createMilestone(caseRecord.case_id, {
  title: "Reproduce the timeout",
  status: "pending",
  provenance,
}, { expected_revision: 1 });

await store.updateMilestone(caseRecord.case_id, milestone.milestone_id, {
  status: "validated",
  evidence_refs: [{ artifact_id: evidence.artifact_id, digest: evidence.digest }],
}, provenance, { expected_revision: 2 });

const contextProposal = await store.proposeContext(caseRecord.case_id, {
  summary: "Verified request path",
  content: "Checkout calls the gateway and then the payment service.",
  evidence_refs: [{ artifact_id: evidence.artifact_id }],
  base_version: 0,
  base_revision: 0,
  provenance,
}, { expected_revision: 3 });

await store.approveContext(
  caseRecord.case_id,
  contextProposal.proposal_id,
  { note: "Reviewed against the reproduction evidence.", provenance: reviewer },
  { expected_revision: 4 },
);

await store.addMemory(caseRecord.case_id, {
  scope: "case",
  classification: "fact",
  statement: "The reproduced failures correlate with payment-side latency, not gateway processing time.",
  evidence_refs: [{ artifact_id: evidence.artifact_id, digest: evidence.digest }],
  confidence: 0.95,
  provenance,
}, { expected_revision: 5 });

const context = await new ContextAssembler(store).assemble(caseRecord.case_id);
console.log(JSON.stringify({ workspace: root, context }, null, 2));
