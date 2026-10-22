#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AzureReadClient, SnapshotStore, SettingsStore, PortfolioStore, ReviewStore, changedFields, claudeTextReviewer, reviewPrompt, planWaves, refreshWorkspaceSource, syncLegacySource, SprintStore } from "./index.js";
import type { SourceIdentity, SprintTask } from "./index.js";

const help = `CVG Studio CLI — mismo núcleo que CVG Studio View (sin servidor web)
Comando: cvg-studio-cli (alias compatible: cvg-workflow)
  settings get
  settings set <task|subtask> <concurrencia> <revision-esperada>
  portfolio list
  portfolio company add <nombre> <revision-esperada> [id]
  portfolio project add <nombre> <revision-esperada> [id] [empresa-id]
  portfolio project add-azure <nombre> <revision-esperada> <organizacion> <proyecto-azure> <pat-env|azure_cli> [id] [empresa-id]
  snapshot history <workspace> <ticket-id>
  snapshot refresh <workspace> <ticket-id>
  snapshot diff <workspace> <ticket-id> <version-a> <version-b>
  snapshot baseline <workspace> <ticket-id> <version> <baseline-esperada>
  pr list [active|all] [skip]
  pr prepare <url>                contexto/prompt, sin ejecutar agente
  pr review <url>                 análisis local con Claude nativo sin herramientas
  pr history
  sprint plan <archivo-tareas.json> [concurrencia]
  sprint iterations <equipo>
  sprint import <equipo> <iteration-id> <email-o-id-responsable>
  sprint list
  sprint history <sprint-local-id>

CVG_WORKFLOWS_ROOT (o CASES_DIR): directorio de workspaces compartido con Studio.
AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT (un proyecto), AZURE_DEVOPS_PAT
o AZURE_DEVOPS_AUTH_MODE=azure_cli. CLAUDE_BIN opcional (.exe nativo en Windows).
No crea PRs, no publica comentarios, no ejecuta código del PR ni pruebas de API.
`;
export async function main(args: string[]): Promise<unknown> {
  if (!args.length || args.includes("--help")) return help;
  const root = process.env.CVG_WORKFLOWS_ROOT || process.env.CASES_DIR;
  if (!root) throw new Error("Indicá CVG_WORKFLOWS_ROOT o CASES_DIR explícitamente");
  const [domain, action, ...rest] = args;
  const settings = new SettingsStore(path.resolve(root));
  const portfolio = new PortfolioStore(path.resolve(root));
  const client = () => new AzureReadClient({ organization: process.env.AZURE_DEVOPS_ORG ?? "", project: process.env.AZURE_DEVOPS_PROJECT ?? "", pat: process.env.AZURE_DEVOPS_PAT ?? "", auth_mode: process.env.AZURE_DEVOPS_AUTH_MODE === "azure_cli" ? "azure_cli" : "pat" });
  if (domain === "settings") {
    if (action === "get") return settings.read();
    if (action === "set") return settings.update({ expected_revision: Number(rest[2]), pr_granularity: rest[0] as "task" | "subtask", max_parallel_tasks: Number(rest[1]) });
  }
  if (domain === "portfolio") {
    if (action === "list") return portfolio.read();
    if (action === "company" && rest[0] === "add" && rest[1] && rest[2]) return portfolio.createCompany({ name: rest[1], expected_revision: Number(rest[2]), ...(rest[3] ? { id: rest[3] } : {}) });
    if (action === "project" && rest[0] === "add" && rest[1] && rest[2]) return portfolio.createProject({ name: rest[1], expected_revision: Number(rest[2]), ...(rest[3] ? { id: rest[3] } : {}), ...(rest[4] ? { company_id: rest[4] } : {}) });
    if (action === "project" && rest[0] === "add-azure" && rest[1] && rest[2] && rest[3] && rest[4] && rest[5]) {
      const source = rest[5] === "azure_cli" ? { organization: rest[3], project: rest[4], auth_mode: "azure_cli" as const } : { organization: rest[3], project: rest[4], auth_mode: "pat" as const, credential_env: rest[5] };
      return portfolio.createProject({ name: rest[1], expected_revision: Number(rest[2]), azure_devops: source, ...(rest[6] ? { id: rest[6] } : {}), ...(rest[7] ? { company_id: rest[7] } : {}) });
    }
  }
  if (domain === "snapshot") {
    const workspace = rest[0]; const ticket = rest[1];
    if (!workspace || !ticket) throw new Error("Faltan workspace e ID de tarea");
    const azure = client(); const source: SourceIdentity = azure.source(ticket);
    const store = new SnapshotStore(path.resolve(root));
    if (action === "refresh") {
      // Do not silently create a workspace by mistyping its name.
      const historyDir = path.resolve(root, workspace);
      if (path.dirname(historyDir) !== path.resolve(root) || !(await fs.stat(historyDir)).isDirectory()) throw new Error("Workspace inexistente o inválido");
      return refreshWorkspaceSource(path.resolve(root), workspace, source, () => azure.captureTicket(ticket));
    }
    const history = await store.history(workspace, source);
    if (action === "history") return history;
    if (action === "baseline") {
      const result = await store.useBaseline(workspace, source, Number(rest[2]), Number(rest[3]));
      await syncLegacySource(path.resolve(root), workspace, source);
      return result;
    }
    if (action === "diff") {
      const before = history.versions.find(v => v.version === Number(rest[2]));
      const after = history.versions.find(v => v.version === Number(rest[3]));
      if (!before || !after) throw new Error("Versión inexistente");
      return { fields: changedFields(before.content, after.content), before, after };
    }
  }
  if (domain === "pr") {
    const store = new ReviewStore(path.resolve(root));
    if (action === "history") return store.list();
    const azure = client();
    if (action === "list") return azure.listPrs((rest[0] ?? "active") as "active" | "all", Number(rest[1] ?? 0));
    const ref = azure.parsePrUrl(rest[0] ?? "");
    if (action === "prepare") return reviewPrompt(await azure.reviewContext(ref));
    if (action === "review") return store.review(azure, ref, claudeTextReviewer(process.env.CLAUDE_BIN));
  }
  if (domain === "sprint") {
    const store = new SprintStore(path.resolve(root));
    if (action === "list") return store.list();
    if (action === "history" && rest[0]) return store.imports(rest[0]);
    if (action === "iterations" && rest[0]) return client().iterations(rest[0]);
    if (action === "import" && rest[0] && rest[1] && rest[2]) return store.import(client(), { team: rest[0], iteration_id: rest[1], assignee: rest[2] });
    if (action === "plan" && rest[0]) {
      const tasks = JSON.parse(await fs.readFile(rest[0], "utf8")) as SprintTask[];
      return { mode: "plan_only", waves: planWaves(tasks, Number(rest[1] ?? (await settings.read()).max_parallel_tasks)) };
    }
  }
  throw new Error("Comando inválido. Consultá --help");
}
main(process.argv.slice(2)).then(result => process.stdout.write(typeof result === "string" ? result : JSON.stringify(result, null, 2) + "\n"))
  .catch(error => { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; });
