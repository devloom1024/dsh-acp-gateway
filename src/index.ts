/**
 * DSH ACP Agent Gateway — a distributable DSH (DeepSeek Harness) plugin that
 * exposes a full ACP v1 (Agent Client Protocol) agent over stdio.
 *
 * Unlike the upstream `@deepseek-ai/dsh-acp` automation-only bridge, this
 * plugin adds: token-level streaming, tool-call notifications, session
 * list/load/delete, usage updates, image/audio prompt content, slash
 * commands, session modes (the agent presets, exactly the web GUI's modes),
 * and full tool access (via the `standard` agent preset).
 *
 * Transport is stdio only: a client (Zed, VS Code ACP, ...) launches the
 * bridge script (`bin/dsh-acp-agent.js` or the generated
 * `~/.dsh/acp/dsh-acp-agent.js`), which forwards newline-delimited JSON-RPC
 * to this plugin over a loopback channel. No HTTP capability is exposed.
 *
 * @module dsh-acp-gateway
 */
import type { Context, Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { NeverSignal, SessionModeState, ConfigOptionsInput } from './codec.js'
import type {
  AgentsService,
  LlmService,
  DefaultModelService,
  ToolsService,
  CommandsService,
  ApprovalService,
  AgentPresetsService,
  SessionQueryService,
  ShellService,
  FsService,
  SandboxPolicyService,
  AttachmentsService,
  LoaderService,
  WebServerService,
  AgentHandle,
  DshAgent,
} from './dsh.js'
import { sessionEvents } from './dsh.js'
import {
  turnEndToStopReason,
  toolKind,
  toolTitle,
  locationFromArgs,
  diffFromArgs,
  makeNeverSignal,
  sessionModeState,
  buildConfigOptions,
  buildBridgeScript,
  planMarkdownToEntries,
} from './codec.js'
import type { StopReason, SessionUpdate, ConfigOption, PlanEntry } from './types.js'
import { randomUUID } from 'node:crypto'

export const name = 'acp-gateway'
/** Hard dependencies: the agent factory and timers. Everything else is optional. */
export const inject = ['agents', 'timer']

/** Session mode ids this agent advertises: the agent-preset roster. */
const FALLBACK_MODE_ID = 'standard'

/**
 * Optional gateway configuration.
 * @param stdioScriptPath - where the generated bridge script is written.
 * @param provider - model provider route (used when no DSH default model exists).
 * @param model - model id (used when no DSH default model exists).
 * @param promptTimeoutMs - hard cap on one ACP prompt/turn in milliseconds.
 *   Absent or 0 disables the gateway timer: the turn lifecycle is fully
 *   DSH-owned (its own timeout/abort machinery and per-tool timeouts apply,
 *   and the client can always `session/cancel`). A long turn — an
 *   `ask_user_question` elicitation waiting on the user, subagent
 *   delegation, long research — must not be killed by an arbitrary cap.
 */
export interface GatewayConfig {
  stdioScriptPath?: string
  provider?: string
  model?: string
  promptTimeoutMs?: number
}


/**
 * Mount the ACP agent gateway.
 * @param ctx - Cordis context.
 * @param config - optional `{ stdioScriptPath }` override for where the
 *   generated bridge script is written.
 */
export async function apply(ctx: Context, config: GatewayConfig = {}): Promise<void> {
  try {
    ctx.logger.info('acp-gateway: apply entered')
  } catch (e) {
    /* logger optional */
  }
  const webServer = ctx.get('webServer')
  const agents = ctx.agents
  // 0/absent = no gateway-level prompt timer (DSH owns turn lifecycle).
  const promptTimeoutMs = config.promptTimeoutMs ?? 0
  const sessionQueryNow = (): SessionQueryService | undefined => ctx.get('sessionQuery')
  const fsNow2 = (): FsService | undefined => ctx.get('fs')
  const shellNow2 = (): ShellService | undefined => ctx.get('shell')
  const sandboxPolicyNow = (): SandboxPolicyService | undefined => ctx.get('sandboxPolicy')
  const toolsNow = (): ToolsService | undefined => ctx.get('tools')
  const attachmentsNow = (): AttachmentsService | undefined => ctx.get('attachments')
  const commandsNow = (): CommandsService | undefined => ctx.get('commands')
  // Services that can become available after apply (the official web profile
  // activates rows in service order) are read lazily at call time.
  const defaultModelNow = (): DefaultModelService | undefined => ctx.get('agentDefaultModel')
  const llmNow = (): LlmService | undefined => ctx.get('llm')
  const approvalNow = (): ApprovalService | undefined => ctx.get('approval')
  const agentPresetsNow = (): AgentPresetsService | undefined => ctx.get('agentPresets')
  const userQuestionsNow = (): any => ctx.get('userQuestions')


  // ---- model selection -------------------------------------------------
  /** The ambient model selection (DSH default model, or gateway config). */
  const modelSelection = (): { provider?: string; model?: string; reasoningEffort?: string } | null => {
    const defaultModel = defaultModelNow()
    if (defaultModel) {
      try {
        const sel = defaultModel.currentSelection()
        if (sel && sel.provider && sel.model) return sel
      } catch (e) {
        /* fall through */
      }
    }
    if (config.provider && config.model) return { provider: config.provider, model: config.model }
    return null
  }
  /** Model catalog for one provider route (empty when unavailable). */
  const modelOptionsFor = async (provider: string | undefined): Promise<{ value: string; name: string }[]> => {
    const llm = llmNow()
    if (!llm || !provider) return []
    try {
      const models = await llm.listModels(provider)
      return models.map((m) => ({ value: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) }))
    } catch (e) {
      return []
    }
  }
  /** Model context window (tokens) with per-model caching. */
  const contextCache = new Map()
  const contextWindowFor = async (provider: string | undefined, model: string | undefined): Promise<number | null> => {
    const key = `${provider}/${model}`
    if (contextCache.has(key)) return contextCache.get(key)
    let size = null
    const llm = llmNow()
    if (llm && provider && model) {
      try {
        const info = await llm.resolveModelInfo(provider, model)
        if (info && info.context && info.context.contextWindow) size = info.context.contextWindow
      } catch (e) {
        /* keep null */
      }
    }
    contextCache.set(key, size)
    return size
  }
  /** Agent options for one session: session config overrides the ambient selection. */
  const agentOptionsFor = (acpSessionId?: string): { provider?: string; model?: string; reasoningEffort?: ReturnType<typeof ReasoningEffortId> } => {
    const sel = modelSelection()
    if (!sel) return {}
    const cfg = acpSessionId ? sessionConfigs.get(acpSessionId) : undefined
    const provider = (cfg && cfg.providerId) || sel.provider
    const model = (cfg && cfg.modelId) || sel.model
    const reasoningEffort = (cfg && cfg.reasoningEffort) || sel.reasoningEffort
    return {
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort: ReasoningEffortId(reasoningEffort) } : {}),
    }
  }
  /** The session's current sandbox mode (permission level) from its log. */
  const sandboxModeFor = (agent: DshAgent): string | null => {
    try {
      const events = sessionEvents(agent.session)
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === 'sandbox/mode') return events[i].data && events[i].data.mode
      }
    } catch (e) {
      /* fall through */
    }
    return null
  }

  // ---- agent assembly ---------------------------------------------------
  /**
   * The preset one session actually runs: the last `agent-preset/selected`
   * event, else the creation header's `agentPreset`. This is the durable
   * answer (it survives process restarts), mirroring the agent-presets
   * package's own `resolveSessionPreset`.
   */
  const sessionPresetOf = (session: any): string | undefined => {
    try {
      const events = sessionEvents(session)
      if (Array.isArray(events)) {
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const e = events[i]
          if (e && e.type === 'agent-preset/selected') return e.data && e.data.agentPreset
        }
      }
      const header = session && session.header
      if (header && header.agentPreset) return header.agentPreset
    } catch (e) {
      /* fall through */
    }
    return undefined
  }
  const agentSetup = async (agentCtx: any): Promise<void> => {
    try {
      // The preset this agent runs: the session's client-selected mode wins,
      // then the session's own recorded preset (durable across restarts),
      // then the deployment default. `agentCtx.agent` exists while setup runs
      // (the factory constructs the agent before awaiting setup), so the
      // session id is read from the agent itself — no shared scratch state.
      const agentPresets = agentPresetsNow()
      if (agentPresets) {
        try {
          const session = agentCtx.agent && agentCtx.agent.session
          const sessionId = session && session.id
          const cfg = sessionId ? sessionConfigs.get(sessionId) : undefined
          const presetId = (cfg && cfg.preset) || sessionPresetOf(session) || defaultPresetId()
          const presets = await agentPresets.list()
          if (presets.some((p) => p.id === presetId)) {
            await agentPresets.mount(agentCtx, presetId)
          } else if (presets.some((p) => p.id === FALLBACK_MODE_ID)) {
            await agentPresets.mount(agentCtx, FALLBACK_MODE_ID)
          }
        } catch (e) {
          ctx.logger.warn(`acp-gateway: preset mount failed: ${String((e instanceof Error && e.message) || e)}`)
        }
      }
    } catch (e) {
      /* no preset registry */
    }
    try {
      // Route this session's model/effort on every request: the client's
      // config-option choice, else the session's own logged request header
      // (so a restarted session resumes under the model it actually ran),
      // else the create-time agent options. Mirrors the web GUI's per-agent
      // model selection (dsh-agent's installModelSelection): a switch takes
      // effect on the next request without disposing the live agent.
      const session = agentCtx.agent && agentCtx.agent.session
      if (session && session.id) {
        const sessionId = session.id
        agentCtx.on('agent/request', async (_payload: any, next: () => Promise<any>) => {
          const resolved = await next()
          const cfg = sessionConfigs.get(sessionId)
          const loggedHeader = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
          const logged = loggedHeader && loggedHeader.config
          const cfgRoute =
            cfg && cfg.providerId && cfg.modelId ? { provider: cfg.providerId, model: cfg.modelId } : undefined
          const loggedRoute =
            logged && logged.provider && logged.model ? { provider: logged.provider, model: logged.model } : undefined
          const route = cfgRoute || loggedRoute
          const cfgEffort = (cfg && cfg.reasoningEffort) || undefined
          if (!route && !cfgEffort) return resolved
          // An explicit client effort wins; otherwise inherit the logged
          // effort only while the route is unchanged (a new model starts at
          // its provider's default effort, like the loop's own rebuild rule).
          const unchanged =
            route !== undefined &&
            loggedRoute !== undefined &&
            route.provider === loggedRoute.provider &&
            route.model === loggedRoute.model
          const effort = cfgEffort || (unchanged && logged && logged.reasoningEffort) || undefined
          const out = route ? { ...resolved, provider: route.provider, model: route.model } : resolved
          return effort ? { ...out, reasoningEffort: effort } : out
        })
      }
    } catch (e) {
      /* no events channel */
    }
    try {
      // Hide this plugin's own test tool from ACP agents (prevents recursion).
      if (agentCtx.tools) {
        agentCtx.tools.restrict({ deny: ['acp_test'] })
      }
    } catch (e) {
      /* ignore */
    }
    // Ask decision source: in workspace-write mode, mutating tools request
    // client approval (read-only tools pass; the sandbox gates read-only mode).
    // client approval (read-only tools pass; the sandbox gates read-only mode).
    try {
      ;(agentCtx as any).on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
        try {
          const agent = exec && exec.agent
          const mode = agent ? sandboxModeFor(agent) : null
          if (mode !== 'workspace-write') return next()
          // Only mutating operations ask (edits/deletes/moves/executions);
          // reads, searches, fetches, and interaction tools (ask_user_question,
          // todo_write, ...) pass — approval is a mutation gate, not a blanket one.
          const MUTATING_KINDS = new Set(['edit', 'delete', 'move', 'execute'])
          const kind = toolKind(exec && exec.name)
          if (!MUTATING_KINDS.has(kind)) return next()
          // Waterfall: wrap the rest of the chain and override the decision.
          return next().then((decision: any) =>
            decision && decision.kind === 'allow'
              ? { kind: 'ask', reason: `tool "${exec && exec.name}" requires approval in workspace-write mode` }
              : decision,
          )
        } catch (e) {
          return next()
        }
      })
    } catch (e) {
      /* no tools channel */
    }
    // Elicitation: a per-agent `ask_user_question` that surfaces as an ACP
    // elicitation/create form. Registered at agent scope (the host tool from
    // dsh-tool-ask-user routes through the userQuestions provider slot, which
    // the web UI owns; a per-agent registration shadows it for ACP sessions).
    try {
      if (agentCtx.tools) {
        agentCtx.tools.register(
          defineTool({
            name: 'ask_user_question',
            description: 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer.',
            parameters: {
              questions: {
                type: 'array',
                required: true,
                description: 'Questions to ask the user before continuing.',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
                    question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
                    header: { type: 'string', description: 'Optional short heading/group label.' },
                    detail: { type: 'string', description: 'Optional supporting detail.' },
                    options: { type: 'array', description: 'Optional choices the UI can render as a menu.', items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, description: { type: 'string' } } } },
                    multi_select: { type: 'boolean', description: 'Whether more than one option may be selected.' },
                  },
                },
              },
            } as any,
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  answers: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        id: { type: 'string' },
                        selected: { type: 'array', items: { type: 'string' } },
                        custom: { type: 'string' },
                      },
                    },
                  },
                },
              },
              render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
            },
            async execute(args: any, exec: any) {
              const items: any[] = Array.isArray(args && args.questions) ? args.questions : []
              // Capability negotiation: without clientCapabilities.elicitation the
              // client would not answer elicitation/create — fall back to a plain
              // text question so the agent can still interact.
              const supportsElicitation = !!(clientCapabilities && clientCapabilities.elicitation)
              if (!supportsElicitation) {
                return {
                  answers: items.map((q: any) => ({
                    id: q.id,
                    selected: [],
                    custom: '[ACP client does not support elicitation forms; ask the user directly in your reply]',
                  })),
                }
              }
              const properties: Record<string, unknown> = {}
              const required: string[] = []
              for (const q of items) {
                properties[q.id] = {
                  type: 'string',
                  title: q.question,
                  ...(q.detail ? { description: q.detail } : {}),
                  ...(q.options && q.options.length ? { enum: q.options.map((o: any) => o.label) } : {}),
                }
                if (!q.multi_select) required.push(q.id)
              }
              const sid = exec && exec.agent && exec.agent.session && exec.agent.session.id
              const response = await sendClientRequest('elicitation/create', {
                ...(typeof sid === 'string' ? { sessionId: sid } : {}),
                message: items.map((q: any) => q.question).join('\n') || 'Please answer',
                mode: 'form',
                requestedSchema: { type: 'object', properties, required },
              })
              const result = response && response.result
              // Spec wire: { action: 'accept', content: { fieldId: value } }.
              // Older drafts used { action: 'accepted', answers: { fieldId: value } }.
              const accepted =
                result &&
                (result.action === 'accept' || result.action === 'accepted') &&
                result.content &&
                typeof result.content === 'object'
              const acceptedAnswers = accepted ? result.content : result && result.answers
              if (accepted && acceptedAnswers && typeof acceptedAnswers === 'object') {
                return {
                  answers: items.map((q: any) => {
                    const value = acceptedAnswers[q.id]
                    const selected = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : []
                    return { id: q.id, selected, ...(typeof value === 'string' ? { custom: value } : {}) }
                  }),
                }
              }
              throw new Error('elicitation declined or cancelled by user')
            },
          }),
        )
      }
    } catch (e: unknown) {
    }
  }
  const configureAgent = (agent: DshAgent): void => {
    try {
      // Approval policy follows the session's permission level: workspace-write
      // asks through the ACP client (request_permission); read-only and
      // full-access never ask (the sandbox enforces the former, nothing gates
      // the latter).
      const approval = approvalNow()
      if (approval) {
        const mode = agent.session ? sandboxModeFor(agent) : null
        approval.setPolicy(agent, mode === 'workspace-write' ? 'ask' : 'never')
      }
    } catch (e) {
      /* ignore */
    }
  }
  /**
   * The deployment's default preset id: the agent-presets service's default
   * (settings layer first — the web GUI's "default" — then row config),
   * falling back to `standard`.
   */
  const defaultPresetId = (): string => {
    const ap = agentPresetsNow()
    if (!ap) return FALLBACK_MODE_ID
    try {
      return ap.defaultId || FALLBACK_MODE_ID
    } catch (e) {
      return FALLBACK_MODE_ID
    }
  }
  /** The agent-preset roster, or an empty list when no registry is mounted. */
  const presetList = async (): Promise<{ id: string; name?: string; description?: string }[]> => {
    const ap = agentPresetsNow()
    if (!ap) return []
    try {
      return await ap.list()
    } catch (e) {
      return []
    }
  }
  /**
   * The ACP session-mode state for one ACP session: modes ARE the agent
   * presets (same vocabulary the web GUI uses for its modes), and the current
   * mode is the preset this session's agent runs. The client's selected mode
   * wins while a change is pending; otherwise the session's own recorded
   * preset (its log/header) is the actual answer. Plan on/off is not a mode —
   * it is the `/plan` slash command, exactly like the web GUI's Plan chip.
   */
  const sessionModesFor = async (acpSessionId: string, agent?: DshAgent | null): Promise<SessionModeState> => {
    const cfg = sessionConfigs.get(acpSessionId)
    const session = agent && agent.session
    return sessionModeState(
      (cfg && cfg.preset) || sessionPresetOf(session) || defaultPresetId(),
      await presetList(),
    )
  }

  // ---- state ------------------------------------------------------------
  const handles = new Map<string, AgentHandle>()
  const sessionConfigs = new Map<string, { providerId?: string; modelId?: string; reasoningEffort?: string; preset?: string }>()
  const appliedOptions = new Map<string, { provider?: string | null; model?: string | null; reasoningEffort?: string | null; preset?: string }>()
  /** Last title text notified per ACP session (identical repeats are suppressed). */
  const lastTitles = new Map<string, string>()
  const subscribers = new Set()
  const inflightPrompts = new Map<string, { turn: number; clearTimer: () => void; resolve: (reason: StopReason) => void; reject: (err: Error) => void }>()
  const announcedToolCalls = new Set<string>()
  /** Agent -> Client JSON-RPC requests awaiting a response (permission, elicitation). */
  const pendingClientRequests = new Map<number, (resp: any) => void>()
  /** Client capabilities negotiated at initialize (elicitation support, ...). */
  let clientCapabilities: any = {}
  let clientRequestSeq = 1
  const toolCallArgs = new Map<string, { name: string; arguments: any }>() // callId -> call facts (for diff reconstruction)
  const newSessionId = () => `sess_acp_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`

  // ---- broadcast ---------------------------------------------------------
  const broadcast = (notification: unknown): void => {
    const json = JSON.stringify(notification)
    for (const sub of subscribers as Set<{ send: (json: string) => void }>) {
      try {
        sub.send(json)
      } catch (e) {
        /* keep going */
      }
    }
  }
  const subscribe = (send: (json: string) => void): (() => void) => {
    const sub = { send }
    subscribers.add(sub)
    return () => subscribers.delete(sub)
  }
  /** Send a raw JSON-RPC message to every client (notifications and requests). */
  const broadcastRaw = (message: unknown): void => {
    const json = JSON.stringify(message)
    for (const sub of subscribers as Set<{ send: (json: string) => void }>) {
      try {
        sub.send(json)
      } catch (e) {
        /* keep going */
      }
    }
  }
  /**
   * Send a client-bound request (session/request_permission, elicitation/request)
   * and await its response. The bridge forwards the request to the client's
   * stdout and routes the client's response back through /acp/rpc.
   */
  const sendClientRequest = (method: string, params: any): Promise<any> =>
    new Promise((resolve) => {
      const id = clientRequestSeq++
      const clearTimer = ctx.timeout(() => {
        pendingClientRequests.delete(id)
        resolve(null)
      }, 120000)
      pendingClientRequests.set(id, (resp: any) => {
        clearTimer()
        resolve(resp)
      })
      broadcastRaw({ jsonrpc: '2.0', id, method, params })
    })
  const notifyUpdate = (acpSessionId: string, update: SessionUpdate): void => {
    broadcast({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: acpSessionId, update } })
  }

  // ---- event -> ACP notification mapping ----------------------------------
  /** The session's latest logged title (the last `session/title` event), if any. */
  const sessionTitleFor = (agent: DshAgent | null): string | undefined => {
    try {
      const events = agent && agent.session ? sessionEvents(agent.session) : []
      if (Array.isArray(events)) {
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const e = events[i]
          if (e && e.type === 'session/title' && typeof e.data.title === 'string') return e.data.title
        }
      }
    } catch (e) {
      /* fall through */
    }
    return undefined
  }
  /** Forward one session title to clients: identical repeats are suppressed. */
  const notifyTitle = (acpSessionId: string, title: string | undefined): void => {
    if (typeof title !== 'string' || title.length === 0) return
    if (lastTitles.get(acpSessionId) === title) return
    lastTitles.set(acpSessionId, title)
    notifyUpdate(acpSessionId, {
      sessionUpdate: 'session_info_update',
      title,
      updatedAt: new Date().toISOString(),
    })
  }
  const mapSessionEvent = (acpSessionId: string, event: any): void => {
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data && event.data.chunk
        if (!chunk) break
        if (chunk.type === 'text-delta') {
          notifyUpdate(acpSessionId, {
            sessionUpdate: 'agent_message_chunk',
            messageId: `msg_${event.data.turn}_${event.data.step}`,
            content: { type: 'text', text: chunk.text },
          })
        } else if (chunk.type === 'reasoning-delta' || chunk.type === 'reasoning' || chunk.type === 'thinking') {
          notifyUpdate(acpSessionId, {
            sessionUpdate: 'agent_thought_chunk',
            messageId: `thought_${event.data.turn}_${event.data.step}`,
            content: { type: 'text', text: chunk.text || '' },
          })
        } else if (chunk.type === 'tool-call-delta') {
          // Only the first delta of a call announces pending; deltas stream after.
          const key = String(chunk.id)
          if (announcedToolCalls.has(key)) break
          announcedToolCalls.add(key)
          notifyUpdate(acpSessionId, {
            sessionUpdate: 'tool_call',
            toolCallId: key,
            title: chunk.name || 'tool call',
            kind: toolKind(chunk.name),
            status: 'pending',
            rawInput: { argumentsDelta: chunk.argumentsDelta },
          })
        }
        break
      }
      case 'assistant/message': {
        // Text blocks were already streamed as `assistant/chunk` text-deltas;
        // re-sending them here would duplicate content after the turn ended.
        // Only non-streamed blocks (images) and usage are reported.
        const blocks = event.data && event.data.message ? event.data.message.content : []
        for (const block of blocks) {
          if (block.type === 'image') {
            notifyUpdate(acpSessionId, {
              sessionUpdate: 'agent_message_chunk',
              messageId: `msg_${event.data.turn}_${event.data.step}`,
              content: { type: 'text', text: `[image attachment ${block.attachment.attachmentId}]` },
            })
          }
        }
        if (event.data && event.data.usage) {
          const u = event.data.usage
          const used = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
          void (async () => {
            const opts = agentOptionsFor(acpSessionId)
            const size = (await contextWindowFor(opts.provider, opts.model)) || 200000
            notifyUpdate(acpSessionId, { sessionUpdate: 'usage_update', used, size })
          })()
        }
        break
      }
      case 'tool/call': {
        const key = String(event.data.callId)
        const name = event.data.name
        if (name === 'exit_plan_mode' || name === 'exit-plan-mode') {
          try {
            const argsObj = typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments
            const entries = planMarkdownToEntries(argsObj && argsObj.plan)
            if (entries.length > 0) notifyUpdate(acpSessionId, { sessionUpdate: 'plan', entries })
          } catch (e) {
            /* best effort */
          }
        }
        const location = locationFromArgs(event.data.arguments)
        toolCallArgs.set(key, { name, arguments: event.data.arguments })
        const payload = {
          toolCallId: key,
          title: toolTitle(name, event.data.arguments),
          kind: toolKind(name),
          rawInput: { name, arguments: event.data.arguments },
          ...(location ? { locations: [location] } : {}),
          // Zed renders the programmatic tool name from meta (no dedicated field).
          _meta: { tool_name: name },
        }
        if (announcedToolCalls.has(key)) {
          // The streaming delta already created this call with empty
          // arguments; complete it with an update instead of re-creating it.
          // in_progress: the tool has started executing (pending → in_progress → completed).
          notifyUpdate(acpSessionId, { sessionUpdate: 'tool_call_update', ...payload, status: 'in_progress' })
        } else {
          announcedToolCalls.add(key)
          notifyUpdate(acpSessionId, { sessionUpdate: 'tool_call', ...payload, status: 'pending' })
        }
        break
      }
      case 'tool/result': {
        const blocks: any[] = event.data.message ? event.data.message.content : []
        const resultBlock: any = blocks.find((b: any) => b && b.type === 'tool-result')
        const innerBlocks: any[] = resultBlock && Array.isArray(resultBlock.content) ? resultBlock.content : []
        const textBlocks: any[] = innerBlocks.filter((b: any) => b && b.type === 'text')
        const callId = String(
          (resultBlock && resultBlock.toolCallId) ||
            (event.data.message && (event.data.message.toolCallId || event.data.message.callId)) ||
            event.data.callId ||
            '',
        )
        const content: any[] = []
        const callRec = toolCallArgs.get(callId)
        const diff = callRec ? diffFromArgs(callRec.name, callRec.arguments) : undefined
        if (diff) content.push(diff)
        if (textBlocks.length) content.push({ type: 'content', content: { type: 'text', text: textBlocks.map((b) => b.text).join('\n') } })
        toolCallArgs.delete(callId)
        notifyUpdate(acpSessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: callId,
          status: event.data.error ? 'failed' : 'completed',
          content: content.length ? content : undefined,
          rawOutput: textBlocks.length ? { text: textBlocks.map((b) => b.text).join('\n') } : undefined,
        })
        break
      }
      case 'session/title': {
        // The deterministic fallback title (a truncation of the first message)
        // is a placeholder that the provider title supersedes seconds later;
        // forwarding it refreshes the client's title twice per session. Only
        // user-pinned and provider titles notify, and identical repeats are
        // suppressed (a session whose title never changes notifies once).
        const source = event.data && event.data.source && event.data.source.kind
        if (source === 'fallback') break
        notifyTitle(acpSessionId, event.data && event.data.title)
        break
      }
      case 'plan/mode': {
        // Plan mode is not a session mode (modes are the agent presets); it is
        // toggled through the `/plan` slash command. Refresh the config options
        // so clients that derive state from them stay consistent, but do not
        // emit a `current_mode_update` with a mode id that no longer exists.
        void (async () => {
          try {
            const opts = await buildConfigOptionsFor(acpSessionId)
            notifyUpdate(acpSessionId, { sessionUpdate: 'config_option_update', configOptions: opts })
          } catch (e) {
            /* best effort */
          }
        })()
        break
      }
      default:
        break
    }
  }

  // Global session/event listener: match sessions owned by this plugin.
  ctx.on('session/event', (session, event) => {
    const sid = session && session.id
    if (sid === undefined) return
    const handle = handles.get(sid)
    if (!handle || handle.agent.session !== session) return
    mapSessionEvent(sid, event)
    const inflight = inflightPrompts.get(sid)
    if (inflight && event.type === 'turn/end' && event.data.turn === inflight.turn) {
      inflightPrompts.delete(sid)
      if (inflight.clearTimer) inflight.clearTimer()
      const reason: { kind?: string; error?: { message?: string } } | undefined = event.data.reason
      // Delay the RPC response slightly so every notification emitted for this
      // turn (streamed chunks, tool updates, usage) reaches the client before
      // the terminal stopReason — a response arriving early makes clients
      // (e.g. Zed) mark the turn finished while chunks are still arriving.
      const settle = () => {
        if (reason && reason.kind === 'error') {
          inflight.reject(new Error(`turn failed: ${(reason.error && reason.error.message) || 'unknown'}`))
        } else {
          inflight.resolve(turnEndToStopReason(reason))
        }
      }
      ctx.timeout(settle, 150)
    }
  })

  // ---- slash commands -----------------------------------------------------
  const advertiseCommands = (acpSessionId: string, agent: DshAgent): void => {
    const commands = commandsNow()
    if (!commands) return
    try {
      const list = commands.list(agent)
      const availableCommands = list.map((c) => ({
        name: c.name,
        description: c.description || '',
        input: c.input ? { hint: c.input.hint || '' } : undefined,
      }))
      notifyUpdate(acpSessionId, { sessionUpdate: 'available_commands_update', availableCommands })
    } catch (e) {
      /* no commands service */
    }
  }
  const tryRunCommand = async (agent: DshAgent, text: string): Promise<{ stopReason: StopReason; output?: string } | null> => {
    const commands = commandsNow()
    if (!commands || typeof text !== 'string' || !text.startsWith('/')) return null
    const line = text.trim()
    const name = line.slice(1).split(/\s+/)[0]
    if (!name || !commands.find(agent, name)) return null
    const execution = await commands.execute(agent, line, [], makeNeverSignal())
    if (!execution) return null
    // Handlers return `{ kind, text }` (e.g. `/plan` → "Plan mode on."); a
    // content-block result is also accepted for compatibility.
    const result = execution.result as { content?: any[]; text?: string } | undefined
    const blocks = result && Array.isArray(result.content) ? result.content : []
    const textOut = [
      ...blocks.filter((b) => b.type === 'text').map((b) => b.text),
      ...(result && typeof result.text === 'string' && result.text ? [result.text] : []),
    ]
      .join('\n')
      .trim()
    return { stopReason: 'end_turn', output: textOut || `Command /${name} completed` }
  }

  // ---- prompt content conversion (text/image/audio/resource) ---------------
  const buildPromptContent = async (acpBlocks: any[]): Promise<{ type: string; text?: string; data?: Uint8Array; mimeType?: string; uri?: string }[]> => {
    const content = []
    for (const b of Array.isArray(acpBlocks) ? acpBlocks : []) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text') {
        content.push({ type: 'text', text: b.text })
      } else if (b.type === 'resource' && b.resource && typeof b.resource.text === 'string') {
        content.push({ type: 'text', text: b.resource.text })
      } else if (b.type === 'image' && b.data && attachmentsNow()) {
        const attachments = attachmentsNow()
        try {
          const binary = atob(b.data)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          const ref = await attachments!.saveImage({ data: bytes, mediaType: b.mimeType || 'image/png', name: b.uri || undefined })
          content.push({ type: 'image', attachment: ref })
        } catch (e: unknown) {
          content.push({ type: 'text', text: `[image attachment failed to load: ${String((e instanceof Error && e.message) || e)}]` })
        }
      } else if (b.type === 'audio' && b.data) {
        // DSH has no native audio block; pass a textual reference.
        content.push({ type: 'text', text: `[audio attachment mimeType=${b.mimeType || 'unknown'} dataLength=${b.data.length}]` })
      }
    }
    return content
  }

  // ---- prompt execution -----------------------------------------------------
  const runPrompt = (handle: AgentHandle, acpSessionId: string, text: string): Promise<{ stopReason: StopReason }> =>
    new Promise((resolve, reject) => {
      const agent = handle.agent
      const turn = sessionEvents(agent.session).filter((e: any) => e.type === 'turn/end').length + 1
      let clearTimer = () => {}
      if (promptTimeoutMs > 0) {
        clearTimer = ctx.timeout(() => {
          inflightPrompts.delete(acpSessionId)
          // Keep client and session consistent: abort the turn instead of
          // leaving it running detached from a client that was told it failed.
          try {
            agent.cancel({ kind: 'user' })
          } catch (e) {
            /* already gone */
          }
          reject(new Error(`ACP prompt timed out after ${promptTimeoutMs}ms (configure promptTimeoutMs to adjust or disable)`))
        }, promptTimeoutMs)
      }
      inflightPrompts.set(acpSessionId, {
        turn,
        clearTimer,
        resolve: (reason) => resolve({ stopReason: reason }),
        reject,
      })
      const userMsg = {
        id: `acp-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }
      try {
        agent.followup(userMsg)
      } catch (e) {
        inflightPrompts.delete(acpSessionId)
        clearTimer()
        reject(e)
      }
    })

  /**
   * The official web profile's host tree can leave the plan-mode row
   * unactivated at boot (loader update contention between rows); the
   * `standard` preset also mounts plan-mode in the agent plane, but to be
   * safe, nudge the host row into activation once per process.
   */
  let hostPlanModeEnsured = false
  const ensureHostPlanMode = async (): Promise<void> => {
    if (hostPlanModeEnsured) return
    hostPlanModeEnsured = true
    try {
      const loader = ctx.get('loader')
      if (!loader) return
      for (const e of loader.entries()) {
        if (!e.fiber && e.options && String(e.options.name || '').includes('dsh-plan-mode')) {
          await e.init()
        }
      }
    } catch (e) {
      /* best effort */
    }
  }

  // ---- session config options (ACP v1) ----------------------------------------
  /**
   * Model catalog across every registered provider, keyed as
   * `<provider>/<model>` (e.g. `opencode-go/deepseek-v4-flash`).
   */
  const allModelOptions = async (): Promise<{ value: string; name: string }[]> => {
    const llm = llmNow()
    if (!llm) return []
    const options = []
    try {
      for (const p of llm.listProviders()) {
        if (!p || !p.id) continue
        try {
          const models = await llm.listModels(p.id)
          for (const m of models) {
            options.push({ value: `${p.id}/${m.id}`, name: `${p.id}/${m.name}` })
          }
        } catch (e) {
          /* skip provider without a catalog */
        }
      }
    } catch (e) {
      /* no provider directory */
    }
    return options
  }
  const buildConfigOptionsFor = async (acpSessionId: string): Promise<ConfigOption[]> => {
    const sel = modelSelection()
    const cfg = sessionConfigs.get(acpSessionId)
    const handle = handles.get(acpSessionId)
    const handleAgent = handle ? handle.agent : null
    // The actual durable route: the session's own logged request header (the
    // last request/header snapshot) — what the agent really runs, surviving
    // restarts. The client's in-memory choice outranks it while pending.
    let logged: { provider?: string; model?: string; reasoningEffort?: string } | undefined
    try {
      const session = handleAgent && handleAgent.session
      const header = session && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
      logged = header && header.config ? header.config : undefined
    } catch (e) {
      /* no header fold */
    }
    const providerId = (cfg && cfg.providerId) || (logged && logged.provider) || (sel && sel.provider) || null
    const modelId = (cfg && cfg.modelId) || (logged && logged.model) || (sel && sel.model) || null
    const effort = (cfg && cfg.reasoningEffort) || (logged && logged.reasoningEffort) || (sel && sel.reasoningEffort) || null
    const modelOptions = await allModelOptions()
    // The actual permission level: the sandbox policy's full resolution
    // (session override, else deployment default), falling back to a raw log
    // scan when the service is absent.
    const sandboxMode = (() => {
      try {
        const sp = sandboxPolicyNow()
        const session = handleAgent && handleAgent.session
        if (sp && typeof sp.resolve === 'function' && session) {
          const resolved = sp.resolve({ session })
          if (resolved && resolved.mode) return resolved.mode
        }
      } catch (e) {
        /* fall through */
      }
      return handleAgent ? sandboxModeFor(handleAgent) : null
    })()
    const modeState = await sessionModesFor(acpSessionId, handleAgent)
    const options = buildConfigOptions({
      currentModeId: modeState.currentModeId,
      availableModes: modeState.availableModes,
      modelId: providerId && modelId ? `${providerId}/${modelId}` : null,
      reasoningEffort: effort,
      modelOptions,
      sandboxMode,
    })
    return options
  }
  /** Whether the live agent was built with the session's current desired preset. */
  const needsRebuild = (acpSessionId: string): boolean => {
    const cfg = sessionConfigs.get(acpSessionId) || {}
    // Model and effort changes route through the agent/request waterfall and
    // need no rebuild; only a preset (mode) switch re-composes the agent.
    if (!cfg.preset) return false
    const applied = appliedOptions.get(acpSessionId) || {}
    return cfg.preset !== (applied.preset || defaultPresetId())
  }
  const recordApplied = (acpSessionId: string): void => {
    const opts = agentOptionsFor(acpSessionId)
    const cfg = sessionConfigs.get(acpSessionId)
    const handle = handles.get(acpSessionId)
    appliedOptions.set(acpSessionId, {
      provider: opts.provider || null,
      model: opts.model || null,
      reasoningEffort: opts.reasoningEffort || null,
      preset:
        (cfg && cfg.preset) ||
        (handle && handle.agent.session ? sessionPresetOf(handle.agent.session) : undefined) ||
        defaultPresetId(),
    })
  }
  /**
   * Apply a mode (preset) selection to one live session. Modes are the agent
   * presets: a blank session (no turn yet) recomposes its scope in place and
   * records the switch in its log — exactly like the web GUI; a started
   * session records the choice and re-composes at the next prompt
   * (`ensureFreshAgent`'s dispose+resume rebuild mounts the selected preset).
   * @returns void on success, or an Error carrying a client-safe message.
   */
  const applyModeChange = async (acpSessionId: string, handle: AgentHandle, modeId: string): Promise<void | Error> => {
    const agent = handle.agent
    const session = agent.session
    let blank = false
    try {
      const events = sessionEvents(session)
      blank = !(Array.isArray(events) && events.some((e: any) => e && e.type === 'turn/start'))
    } catch (e) {
      /* treat as started */
    }
    if (blank) {
      const ap = agentPresetsNow()
      if (ap && typeof ap.recompose === 'function') {
        try {
          // Recompose the live scope onto the selected preset's standing
          // mount, then record the switch — the log IS the durable state.
          const recomposed = await ap.recompose(agent.ctx, modeId)
          const appliedId = (recomposed && recomposed.id) || modeId
          try {
            session.append('agent-preset/selected', { agentPreset: appliedId })
          } catch (e) {
            /* log append is best effort */
          }
          const prev = appliedOptions.get(acpSessionId) || {}
          appliedOptions.set(acpSessionId, { ...prev, preset: appliedId })
        } catch (e) {
          return new Error(`mode switch failed: ${String((e instanceof Error && e.message) || e)}`)
        }
      }
    }
    const cfg = sessionConfigs.get(acpSessionId) || {}
    sessionConfigs.set(acpSessionId, { ...cfg, preset: modeId })
    notifyUpdate(acpSessionId, { sessionUpdate: 'current_mode_update', modeId })
    void (async () => {
      try {
        const opts = await buildConfigOptionsFor(acpSessionId)
        notifyUpdate(acpSessionId, { sessionUpdate: 'config_option_update', configOptions: opts })
      } catch (e) {
        /* best effort */
      }
    })()
    return undefined
  }
  /**
   * Rebuild the live agent when the session's preset (mode) changed since it
   * was created: dispose and resume from the persisted session; the setup hook
   * mounts the selected preset. Model/effort changes never reach this path —
   * they route through the per-agent `agent/request` waterfall. Falls back to
   * the current handle when resume fails.
   */
  const ensureFreshAgent = async (acpSessionId: string): Promise<AgentHandle | undefined> => {
    const handle = handles.get(acpSessionId)
    if (!handle || !needsRebuild(acpSessionId)) return handle
    try {
      await handle.dispose()
    } catch (e) {
      /* already gone */
    }
    try {
      const fresh = await agents.resume({ resumeSessionId: acpSessionId as any, agentOptions: agentOptionsFor(acpSessionId), setup: agentSetup })
      handles.set(acpSessionId, fresh)
      recordApplied(acpSessionId)
      configureAgent(fresh.agent)
      advertiseCommands(acpSessionId, fresh.agent)
      return fresh
    } catch (e) {
      ctx.logger.warn(`acp-gateway: config rebuild failed for ${acpSessionId}: ${String((e instanceof Error && e.message) || e)}`)
      return handle
    }
  }

  // ---- session/load history replay -------------------------------------------
  const replayHistory = (acpSessionId: string, agent: DshAgent): void => {
    for (const event of sessionEvents(agent.session)) {
      if (event.type === 'user/message') {
        const text = (event.data.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
        if (text) notifyUpdate(acpSessionId, { sessionUpdate: 'user_message_chunk', messageId: String(event.seq), content: { type: 'text', text } })
      } else if (event.type === 'assistant/message') {
        for (const block of event.data.message.content as any[]) {
          if (block.type === 'text' && block.text) {
            notifyUpdate(acpSessionId, { sessionUpdate: 'agent_message_chunk', messageId: String(event.seq), content: { type: 'text', text: block.text } })
          }
        }
      }
    }
  }

  // ---- protocol dispatch --------------------------------------------------------
  const handleMessage = async (msg: any): Promise<any> => {
    if (!msg || typeof msg !== 'object') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
    }
    // A response to an outstanding agent→client request (permission/elicitation).
    if (typeof msg.method !== 'string' && typeof msg.id === 'number') {
      const pending = pendingClientRequests.get(msg.id)
      if (pending) {
        pendingClientRequests.delete(msg.id)
        pending(msg)
        return null
      }
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown response id' } }
    }
    if (typeof msg.method !== 'string') {
      const id = typeof msg.id !== 'undefined' ? msg.id : null
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } }
    }
    const { id, method, params = {} } = msg
    const hasId = typeof id !== 'undefined'
    const respond = (result: any) => (hasId ? { jsonrpc: '2.0', id, result } : null)
    const fail = (code: number, message: string) => (hasId ? { jsonrpc: '2.0', id, error: { code, message } } : null)
    try {
      switch (method) {
        case 'initialize': {
          clientCapabilities = (params && params.clientCapabilities) || {}
          return respond({
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true, audio: true, embeddedContext: true },
              sessionCapabilities: { list: {}, delete: {}, resume: {} },
            },
            agentInfo: { name: 'dsh-acp', title: 'DeepSeek Harness ACP Agent', version: '3.11.0' },
            authMethods: [],
          })
        }
        case 'session/new': {
          if (typeof params.cwd !== 'string') return fail(-32602, 'session/new requires params.cwd (absolute path)')
          await ensureHostPlanMode()
          const acpSessionId = newSessionId()
          // Record the composed preset in the creation header (durable), so a
          // restarted server resumes this session under its own preset.
          const presetId = agentPresetsNow() ? defaultPresetId() : undefined
          const handle = await agents.create({
            sessionId: acpSessionId as any,
            meta: { cwd: params.cwd, ...(presetId ? { agentPreset: presetId } : {}) },
            agentOptions: agentOptionsFor(acpSessionId),
            setup: agentSetup,
          })
          handles.set(acpSessionId, handle)
          configureAgent(handle.agent)
          advertiseCommands(acpSessionId, handle.agent)
          recordApplied(acpSessionId)
          const newOptions = await buildConfigOptionsFor(acpSessionId)
          return respond({
            sessionId: acpSessionId,
            modes: await sessionModesFor(acpSessionId, handle.agent),
            configOptions: newOptions,
          })
        }
        case 'session/load': {
          const acpSessionId = String(params.sessionId || '')
          if (!acpSessionId) return fail(-32602, 'session/load requires params.sessionId')
          const existingHandle = handles.get(acpSessionId)
          if (existingHandle) {
            notifyTitle(acpSessionId, sessionTitleFor(existingHandle.agent))
            const opts = await buildConfigOptionsFor(acpSessionId)
            return respond({ modes: await sessionModesFor(acpSessionId, existingHandle.agent), configOptions: opts })
          }
          try {
            const handle = await agents.resume({ resumeSessionId: acpSessionId as any, agentOptions: agentOptionsFor(acpSessionId), setup: agentSetup })
            handles.set(acpSessionId, handle)
            configureAgent(handle.agent)
            replayHistory(acpSessionId, handle.agent)
            advertiseCommands(acpSessionId, handle.agent)
            recordApplied(acpSessionId)
            // Re-surface the session's current title once (deduped): a client
            // that loads an already-titled session must see its title even
            // when the generating event happened before it connected.
            notifyTitle(acpSessionId, sessionTitleFor(handle.agent))
            const opts = await buildConfigOptionsFor(acpSessionId)
            return respond({ modes: await sessionModesFor(acpSessionId, handle.agent), configOptions: opts })
          } catch (e) {
            return fail(-32002, `session not found: ${acpSessionId}`)
          }
        }
        case 'session/resume': {
          // ACP v1: restore a previous session WITHOUT replaying its history
          // (session/load replays; resume just reattaches, per the session
          // setup spec). A session already live in this process answers
          // directly.
          const acpSessionId = String(params.sessionId || '')
          if (!acpSessionId) return fail(-32602, 'session/resume requires params.sessionId')
          const existingHandle = handles.get(acpSessionId)
          if (existingHandle) {
            notifyTitle(acpSessionId, sessionTitleFor(existingHandle.agent))
            const opts = await buildConfigOptionsFor(acpSessionId)
            return respond({ modes: await sessionModesFor(acpSessionId, existingHandle.agent), configOptions: opts })
          }
          try {
            const handle = await agents.resume({ resumeSessionId: acpSessionId as any, agentOptions: agentOptionsFor(acpSessionId), setup: agentSetup })
            handles.set(acpSessionId, handle)
            configureAgent(handle.agent)
            advertiseCommands(acpSessionId, handle.agent)
            recordApplied(acpSessionId)
            notifyTitle(acpSessionId, sessionTitleFor(handle.agent))
            const opts = await buildConfigOptionsFor(acpSessionId)
            return respond({ modes: await sessionModesFor(acpSessionId, handle.agent), configOptions: opts })
          } catch (e) {
            return fail(-32002, `session not found: ${acpSessionId}`)
          }
        }
        case 'session/prompt': {
          const handle = await ensureFreshAgent(String(params.sessionId))
          if (!handle) return fail(-32002, `session not found: ${String(params.sessionId)}`)
          const rawText = (Array.isArray(params.prompt) ? params.prompt : [])
            .map((b: any) => (b && b.type === 'text' ? b.text : ''))
            .join('\n')
          const cmdResult = await tryRunCommand(handle.agent, rawText)
          if (cmdResult) {
            if (cmdResult.output) {
              notifyUpdate(String(params.sessionId), {
                sessionUpdate: 'agent_message_chunk',
                messageId: `cmd_${Date.now()}`,
                content: { type: 'text', text: cmdResult.output },
              })
            }
            return respond({ stopReason: cmdResult.stopReason })
          }
          const content = await buildPromptContent(params.prompt)
          if (content.length === 0) return fail(-32602, 'session/prompt requires non-empty content')
          const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
          const hasImage = content.some((b) => b.type === 'image')
          notifyUpdate(String(params.sessionId), {
            sessionUpdate: 'user_message_chunk',
            messageId: `user_${Date.now()}`,
            content: { type: 'text', text: text || (hasImage ? '[image]' : '') },
          })
          return respond(await runPrompt(handle, String(params.sessionId), text))
        }
        case 'session/cancel': {
          const handle = handles.get(params.sessionId)
          if (handle) {
            try {
              handle.agent.cancel({ kind: 'user' })
            } catch (e) {
              /* noop */
            }
          }
          return null
        }
        case 'session/set_mode': {
          const handle = handles.get(params.sessionId)
          if (!handle) return fail(-32002, `session not found: ${String(params.sessionId)}`)
          const modeId = String(params.modeId || '')
          // Modes are the agent presets; switching mode re-composes the agent.
          const ids = (await presetList()).map((p) => p.id)
          if (ids.length === 0) ids.push(FALLBACK_MODE_ID)
          if (!ids.includes(modeId)) return fail(-32602, `unknown mode: ${modeId}`)
          const acpSessionId = String(params.sessionId)
          const applied = await applyModeChange(acpSessionId, handle, modeId)
          if (applied instanceof Error) return fail(-32603, applied.message)
          return respond({})
        }
        case 'session/set_config_option': {
          const acpSessionId = String(params.sessionId || '')
          const handle = handles.get(acpSessionId)
          if (!handle) return fail(-32002, `session not found: ${acpSessionId}`)
          const configId = String(params.configId || '')
          const value = params.value
          if (configId === 'mode' || configId === 'preset') {
            // `preset` is a compatibility alias folded into `mode` (modes ARE
            // the presets); both accept the same values.
            const modeId = String(value)
            const ids = (await presetList()).map((p) => p.id)
            if (ids.length === 0) ids.push(FALLBACK_MODE_ID)
            if (!ids.includes(modeId)) return fail(-32602, `unknown mode: ${modeId}`)
            const applied = await applyModeChange(acpSessionId, handle, modeId)
            if (applied instanceof Error) return fail(-32603, applied.message)
          } else if (configId === 'model') {
            const valueStr = String(value)
            const slash = valueStr.indexOf('/')
            if (slash <= 0 || slash === valueStr.length - 1) return fail(-32602, `model must be "provider/model", got: ${valueStr}`)
            const provider = valueStr.slice(0, slash)
            const model = valueStr.slice(slash + 1)
            const options = await allModelOptions()
            if (!options.some((o) => o.value === valueStr)) return fail(-32602, `unknown model: ${valueStr}`)
            const cfg = sessionConfigs.get(acpSessionId) || {}
            sessionConfigs.set(acpSessionId, { ...cfg, providerId: provider, modelId: model })
          } else if (configId === 'provider') {
            // Compatibility alias: Zed's default_config_options may pre-fill a
            // standalone provider. Accept it (validate against the directory)
            // and reset the model so the client re-picks from the new provider.
            const providers: string[] = []
            const llmSvc = llmNow()
            if (llmSvc) {
              try {
                for (const p of llmSvc.listProviders()) if (p && p.id) providers.push(p.id)
              } catch (e) {
                /* no directory */
              }
            }
            if (!providers.includes(String(value))) return fail(-32602, `unknown provider: ${String(value)}`)
            const cfg = sessionConfigs.get(acpSessionId) || {}
            sessionConfigs.set(acpSessionId, { ...cfg, providerId: String(value), modelId: undefined })
          } else if (configId === 'thought_level') {
            const allowed = ['minimal', 'low', 'medium', 'high', 'max']
            if (!allowed.includes(String(value))) return fail(-32602, `unknown thought level: ${String(value)}`)
            const cfg = sessionConfigs.get(acpSessionId) || {}
            sessionConfigs.set(acpSessionId, { ...cfg, reasoningEffort: String(value) })
          } else if (configId === 'permission') {
            const allowed = ['read-only', 'workspace-write', 'danger-full-access']
            if (!allowed.includes(String(value))) return fail(-32602, `unknown permission: ${String(value)}`)
            try {
              // The sandbox-mode switch IS the event; the policy folds it from the log.
              handle.agent.session.append('sandbox/mode', { mode: String(value) })
              // Keep the approval policy in lockstep (workspace-write asks).
              const approvalNowSvc = approvalNow()
              if (approvalNowSvc) approvalNowSvc.setPolicy(handle.agent, String(value) === 'workspace-write' ? 'ask' : 'never')
            } catch (e) {
              return fail(-32603, 'permission switch failed')
            }
          } else {
            return fail(-32602, `unknown config option: ${configId}`)
          }
          const opts = await buildConfigOptionsFor(acpSessionId)
          notifyUpdate(acpSessionId, { sessionUpdate: 'config_option_update', configOptions: opts })
          return respond({ configOptions: opts })
        }
        case 'session/list': {
          const list = []
          const sessionQuery = sessionQueryNow()
          if (sessionQuery) {
            try {
              const records = await sessionQuery.listSessions()
              const ids = records.map((r) => r.header.id)
              // Session headers carry no title; fold the latest logged
              // `session/title` per session so the picker shows real names.
              const titleById = new Map<string, string>()
              if (ids.length > 0 && typeof sessionQuery.readTitleSnapshots === 'function') {
                try {
                  const snapshots = await sessionQuery.readTitleSnapshots(ids)
                  for (const s of snapshots) {
                    if (s.status === 'fulfilled' && s.value && s.value.title) titleById.set(s.sessionId, s.value.title.title)
                  }
                } catch (e) {
                  /* best effort */
                }
              }
              for (const r of records) {
                list.push({
                  sessionId: r.header.id,
                  cwd: r.header.cwd || undefined,
                  title: titleById.get(r.header.id) || r.header.title || undefined,
                  // Session headers carry no updatedAt field; the closest durable
                  // timestamp is the header's createdAt (or the title snapshot's).
                  updatedAt: r.header.updatedAt
                    ? new Date(r.header.updatedAt).toISOString()
                    : r.header.createdAt
                      ? new Date(r.header.createdAt).toISOString()
                      : undefined,
                })
              }
            } catch (e) {
              /* fall through to handles */
            }
          }
          if (list.length === 0) {
            for (const [sid, handle] of handles) {
              const header = handle.agent.session && handle.agent.session.header
              list.push({
                sessionId: sid,
                cwd: (header && header.cwd) || handle.agent.session.cwd || undefined,
                updatedAt: new Date((header && header.createdAt) || handle.agent.session.updatedAt || Date.now()).toISOString(),
              })
            }
          }
          return respond({ sessions: list })
        }
        case 'session/delete': {
          const acpSessionId = String(params.sessionId || '')
          sessionConfigs.delete(acpSessionId)
          appliedOptions.delete(acpSessionId)
          lastTitles.delete(acpSessionId)
          const handle = handles.get(acpSessionId)
          if (handle) {
            try {
              await handle.dispose()
            } catch (e) {
              /* ignore */
            }
            handles.delete(acpSessionId)
            inflightPrompts.delete(params.sessionId)
            // Remove the persisted session directory with direct node:fs: the
            // `shell` service is gated by the sandbox policy (workspaceRoot),
            // which would silently refuse an rm outside the workspace.
            try {
              const { readdirSync, rmSync } = await import('node:fs')
              const { join } = await import('node:path')
              const { homedir } = await import('node:os')
              const sessionsRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
              const dir = String(params.sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')
              for (const cwdDir of readdirSync(sessionsRoot)) {
                try {
                  rmSync(join(sessionsRoot, cwdDir, dir), { recursive: true, force: true })
                } catch (e) {
                  /* per-dir best effort */
                }
              }
            } catch (e) {
              /* no sessions store */
            }
          }
          return respond({})
        }
        default:
          return fail(-32601, `Method not found: ${String(method)}`)
      }
    } catch (e: unknown) {
      return fail(
        typeof e === 'object' && e !== null && 'code' in e ? ((e as { code: number }).code as number) : -32603,
        String((e instanceof Error && e.message) || e),
      )
    }
  }

  // ---- web-facing mounts: loopback channel + bridge script ---------------------
  // The official `dsh web` profile activates its webServer service after this
  // plugin's own inject deps are ready, so mount lazily when it appears.
  const mountWeb = async (ws: WebServerService): Promise<void> => {
    // Services are resolved lazily here: webServer can appear after apply, and
    // fs/shell may too, so re-read them instead of the apply-time snapshot.
    const fsNow = ctx.get('fs')
    const shellNow = ctx.get('shell')
    const sandboxPolicy = sandboxPolicyNow()

    // Endpoint file for the stdio bridge: written directly via node:fs so it
    // works even in compositions without the `fs` service (official web profile).
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const home = process.env.HOME || process.env.USERPROFILE
      const dshHome = process.env.DSH_ACP_HOME || process.env.DSH_HOME || (home ? join(home, '.dsh') : null)
      if (dshHome) {
        const dir = join(dshHome, 'acp')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'endpoint'), `http://127.0.0.1:${ws.port}\n`)
      }
    } catch (e) {
      /* best effort */
    }
    // Clean any stale ACP routes from a previous run of this plugin.
    try {
      const table = ws.exact
      if (table && typeof table.delete === 'function') {
        for (const p of ['/acp/rpc', '/acp/events']) table.delete(p)
      }
    } catch (e) {
      /* internal table not reachable */
    }

    // stdio bridge script generation (needs the web port).
    if (fsNow) {
      try {
        let home = null
        if (shellNow) {
          const spec = shellNow.resolve({ command: 'printf %s "$HOME"' })
          const r = await shellNow.run(spec)
          home = r.stdout && r.stdout.text ? r.stdout.text.trim() : null
        }
        const base = home || (sandboxPolicy && sandboxPolicy.workspaceRoot) || null
        if (base) {
          const stdioScriptPath = config.stdioScriptPath || `${base}/.dsh/acp/dsh-acp-agent.js`
          const endpoint = `http://127.0.0.1:${ws.port}`
          const target = await fsNow.resolve(stdioScriptPath)
          await fsNow.writeText(target, buildBridgeScript(endpoint))
        }
      } catch (e) {
        ctx.logger.warn(`acp-gateway: stdio bridge script write failed: ${String((e instanceof Error && e.message) || e)}`)
      }
    }

    // internal loopback channel (for the stdio bridge only)
    const readBody = (req: any): Promise<string> =>
      new Promise((resolve) => {
        let data = ''
        req.setEncoding('utf8')
        req.on('data', (c: string) => {
          data += c
        })
        req.on('end', () => resolve(data))
      })
    const sendJson = (res: any, obj: any, status?: number): void => {
      res.writeHead(status || 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    ctx.effect(() => {
      const dispose = ws.register({
        kind: 'exact',
        path: '/acp/rpc',
        async handler(req: any, res: any) {
          try {
            if (req.method !== 'POST') {
              sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'POST required' } }, 405)
              return
            }
            const body = await readBody(req)
            let msg
            try {
              msg = JSON.parse(body)
            } catch (e) {
              sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
              return
            }
            const response = await handleMessage(msg)
            if (response) sendJson(res, response)
            else {
              res.writeHead(204)
              res.end()
            }
          } catch (e) {
            try {
              sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32603, message: String((e instanceof Error && e.message) || e) } })
            } catch (e2) {
              /* socket gone */
            }
          }
        },
      }) as unknown as () => void
      return dispose
    })
    ctx.effect(() => {
      const dispose = ws.register({
        kind: 'exact',
        path: '/acp/events',
        handler(req: any, res: any) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
          res.write(': connected\n\n')
          const off = subscribe((json: string) => {
            try {
              res.write(`data: ${json}\n\n`)
            } catch (e) {
              /* socket gone */
            }
          })
          req.on('close', off)
        },
      }) as unknown as () => void
      return dispose
    })
  }
  ctx.inject(['webServer'] as any, (webCtx: any) => mountWeb(webCtx.webServer))

  // ---- model-facing test tool (registered globally; hidden from ACP agents) ------
  const tools = toolsNow()
  if (tools) {
    const tool = defineTool({
      name: 'acp_test',
      description:
        'Run a complete Agent Client Protocol (ACP) v1 round trip against the built-in DSH ACP agent: initialize, session/new (a real DSH agent with full tool access), session/prompt with streamed notifications, session/delete, and the final stop reason. Returns the full protocol interaction record.',
      parameters: {
        prompt: { type: 'string', description: 'Prompt text to send to the ACP agent. Defaults to a greeting.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        const promptText = args && typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt : 'Hello! Please introduce yourself in one sentence.'
        const record: {
          steps: any[]
          notifications: any[]
          text: string
          stopReason: string | null
          modes?: any
          sessionId?: string | null
          notificationTypes?: string[]
          agentIds?: number
        } = { steps: [], notifications: [], text: '', stopReason: null }
        const off = subscribe((json: string) => {
          try {
            record.notifications.push(JSON.parse(json))
          } catch (e) {
            /* skip */
          }
        })
        try {
          const push = async (request: any): Promise<any> => {
            const response = await handleMessage(request)
            record.steps.push({ request: request.method, id: request.id, response })
            return response
          }
          await push({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-acp-test', version: '3.11.0' } } })
          const cwd = (sandboxPolicyNow() && sandboxPolicyNow()!.workspaceRoot) || '.'
          const newRes = await push({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } })
          const sessionId = newRes && newRes.result ? newRes.result.sessionId : null
          record.modes = newRes && newRes.result ? newRes.result.modes : null
          const promptRes = await push({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: promptText }] } })
          record.stopReason = promptRes && promptRes.result ? promptRes.result.stopReason : null
          record.text = record.notifications
            .filter((n) => n.params && n.params.update && n.params.update.sessionUpdate === 'agent_message_chunk')
            .map((n) => n.params.update.content.text)
            .join('')
          record.sessionId = sessionId
          record.notificationTypes = record.notifications.map((n) => n.params.update.sessionUpdate)
          record.agentIds = handles.size
          await push({ jsonrpc: '2.0', id: 4, method: 'session/delete', params: { sessionId } })
        } finally {
          off()
        }
        return record
      },
    })
    ctx.effect(() => tools.register(tool) as unknown as () => void)
  }

  // ---- approval answerer (global scope; the approval waterfall carries the
  // agent, so an unscoped listener matches every agent) ------------------------
  try {
    ;(ctx.on as any)('approval/request', async (req: any, next: (outcome: string) => void) => {
      const sid = req && req.agent && req.agent.session && req.agent.session.id
      if (typeof sid !== 'string') return next('unavailable')
      const toolCallId = req && req.callId ? String(req.callId) : `call_${Date.now().toString(36)}`
      const response = await sendClientRequest('session/request_permission', {
        sessionId: sid,
        toolCall: {
          toolCallId,
          title: (req && req.toolName) || 'tool call',
          kind: toolKind(req && req.toolName),
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      })
      const outcome = response && response.result && response.result.outcome
      if (outcome && outcome.outcome === 'selected') {
        next(outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected')
      } else {
        next('cancelled')
      }
    })
  } catch (e) {
    /* no approval channel */
  }

  // ---- release all agents on stop ------------------------------------------------
  ;(ctx.on as any)('dispose', async () => {
    for (const handle of handles.values()) {
      try {
        await handle.dispose()
      } catch (e) {
        /* ignore */
      }
    }
    handles.clear()
  })
}

export default { name, inject, apply }
