/**
 * Pure translation between the DSH harness lifecycle and the ACP v1 wire.
 *
 * @module dsh-acp-gateway/codec
 */
import { Buffer } from 'node:buffer'
import type { StopReason, ToolKind, ToolCallLocation, DiffContent, ConfigOption, ConfigOptionValue } from './types.js'

/**
 * The `thought_level` value that means "leave the provider's own default in
 * place" (no explicit reasoning effort on requests). Mirrors the official
 * `@deepseek-ai/dsh-acp` model-control vocabulary (`""` = provider default).
 */
export const PROVIDER_DEFAULT_REASONING_EFFORT = ''

/**
 * Map a harness turn ending to ACP's terminal stop-reason vocabulary.
 * @param reason - harness turn outcome (`{ kind }`).
 * @returns the closest legal ACP stop reason.
 */
export function turnEndToStopReason(reason: { kind?: string } | undefined): StopReason {
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
export function acpPromptToText(prompt: any[]): string {
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
export function promptHasUnsupportedContent(prompt: any[]): boolean {
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

/** Raster media types DSH attachment stores accept (aligned with dsh-acp). */
export const RASTER_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Canonical RFC 4648 base64 (no whitespace, no URL-safe aliases). */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Decode one canonical base64 payload, or `undefined` when not canonical. */
function decodeBase64(data: string): Uint8Array | undefined {
  if (typeof data !== 'string' || data.length === 0 || !CANONICAL_BASE64.test(data)) return undefined
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) return undefined
  return new Uint8Array(bytes)
}

/**
 * One ACP prompt block already admitted from the wire (or prepared for one).
 * @param type - DSH core content block type (`text` or `image`).
 * @param text - text content when the block is a text block.
 * @param attachment - durable image reference when the block is an image block.
 */
export interface AcpAdmittedBlock {
  type: 'text' | 'image'
  text?: string
  attachment?: unknown
}

/**
 * Injections the gateway provides while admitting one ACP prompt.
 * @param saveImage - persist one decoded raster image through the deployment
 *   attachment store; absent when no store is mounted (image blocks degrade to
 *   textual references instead of failing the prompt).
 * @param readFile - read one local `file://` (or absolute-path) reference to
 *   text, resolving `undefined` when the file is unreadable, binary, too large,
 *   or outside the gateway's file-read policy.
 */
export interface AcpPromptAdmissionDeps {
  saveImage?(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
  readFile?(uri: string): Promise<string | undefined>
}

/**
 * Admit an ACP v1 prompt's blocks into core DSH content. Every block type
 * degrades gracefully instead of being dropped:
 * - `text` passes through verbatim;
 * - `resource` (embedded context) expands its `text`, admits raster `data`
 *   through the attachment store, inlines local `file://` files, and otherwise
 *   becomes an explicit textual reference;
 * - `resource_link` inlines local `file://` files through the injected reader
 *   and otherwise becomes an explicit textual reference (same shape the
 *   baseline `acpPromptToText` uses);
 * - `image` is admitted through the attachment store (canonical base64, raster
 *   media types only), degrading to a textual reference when the store is
 *   absent or admission fails;
 * - `audio` and unknown kinds become textual references so no client content
 *   is silently dropped.
 * @param prompt - ACP prompt blocks in wire order.
 * @param deps - attachment-store and file-reader injections.
 * @returns ordered core content plus the encoded raster images (for slash
 *   commands, which accept `EncodedImageAttachment[]`).
 */
export async function acpPromptToContent(
  prompt: any[],
  deps: AcpPromptAdmissionDeps = {},
): Promise<{ content: AcpAdmittedBlock[]; images: { mediaType: string; data: string; name?: string }[] }> {
  const content: AcpAdmittedBlock[] = []
  const images: { mediaType: string; data: string; name?: string }[] = []
  const pushRef = (text: string) => content.push({ type: 'text', text })
  const refText = (text: string, fallback: string) => (text && text.trim() ? text : fallback)
  const isRaster = (mimeType: string | undefined): mimeType is string =>
    typeof mimeType === 'string' && RASTER_IMAGE_MEDIA_TYPES.includes(mimeType)
  /** Persist one decoded raster image, degrading to a reference on failure. */
  const admitImage = async (
    data: string,
    mimeType: string | undefined,
    name: string | undefined,
    label: string,
  ): Promise<void> => {
    const bytes = decodeBase64(data)
    if (bytes && deps.saveImage && isRaster(mimeType)) {
      try {
        const attachment = await deps.saveImage({ data: bytes, mediaType: mimeType, ...(name ? { name } : {}) })
        images.push({ mediaType: mimeType, data, ...(name ? { name } : {}) })
        content.push({ type: 'image', attachment })
        return
      } catch (e) {
        pushRef(`[image attachment failed to load: ${String((e instanceof Error && e.message) || e)}]`)
        return
      }
    }
    pushRef(
      `[${label} mimeType=${mimeType || 'unknown'} dataLength=${typeof data === 'string' ? data.length : 0}${name ? ` name=${JSON.stringify(name)}` : ''}]`,
    )
  }
  /** Inline one local file reference through the injected reader. */
  const admitLocalFile = async (uri: string, label: string): Promise<boolean> => {
    if (!deps.readFile) return false
    let text: string | undefined
    try {
      text = await deps.readFile(uri)
    } catch (e) {
      text = undefined
    }
    if (text === undefined) return false
    const head = `\n[${label} ${uri}]\n`
    content.push({ type: 'text', text: text.length > 0 ? `${head}${text}\n` : head })
    return true
  }
  for (const b of Array.isArray(prompt) ? prompt : []) {
    if (!b || typeof b !== 'object') continue
    const type = b.type
    if (type === 'text') {
      content.push({ type: 'text', text: refText(b.text, '') })
    } else if (type === 'resource') {
      const r = b.resource && typeof b.resource === 'object' ? b.resource : {}
      if (typeof r.text === 'string') {
        content.push({ type: 'text', text: r.text })
      } else if (typeof r.data === 'string') {
        if (isRaster(r.mimeType)) {
          await admitImage(r.data, r.mimeType, r.name || b.name || r.uri, 'image attachment')
        } else {
          const resName = r.name || b.name
          pushRef(
            `[file attachment mimeType=${r.mimeType || 'unknown'} dataLength=${r.data.length}${resName ? ` name=${JSON.stringify(resName)}` : r.uri ? ` uri=${JSON.stringify(r.uri)}` : ''}]`,
          )
        }
      } else if (typeof r.uri === 'string') {
        if (!(await admitLocalFile(r.uri, 'resource'))) pushRef(`[resource uri=${JSON.stringify(r.uri)}]`)
      } else {
        // Embedded resource with no readable projection: name it, do not drop it.
        pushRef(`[resource${b.name ? ` name=${JSON.stringify(b.name)}` : ''}]`)
      }
    } else if (type === 'resource_link') {
      const uri = typeof b.uri === 'string' ? b.uri : ''
      if (!(await admitLocalFile(uri, 'resource_link'))) {
        pushRef(`\n[resource_link name=${JSON.stringify(b.name ?? null)} uri=${JSON.stringify(uri)}]\n`)
      }
    } else if (type === 'image') {
      await admitImage(b.data, b.mimeType, b.uri, 'image attachment')
    } else if (type === 'audio') {
      // DSH has no native audio block; pass an explicit textual reference.
      pushRef(`[audio attachment mimeType=${b.mimeType || 'unknown'} dataLength=${typeof b.data === 'string' ? b.data.length : 0}]`)
    } else {
      pushRef(`[unsupported content block: ${String(type)}]`)
    }
  }
  return { content, images }
}

/**
 * Infer an ACP ToolKind from a DSH tool name.
 * @param name - DSH tool name (bash, read, edit, web_fetch, ...).
 * @returns the ACP tool kind.
 */
export function toolKind(name: string | undefined): ToolKind {
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
export function locationFromArgs(args: any): ToolCallLocation | undefined {
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
function parseArgs(args: any): any {
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
export function toolTitle(name: string | undefined, args: any): string {
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
export function diffFromArgs(name: string | undefined, args: any): DiffContent | undefined {
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
export interface NeverSignal {
  readonly aborted: boolean
  addEventListener(type: string, listener: (event?: any) => void): void
  removeEventListener(type: string, listener: (event?: any) => void): void
  _abort(): void
}

export function makeNeverSignal(): NeverSignal {
  const listeners = new Set<(event?: any) => void>()
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
 * Build the ACP session-mode state from the agent-preset roster.
 *
 * DSH's own "modes" are its agent presets (the web GUI's Standard / Code /
 * Minimal / Creator modes): a session's mode is the preset its agent was
 * composed from, and switching mode re-composes the agent. Plan mode is not
 * a session mode — it is a per-agent toggle driven through the `/plan` slash
 * command, exactly like the web GUI's Plan chip.
 * @param currentModeId - the session's current preset id.
 * @param presets - the roster rows (`{ id, name?, description? }`); when the
 *   registry is absent the caller passes an empty list and a single
 *   `standard` fallback mode is advertised (the gateway's default preset).
 * @returns the ACP SessionModeState.
 */
export interface SessionModeState {
  currentModeId: string
  availableModes: { id: string; name: string; description: string }[]
}

export function sessionModeState(
  currentModeId: string,
  presets: { id: string; name?: string; description?: string }[],
): SessionModeState {
  const rows = presets.length > 0 ? presets : [{ id: 'standard' }]
  return {
    currentModeId: rows.some((p) => p.id === currentModeId) ? currentModeId : rows[0].id,
    availableModes: rows.map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      description: p.description ?? '',
    })),
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
export function buildBridgeScript(endpoint: string): string {
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
export interface ConfigOptionsInput {
  currentModeId: string
  availableModes: { id: string; name: string; description: string }[]
  modelId?: string | null
  reasoningEffort?: string | null
  modelOptions?: ConfigOptionValue[]
  effortOptions?: ConfigOptionValue[]
  sandboxMode?: string | null
}

export function buildConfigOptions(input: ConfigOptionsInput): ConfigOption[] {
  const {
    currentModeId,
    availableModes,
    modelId,
    reasoningEffort,
    modelOptions = [],
    effortOptions = [],
    sandboxMode,
  } = input
  const options: ConfigOption[] = [
    {
      id: 'mode',
      name: 'Session Mode',
      description: 'The agent preset this session runs (Standard / Code / Minimal / Creator / custom)',
      category: 'mode',
      type: 'select',
      currentValue: currentModeId,
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
  if (reasoningEffort || effortOptions.length > 0) {
    options.push({
      id: 'thought_level',
      name: 'Thought Level',
      description: 'Reasoning effort for this session',
      category: 'thought_level',
      type: 'select',
      currentValue: reasoningEffort ?? PROVIDER_DEFAULT_REASONING_EFFORT,
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

/**
 * Parse a plan-mode markdown document into ACP plan entries. Every heading
 * (`#`, `##`, ...) or list item (`- `) line becomes one entry.
 * @param markdown - the `exit_plan_mode` plan text.
 * @returns plan entries (never empty when the text is non-empty).
 */
export function planMarkdownToEntries(markdown: string): { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }[] {
  const entries: { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }[] = []
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.trim()
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    const item = line.match(/^[-*]\s+(.*)$/)
    if (heading) {
      entries.push({ content: heading[1], priority: 'high', status: 'pending' })
    } else if (item) {
      entries.push({ content: item[1], priority: 'medium', status: 'pending' })
    }
  }
  return entries
}
