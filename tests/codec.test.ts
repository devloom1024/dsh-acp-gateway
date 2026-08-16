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
} from '../src/codec.js'
import { buildBridgeScript } from '../src/codec.js'

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
