import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson, readOptional, segment, withFileLock } from "./storage.js";

export type AzureProjectConnection = {
  organization: string;
  project: string;
  auth_mode: "pat" | "azure_cli";
  /** Nombre de variable de entorno; el secreto nunca se persiste en el catálogo. */
  credential_env?: string;
};

/** Referencia a una identidad de IA configurada localmente. Nunca contiene tokens. */
export type ProjectAgentRuntime = {
  provider: "claude" | "codex";
  /** Identificador estable del perfil local, por ejemplo `claude-mcm`. */
  profile_id: string;
  /** Nombre que CVG muestra al usuario, por ejemplo `Claude MCM`. */
  label: string;
};

export type StudioCompany = {
  id: string;
  name: string;
  created_at: string;
  archived_at?: string;
};

export type StudioProject = {
  id: string;
  name: string;
  /** Una empresa es opcional: CVG también sirve para proyectos personales o internos. */
  company_id?: string;
  created_at: string;
  archived_at?: string;
  azure_devops?: AzureProjectConnection;
  agent_runtime?: ProjectAgentRuntime;
  repositories: StudioRepository[];
  operational_tasks: StudioOperationalTask[];
  /** Recursos privados del proyecto. Su contenido vive en la carpeta local del proyecto, no en CVG central. */
  skills: ProjectSkill[];
  agents: ProjectAgent[];
};

export type ProjectSkill = {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
};

export type ProjectAgent = {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
};

export type StudioRepository = {
  id: string;
  name: string;
  remote_url: string;
  local_path: string;
  added_at: string;
  cloned_at?: string;
};

/** Trabajo iniciado desde el proyecto, con o sin un work item remoto. */
export type StudioOperationalTask = {
  workspace_id: string;
  title: string;
  description?: string;
  /** Origen visible del workspace; Azure se conserva como vínculo, no como copia global. */
  source: "local_operation" | "azure_devops";
  /** Identidad estable del work item cuando el origen es Azure DevOps. */
  ticket_id?: string;
  ticket_url?: string;
  /** Clave efímera del formulario que vuelve idempotente un reintento local. */
  operation_key?: string;
  status: "captured";
  created_at: string;
};

export type Portfolio = {
  schema_version: 1;
  revision: number;
  companies: StudioCompany[];
  projects: StudioProject[];
};

const empty = (): Portfolio => ({ schema_version: 1, revision: 0, companies: [], projects: [] });
const clean = (value: unknown, label: string): string => {
  const result = String(value ?? "").trim();
  if (!result || result.length > 120) throw new Error(`${label} inválido`);
  return result;
};
const id = (value: unknown, label: string): string => {
  const result = clean(value, label);
  if (segment(result) !== result || !/^[a-z0-9][a-z0-9_-]*$/i.test(result)) throw new Error(`${label} debe usar letras, números, guiones o guiones bajos`);
  return result;
};
const credentialEnv = (value: unknown): string | undefined => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const result = String(value).trim();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(result)) throw new Error("La referencia de credencial debe ser el nombre de una variable de entorno");
  return result;
};
const azureConnection = (value: AzureProjectConnection): AzureProjectConnection => {
  const authMode = value.auth_mode;
  if (authMode !== "pat" && authMode !== "azure_cli") throw new Error("Modo de autenticación Azure inválido");
  const reference = credentialEnv(value.credential_env);
  if (authMode === "pat" && !reference) throw new Error("Un proyecto Azure con PAT necesita la referencia a una variable de entorno");
  return {
    organization: clean(value.organization, "Organización Azure"),
    project: clean(value.project, "Proyecto Azure"),
    auth_mode: authMode,
    ...(reference ? { credential_env: reference } : {}),
  };
};
const agentRuntime = (value: ProjectAgentRuntime): ProjectAgentRuntime => {
  if (value.provider !== "claude" && value.provider !== "codex") throw new Error("Proveedor de IA inválido");
  return { provider: value.provider, profile_id: id(value.profile_id, "ID del perfil de IA"), label: clean(value.label, "Nombre del perfil de IA") };
};

/**
 * Catálogo de límites de trabajo. No contiene tokens ni rutas locales: las dos
 * cosas son propias de cada PC y se resuelven al ejecutar una operación.
 */
export class PortfolioStore {
  constructor(private readonly root: string) {}
  private get file(): string { return path.join(this.root, "_workflows", "portfolio.json"); }

  async read(): Promise<Portfolio> {
    const value = await readOptional<Portfolio>(this.file);
    if (!value) return empty();
    // Los proyectos creados por el catálogo inicial no tenían este campo.
    return { ...value, projects: value.projects.map(project => ({ ...project, repositories: Array.isArray(project.repositories) ? project.repositories : [], operational_tasks: Array.isArray(project.operational_tasks) ? project.operational_tasks : [], skills: Array.isArray(project.skills) ? project.skills : [], agents: Array.isArray(project.agents) ? project.agents : [] })) };
  }

