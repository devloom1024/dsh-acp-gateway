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

/**
 * The session's durable event log as a plain array. 0.1.2-alpha.4 removed the
 * public `Session.events` accessor in favor of `snapshotEvents()` /
 * `eventAt()` / `seq`; this helper prefers the new API and falls back to the
 * legacy accessors on pre-alpha.4 runtimes.
 */
export function sessionEvents(session: any): any[] {
  try {
    if (session && typeof session.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return snapshot as any[]
    }
  } catch (e) {
    /* fall through */
  }
  return session && (session.events || session.log) ? (session.events || session.log) : []
}

/** A DSH agent session (persisted log + event append). */
export interface DshSession {
  readonly id: string
  /**
   * On-demand immutable full log snapshot: the 0.1.2-alpha.4 replacement for the
   * legacy public `events` accessor (alpha.4 removed `Session.events` and
   * `Session.log` visibility in favor of `snapshotEvents()`/`eventAt()`/`seq`).
   */
  snapshotEvents?(fromSeq?: any, toSeqExclusive?: any): readonly any[]
  append(type: string, data: any, opts?: any): any
  /** Durable creation metadata; `agentPreset` names the preset the session started under. */
  readonly header?: { cwd?: string; agentPreset?: string }
  /** The latest logged `request/header` fold (actual provider/model/effort), if any. */
  requestHeader?(): { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined
}

/** A live DSH agent (the value behind `handle.agent`). */
export interface DshAgent {
  readonly ctx: any
  readonly session: any
  followup(userMsg: any): void
  /** `cancel(cause)` since 0.1.2; a plain `{ kind: string }` remains the callers' shape. */
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
    meta?: { cwd?: string; agentPreset?: string }
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
  execute(
    agent: DshAgent,
    line: string,
    images: readonly never[],
    signal: NeverSignal,
  ): Promise<{ commandId: string; result?: { kind?: string; text?: string; content?: any[] } } | undefined>
}

/** `approval` service surface. */
export interface ApprovalService {
  setPolicy(agent: DshAgent, policy: string): void
}

/** `agentPresets` service surface. */
export interface AgentPresetsService {
  list(): Promise<{ id: string; name?: string; description?: string }[]>
  mount(agentCtx: any, id: string): Promise<void>
  /** Rebind one live agent's scope to another standing preset composition (blank sessions). */
  recompose?(agentCtx: any, id: string): Promise<{ id: string }>
  /** The deployment's default preset id (settings layer first, then config). */
  defaultId?: string
}

/** `sessionQuery` service surface. */
export interface SessionQueryService {
  listSessions(signal?: AbortSignal): Promise<{
    header: {
      id: string
      cwd?: string
      createdAt?: number
      title?: string
      updatedAt?: string | number
    }
  }[]>
  /** Fold the latest logged title per session (best effort; absent when unsupported). */
  readTitleSnapshots?(
    sessionIds: string[],
  ): Promise<
    (
      | { sessionId: string; status: 'fulfilled'; value: { title?: { title: string } } }
      | { sessionId: string; status: 'rejected'; reason: unknown }
    )[]
  >
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
  /** The deployment default mode — the fallback beneath a session override. */
  defaultMode?: string
  /** Resolve the complete policy for one session (override → deployment default). */
  resolve?(request: { session?: any }): { mode: string; workspaceRoot: string }
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
