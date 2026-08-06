import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../skills/", import.meta.url));
const entries = await readdir(root, { withFileTypes: true });
const failures = [];
let count = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  count += 1;
  const directory = join(root, entry.name);
  const skillPath = join(directory, "SKILL.md");
  const metadataPath = join(directory, "agents", "openai.yaml");

  if (!/^[a-z0-9-]{1,63}$/.test(entry.name)) {
    failures.push(`${entry.name}: invalid directory name`);
  }

  let source;
  try {
    source = await readFile(skillPath, "utf8");
  } catch {
    failures.push(`${entry.name}: missing SKILL.md`);
    continue;
  }

  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    failures.push(`${entry.name}: missing YAML frontmatter`);
    continue;
  }

  const frontmatter = match[1];
  const keys = [...frontmatter.matchAll(/^([a-zA-Z0-9_-]+):/gm)].map((item) => item[1]);
  if (keys.join(",") !== "name,description") {
    failures.push(`${entry.name}: frontmatter must contain only name and description`);
  }
  if (!new RegExp(`^name:\\s*${entry.name.replaceAll("-", "\\-")}\\s*$`, "m").test(frontmatter)) {
    failures.push(`${entry.name}: name must match directory`);
  }
  if (!/^description:\s*\S.+$/m.test(frontmatter)) {
    failures.push(`${entry.name}: description is missing`);
  }
  if (/\bTODO\b/i.test(source)) {
    failures.push(`${entry.name}: unresolved TODO`);
  }
  if (source.split(/\r?\n/).length > 500) {
    failures.push(`${entry.name}: SKILL.md exceeds 500 lines`);
  }

  try {
    const metadata = await readFile(metadataPath, "utf8");
    if (!metadata.includes(`$${entry.name}`)) {
      failures.push(`${entry.name}: default_prompt must mention $${entry.name}`);
    }
  } catch {
    failures.push(`${entry.name}: missing agents/openai.yaml`);
  }
}

if (count === 0) failures.push("no skills found");

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${count} skills.`);
}