  async createCompany(input: { expected_revision: number; id?: string; name: string }): Promise<Portfolio> {
    return this.change(input.expected_revision, current => {
      const companyId = input.id ? id(input.id, "ID de empresa") : `company-${randomUUID().slice(0, 8)}`;
      if (current.companies.some(company => company.id.toLowerCase() === companyId.toLowerCase())) throw new Error("Ya existe una empresa con ese ID");
      current.companies.push({ id: companyId, name: clean(input.name, "Nombre de empresa"), created_at: new Date().toISOString() });
    });
  }

  async createProject(input: { expected_revision: number; id?: string; name: string; company_id?: string; azure_devops?: AzureProjectConnection }): Promise<Portfolio> {
    return this.change(input.expected_revision, current => {
      const projectId = input.id ? id(input.id, "ID de proyecto") : `project-${randomUUID().slice(0, 8)}`;
      if (current.projects.some(project => project.id.toLowerCase() === projectId.toLowerCase())) throw new Error("Ya existe un proyecto con ese ID");
      const companyId = input.company_id ? id(input.company_id, "ID de empresa") : undefined;
      if (companyId && !current.companies.some(company => company.id === companyId && !company.archived_at)) throw new Error("La empresa elegida no existe o está archivada");
      const azure = input.azure_devops ? azureConnection(input.azure_devops) : undefined;
      current.projects.push({ id: projectId, name: clean(input.name, "Nombre de proyecto"), ...(companyId ? { company_id: companyId } : {}), created_at: new Date().toISOString(), repositories: [], operational_tasks: [], skills: [], agents: [], ...(azure ? { azure_devops: azure } : {}) });
    });
  }

  async configureAzureDevOps(input: { expected_revision: number; project_id: string; azure_devops: AzureProjectConnection }): Promise<Portfolio> {
    return this.change(input.expected_revision, current => {
      const project = current.projects.find(value => value.id === id(input.project_id, "ID de proyecto") && !value.archived_at);
      if (!project) throw new Error("Proyecto inexistente o archivado");
      project.azure_devops = azureConnection(input.azure_devops);
    });
  }

  async configureAgentRuntime(input: { expected_revision: number; project_id: string; agent_runtime: ProjectAgentRuntime }): Promise<Portfolio> {
    return this.change(input.expected_revision, current => {
      const project = current.projects.find(value => value.id === id(input.project_id, "ID de proyecto") && !value.archived_at);
      if (!project) throw new Error("Proyecto inexistente o archivado");
      project.agent_runtime = agentRuntime(input.agent_runtime);
    });
  }

  async archiveProject(input: { expected_revision: number; project_id: string }): Promise<Portfolio> {
    return this.change(input.expected_revision, current => {
      const project = current.projects.find(value => value.id === id(input.project_id, "ID de proyecto"));
      if (!project) throw new Error("Proyecto inexistente");
      if (!project.archived_at) project.archived_at = new Date().toISOString();
    });
  }

  async addRepository(input: { expected_revision: number; project_id: string; id: string; name: string; remote_url: string; local_path: string; cloned_at?: string }): Promise<Portfolio> {
    return this.change(input.expected_revision, current => {
      const project = current.projects.find(value => value.id === id(input.project_id, "ID de proyecto") && !value.archived_at);
      if (!project) throw new Error("Proyecto inexistente o archivado");
      project.repositories = Array.isArray(project.repositories) ? project.repositories : [];
      const repoId = id(input.id, "ID de repositorio");
      if (project.repositories.some(value => value.id.toLowerCase() === repoId.toLowerCase() || value.remote_url === input.remote_url || value.local_path.toLowerCase() === input.local_path.toLowerCase())) throw new Error("Ese repositorio ya está registrado en el proyecto");
      project.repositories.push({ id: repoId, name: clean(input.name, "Nombre de repositorio"), remote_url: clean(input.remote_url, "URL remota"), local_path: clean(input.local_path, "Ruta local"), added_at: new Date().toISOString(), ...(input.cloned_at ? { cloned_at: input.cloned_at } : {}) });
    });
  }

