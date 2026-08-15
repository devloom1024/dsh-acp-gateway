/**
 * DSH ACP Agent Gateway — a distributable DSH (DeepSeek Harness) plugin that
 * exposes a full ACP v1 (Agent Client Protocol) agent over stdio.
 *
 * Unlike the upstream `@deepseek-ai/dsh-acp` automation-only bridge, this
 * plugin adds: token-level streaming, tool-call notifications, session
 * list/load/delete, usage updates, image/audio prompt content, slash
 * commands, session modes, and full tool access (via the `standard` agent
 * preset).
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
import type { NeverSignal, SessionModeState, ConfigOptionsInput } from './codec.js'
import type {
  AgentsService,
  LlmService,
  DefaultModelService,
  ToolsService,
  CommandsService,
  PlanModeService,
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

/** Session mode ids this agent advertises. */
const MODE_IDS = ['code', 'plan']

/**
 * Optional gateway configuration.
 * @param stdioScriptPath - where the generated bridge script is written.
 * @param provider - model provider route (used when no DSH default model exists).
 * @param model - model id (used when no DSH default model exists).
 */
export interface GatewayConfig {
  stdioScriptPath?: string
  provider?: string
  model?: string
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
  const sessionQueryNow = (): SessionQueryService | undefined => ctx.get('sessionQuery')
  const fsNow2 = (): FsService | undefined => ctx.get('fs')
  const shellNow2 = (): ShellService | undefined => ctx.get('shell')
  const sandboxPolicyNow = (): SandboxPolicyService | undefined => ctx.get('sandboxPolicy')
  const toolsNow = (): ToolsService | undefined => ctx.get('tools')
  const attachmentsNow = (): AttachmentsService | undefined => ctx.get('attachments')
  const commandsNow = (): CommandsService | undefined => ctx.get('commands')
  // Services that can become available after apply (the official web profile
  // activates rows in service order) are read lazily at call time.
  const planModeNow = (): PlanModeService | undefined => ctx.get('planMode')
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
  const agentOptionsFor = (acpSessionId?: string): { provider?: string; model?: string; reasoningEffort?: string } => {
    const sel = modelSelection()
    if (!sel) return {}
    const cfg = acpSessionId ? sessionConfigs.get(acpSessionId) : undefined
    const provider = (cfg && cfg.providerId) || sel.provider
    const model = (cfg && cfg.modelId) || sel.model
    const reasoningEffort = (cfg && cfg.reasoningEffort) || sel.reasoningEffort
    return {
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
  }
  /** The session's current sandbox mode (permission level) from its log. */
  const sandboxModeFor = (agent: DshAgent): string | null => {
    try {
      const events = agent.session.log || agent.session.events || []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === 'sandbox/mode') return events[i].data && events[i].data.mode
      }
    } catch (e) {
      /* fall through */
    }
    return null
  }

  // ---- agent assembly ---------------------------------------------------
  /** The session being created/resumed right now (read by agentSetup). */
  let setupSessionId: string | null = null
  const agentSetup = async (agentCtx: any): Promise<void> => {
    try {
      // Full tool access + system prompt, same as the Web GUI. The preset is
      // the session's selected one (standard by default); when no preset
      // registry is configured, the agent keeps whatever the composition
      // mounted at the agent scope.
      const agentPresets = agentPresetsNow()
      if (agentPresets) {
        try {
          const cfg = setupSessionId ? sessionConfigs.get(setupSessionId) : undefined
          const presetId = (cfg && cfg.preset) || 'standard'
          const presets = await agentPresets.list()
          if (presets.some((p) => p.id === presetId)) {
            await agentPresets.mount(agentCtx, presetId)
          } else if (presets.some((p) => p.id === 'standard')) {
            await agentPresets.mount(agentCtx, 'standard')
          }
        } catch (e) {
          ctx.logger.warn(`acp-gateway: preset mount failed: ${String((e instanceof Error && e.message) || e)}`)
        }
      }
    } catch (e) {
      /* no preset registry */
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
              if (result && result.action === 'accepted' && result.answers && typeof result.answers === 'object') {
                return {
                  answers: items.map((q: any) => {
                    const value = result.answers[q.id]
                    const selected = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : []
                    return { id: q.id, selected, ...(typeof value === 'string' ? { custom: value } : {}) }
                  }),
                }
              }
              throw new Error('elicitation dismissed by user')
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
   * Plan-mode controller for one agent: the `standard` preset mounts it in
   * the agent plane (isolate realm), so read it from the agent's own context
   * first, falling back to the host plane (dynamic harness compositions).
   */
  const planModeFor = (agent: DshAgent): PlanModeService | undefined => {
    try {
      if (agent && agent.ctx) {
        const pm = agent.ctx.get('planMode')
        if (pm) return pm
      }
    } catch (e) {
      /* fall through */
    }
    return planModeNow()
  }
  const modeStateFor = (agent: DshAgent): SessionModeState => {
    let planActive = false
    const planMode = planModeFor(agent)
    if (planMode) {
      try {
        // `pending` is the not-yet-committed selection (committed at the next
        // step start); both count as the effective mode for the client.
        const state = planMode.get(agent)
        planActive = !!(state && (state.active || state.pending))
      } catch (e) {
        /* keep code */
      }
    }
    return sessionModeState(planActive)
  }

  // ---- state ------------------------------------------------------------
  const handles = new Map<string, AgentHandle>()
  const sessionConfigs = new Map<string, { providerId?: string; modelId?: string; reasoningEffort?: string; preset?: string }>()
  const appliedOptions = new Map<string, { provider?: string | null; model?: string | null; reasoningEffort?: string | null; preset?: string }>()
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
        } else if (chunk.type === 'reasoning' || chunk.type === 'thinking') {
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
        const title = event.data && event.data.title
        if (typeof title === 'string') {
          notifyUpdate(acpSessionId, {
            sessionUpdate: 'session_info_update',
            title,
            updatedAt: new Date().toISOString(),
          })
        }
        break
      }
      case 'plan/mode': {
        const active = event.data && event.data.active
        notifyUpdate(acpSessionId, { sessionUpdate: 'current_mode_update', modeId: active ? 'plan' : 'code' })
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
    const execution = await commands.execute(agent, line, makeNeverSignal())
    if (!execution) return null
    const blocks = execution.result && execution.result.content
      ? execution.result.content
      : [{ type: 'text', text: `Command /${name} completed` }]
    const textOut = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    return { stopReason: 'end_turn', output: textOut }
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
      const turn = (agent.session.log as any[]).filter((e: any) => e.type === 'turn/end').length + 1
      let clearTimer = ctx.timeout(() => {
        inflightPrompts.delete(acpSessionId)
        reject(new Error('ACP prompt timed out'))
      }, 600000)
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
    const providerId = (cfg && cfg.providerId) || (sel && sel.provider) || null
    const modelId = (cfg && cfg.modelId) || (sel && sel.model) || null
    const effort = (cfg && cfg.reasoningEffort) || (sel && sel.reasoningEffort) || null
    const handle = handles.get(acpSessionId)
    const modeState = handle ? modeStateFor(handle.agent) : sessionModeState(false)
    const modelOptions = await allModelOptions()
    const handleAgent = handle ? handle.agent : null
    const sandboxMode = handleAgent ? sandboxModeFor(handleAgent) : null
    const presetOptions: { value: string; name: string }[] = []
    const ap = agentPresetsNow()
    if (ap) {
      try {
        for (const p of await ap.list()) presetOptions.push({ value: p.id, name: p.id })
      } catch (e) {
        /* no presets */
      }
    }
    const presetId = (cfg && cfg.preset) || 'standard'
    const options = buildConfigOptions({
      currentModeId: modeState.currentModeId,
      availableModes: modeState.availableModes,
      modelId: providerId && modelId ? `${providerId}/${modelId}` : null,
      reasoningEffort: effort,
      modelOptions,
      sandboxMode,
    })
    if (presetOptions.length > 0) {
      options.push({ id: 'preset', name: 'Agent Preset', description: 'Agent preset (standard / PTC / minimal / creation)', category: 'mode', type: 'select', currentValue: presetId, options: presetOptions })
    }
    return options
  }
  /** Whether the live agent was built with the session's current desired config. */
  const needsRebuild = (acpSessionId: string): boolean => {
    const cfg = sessionConfigs.get(acpSessionId) || {}
    const applied = appliedOptions.get(acpSessionId) || {}
    const sel = modelSelection() || {}
    const desiredProvider = cfg.providerId || sel.provider || null
    const desiredModel = cfg.modelId || sel.model || null
    const desiredEffort = cfg.reasoningEffort || sel.reasoningEffort || null
    const desiredPreset = cfg.preset || 'standard'
    return (
      desiredProvider !== (applied.provider || null) ||
      desiredModel !== (applied.model || null) ||
      desiredEffort !== (applied.reasoningEffort || null) ||
      desiredPreset !== (applied.preset || 'standard')
    )
  }
  const recordApplied = (acpSessionId: string): void => {
    const opts = agentOptionsFor(acpSessionId)
    const cfg = sessionConfigs.get(acpSessionId)
    appliedOptions.set(acpSessionId, {
      provider: opts.provider || null,
      model: opts.model || null,
      reasoningEffort: opts.reasoningEffort || null,
      preset: (cfg && cfg.preset) || 'standard',
    })
  }
  /**
   * Rebuild the live agent when the session's model/effort config changed since
   * it was created: dispose and resume from the persisted session with the new
   * options. Falls back to the current handle when resume fails.
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
    for (const event of agent.session.log as any[]) {
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
              sessionCapabilities: { list: {}, delete: {} },
            },
            agentInfo: { name: 'dsh-acp', title: 'DeepSeek Harness ACP Agent', version: '3.9.0' },
            authMethods: [],
          })
        }
        case 'session/new': {
          if (typeof params.cwd !== 'string') return fail(-32602, 'session/new requires params.cwd (absolute path)')
          await ensureHostPlanMode()
          const acpSessionId = newSessionId()
          const handle = await agents.create({
            sessionId: acpSessionId as any,
            meta: { cwd: params.cwd },
            agentOptions: agentOptionsFor(),
            setup: agentSetup,
          })
          handles.set(acpSessionId, handle)
          configureAgent(handle.agent)
          advertiseCommands(acpSessionId, handle.agent)
          recordApplied(acpSessionId)
          const newOptions = await buildConfigOptionsFor(acpSessionId)
          return respond({ sessionId: acpSessionId, modes: modeStateFor(handle.agent), configOptions: newOptions })
        }
        case 'session/load': {
          const acpSessionId = String(params.sessionId || '')
          if (!acpSessionId) return fail(-32602, 'session/load requires params.sessionId')
          const existingHandle = handles.get(acpSessionId)
          if (existingHandle) {
            const opts = await buildConfigOptionsFor(acpSessionId)
            return respond({ modes: modeStateFor(existingHandle.agent), configOptions: opts })
          }
          try {
            const handle = await agents.resume({ resumeSessionId: acpSessionId as any, agentOptions: agentOptionsFor(acpSessionId), setup: agentSetup })
            handles.set(acpSessionId, handle)
            configureAgent(handle.agent)
            replayHistory(acpSessionId, handle.agent)
            advertiseCommands(acpSessionId, handle.agent)
            recordApplied(acpSessionId)
            const opts = await buildConfigOptionsFor(acpSessionId)
            return respond({ modes: modeStateFor(handle.agent), configOptions: opts })
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
          if (!MODE_IDS.includes(modeId)) return fail(-32602, `unknown mode: ${modeId}`)
          const planMode = planModeFor(handle.agent)
          if (planMode) {
            try {
              planMode.set(handle.agent, modeId === 'plan')
            } catch (e) {
              return fail(-32603, 'mode switch failed')
            }
          }
          notifyUpdate(String(params.sessionId), { sessionUpdate: 'current_mode_update', modeId })
          void (async () => {
            try {
              const opts = await buildConfigOptionsFor(String(params.sessionId))
              notifyUpdate(String(params.sessionId), { sessionUpdate: 'config_option_update', configOptions: opts })
            } catch (e) {
              /* best effort */
            }
          })()
          return respond({})
        }
        case 'session/set_config_option': {
          const acpSessionId = String(params.sessionId || '')
          const handle = handles.get(acpSessionId)
          if (!handle) return fail(-32002, `session not found: ${acpSessionId}`)
          const configId = String(params.configId || '')
          const value = params.value
          if (configId === 'mode') {
            const modeId = String(value)
            if (!MODE_IDS.includes(modeId)) return fail(-32602, `unknown mode: ${modeId}`)
            const planMode = planModeFor(handle.agent)
            if (planMode) {
              try {
                planMode.set(handle.agent, modeId === 'plan')
              } catch (e) {
                return fail(-32603, 'mode switch failed')
              }
            }
            notifyUpdate(acpSessionId, { sessionUpdate: 'current_mode_update', modeId })
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
          } else if (configId === 'preset') {
            const presets = []
            const ap = agentPresetsNow()
            if (ap) {
              try {
                for (const p of await ap.list()) presets.push(p.id)
              } catch (e) {
                /* no presets */
              }
            }
            if (!presets.includes(String(value))) return fail(-32602, `unknown preset: ${String(value)}`)
            const cfg = sessionConfigs.get(acpSessionId) || {}
            sessionConfigs.set(acpSessionId, { ...cfg, preset: String(value) })
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
              for (const r of records) {
                list.push({
                  sessionId: r.header.id,
                  cwd: r.header.cwd || undefined,
                  title: r.header.title || undefined,
                  updatedAt: r.header.updatedAt ? new Date(r.header.updatedAt).toISOString() : undefined,
                })
              }
            } catch (e) {
              /* fall through to handles */
            }
          }
          if (list.length === 0) {
            for (const [sid, handle] of handles) {
              list.push({ sessionId: sid, cwd: handle.agent.session.cwd || undefined, updatedAt: new Date(handle.agent.session.updatedAt || Date.now()).toISOString() })
            }
          }
          return respond({ sessions: list })
        }
        case 'session/delete': {
          const acpSessionId = String(params.sessionId || '')
          sessionConfigs.delete(acpSessionId)
          appliedOptions.delete(acpSessionId)
          const handle = handles.get(acpSessionId)
          if (handle) {
            try {
              await handle.dispose()
            } catch (e) {
              /* ignore */
            }
            handles.delete(acpSessionId)
            inflightPrompts.delete(params.sessionId)
            const shellDel = shellNow2()
            if (shellDel) {
              try {
                const dir = String(params.sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')
                const spec = shellDel.resolve({ command: `rm -rf "$HOME/.dsh/sessions"/*/"${dir}"` })
                await shellDel.run(spec)
              } catch (e) {
                /* ignore */
              }
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
      if (home) {
        const dir = join(home, '.dsh', 'acp')
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
          await push({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-acp-test', version: '3.9.0' } } })
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
