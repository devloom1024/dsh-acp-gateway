/**
 * Pure translation between the DSH harness lifecycle and the ACP v1 wire.
 *
 * @module dsh-acp-gateway/codec
 */

/**
 * Map a harness turn ending to ACP's terminal stop-reason vocabulary.
 * @param reason - harness turn outcome (`{ kind }`).
 * @returns the closest legal ACP stop reason.
 */
export function turnEndToStopReason(reason) {
  switch (reason && reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    // `cancelled` is reserved for explicit client cancellation (session/cancel)
    // and disposal; a turn aborted by a hook or another owner is ordinary
    // quiescence and reports `end_turn`.
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

/**
 * Flatten an ACP prompt's baseline blocks to text. Text blocks concatenate
 * verbatim; embedded resources become their text content; resource links
 * become explicit textual references so a baseline client can point at files
 * without the bridge silently dropping that context.
 * @param prompt - supported ACP prompt blocks.
 * @returns text in wire order.
 */
export function acpPromptToText(prompt) {
  return (Array.isArray(prompt) ? prompt : [])
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      switch (block.type) {
        case 'text':
          return block.text
        case 'resource':
          return block.resource && typeof block.resource.text === 'string' ? block.resource.text : ''
        case 'resource_link':
          return `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`
        default:
          return ''
      }
    })
    .join('')
}

/**
 * Whether a prompt carries content beyond what this agent supports.
 * Supported: text, resource (embedded context), resource_link, image, audio.
 * Unsupported: anything else (future content kinds fail closed).
 * @param prompt - ACP prompt blocks to inspect.
 * @returns `true` when any block is unsupported.
 */
export function promptHasUnsupportedContent(prompt) {
  return (Array.isArray(prompt) ? prompt : []).some(
    (block) =>
      block &&
      typeof block === 'object' &&
      block.type !== 'text' &&
      block.type !== 'resource' &&
      block.type !== 'resource_link' &&
      block.type !== 'image' &&
      block.type !== 'audio',
  )
}

/**
 * Infer an ACP ToolKind from a DSH tool name.
 * @param name - DSH tool name (bash, read, edit, web_fetch, ...).
 * @returns the ACP tool kind.
 */
export function toolKind(name) {
  const n = String(name || '').toLowerCase()
  if (n.includes('todo') || n.includes('goal') || n.includes('subagent') || n.includes('workflow') || n.includes('skill')) return 'other'
  if (n.includes('bash') || n.includes('shell') || n.includes('pwsh') || n.includes('code') || n.includes('run') || n === 'execute') return 'execute'
  if (n.includes('glob') || n.includes('grep') || n.includes('search') || n.includes('find') || n.includes('lsp')) return 'search'
  if (n.includes('read') || n.includes('view') || n.includes('cat')) return 'read'
  if (n.includes('move') || n.includes('rename')) return 'move'
  if (n.includes('delete') || n.includes('remove')) return 'delete'
  if (n.includes('edit') || n.includes('write') || n.includes('replace') || n.includes('patch')) return 'edit'
  if (n.includes('web') || n.includes('fetch') || n.includes('http')) return 'fetch'
  if (n.includes('think') || n.includes('plan')) return 'think'
  return 'other'
}

/**
 * Extract a tool-call location (file the tool accesses) from its arguments.
 * @param args - tool call arguments (object or JSON string).
 * @returns an ACP ToolCallLocation, or undefined when no file path is present.
 */
export function locationFromArgs(args) {
  let a = args
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a)
    } catch (e) {
      return undefined
    }
  }
  if (!a || typeof a !== 'object') return undefined
  const path =
    a.path ||
    a.filePath ||
    a.file_path ||
    a.file ||
    a.filename ||
    (a.target && typeof a.target === 'object' ? a.target.path || a.target.filePath : undefined) ||
    (Array.isArray(a.files) && typeof a.files[0] === 'string' ? a.files[0] : undefined)
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined
  const line =
    (typeof a.line === 'number' && a.line >= 0 ? a.line : undefined) ??
    (a.range && typeof a.range.start === 'number' ? a.range.start : undefined) ??
    (typeof a.startLine === 'number' && a.startLine >= 0 ? a.startLine : undefined) ??
    (typeof a.start === 'number' && a.start >= 0 ? a.start : undefined)
  return line === undefined ? { path } : { path, line }
}

/** Parse tool arguments (object or JSON string). */
function parseArgs(args) {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args)
    } catch (e) {
      return undefined
    }
  }
  return args && typeof args === 'object' ? args : undefined
}

/**
 * Human-readable tool title per the spec ("describing what the tool is doing").
 * Falls back to the raw tool name.
 */