  async addOperationalTask(input: { expected_revision: number; project_id: string; workspace_id: string; title: string; description?: string; operation_key?: string; source?: "local_operation" | "azure_devops"; ticket_id?: string; ticket_url?: string }): Promise<Portfolio> {
    return this.change(input.expected_revision, current => {
      const project = current.projects.find(value => value.id === id(input.project_id, "ID de proyecto") && !value.archived_at);
      if (!project) throw new Error("Proyecto inexistente o archivado");
      project.operational_tasks = Array.isArray(project.operational_tasks) ? project.operational_tasks : [];
      const workspaceId = clean(input.workspace_id, "ID de workspace");
      if (project.operational_tasks.some(task => task.workspace_id === workspaceId)) throw new Error("Ese workspace operativo ya está vinculado al proyecto");
      const description = String(input.description ?? "").trim();
      if (description.length > 5000) throw new Error("Descripción operativa demasiado extensa");
      const operationKey = input.operation_key ? clean(input.operation_key, "Clave de operación") : undefined;
      if (operationKey && project.operational_tasks.some(task => task.operation_key === operationKey)) throw new Error("Esta tarea operativa ya fue creada");
      const source = input.source ?? "local_operation";
      if (source !== "local_operation" && source !== "azure_devops") throw new Error("Origen de tarea inválido");
      const ticketId = input.ticket_id ? clean(input.ticket_id, "ID de tarea Azure") : undefined;
      const ticketUrl = input.ticket_url ? clean(input.ticket_url, "URL de tarea Azure") : undefined;
      if (source === "azure_devops" && !ticketId) throw new Error("Una tarea Azure necesita su identificador");
      if (ticketId && project.operational_tasks.some(task => task.source === "azure_devops" && task.ticket_id === ticketId)) throw new Error("Esta tarea de Azure ya tiene un workspace en el proyecto");
      project.operational_tasks.push({ workspace_id: workspaceId, title: clean(input.title, "Título de tarea operativa"), ...(description ? { description } : {}), ...(operationKey ? { operation_key: operationKey } : {}), source, ...(ticketId ? { ticket_id: ticketId } : {}), ...(ticketUrl ? { ticket_url: ticketUrl } : {}), status: "captured", created_at: new Date().toISOString() });
    });
  }

  async addProjectSkill(input: { expected_revision: number; project_id: string; id?: string; name: string; description?: string }): Promise<Portfolio> {
    return this.addProjectResource("skills", input);
  }

  async addProjectAgent(input: { expected_revision: number; project_id: string; id?: string; name: string; description?: string }): Promise<Portfolio> {
    return this.addProjectResource("agents", input);
  }

  async removeProjectSkill(input: { expected_revision: number; project_id: string; id: string }): Promise<Portfolio> {
    return this.removeProjectResource("skills", input);
  }

  async removeProjectAgent(input: { expected_revision: number; project_id: string; id: string }): Promise<Portfolio> {
    return this.removeProjectResource("agents", input);
  }

  private async addProjectResource(kind: "skills" | "agents", input: { expected_revision: number; project_id: string; id?: string; name: string; description?: string }): Promise<Portfolio> {
    return this.change(input.expected_revision, current => {
      const project = current.projects.find(value => value.id === id(input.project_id, "ID de proyecto") && !value.archived_at);
      if (!project) throw new Error("Proyecto inexistente o archivado");
      const resourceId = input.id ? id(input.id, `ID de ${kind === "skills" ? "skill" : "agente"}`) : `${kind === "skills" ? "skill" : "agent"}-${randomUUID().slice(0, 8)}`;
      const resources = Array.isArray(project[kind]) ? project[kind] : [];
      if (resources.some(resource => resource.id.toLowerCase() === resourceId.toLowerCase())) throw new Error(`Ya existe una ${kind === "skills" ? "skill" : "agente"} con ese ID`);
      const description = String(input.description ?? "").trim();
      if (description.length > 500) throw new Error("La descripción puede tener hasta 500 caracteres");
      const now = new Date().toISOString();
      resources.push({ id: resourceId, name: clean(input.name, `Nombre de ${kind === "skills" ? "skill" : "agente"}`), ...(description ? { description } : {}), created_at: now, updated_at: now });
      project[kind] = resources;
    });
  }

  private async removeProjectResource(kind: "skills" | "agents", input: { expected_revision: number; project_id: string; id: string }): Promise<Portfolio> {
    return this.change(input.expected_revision, current => {
      const project = current.projects.find(value => value.id === id(input.project_id, "ID de proyecto") && !value.archived_at);
      if (!project) throw new Error("Proyecto inexistente o archivado");
      const resourceId = id(input.id, `ID de ${kind === "skills" ? "skill" : "agente"}`);
      const resources = Array.isArray(project[kind]) ? project[kind] : [];
      if (!resources.some(resource => resource.id === resourceId)) throw new Error(`${kind === "skills" ? "Skill" : "Agente"} inexistente`);
      project[kind] = resources.filter(resource => resource.id !== resourceId);
    });
  }

  private async change(expectedRevision: number, mutate: (portfolio: Portfolio) => void): Promise<Portfolio> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("Revisión esperada inválida");
    return withFileLock(this.file + ".lock", async () => {
      const current = await this.read();
      if (current.revision !== expectedRevision) throw new Error("CONFLICT: el catálogo cambió; recargá antes de guardar");
      const next: Portfolio = structuredClone(current);
      mutate(next);
      next.revision += 1;
      await atomicWriteJson(this.file, next);
      return next;
    });
  }
}
