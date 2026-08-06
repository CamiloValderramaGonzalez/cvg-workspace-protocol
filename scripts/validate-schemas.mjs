import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = fileURLToPath(new URL("../schemas/", import.meta.url));
const files = (await readdir(root)).filter((name) => name.endsWith(".schema.json")).sort();
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const failures = [];
let semanticFixtureCount = 0;

const fixture = (name, expected_valid, mutate) => ({ name, expected_valid, mutate });
const humanReviewer = {
  actor: "human-reviewer-1",
  actor_type: "human",
  source: "schema-validation",
  occurred_at: "2026-08-06T16:00:00Z",
};
const unsafeRelativePaths = [
  "C:/workspace/evidence.json",
  "/workspace/evidence.json",
  "../evidence.json",
  "artifacts/../evidence.json",
  "artifacts/./evidence.json",
  "artifacts\\evidence.json",
  "artifacts//evidence.json",
  "artifacts/",
];

const semanticFixtures = {
  "artifact-manifest.schema.json": [
    fixture("accepts a portable relative artifact path", true, (value) => {
      value.path = "artifacts/artifact-1/evidence.json";
    }),
    ...unsafeRelativePaths.map((path) => fixture(`rejects unsafe artifact path ${JSON.stringify(path)}`, false, (value) => {
      value.path = path;
    })),
  ],
  "case.schema.json": [
    fixture("accepts a non-closed case without closed_at", true, (value) => {
      value.status = "active";
      delete value.closed_at;
    }),
    fixture("rejects a closed case without closed_at", false, (value) => {
      value.status = "closed";
      delete value.closed_at;
    }),
    fixture("accepts a closed case with closed_at", true, (value) => {
      value.status = "closed";
      value.closed_at = "2026-08-06T16:00:00Z";
    }),
  ],
  "context-proposal.schema.json": [
    fixture("accepts approved context with evidence and a human reviewer", true, (value) => {
      value.status = "approved";
      value.reviewed_by = structuredClone(humanReviewer);
    }),
    fixture("rejects approved context without evidence", false, (value) => {
      value.status = "approved";
      value.evidence_refs = [];
      value.reviewed_by = structuredClone(humanReviewer);
    }),
    fixture("rejects approved context without a reviewer", false, (value) => {
      value.status = "approved";
      delete value.reviewed_by;
    }),
    fixture("rejects approved context reviewed by an agent", false, (value) => {
      value.status = "approved";
      value.reviewed_by = { ...humanReviewer, actor_type: "agent" };
    }),
    fixture("accepts superseded context with review and successor", true, (value) => {
      value.status = "superseded";
      value.reviewed_by = structuredClone(humanReviewer);
      value.superseded_by_proposal_id = "proposal-case-0042-4";
    }),
    fixture("rejects superseded context without a successor", false, (value) => {
      value.status = "superseded";
      value.reviewed_by = structuredClone(humanReviewer);
      delete value.superseded_by_proposal_id;
    }),
    fixture("accepts a portable relative context evidence path", true, (value) => {
      value.evidence_refs = [{ path: "artifacts/artifact-1/evidence.json" }];
    }),
    ...unsafeRelativePaths.map((path) => fixture(`rejects unsafe context evidence path ${JSON.stringify(path)}`, false, (value) => {
      value.evidence_refs = [{ path }];
    })),
  ],
  "event.schema.json": [
    fixture("accepts the canonical handoff request", true, () => {}),
    fixture("rejects a handoff request without handoff_id", false, (value) => {
      delete value.payload.handoff_id;
    }),
    fixture("rejects a handoff request without target_role", false, (value) => {
      delete value.payload.target_role;
    }),
    fixture("accepts an unrelated event with a generic payload", true, (value) => {
      value.event_type = "custom.note";
      value.payload = {};
    }),
    fixture("accepts a portable relative handoff evidence path", true, (value) => {
      value.payload.evidence_refs = [{ path: "artifacts/artifact-1/evidence.json" }];
    }),
    ...unsafeRelativePaths.map((path) => fixture(`rejects unsafe handoff evidence path ${JSON.stringify(path)}`, false, (value) => {
      value.payload.evidence_refs = [{ path }];
    })),
  ],
  "memory-entry.schema.json": [
    fixture("accepts a portable relative memory evidence path", true, (value) => {
      value.evidence_refs = [{ path: "artifacts/artifact-1/evidence.json" }];
    }),
    ...unsafeRelativePaths.map((path) => fixture(`rejects unsafe memory evidence path ${JSON.stringify(path)}`, false, (value) => {
      value.evidence_refs = [{ path }];
    })),
  ],
  "milestone.schema.json": [
    fixture("accepts validated milestone with evidence", true, () => {}),
    fixture("rejects validated milestone without evidence", false, (value) => {
      value.status = "validated";
      value.evidence_refs = [];
    }),
    fixture("rejects completed milestone without evidence", false, (value) => {
      value.status = "completed";
      value.evidence_refs = [];
    }),
    fixture("accepts pending milestone without evidence", true, (value) => {
      value.status = "pending";
      value.evidence_refs = [];
    }),
    fixture("accepts a portable relative milestone evidence path", true, (value) => {
      value.evidence_refs = [{ path: "artifacts/artifact-1/evidence.json" }];
    }),
    ...unsafeRelativePaths.map((path) => fixture(`rejects unsafe milestone evidence path ${JSON.stringify(path)}`, false, (value) => {
      value.evidence_refs = [{ path }];
    })),
  ],
};

for (const file of files) {
  let schema;
  try {
    schema = JSON.parse(await readFile(join(root, file), "utf8"));
  } catch (error) {
    failures.push(`${file}: invalid JSON (${error.message})`);
    continue;
  }

  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    failures.push(`${file}: invalid schema (${error.message})`);
    continue;
  }

  if (!Array.isArray(schema.examples) || schema.examples.length === 0) {
    failures.push(`${file}: include at least one example`);
    continue;
  }

  schema.examples.forEach((example, index) => {
    if (!validate(example)) {
      failures.push(`${file}: example ${index + 1} fails validation: ${ajv.errorsText(validate.errors)}`);
    }
  });

  for (const semanticFixture of semanticFixtures[file] ?? []) {
    semanticFixtureCount += 1;
    const candidate = structuredClone(schema.examples[0]);
    semanticFixture.mutate(candidate);
    const valid = validate(candidate);
    if (valid !== semanticFixture.expected_valid) {
      const detail = valid
        ? "unexpectedly passed validation"
        : `unexpectedly failed validation: ${ajv.errorsText(validate.errors)}`;
      failures.push(`${file}: fixture "${semanticFixture.name}" ${detail}`);
    }
  }
}

if (files.length === 0) failures.push("no schema files found");

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${files.length} schemas, their examples, and ${semanticFixtureCount} semantic fixtures.`);
}
