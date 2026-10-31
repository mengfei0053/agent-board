import { assertLoopbackHttp } from "./config.js";
import { mapBoardTask, type CreateBody, type MappedTask } from "./map.js";
import type { WorkspaceStub } from "./workspaces.js";

export class BoardHttpError extends Error {
  readonly detail: string;
  readonly code: string;

  constructor(
    readonly status: number,
    readonly path: string,
    detail = "",
    code = "",
  ) {
    super(`${path} returned ${status}`);
    this.detail = detail;
    this.code = code;
  }
}

export class BoardClient {
  readonly base: URL;

  constructor(
    baseUrl: string,
    private readonly timeoutMs: number,
  ) {
    const checked = assertLoopbackHttp(baseUrl);
    if (!checked.ok) throw new Error(checked.message);
    this.base = new URL(checked.url);
  }

  createTask(body: CreateBody): Promise<MappedTask> {
    return this.send("/api/tasks", { method: "POST", body });
  }

  stopTask(id: string): Promise<MappedTask> {
    return this.send(`/api/tasks/${encodeURIComponent(id)}/stop`, { method: "POST", body: {} });
  }

  continueTask(id: string, prompt?: string): Promise<MappedTask> {
    const body = prompt ? { prompt } : {};
    return this.send(`/api/tasks/${encodeURIComponent(id)}/continue`, { method: "POST", body });
  }

  async listWorkspaces(): Promise<WorkspaceStub[]> {
    const payload = await this.request("/api/workspaces", { method: "GET" });
    const list = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.workspaces) ? payload.workspaces : [];
    const stubs: WorkspaceStub[] = [];
    for (const item of list) {
      if (!isRecord(item)) continue;
      const id = typeof item.id === "string" ? item.id : "";
      const name = typeof item.name === "string" ? item.name : "";
      const path = typeof item.path === "string" ? item.path : "";
      if (!id || !name || !path) continue;
      stubs.push({ id, name, path });
    }
    return stubs;
  }

  async workspaceIsGit(id: string): Promise<boolean> {
    const payload = await this.request(`/api/workspaces/${encodeURIComponent(id)}/git-worktree-eligibility`, { method: "GET" });
    if (!isRecord(payload)) return false;
    return payload.ok === true || payload.eligible === true;
  }

  async listTasks(): Promise<MappedTask[]> {
    const list = await this.listTaskRecords();
    return list.map(mapBoardTask).filter((task): task is MappedTask => task !== null);
  }

  /** Includes archived rows. Callers decide which statuses to keep. */
  async listTaskRecords(): Promise<unknown[]> {
    const payload = await this.request("/api/tasks", { method: "GET" });
    if (Array.isArray(payload)) return payload;
    if (isRecord(payload) && Array.isArray(payload.tasks)) return payload.tasks;
    return [];
  }

  async getTaskRecord(id: string): Promise<unknown> {
    const payload = await this.request(`/api/tasks/${encodeURIComponent(id)}`, { method: "GET" });
    if (isRecord(payload) && payload.task !== undefined) return payload.task;
    return payload;
  }

  getSettings(): Promise<unknown> {
    return this.request("/api/settings", { method: "GET" });
  }

  putSettings(body: Record<string, unknown>): Promise<unknown> {
    return this.request("/api/settings", { method: "PUT", body });
  }

  getWorkspaceRecord(id: string): Promise<unknown> {
    return this.request(`/api/workspaces/${encodeURIComponent(id)}`, { method: "GET" });
  }

  patchWorkspace(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/workspaces/${encodeURIComponent(id)}`, { method: "PATCH", body });
  }

  workspaceGitStatus(id: string): Promise<unknown> {
    return this.request(`/api/workspaces/${encodeURIComponent(id)}/git-status`, { method: "GET" });
  }

  archiveTask(id: string): Promise<unknown> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/archive`, { method: "POST", body: {} });
  }

  private async send(path: string, init: { method: string; body?: unknown }): Promise<MappedTask> {
    const payload = await this.request(path, init);
    const task = mapBoardTask(isRecord(payload) && payload.task !== undefined ? payload.task : payload);
    if (!task) throw new BoardHttpError(502, path);
    return task;
  }

  private async request(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, this.base), {
        method: init.method,
        redirect: "manual",
        signal: controller.signal,
        headers: init.body === undefined ? undefined : { "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (response.status >= 300 && response.status < 400) throw new BoardHttpError(response.status, path);
      if (!response.ok) {
        const failure = await safeErrorBody(response);
        throw new BoardHttpError(response.status, path, failure.detail, failure.code);
      }
      if (response.status === 204) return {};
      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof BoardHttpError) throw error;
      throw new BoardHttpError(0, path);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function safeErrorBody(response: Response): Promise<{ detail: string; code: string }> {
  try {
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload)) return { detail: "", code: "" };
    const code = typeof payload.code === "string" && /^[a-z0-9_]{1,64}$/.test(payload.code) ? payload.code : "";
    const raw = typeof payload.error === "string" ? payload.error : "";
    const detail = !raw || raw.length > 180 || /[\\/@]|:\/\//.test(raw) ? "" : raw;
    return { detail, code };
  } catch {
    return { detail: "", code: "" };
  }
}