export function toolTitle(name, args) {
  const n = String(name || '').toLowerCase()
  const a = parseArgs(args)
  const path = a && (typeof a.path === 'string' ? a.path : typeof a.file_path === 'string' ? a.file_path : undefined)
  if (n.includes('bash') || n.includes('shell') || n.includes('pwsh') || n === 'run_code' || (n.includes('code') && n.includes('run'))) {
    const cmd = a && typeof a.command === 'string' ? a.command.slice(0, 60) : undefined
    return cmd ? `Running: ${cmd}` : 'Running command'
  }
  if (path) {
    const cmd = a && a.command
    if (n.includes('str-replace') || n.includes('replace') || n.includes('edit') || n.includes('write')) {
      if (cmd === 'create') return `Creating: ${path}`
      if (cmd === 'insert') return `Inserting into: ${path}`
      return `Editing: ${path}`
    }
    if (n.includes('read') || n.includes('view') || n.includes('cat')) return `Reading: ${path}`
    if (n.includes('glob') || n.includes('grep') || n.includes('search') || n.includes('find')) {
      const pat = a && (a.pattern || a.query || a.q)
      return pat ? `Searching: ${String(pat).slice(0, 60)}` : `Searching: ${path}`
    }
    if (n.includes('move') || n.includes('rename')) return `Moving: ${path}`
    if (n.includes('delete') || n.includes('remove')) return `Deleting: ${path}`
    return `${name}: ${path}`
  }
  if (n.includes('web') || n.includes('fetch') || n.includes('http')) {
    const url = a && (a.url || a.uri)
    return url ? `Fetching: ${url}` : 'Fetching URL'
  }
  return String(name || 'tool')
}

/**
 * Reconstruct an ACP diff block from edit-tool arguments. DSH events carry
 * only the result text; the diff itself is derivable from the call arguments
 * (`str_replace` → old_str/new_str, `create` → file_text).
 * @returns a `{ type: 'diff', path, oldText, newText }` block, or undefined.
 */
export function diffFromArgs(name, args) {
  const n = String(name || '').toLowerCase()
  const a = parseArgs(args)
  if (!a) return undefined
  const path = a.path || a.file_path
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined
  const cmd = a.command
  // `edit` (dsh-tool-fs): file_path + old_string/new_string literal replacement.
  if (n.includes('edit') || n.includes('write')) {
    if (typeof a.old_string === 'string' || typeof a.new_string === 'string') {
      return {
        type: 'diff',
        path,
        oldText: a.old_string ?? null,
        newText: a.new_string ?? '',
      }
    }
  }
  // `str_replace_editor`: command str_replace/create with old_str/new_str/file_text.
  if (cmd === 'str_replace' || n.includes('str-replace')) {
    return {
      type: 'diff',
      path,
      oldText: a.old_str ?? a.oldString ?? null,
      newText: a.new_str ?? a.newString ?? '',
    }
  }
  if (cmd === 'create') {
    return { type: 'diff', path, oldText: null, newText: a.file_text ?? a.content ?? '' }
  }
  return undefined
}

/**
 * Create a minimal AbortSignal-compatible object. The dynamic sandbox has no
 * AbortController; commands.execute and other harness APIs only need
 * `aborted`, `addEventListener`, and `removeEventListener`.
 * @returns a mock signal that never aborts.
 */
export function makeNeverSignal() {
  const listeners = new Set()
  return {
    get aborted() {
      return false
    },
    addEventListener(type, fn) {
      if (type === 'abort') listeners.add(fn)
    },
    removeEventListener(type, fn) {
      if (type === 'abort') listeners.delete(fn)
    },
    _abort() {
      for (const fn of listeners) {
        try {
          fn()
        } catch (e) {
          /* ignore listener failures */
        }
      }
    },
  }
}

/**
 * Build the ACP session-mode state from DSH plan-mode state.
 * @param planActive - whether DSH plan mode is currently active.
 * @returns the ACP SessionModeState.
 */
export function sessionModeState(planActive) {
  return {
    currentModeId: planActive ? 'plan' : 'code',
    availableModes: [
      { id: 'code', name: 'Code', description: 'Full tool access for implementation' },
      { id: 'plan', name: 'Plan', description: 'Design and plan without implementation' },
    ],
  }
}

/**
 * Build the stdio bridge script source for a given loopback endpoint.
 * The bridge is a standalone Node process: it reads newline-delimited
 * JSON-RPC from stdin, forwards each request to the plugin's loopback
 * channel, and writes responses plus `session/update` notifications
 * (single-line JSON) to stdout. Logs go to stderr only.
 * @param endpoint - loopback base URL, e.g. `http://127.0.0.1:3080`.
 * @returns the bridge script text.
 */
