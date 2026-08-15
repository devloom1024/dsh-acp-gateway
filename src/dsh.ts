/**
 * Minimal structural types for the DSH services and entities the gateway
 * consumes. The official packages ship full typings; these cover only the
 * members this plugin calls, keeping the migration self-contained while
 * `ctx.get()` returns untyped values for services without Context
 * augmentation.
 *
 * @module dsh-acp-gateway/dsh
 */
import type { NeverSignal, SessionModeState } from './codec.js'

/** A DSH agent session (persisted log + event append). */
export interface DshSession {
  readonly id: string
  readonly log: any[]
  readonly events: any[]
  append(type: string, data: any, opts?: any): any
}

/** A live DSH agent (the value behind `handle.agent`). */
export interface DshAgent {
  readonly ctx: any
  readonly session: any
  followup(userMsg: any): void
  cancel(opts: { kind: string }): void
  inject?(message: any): void
}

/** The handle returned by `agents.create` / `agents.resume`. */
export interface AgentHandle {
  readonly agent: DshAgent
  dispose(): Promise<void> | void
}

/** `agents` service (AgentRegistry surface used here). */
export interface AgentsService {
  create(opts: {
    sessionId: string
    meta?: { cwd?: string }
    agentOptions?: Record<string, unknown>
    setup?: (agentCtx: any) => Promise<void> | void
  }): Promise<AgentHandle>
  resume(opts: {
    resumeSessionId: string
    agentOptions?: Record<string, unknown>
    setup?: (agentCtx: any) => Promise<void> | void
  }): Promise<AgentHandle>
}

/** `llm` service surface. */
export interface LlmService {
  listProviders(): { id: string; displayName?: string }[]
  listModels(provider: string): Promise<{ id: string; name: string; description?: string }[]>
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ context?: { contextWindow: number } } | undefined>
}

/** `agentDefaultModel` service surface. */
export interface DefaultModelService {
  currentSelection(): { provider?: string; model?: string; reasoningEffort?: string } | undefined
}

/** `tools` service surface. */
export interface ToolsService {
  register(tool: any): void
  restrict(opts: { deny: string[] }): void
}

/** `commands` service surface. */
export interface CommandsService {
  list(agent: DshAgent): { name: string; description?: string; input?: { hint?: string } }[]
  find(agent: DshAgent, name: string): unknown
  execute(agent: DshAgent, line: string, signal: NeverSignal): Promise<{ result?: { content?: any[] } } | undefined>
}

/** `planMode` service surface (PlanModeController). */
export interface PlanModeService {
  get(agent: DshAgent): { active: boolean; pending?: boolean }
  set(agent: DshAgent, active: boolean): string
}

/** `approval` service surface. */
export interface ApprovalService {
  setPolicy(agent: DshAgent, policy: string): void
}

/** `agentPresets` service surface. */
export interface AgentPresetsService {
  list(): Promise<{ id: string }[]>
  mount(agentCtx: any, id: string): Promise<void>
}

/** `sessionQuery` service surface. */
export interface SessionQueryService {
  listSessions(): Promise<{ header: { id: string; cwd?: string; title?: string; updatedAt?: string | number } }[]>
}

/** `shell` service surface. */
export interface ShellService {
  resolve(cmd: { command: string }): { command: string }
  run(spec: { command: string }): Promise<{ stdout?: { text?: string } }>
}

/** `fs` service surface. */
export interface FsService {
  resolve(path: string): Promise<string>
  writeText(target: string, text: string): Promise<void>
}

/** `sandboxPolicy` service surface. */
export interface SandboxPolicyService {
  workspaceRoot?: string
}

/** `attachments` service surface. */
export interface AttachmentsService {
  saveImage(opts: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
}

/** `loader` service surface. */
export interface LoaderService {
  entries(): { id: string; options: { name?: string }; fiber: unknown; init(): Promise<void>; disabled?: boolean }[]
}

/** `webServer` service surface (WebServer). */
export interface WebServerService {
  readonly port: number
  readonly exact?: { delete(path: string): void }
  register(route: {
    kind: 'exact'
    path: string
    handler(req: any, res: any): void | Promise<void>
  }): unknown
}

/** `permissionPresets` service surface (not currently used, reserved). */
export interface PermissionPresetsService {
  names: string[]
  set(session: DshSession, name: string): void
  current(events: any[]): string | undefined
}

/** The mode state shape the gateway advertises. */
export type { SessionModeState }
