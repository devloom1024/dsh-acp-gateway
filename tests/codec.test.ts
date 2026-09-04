import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  turnEndToStopReason,
  acpPromptToText,
  promptHasUnsupportedContent,
  toolKind,
  makeNeverSignal,
  sessionModeState,
  buildConfigOptions,
  acpPromptToContent,
  PROVIDER_DEFAULT_REASONING_EFFORT,
} from '../src/codec.js'
import { buildBridgeScript } from '../src/codec.js'

// 1x1 transparent GIF: R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==
const GIF_PNG = 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='

test('turnEndToStopReason maps harness reasons to ACP stop reasons', () => {
  assert.equal(turnEndToStopReason({ kind: 'completed' }), 'end_turn')
  assert.equal(turnEndToStopReason({ kind: 'max-tokens' }), 'max_tokens')
  assert.equal(turnEndToStopReason({ kind: 'aborted' }), 'end_turn')
  assert.equal(turnEndToStopReason({ kind: 'interrupted' }), 'cancelled')
  assert.equal(turnEndToStopReason({ kind: 'blocked' }), 'end_turn')
  assert.equal(turnEndToStopReason({ kind: 'error' }), 'end_turn')
  assert.equal(turnEndToStopReason(undefined), 'end_turn')
})

test('acpPromptToText concatenates text and expands resources', () => {
  const text = acpPromptToText([
    { type: 'text', text: 'Hello ' },
    { type: 'resource', resource: { uri: 'file:///tmp/a.py', text: 'print(1)' } },
    { type: 'resource_link', name: 'readme', uri: 'file:///tmp/README.md' },
  ])
  assert.ok(text.includes('Hello print(1)'))
  assert.ok(text.includes('[resource_link name="readme" uri="file:///tmp/README.md"]'))
})

test('promptHasUnsupportedContent rejects unknown kinds but accepts supported ones', () => {
  assert.equal(promptHasUnsupportedContent([{ type: 'text', text: 'x' }]), false)
  assert.equal(promptHasUnsupportedContent([{ type: 'image', data: 'a', mimeType: 'image/png' }]), false)
  assert.equal(promptHasUnsupportedContent([{ type: 'audio', data: 'a' }]), false)
  assert.equal(promptHasUnsupportedContent([{ type: 'resource', resource: {} }]), false)
  assert.equal(promptHasUnsupportedContent([{ type: 'video', data: 'a' }]), true)
})

test('toolKind infers ACP kinds from DSH tool names', () => {
  assert.equal(toolKind('bash'), 'execute')
  assert.equal(toolKind('read'), 'read')
  assert.equal(toolKind('edit'), 'edit')
  assert.equal(toolKind('web_fetch'), 'fetch')
  assert.equal(toolKind('todo_write'), 'other')
})

test('makeNeverSignal provides the AbortSignal surface without aborting', () => {
  const sig = makeNeverSignal()
  assert.equal(sig.aborted, false)
  let called = false
  sig.addEventListener('abort', () => {
    called = true
  })
  assert.equal(called, false)
})

test('sessionModeState builds preset modes', () => {
  const presets = [
    { id: 'anchored-standard', name: 'Anchored Standard (experimental)', description: 'bootstrap' },
    { id: 'standard', name: 'Standard mode' },
    { id: 'minimal', name: 'Minimal mode' },
  ]
  const state = sessionModeState('anchored-standard', presets)
  assert.equal(state.currentModeId, 'anchored-standard')
  assert.deepEqual(state.availableModes.map((m) => m.id), ['anchored-standard', 'standard', 'minimal'])
  assert.equal(state.availableModes[0].name, 'Anchored Standard (experimental)')
  // An unknown current id falls back to the first advertised mode.
  assert.equal(sessionModeState('nope', presets).currentModeId, 'anchored-standard')
  // No registry: single `standard` fallback mode.
  const fallback = sessionModeState('standard', [])
  assert.equal(fallback.currentModeId, 'standard')
  assert.deepEqual(fallback.availableModes.map((m) => m.id), ['standard'])
})

