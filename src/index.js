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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { turnEndToStopReason, toolKind, toolTitle, locationFromArgs, diffFromArgs, makeNeverSignal, sessionModeState, buildConfigOptions, buildBridgeScript } from './codec.js'

export const name = 'acp-gateway'
/** Hard dependencies: the agent factory and timers. Everything else is optional. */
export const inject = ['agents', 'timer']

/** Session mode ids this agent advertises. */
const MODE_IDS = ['code', 'plan']


/**
 * Mount the ACP agent gateway.
 * @param ctx - Cordis context.
 * @param config - optional `{ stdioScriptPath }` override for where the
 *   generated bridge script is written.
 */
export async function apply(ctx, config = {}) {
  try {
    ctx.logger.info('acp-gateway: apply entered')
  } catch (e) {
    /* logger optional */
  }
  const webServer = ctx.get('webServer')
  const agents = ctx.agents
  const sessionQueryNow = () => ctx.get('sessionQuery')
  const fsNow2 = () => ctx.get('fs')
  const shellNow2 = () => ctx.get('shell')
  const sandboxPolicyNow = () => ctx.get('sandboxPolicy')
  const toolsNow = () => ctx.get('tools')
  const attachmentsNow = () => ctx.get('attachments')
  const commandsNow = () => ctx.get('commands')
  // Services that can become available after apply (the official web profile
  // activates rows in service order) are read lazily at call time.
  const planModeNow = () => ctx.get('planMode')
  const defaultModelNow = () => ctx.get('agentDefaultModel')
  const llmNow = () => ctx.get('llm')
  const approvalNow = () => ctx.get('approval')
  const agentPresetsNow = () => ctx.get('agentPresets')


  // ---- model selection -------------------------------------------------
  /** The ambient model selection (DSH default model, or gateway config). */
  const modelSelection = () => {
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
  const modelOptionsFor = async (provider) => {
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
  const contextWindowFor = async (provider, model) => {
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
  const agentOptionsFor = (acpSessionId) => {
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
  const sandboxModeFor = (agent) => {
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
  const agentSetup = async (agentCtx) => {
    try {
      // Full tool access + system prompt, same as the Web GUI. In the
      // standalone (isolated) deployment the composition supplies tools
      // directly, so preset mounting is best-effort: when no preset registry
      // is configured (or it lacks `standard`), the agent keeps whatever the
      // composition mounted at the agent scope.
      const agentPresets = agentPresetsNow()
      if (agentPresets) {
        try {
          const presets = await agentPresets.list()
          if (presets.some((p) => p.id === 'standard')) {
            await agentPresets.mount(agentCtx, 'standard')
          }
        } catch (e) {
          ctx.logger.warn(`acp-gateway: preset mount failed: ${String((e && e.message) || e)}`)
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
  }
  const configureAgent = (agent) => {
    try {
      // Auto-approve tool calls: the ACP client is the permission surface.
      const approval = approvalNow()
      if (approval) approval.setPolicy(agent, 'never')
    } catch (e) {
      /* ignore */
    }
  }
  /**
   * Plan-mode controller for one agent: the `standard` preset mounts it in
   * the agent plane (isolate realm), so read it from the agent's own context
   * first, falling back to the host plane (dynamic harness compositions).
   */
  const planModeFor = (agent) => {
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
  const modeStateFor = (agent) => {
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
  const handles = new Map()
  const sessionConfigs = new Map() // acpSessionId -> { modelId?, reasoningEffort? } (client-desired)
  const appliedOptions = new Map() // acpSessionId -> { model?, reasoningEffort? } (agent actually built with)
  const subscribers = new Set()
  const inflightPrompts = new Map()
  const announcedToolCalls = new Set()
  const toolCallArgs = new Map() // callId -> arguments (for diff reconstruction)
  const newSessionId = () => `sess_acp_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`

  // ---- broadcast ---------------------------------------------------------
  const broadcast = (notification) => {
    const json = JSON.stringify(notification)
    for (const sub of subscribers) {
      try {
        sub.send(json)
      } catch (e) {
        /* keep going */
      }
    }
  }
  const subscribe = (send) => {
    const sub = { send }
    subscribers.add(sub)
    return () => subscribers.delete(sub)
  }
  const notifyUpdate = (acpSessionId, update) => {
    broadcast({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: acpSessionId, update } })
  }

  // ---- event -> ACP notification mapping ----------------------------------
  const mapSessionEvent = (acpSessionId, event) => {
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
        const blocks = event.data.message ? event.data.message.content : []
        const resultBlock = blocks.find((b) => b && b.type === 'tool-result')
        const innerBlocks = resultBlock && Array.isArray(resultBlock.content) ? resultBlock.content : []
        const textBlocks = innerBlocks.filter((b) => b && b.type === 'text')
        const callId = String(
          (resultBlock && resultBlock.toolCallId) ||
            (event.data.message && (event.data.message.toolCallId || event.data.message.callId)) ||
            event.data.callId ||
            '',
        )
        const content = []
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
      const reason = event.data.reason
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
  const advertiseCommands = (acpSessionId, agent) => {
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
  const tryRunCommand = async (agent, text) => {
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
  const buildPromptContent = async (acpBlocks) => {
    const content = []
    for (const b of Array.isArray(acpBlocks) ? acpBlocks : []) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text') {
        content.push({ type: 'text', text: b.text })
      } else if (b.type === 'resource' && b.resource && typeof b.resource.text === 'string') {
        content.push({ type: 'text', text: b.resource.text })
      } else if (b.type === 'image' && b.data && attachmentsNow()) {
        try {
          const binary = atob(b.data)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          const ref = await attachments.saveImage({ data: bytes, mediaType: b.mimeType || 'image/png', name: b.uri || undefined })
          content.push({ type: 'image', attachment: ref })
        } catch (e) {
          content.push({ type: 'text', text: `[image attachment failed to load: ${String((e && e.message) || e)}]` })
        }
      } else if (b.type === 'audio' && b.data) {
        // DSH has no native audio block; pass a textual reference.
        content.push({ type: 'text', text: `[audio attachment mimeType=${b.mimeType || 'unknown'} dataLength=${b.data.length}]` })
      }
    }
    return content
  }

  // ---- prompt execution -----------------------------------------------------
  const runPrompt = (handle, acpSessionId, text) =>
    new Promise((resolve, reject) => {
      const agent = handle.agent
      const turn = agent.session.log.filter((e) => e.type === 'turn/end').length + 1
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
  const ensureHostPlanMode = async () => {
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
  const allModelOptions = async () => {
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
  const buildConfigOptionsFor = async (acpSessionId) => {
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
    return buildConfigOptions({
      currentModeId: modeState.currentModeId,
      availableModes: modeState.availableModes,
      modelId: providerId && modelId ? `${providerId}/${modelId}` : null,
      reasoningEffort: effort,
      modelOptions,
      sandboxMode,
    })
  }
  /** Whether the live agent was built with the session's current desired config. */
  const needsRebuild = (acpSessionId) => {
    const cfg = sessionConfigs.get(acpSessionId) || {}
    const applied = appliedOptions.get(acpSessionId) || {}
    const sel = modelSelection() || {}
    const desiredProvider = cfg.providerId || sel.provider || null
    const desiredModel = cfg.modelId || sel.model || null
    const desiredEffort = cfg.reasoningEffort || sel.reasoningEffort || null
    return (
      desiredProvider !== (applied.provider || null) ||
      desiredModel !== (applied.model || null) ||
      desiredEffort !== (applied.reasoningEffort || null)
    )
  }
  const recordApplied = (acpSessionId) => {
    const opts = agentOptionsFor(acpSessionId)
    appliedOptions.set(acpSessionId, {
      provider: opts.provider || null,
      model: opts.model || null,
      reasoningEffort: opts.reasoningEffort || null,
    })
  }
  /**
   * Rebuild the live agent when the session's model/effort config changed since
   * it was created: dispose and resume from the persisted session with the new
   * options. Falls back to the current handle when resume fails.
   */
  const ensureFreshAgent = async (acpSessionId) => {
    const handle = handles.get(acpSessionId)
    if (!handle || !needsRebuild(acpSessionId)) return handle
    try {
      await handle.dispose()
    } catch (e) {
      /* already gone */
    }
    try {
      const fresh = await agents.resume({ resumeSessionId: acpSessionId, agentOptions: agentOptionsFor(acpSessionId), setup: agentSetup })
      handles.set(acpSessionId, fresh)
      recordApplied(acpSessionId)
      configureAgent(fresh.agent)
      advertiseCommands(acpSessionId, fresh.agent)
      return fresh
    } catch (e) {
      ctx.logger.warn(`acp-gateway: config rebuild failed for ${acpSessionId}: ${String((e && e.message) || e)}`)
      return handle
    }
  }

  // ---- session/load history replay -------------------------------------------
  const replayHistory = (acpSessionId, agent) => {
    for (const event of agent.session.log) {
      if (event.type === 'user/message') {
        const text = event.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
        if (text) notifyUpdate(acpSessionId, { sessionUpdate: 'user_message_chunk', messageId: String(event.seq), content: { type: 'text', text } })
      } else if (event.type === 'assistant/message') {
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text) {
            notifyUpdate(acpSessionId, { sessionUpdate: 'agent_message_chunk', messageId: String(event.seq), content: { type: 'text', text: block.text } })
          }
        }
      }
    }
  }

  // ---- protocol dispatch --------------------------------------------------------
  const handleMessage = async (msg) => {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      const id = msg && typeof msg.id !== 'undefined' ? msg.id : null
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } }
    }
    const { id, method, params = {} } = msg
    const hasId = typeof id !== 'undefined'
    const respond = (result) => (hasId ? { jsonrpc: '2.0', id, result } : null)
    const fail = (code, message) => (hasId ? { jsonrpc: '2.0', id, error: { code, message } } : null)
    try {
      switch (method) {
        case 'initialize': {
          return respond({
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true, audio: true, embeddedContext: true },
              sessionCapabilities: { list: {}, delete: {} },
            },
            agentInfo: { name: 'dsh-acp', title: 'DeepSeek Harness ACP Agent', version: '3.8.0' },
            authMethods: [],
          })
        }
        case 'session/new': {
          if (typeof params.cwd !== 'string') return fail(-32602, 'session/new requires params.cwd (absolute path)')
          await ensureHostPlanMode()
          const acpSessionId = newSessionId()
          const handle = await agents.create({
            sessionId: acpSessionId,
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
          if (handles.has(acpSessionId)) {
            const opts = await buildConfigOptionsFor(acpSessionId)
            return respond({ modes: modeStateFor(handles.get(acpSessionId).agent), configOptions: opts })
          }
          try {
            const handle = await agents.resume({ resumeSessionId: acpSessionId, agentOptions: agentOptionsFor(acpSessionId), setup: agentSetup })
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
            .map((b) => (b && b.type === 'text' ? b.text : ''))
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
            if (shell) {
              try {
                const dir = String(params.sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')
                const spec = shell.resolve({ command: `rm -rf "$HOME/.dsh/sessions"/*/"${dir}"` })
                await shell.run(spec)
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
    } catch (e) {
      return fail(typeof e === 'object' && e && e.code ? e.code : -32603, String((e && e.message) || e))
    }
  }

  // ---- web-facing mounts: loopback channel + bridge script ---------------------
  // The official `dsh web` profile activates its webServer service after this
  // plugin's own inject deps are ready, so mount lazily when it appears.
  const mountWeb = async (ws) => {
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
        ctx.logger.warn(`acp-gateway: stdio bridge script write failed: ${String((e && e.message) || e)}`)
      }
    }

    // internal loopback channel (for the stdio bridge only)
    const readBody = (req) =>
      new Promise((resolve) => {
        let data = ''
        req.setEncoding('utf8')
        req.on('data', (c) => {
          data += c
        })
        req.on('end', () => resolve(data))
      })
    const sendJson = (res, obj, status) => {
      res.writeHead(status || 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    ctx.effect(() =>
      ws.register({
        kind: 'exact',
        path: '/acp/rpc',
        async handler(req, res) {
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
              sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32603, message: String((e && e.message) || e) } })
            } catch (e2) {
              /* socket gone */
            }
          }
        },
      }),
    )
    ctx.effect(() =>
      ws.register({
        kind: 'exact',
        path: '/acp/events',
        handler(req, res) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
          res.write(': connected\n\n')
          const off = subscribe((json) => {
            try {
              res.write(`data: ${json}\n\n`)
            } catch (e) {
              /* socket gone */
            }
          })
          req.on('close', off)
        },
      }),
    )
  }
  ctx.inject(['webServer'], (webCtx) => mountWeb(webCtx.webServer))

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
        const record = { steps: [], notifications: [], text: '', stopReason: null }
        const off = subscribe((json) => {
          try {
            record.notifications.push(JSON.parse(json))
          } catch (e) {
            /* skip */
          }
        })
        try {
          const push = async (request) => {
            const response = await handleMessage(request)
            record.steps.push({ request: request.method, id: request.id, response })
            return response
          }
          await push({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-acp-test', version: '3.8.0' } } })
          const cwd = sandboxPolicy && sandboxPolicy.workspaceRoot ? sandboxPolicy.workspaceRoot : '.'
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
    ctx.effect(() => tools.register(tool))
  }

  // ---- release all agents on stop ------------------------------------------------
  ctx.on('dispose', async () => {
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
