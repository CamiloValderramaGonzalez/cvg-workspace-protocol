import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SourceContent, SourceIdentity } from "./snapshots.js";
const execute = promisify(execFile);
type Obj = Record<string, any>;
export interface AzureReadConfig { organization: string; project: string; pat?: string; auth_mode?: "pat" | "azure_cli"; /** Perfil local aislado de Azure CLI para un proyecto Studio. */ azure_cli_config_dir?: string }
export interface PrRef { project: string; repository: string; id: number }
export interface AzureRepository { id: string; name: string; remote_url: string; default_branch: string | null }
/** Work item liviano para elegir la tarea de origen de un workspace. */
export interface AzureWorkItem { id: string; subject: string; status?: string; priority?: string; updated_at?: string; external_url: string }
export interface PrSummary extends PrRef { title: string; url: string; status: string; author: string; source_branch: string; target_branch: string; created_at: string }
export interface ReviewFile { path: string; original_path: string; change_type: string; before: string | null; after: string | null; omitted_reason: string | null }
export interface PrContext {
  pr: PrSummary; description: string; source_commit: string; target_commit: string; base_commit: string;
  iteration: number; captured_at: string; files: ReviewFile[]; limitations: string[];
}
export interface AzureIteration { id: string; name: string; path: string; attributes: { startDate?: string; finishDate?: string; timeFrame?: string } }
export interface SprintSelection { team: string; iteration_id: string; assignee: string }
export interface AzureSprintScope { iteration: AzureIteration; selection: SprintSelection; all_items: Obj[]; selected_items: Obj[] }
function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new Error(`${name} requerido`);
  return value.trim();
}
export class AzureReadClient {
  private readonly organization: string;
  private readonly project: string;
  private credentials: Promise<Record<string, string>> | undefined;
  constructor(private readonly config: AzureReadConfig, private readonly transport: typeof fetch = fetch) {
    this.organization = required(config.organization, "Organización");
    this.project = required(config.project, "Proyecto");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(this.organization)) throw new Error("Usá el nombre de organización de Azure, no una URL");
  }
  private headers(): Promise<Record<string, string>> {
    this.credentials ??= this.loadHeaders().catch(error => { this.credentials = undefined; throw error; });
    return this.credentials;
  }
  private async loadHeaders(): Promise<Record<string, string>> {
    if (this.config.auth_mode === "azure_cli") {
      // No shell interpolation; the resource and arguments are fixed.
      const bin = process.platform === "win32" ? "az.cmd" : "az";
      // Azure's Windows shim needs cmd; use only a fixed command without user-controlled arguments.
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, ...(this.config.azure_cli_config_dir ? { AZURE_CONFIG_DIR: this.config.azure_cli_config_dir } : {}) };
        if (process.platform === "win32") {
          const cliDirectory = `${process.env.ProgramFiles || "C:\\Program Files"}\\Microsoft SDKs\\Azure\\CLI2\\wbin`;
          if (!(env.PATH ?? "").toLowerCase().split(";").includes(cliDirectory.toLowerCase())) env.PATH = `${cliDirectory};${env.PATH ?? ""}`;
        }
        const result = process.platform === "win32"
          ? await execute(process.env.ComSpec || `${process.env.SystemRoot || "C:\\Windows"}\\System32\\cmd.exe`, ["/d", "/s", "/c", "az.cmd", "account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "--query", "accessToken", "-o", "tsv"], { windowsHide: true, timeout: 20_000, env })
          : await execute(bin, ["account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "--query", "accessToken", "-o", "tsv"], { timeout: 20_000, env });
        const token = result.stdout.trim();
        if (!token) throw new Error("Azure CLI no devolvió una sesión válida");
        return { Authorization: `Bearer ${token}`, Accept: "application/json" };
      } catch {
        throw new Error("No se pudo usar la sesión local de Azure. Iniciá sesión con Azure CLI en esta PC y volvé a probar la conexión.");
      }
    }
    if (!this.config.pat) throw new Error("Azure no configurado: falta PAT o autenticación Azure CLI");
    return { Authorization: `Basic ${Buffer.from(`:${this.config.pat}`).toString("base64")}`, Accept: "application/json" };
  }
  private async get(route: string, params: Record<string, string> = {}, project: string | null = this.project, team?: string): Promise<{ data: Obj; continuation: string | null }> {
    const base = project === null
      ? `https://dev.azure.com/${encodeURIComponent(this.organization)}/_apis/${route}`
      : `https://dev.azure.com/${encodeURIComponent(this.organization)}/${encodeURIComponent(project)}${team ? '/' + encodeURIComponent(team) : ''}/_apis/${route}`;
    const url = new URL(base);
    url.search = new URLSearchParams({ "api-version": "7.1", ...params }).toString();
    const response = await this.transport(url, { headers: await this.headers(), signal: AbortSignal.timeout(25_000), redirect: "error" });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 360);
      throw new Error(`Azure devolvió HTTP ${response.status} al leer ${route.split("/")[0]}${detail ? `: ${detail}` : ""}`);
    }
    // Avoid unbounded files/context, including misleading content-length headers.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Respuesta vacía de Azure");
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8_000_000) { await reader.cancel(); throw new Error("Respuesta de Azure excede el límite de 8 MB"); }
      chunks.push(chunk.value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Obj;
    return { data, continuation: response.headers.get("x-ms-continuationtoken") };
  }
  private async post(route: string, body: Obj, project: string | null = this.project): Promise<Obj> {
    const base = project === null
      ? `https://dev.azure.com/${encodeURIComponent(this.organization)}/_apis/${route}`
      : `https://dev.azure.com/${encodeURIComponent(this.organization)}/${encodeURIComponent(project)}/_apis/${route}`;
    const url = new URL(base); url.search = new URLSearchParams({ "api-version": "7.1" }).toString();
    const response = await this.transport(url, { method: "POST", headers: { ...(await this.headers()), "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000), redirect: "error" });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 360);
      throw new Error(`Azure devolvió HTTP ${response.status} al leer ${route.split("/")[0]}${detail ? `: ${detail}` : ""}`);
    }
    const text = await response.text();
    if (text.length > 8_000_000) throw new Error("Respuesta de Azure excede el límite de 8 MB");
    return JSON.parse(text) as Obj;
  }
  source(ticketId: string): SourceIdentity {
    if (!/^\d+$/.test(ticketId)) throw new Error("ID Azure inválido");
    return { provider: "azure_devops", organization: this.organization, project: this.project, ticket_id: ticketId };
  }
  /** A bounded read used only to validate the selected organization/project and credentials. */
  async verifyConnection(): Promise<{ id: string; name: string }> {
    const { data } = await this.get(`projects/${encodeURIComponent(this.project)}`, {}, null);
    if (typeof data.id !== "string" || typeof data.name !== "string") throw new Error("Azure devolvió una respuesta de proyecto incompleta");
    return { id: data.id, name: data.name };
  }
  /** Lists repositories visible to the signed-in user; it does not clone or modify them. */
  async listRepositories(): Promise<AzureRepository[]> {
    const { data } = await this.get("git/repositories", { "$top": "1000" });
    if (!Array.isArray(data.value)) throw new Error("Listado de repositorios incompleto");
    return data.value.map((repository: Obj) => {
      if (typeof repository.id !== "string" || typeof repository.name !== "string" || !repository.name.trim()) throw new Error("Azure devolvió un repositorio incompleto");
      return {
        id: repository.id,
        name: repository.name,
        remote_url: `https://dev.azure.com/${encodeURIComponent(this.organization)}/${encodeURIComponent(this.project)}/_git/${encodeURIComponent(repository.name)}`,
        default_branch: typeof repository.defaultBranch === "string" ? repository.defaultBranch : null,
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
  }
  /** Lista tareas no cerradas del proyecto para elegir el origen de un workspace. */
  async listOpenWorkItems(limit = 80): Promise<AzureWorkItem[]> {
    const top = Math.max(1, Math.min(limit, 200));
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project.replace(/'/g, "''")}' AND [System.State] <> 'Closed' ORDER BY [System.ChangedDate] DESC`;
    const result = await this.post("wit/wiql", { query });
    const ids = (Array.isArray(result.workItems) ? result.workItems : []).map(item => Number(item?.id)).filter(id => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) return [];
    const fields = "System.Id,System.Title,System.State,System.ChangedDate,Microsoft.VSTS.Common.Priority";
    const { data } = await this.get("wit/workitems", { ids: ids.join(","), fields });
    if (!Array.isArray(data.value)) throw new Error("Listado de tareas incompleto");
    return data.value.map((item: Obj) => {
      const id = String(item.id ?? item.fields?.["System.Id"] ?? "");
      const title = String(item.fields?.["System.Title"] ?? "").trim();
      if (!/^\d+$/.test(id) || !title) throw new Error("Azure devolvió una tarea incompleta");
      return { id, subject: title, ...(item.fields?.["System.State"] ? { status: String(item.fields["System.State"]) } : {}), ...(item.fields?.["Microsoft.VSTS.Common.Priority"] !== undefined ? { priority: String(item.fields["Microsoft.VSTS.Common.Priority"]) } : {}), ...(item.fields?.["System.ChangedDate"] ? { updated_at: String(item.fields["System.ChangedDate"]) } : {}), external_url: `https://dev.azure.com/${this.organization}/${encodeURIComponent(this.project)}/_workitems/edit/${id}` };
    });
  }
  /** Lee el work item elegido para fijar el título y validar que pertenece al proyecto. */
  async readWorkItem(ticketId: string): Promise<AzureWorkItem> {
    this.source(ticketId);
    const fields = "System.Id,System.Title,System.State,System.ChangedDate,Microsoft.VSTS.Common.Priority,System.TeamProject";
    const { data } = await this.get(`wit/workitems/${ticketId}`, { fields });
    if (String(data.fields?.["System.TeamProject"] ?? "").toLowerCase() !== this.project.toLowerCase()) throw new Error("La tarea pertenece a otro proyecto; elegila desde su proyecto real");
    const title = String(data.fields?.["System.Title"] ?? "").trim();
    if (!title) throw new Error("Azure devolvió una tarea sin título");
    return { id: ticketId, subject: title, ...(data.fields?.["System.State"] ? { status: String(data.fields["System.State"]) } : {}), ...(data.fields?.["Microsoft.VSTS.Common.Priority"] !== undefined ? { priority: String(data.fields["Microsoft.VSTS.Common.Priority"]) } : {}), ...(data.fields?.["System.ChangedDate"] ? { updated_at: String(data.fields["System.ChangedDate"]) } : {}), external_url: `https://dev.azure.com/${this.organization}/${encodeURIComponent(this.project)}/_workitems/edit/${ticketId}` };
  }
  async iterations(team: string): Promise<AzureIteration[]> {
    const { data } = await this.get("work/teamsettings/iterations", {}, this.project, required(team, "Equipo"));
    if (!Array.isArray(data.value)) throw new Error("Listado de sprints incompleto");
    return data.value;
  }
  async sprintScope(input: SprintSelection): Promise<AzureSprintScope> {
    const selection = { team: required(input.team, "Equipo"), iteration_id: required(input.iteration_id, "Sprint"), assignee: required(input.assignee, "Email o ID del responsable") };
    const iteration = (await this.iterations(selection.team)).find(i => i.id === selection.iteration_id);
    if (!iteration) throw new Error("Sprint no encontrado en el equipo seleccionado");
    const { data } = await this.get(`work/teamsettings/iterations/${encodeURIComponent(iteration.id)}/workitems`, {}, this.project, selection.team);
    if (!Array.isArray(data.workItemRelations)) throw new Error("Membresía del sprint incompleta");
    // Sources may be parents outside the iteration; only target IDs are membership candidates.
    const ids = [...new Set<number>(data.workItemRelations.map((r: Obj) => r.target?.id).filter((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0))];
    if (ids.length > 5000) throw new Error("Sprint mayor a 5000 work items: importación no realizada");
    const items: Obj[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const { data: result } = await this.get("wit/workitems", { ids: batch.join(","), "$expand": "relations", errorPolicy: "Fail" });
      if (!Array.isArray(result.value) || batch.some(id => !result.value.some((item: Obj) => item.id === id))) throw new Error("No se pudieron leer todos los work items del sprint");
      items.push(...result.value);
    }
    const all_items = items.filter(item => String(item.fields?.["System.IterationPath"]).toLowerCase() === iteration.path.toLowerCase());
    const assignee = selection.assignee.toLowerCase();
    const selected_items = all_items.filter(item => {
      const identity = item.fields?.["System.AssignedTo"];
      return typeof identity === "string" ? identity.toLowerCase() === assignee : [identity?.uniqueName, identity?.id].some(value => typeof value === "string" && value.toLowerCase() === assignee);
    });
    return { iteration, selection, all_items, selected_items };
  }
  async captureTicket(ticketId: string): Promise<SourceContent> {
    this.source(ticketId);
    const { data: raw } = await this.get(`wit/workitems/${ticketId}`, { "$expand": "relations" });
    if (String(raw.fields?.["System.TeamProject"]).toLowerCase() !== this.project.toLowerCase()) throw new Error("La tarea pertenece a otro proyecto; seleccioná su proyecto real");
    const comments: Obj[] = []; let token: string | null = null;
    const seen = new Set<string>();
    do {
      const params: Record<string, string> = { "api-version": "7.1-preview.4", "$top": "200" };
      if (token) params.continuationToken = token;
      const response = await this.get(`wit/workItems/${ticketId}/comments`, params);
      if (!Array.isArray(response.data.comments)) throw new Error("Azure devolvió comentarios incompletos");
      comments.push(...response.data.comments);
      token = response.data.continuationToken ? String(response.data.continuationToken) : response.continuation;
      if (token && seen.has(token)) throw new Error("Paginación de comentarios inconsistente");
      if (token) seen.add(token);
      if (comments.length > 10_000) throw new Error("Demasiados comentarios para una captura completa");
    } while (token);
    const { data: after } = await this.get(`wit/workitems/${ticketId}`);
    if (after.rev !== raw.rev) throw new Error("La tarea cambió durante la captura. Volvé a actualizar");
    const f = raw.fields as Obj;
    comments.sort((a, b) => Number(a.id) - Number(b.id));
    return {
      ticket: { id: raw.id, subject: f["System.Title"] ?? "", description: f["System.Description"] ?? "",
        acceptance_criteria: f["Microsoft.VSTS.Common.AcceptanceCriteria"] ?? "", status: f["System.State"] ?? "",
        provider: "azure_devops", external_url: `https://dev.azure.com/${this.organization}/${encodeURIComponent(this.project)}/_workitems/edit/${ticketId}` },
      conversations: comments.map(c => ({ id: c.id, author: c.createdBy?.displayName ?? "", body: c.text ?? "", created_at: c.createdDate ?? null, native: c })),
      native: raw,
    };
  }
  parsePrUrl(value: string): PrRef {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const modern = url.hostname === "dev.azure.com";
    const legacy = url.hostname === `${this.organization.toLowerCase()}.visualstudio.com`;
    if (url.protocol !== "https:" || url.username || url.password || url.port || (!modern && !legacy)) throw new Error("URL de PR Azure no permitida");
    if (modern && parts.shift()?.toLowerCase() !== this.organization.toLowerCase()) throw new Error("El PR pertenece a otra organización");
    const [project, git, repository, marker, number, extra] = parts;
    if (!project || git !== "_git" || !repository || marker !== "pullrequest" || !number || !/^\d+$/.test(number) || extra) throw new Error("URL de PR Azure inválida");
    return { project, repository, id: Number(number) };
  }
  private summary(raw: Obj, project: string): PrSummary {
    const repo = raw.repository?.id;
    if (!repo || !raw.pullRequestId) throw new Error("PR incompleto");
    return { project, repository: repo, id: raw.pullRequestId, title: raw.title ?? "", status: raw.status ?? "unknown",
      author: raw.createdBy?.displayName ?? "", source_branch: raw.sourceRefName ?? "", target_branch: raw.targetRefName ?? "",
      created_at: raw.creationDate ?? "", url: `https://dev.azure.com/${this.organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(raw.repository.name ?? repo)}/pullrequest/${raw.pullRequestId}` };
  }
  async listPrs(status: "active" | "all" = "active", skip = 0): Promise<PrSummary[]> {
    if (!["active", "all"].includes(status) || !Number.isInteger(skip) || skip < 0) throw new Error("Filtro de PRs inválido");
    const { data } = await this.get("git/pullrequests", { "searchCriteria.status": status, "$top": "50", "$skip": String(skip) });
    if (!Array.isArray(data.value)) throw new Error("Listado de PRs incompleto");
    return data.value.map((p: Obj) => this.summary(p, this.project));
  }
  async readPr(ref: PrRef): Promise<PrSummary & { source_commit: string; target_commit: string }> {
    const { data } = await this.get(`git/repositories/${encodeURIComponent(ref.repository)}/pullrequests/${ref.id}`, {}, ref.project);
    return { ...this.summary(data, ref.project), source_commit: data.lastMergeSourceCommit?.commitId ?? "", target_commit: data.lastMergeTargetCommit?.commitId ?? "" };
  }
  async reviewContext(ref: PrRef): Promise<PrContext> {
    if (!Number.isSafeInteger(ref.id) || ref.id < 1) throw new Error("ID de PR inválido");
    const route = `git/repositories/${encodeURIComponent(ref.repository)}/pullrequests/${ref.id}`;
    const { data: raw } = await this.get(route, {}, ref.project);
    const { data: iterations } = await this.get(`${route}/iterations`, {}, ref.project);
    const latest = [...(iterations.value ?? [])].sort((a: Obj, b: Obj) => b.id - a.id)[0];
    const source = latest?.sourceRefCommit?.commitId;
    const target = latest?.targetRefCommit?.commitId;
    const base = latest?.commonRefCommit?.commitId;
    if (![source, target, base].every(x => typeof x === "string" && /^[a-f\d]{40}$/i.test(x))) throw new Error("No se pudo fijar la revisión a commits exactos");
    const context: PrContext = { pr: this.summary(raw, ref.project), description: raw.description ?? "", source_commit: source,
      target_commit: target, base_commit: base, iteration: latest.id, captured_at: new Date().toISOString(), files: [], limitations: [] };
    let skip = 0; let totalText = 0;
    const deadline = Date.now() + 120_000;
    do {
      const { data } = await this.get(`${route}/iterations/${latest.id}/changes`, { "$compareTo": "0", "$top": "100", "$skip": String(skip) }, ref.project);
      if (!Array.isArray(data.changeEntries)) throw new Error("Cambios de PR incompletos");
      for (const change of data.changeEntries) {
        if (context.files.length >= 200) { context.limitations.push("PR mayor a 200 archivos: revisión parcial"); return context; }
        const filePath = change.item?.path;
        if (!filePath) { context.limitations.push("Cambio sin ruta: no se pudo inspeccionar"); continue; }
        const file: ReviewFile = { path: filePath, original_path: change.sourceServerItem ?? filePath, change_type: change.changeType ?? "unknown", before: null, after: null, omitted_reason: null };
        context.files.push(file);
        if (change.item?.isFolder) { file.omitted_reason = "Directorio"; continue; }
        if (Date.now() >= deadline) { file.omitted_reason = "Límite de tiempo de lectura del contexto (2 minutos)"; continue; }
        if (totalText >= 300_000) { file.omitted_reason = "Límite total de contexto (300 KB)"; continue; }
        const type = String(file.change_type).toLowerCase();
        try {
          const item = async (p: string, sha: string): Promise<string> => {
            const { data: obj } = await this.get(`git/repositories/${encodeURIComponent(ref.repository)}/items`, {
              path: p, "versionDescriptor.versionType": "commit", "versionDescriptor.version": sha,
              includeContent: "true", includeContentMetadata: "true", "$format": "json",
            }, ref.project);
            if (obj.contentMetadata?.isBinary || typeof obj.content !== "string") throw new Error("Archivo binario o contenido no disponible");
            if (obj.content.length > 60_000) throw new Error("Archivo mayor a 60 KB");
            totalText += obj.content.length;
            if (totalText > 300_000) throw new Error("Límite total de contexto (300 KB)");
            return obj.content;
          };
          if (!type.includes("add")) file.before = await item(file.original_path, base);
          if (!type.includes("delete")) file.after = await item(file.path, source);
        } catch (error) { file.omitted_reason = error instanceof Error ? error.message : "No se pudo leer"; }
      }
      const next = Number(data.nextSkip ?? 0);
      if (!next) break;
      if (next <= skip) throw new Error("Paginación de cambios inconsistente");
      skip = next;
    } while (true);
    if (context.files.some(f => f.omitted_reason)) context.limitations.push("Hay archivos omitidos; no equivale a una revisión completa");
    return context;
  }
}