test('acpPromptToContent admits text, images, files, and references in wire order', async () => {
  const saved: any[] = []
  const saveImage = async (input: any) => {
    saved.push(input)
    return { attachmentId: `att_${saved.length}` }
  }
  // text + raster image + resource text + audio → ordered core content.
  const admitted = await acpPromptToContent(
    [
      { type: 'text', text: 'Look at ' },
      { type: 'image', data: GIF_PNG, mimeType: 'image/gif', uri: 'pixel.gif' },
      { type: 'resource', resource: { uri: 'file:///tmp/a.py', text: 'print(1)' } },
      { type: 'audio', data: 'AA==', mimeType: 'audio/wav' },
    ],
    { saveImage },
  )
  assert.deepEqual(
    admitted.content.map((b) => b.type),
    ['text', 'image', 'text', 'text'],
  )
  assert.equal(admitted.content[0].text, 'Look at ')
  assert.deepEqual((admitted.content[1] as any).attachment, { attachmentId: 'att_1' })
  assert.equal(admitted.content[2].text, 'print(1)')
  assert.ok((admitted.content[3].text as string).includes('audio attachment mimeType=audio/wav'))
  assert.deepEqual(admitted.images, [{ mediaType: 'image/gif', data: GIF_PNG, name: 'pixel.gif' }])
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/gif')
})

test('acpPromptToContent inlines local files and degrades unreadable references', async () => {
  const readFile = async (uri: string): Promise<string | undefined> => {
    if (uri === 'file:///tmp/note.txt') return 'hello file'
    return undefined
  }
  // file:// resource_link that resolves → raw file content with a header line.
  const linked = await acpPromptToContent([{ type: 'resource_link', name: 'note', uri: 'file:///tmp/note.txt' }], { readFile })
  assert.equal(linked.content.length, 1)
  assert.ok((linked.content[0].text as string).includes('hello file'))
  assert.ok((linked.content[0].text as string).includes('[resource_link file:///tmp/note.txt]'))
  // Unreadable resource_link → explicit textual reference (never dropped).
  const dropped = await acpPromptToContent([{ type: 'resource_link', name: 'readme', uri: 'file:///nope.md' }], { readFile })
  assert.deepEqual(dropped.content, [
    { type: 'text', text: '\n[resource_link name="readme" uri="file:///nope.md"]\n' },
  ])
  // resource with file uri that resolves → content inlined.
  const resource = await acpPromptToContent([{ type: 'resource', resource: { uri: 'file:///tmp/note.txt' } }], { readFile })
  assert.ok((resource.content[0].text as string).includes('hello file'))
})

test('acpPromptToContent degrades images without dropping them', async () => {
  // Non-raster mimeType and non-canonical base64 degrade to references.
  const nosave = await acpPromptToContent(
    [
      { type: 'image', data: GIF_PNG, mimeType: 'image/svg+xml' },
      { type: 'image', data: 'not!base64', mimeType: 'image/png' },
    ],
    { saveImage: async () => ({}) },
  )
  assert.equal(nosave.content.length, 2)
  assert.ok((nosave.content[0].text as string).includes('mimeType=image/svg+xml'))
  assert.ok((nosave.content[1].text as string).includes('dataLength=10'))
  // Without a store, a valid raster image still surfaces as a reference.
  const nostore = await acpPromptToContent([{ type: 'image', data: GIF_PNG, mimeType: 'image/png' }])
  assert.equal(nostore.content.length, 1)
  assert.ok((nostore.content[0].text as string).includes('image attachment'))
  // A store failure degrades to a failure reference, not a crash.
  const failing = await acpPromptToContent([{ type: 'image', data: GIF_PNG, mimeType: 'image/png' }], {
    saveImage: async () => {
      throw new Error('disk full')
    },
  })
  assert.equal(failing.content.length, 1)
  assert.ok((failing.content[0].text as string).includes('failed to load: disk full'))
  // resource with binary non-raster data becomes a file reference.
  const bin = await acpPromptToContent([{ type: 'resource', name: 'x.pdf', resource: { uri: 'file:///x.pdf', data: 'AAEC', mimeType: 'application/pdf' } }], {
    saveImage: async () => ({}) as any,
  })
  assert.equal(bin.content.length, 1)
  assert.ok((bin.content[0].text as string).includes('file attachment mimeType=application/pdf'))
  assert.ok((bin.content[0].text as string).includes('name="x.pdf"'))
  // resource with raster data admits as an image.
  const raster = await acpPromptToContent([{ type: 'resource', resource: { uri: 'x.png', data: GIF_PNG, mimeType: 'image/gif' } }], {
    saveImage: async (input) => ({ attachmentId: `r_${(input.data as Uint8Array).length}` }) as any,
  })
  assert.deepEqual(
    raster.content.map((b) => b.type),
    ['image'],
  )
  // Unknown block kinds surface as references instead of being dropped.
  const unknown = await acpPromptToContent([{ type: 'video', data: 'x' }])
  assert.ok((unknown.content[0].text as string).includes('unsupported content block: video'))
})