/**
 * See index.js for usage notes.
 */
export function buildBridgeScript(endpoint) {
  return [
    '#!/usr/bin/env node',
    '// DSH ACP stdio bridge - launch this file as an ACP agent from your editor (Zed, VS Code ACP, ...).',
    '// Reads newline-delimited JSON-RPC from stdin, forwards to the DSH ACP loopback endpoint,',
    '// writes responses and session/update notifications (single-line JSON) to stdout.',
    '// Logs go to stderr only.',
    "const http = require('node:http')",
    "const readline = require('node:readline')",
    "const ENDPOINT = process.env.DSH_ACP_URL || " + JSON.stringify(endpoint),
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    'const post = (body) => new Promise((resolve, reject) => {',
    "  const req = http.request(ENDPOINT + '/acp/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {",
    "    let data = ''",
    "    res.setEncoding('utf8')",
    "    res.on('data', (c) => { data += c })",
    "    res.on('end', () => resolve(data))",
    '  })',
    "  req.on('error', reject)",
    '  req.end(body)',
    '})',
    '// Subscribe to Agent -> Client notifications (SSE) and forward each as one stdout line.',
    'const subscribeEvents = () => {',
    "  const req = http.get(ENDPOINT + '/acp/events', (res) => {",
    "    res.setEncoding('utf8')",
    "    let buf = ''",
    "    res.on('data', (c) => {",
    "      buf += c",
    "      let idx",
    "      while ((idx = buf.indexOf('\\n\\n')) !== -1) {",
    "        const frame = buf.slice(0, idx)",
    "        buf = buf.slice(idx + 2)",
    "        for (const line of frame.split('\\n')) {",
    "          if (line.startsWith('data: ')) { try { process.stdout.write(line.slice(6) + '\\n') } catch (e) {} }",
    '        }',
    '      }',
    '    })',
    "    res.on('end', () => setTimeout(subscribeEvents, 1000))",
    "    res.on('error', () => setTimeout(subscribeEvents, 1000))",
    '  })',
    "  req.on('error', () => setTimeout(subscribeEvents, 1000))",
    '}',
    'subscribeEvents()',
    "rl.on('line', async (line) => {",
    '  const trimmed = line.trim()',
    '  if (!trimmed) return',
    '  try {',
    '    const response = await post(trimmed)',
    "    if (response) process.stdout.write(response + '\\n')",
    '  } catch (e) {',
    "    process.stderr.write('bridge error: ' + String((e && e.message) || e) + '\\n')",
    '  }',
    '})',
    "rl.on('close', () => process.exit(0))",
    '',
  ].join('\n')
}

/**
 * Build the ACP session config options list.
 *
 * ACP v1 Session Config Options let the client pick the session mode
 * (permission model), the model, and the thought/reasoning level via
 * `session/set_config_option`. Select options only, matching the category
 * vocabulary: `mode`, `model`, `thought_level`.
 * @param input - current state (mode id, available modes, model id, reasoning
 *   effort, model options, effort options).
 * @returns the configOptions array (never empty: `mode` is always present).
 */
export function buildConfigOptions(input) {
  const {
    currentModeId,
    availableModes,
    modelId,
    reasoningEffort,
    modelOptions = [],
    effortOptions = [],
    sandboxMode,
  } = input
  const options = [
    {
      id: 'mode',
      name: 'Session Mode',
      description: 'Controls how the agent requests permission',
      category: 'mode',
      type: 'select',
      currentValue: currentModeId || 'code',
      options: availableModes.map((m) => ({ value: m.id, name: m.name, description: m.description })),
    },
  ]
  if (modelId) {
    options.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: modelId,
      options: modelOptions.length > 0 ? modelOptions : [],
    })
  }
  if (reasoningEffort) {
    options.push({
      id: 'thought_level',
      name: 'Thought Level',
      description: 'Reasoning effort for this session',
      category: 'thought_level',
      type: 'select',
      currentValue: reasoningEffort,
      options:
        effortOptions.length > 0
          ? effortOptions
          : ['minimal', 'low', 'medium', 'high', 'max'].map((v) => ({ value: v, name: v })),
    })
  }
  if (sandboxMode) {
    const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access']
    options.push({
      id: 'permission',
      name: 'Permission',
      description: 'Sandbox file access level for this session',
      category: '_permission',
      type: 'select',
      currentValue: sandboxMode,
      options: PERMISSION_MODES.map((v) => ({
        value: v,
        name: v,
        description:
          v === 'read-only'
            ? 'Read-only file access'
            : v === 'workspace-write'
              ? 'Write inside the workspace'
              : 'Full file access without approval prompts',
      })),
    })
  }
  return options
}