test('buildConfigOptions always offers thought_level once effort options exist', () => {
  const modes = [{ id: 'standard', name: 'Standard mode', description: '' }]
  const effortOptions = [
    { value: PROVIDER_DEFAULT_REASONING_EFFORT, name: 'Provider default' },
    { value: 'high', name: 'High' },
    { value: 'low', name: 'Low' },
  ]
  // No effort chosen yet, but the route declares efforts → option present with
  // "Provider default" as the current value and the adapter's exact vocabulary.
  const options = buildConfigOptions({ currentModeId: 'standard', availableModes: modes, modelId: 'p/m', effortOptions })
  const effort = options.find((o) => o.id === 'thought_level')!
  assert.equal(effort.currentValue, PROVIDER_DEFAULT_REASONING_EFFORT)
  assert.deepEqual(
    effort.options!.map((o) => o.value),
    [PROVIDER_DEFAULT_REASONING_EFFORT, 'high', 'low'],
  )
  // A chosen explicit effort wins as the current value.
  const chosen = buildConfigOptions({
    currentModeId: 'standard',
    availableModes: modes,
    modelId: 'p/m',
    reasoningEffort: 'high',
    effortOptions,
  })
  assert.equal(chosen.find((o) => o.id === 'thought_level')!.currentValue, 'high')
  // Without effort options and without an effort, no thought_level option.
  const bare = buildConfigOptions({ currentModeId: 'standard', availableModes: modes })
  assert.equal(bare.find((o) => o.id === 'thought_level'), undefined)
})

test('buildConfigOptions carries the actual current state into every option', () => {
  const modes = [
    { id: 'standard', name: 'Standard mode', description: '' },
    { id: 'minimal', name: 'Minimal mode', description: '' },
  ]
  const options = buildConfigOptions({
    currentModeId: 'minimal',
    availableModes: modes,
    modelId: 'opencode-go/deepseek-v4-flash',
    reasoningEffort: 'high',
    modelOptions: [{ value: 'opencode-go/deepseek-v4-flash', name: 'deepseek-v4-flash' }],
    sandboxMode: 'workspace-write',
  })
  assert.deepEqual(
    options.map((o) => o.id),
    ['mode', 'model', 'thought_level', 'permission'],
  )
  const mode = options.find((o) => o.id === 'mode')!
  assert.equal(mode.currentValue, 'minimal')
  assert.deepEqual(mode.options!.map((o) => o.value), ['standard', 'minimal'])
  const model = options.find((o) => o.id === 'model')!
  assert.equal(model.currentValue, 'opencode-go/deepseek-v4-flash')
  const effort = options.find((o) => o.id === 'thought_level')!
  assert.equal(effort.currentValue, 'high')
  assert.deepEqual(effort.options!.map((o) => o.value), ['minimal', 'low', 'medium', 'high', 'max'])
  const permission = options.find((o) => o.id === 'permission')!
  assert.equal(permission.currentValue, 'workspace-write')
  // A session without a model route or effort exposes only the mode option.
  const bare = buildConfigOptions({ currentModeId: 'standard', availableModes: modes })
  assert.deepEqual(
    bare.map((o) => o.id),
    ['mode'],
  )
})

test('buildBridgeScript embeds the endpoint and generates a parseable script', () => {
  const script = buildBridgeScript('http://127.0.0.1:3999')
  assert.ok(script.startsWith('#!/usr/bin/env node'))
  assert.ok(script.includes('"http://127.0.0.1:3999"'))
  // The script must not contain raw newlines inside JSON writes: verify the
  // emitted SSE frame writer uses escaped newlines.
  assert.ok(script.includes("line.slice(6) + '\\n'"))
  // Validate the generated script parses with node.
  const dir = mkdtempSync(join(tmpdir(), 'acp-bridge-'))
  const file = join(dir, 'bridge.js')
  writeFileSync(file, script)
  try {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
