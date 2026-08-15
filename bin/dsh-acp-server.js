#!/usr/bin/env node
/**
 * DSH ACP Gateway — one-command isolated ACP server.
 *
 * Boots a private DSH instance (its own home, config, persistence, and an
 * OS-assigned loopback port) that exposes the dsh-acp-gateway plugin, and
 * serves the ACP protocol directly over this process's stdio. Nothing in the
 * user's existing DSH deployment is touched:
 *
 *   - DSH_HOME → $HOME/.dsh-acp (isolated credentials/settings/sessions)
 *   - webServer → 127.0.0.1:0 (OS-assigned random loopback port)
 *
 * The composition is the official `dsh-base` bundle (the same agent stack a
 * `dsh web` profile mounts: LLM runtime, credentials, tools, agent registry,
 * commands, plan mode, ...) plus a loopback-only webServer and the ACP
 * gateway. The model provider is `deepseek-official` (DeepSeek official API);
 * set `DEEPSEEK_API_KEY` (or use `--provider`/`--model` flags).
 *
 * Usage:
 *   dsh-acp-server
 *
 * Stdout is reserved for ACP JSON-RPC; all diagnostics go to stderr.
 */
import { parseArgs } from 'node:util'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { boot, healProfilesModuleFallback, installFailLoud, loadEnv, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { attachBridge } from '../src/bridge.js'

const NAME = 'dsh-acp-server'
const here = dirname(fileURLToPath(import.meta.url))
const EMPTY_CONFIG = join(here, '..', 'examples', 'empty.cordis.yml')

installFailLoud(NAME)
loadEnv(NAME)

// Isolated home: never touch the user's real ~/.dsh.
const acpHome = process.env.DSH_ACP_HOME || join(homedir(), '.dsh-acp')
mkdirSync(acpHome, { recursive: true })
process.env.DSH_HOME = acpHome
if (!process.env.DSH_ACP_HOME) process.env.DSH_ACP_HOME = acpHome

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    provider: { type: 'string', default: process.env.DSH_ACP_PROVIDER || 'opencode-go' },
    model: { type: 'string', default: process.env.DSH_ACP_MODEL || 'deepseek-v4-flash' },
  },
  strict: true,
})

/** Resolve one npm package to its directory, mirroring Node's parent-walk. */
function resolvePackageDir(specifier) {
  const resolved = import.meta.resolve(specifier + '/package.json')
  return dirname(fileURLToPath(resolved))
}

/**
 * The dsh app installation anchor (its package.json). The typical layout has
 * dsh-app-boot nested under the dsh app's own node_modules: ascend three
 * levels to the dsh package root and verify its name. A flat installation
 * has no resolvable `@deepseek-ai/dsh` (its exports gate subpaths), so the
 * anchor is then simply unavailable and the server exits with a hint.
 */
function dshInstallAnchor() {
  const appBootDir = resolvePackageDir('@deepseek-ai/dsh-app-boot')
  const candidate = join(appBootDir, '..', '..', '..', 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
    if (manifest.name === '@deepseek-ai/dsh') return candidate
  } catch (e) {
    /* not the dsh app */
  }
  return null
}

/**
 * The official dsh-base bundle patch — the complete agent stack (LLM,
 * credentials, session store, tools, agent registry, commands, plan mode,
 * subagents, ...). Loaded from the same package the user's `dsh` installs.
 */
const baseDir = resolvePackageDir('@deepseek-ai/dsh-base')
const baseManifest = JSON.parse(readFileSync(join(baseDir, 'package.json'), 'utf8'))
const basePatchPath = join(baseDir, baseManifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')

/**
 * Agent presets (the `standard` preset the gateway mounts per agent) live
 * beside the dsh installation. The dsh-app-boot package sits under the dsh
 * install's node_modules in the typical (npx) layout; when that layout is
 * absent the preset row is simply not configured and agents keep the
 * composition's tool surface.
 */
function shippedPresetRoot() {
  try {
    const appBootDir = resolvePackageDir('@deepseek-ai/dsh-app-boot')
    const candidate = join(dirname(dirname(appBootDir)), 'config', 'agent-presets')
    return readFileSync(join(candidate, 'standard', 'preset.yml'), 'utf8') ? candidate : null
  } catch (e) {
    return null
  }
}

// Boot with the empty composition patched by: the official dsh-base bundle
// (unchanged), then our overlays (HMR off, loopback webServer, agent presets
// root, provider route for the isolated home, and the ACP gateway). Stdout
// stays pure for ACP JSON-RPC.
const presetRoot = shippedPresetRoot()
const provider = values.provider
// The isolated home has no settings document, so a pi-ai provider route is
// declared directly on the adapter row. `deepseek-official` is the dedicated
// llm-deepseek adapter (DEEPSEEK_API_KEY) and needs no pi-ai route.
const apiKeyEnv = provider === 'deepseek-official' ? 'DEEPSEEK_API_KEY' : `${provider.replace(/-/g, '_').toUpperCase()}_API_KEY`
const patches = [
  ...loadOverlayPatches(NAME, basePatchPath),
  { id: 'hmr', disabled: true },
  // The isolated home has no settings document, so the default model row
  // (bundle default: deepseek-official) must match the requested provider.
  { id: 'agent-default-model', config: { provider, model: values.model } },
  ...(provider === 'deepseek-official'
    ? []
    : [{ id: 'llm-pi-ai', config: { providers: { [provider]: { apiKeyEnv } } } }]),
  {
    insert: [
      { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
      ...(presetRoot
        ? [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: { roots: [{ path: presetRoot, trust: 'system' }] } }]
        : []),
      {
        id: 'acp-gateway',
        name: '../src/index.js',
        config: {
          provider,
          model: values.model,
          stdioScriptPath: join(acpHome, 'dsh-acp-agent.js'),
        },
      },
    ],
  },
]

// Bare package resolution: the official dsh CLI keeps one flat symlink
// directory per home ($DSH_HOME/profiles/node_modules) that mirrors every
// package the dsh app and its bundles depend on. Recreate it inside the
// isolated home and hand it to the loader as the bare-module base, exactly
// like `dsh --profile web` does.
const anchor = dshInstallAnchor()
if (anchor === null) {
  process.stderr.write(`${NAME}: cannot locate the @deepseek-ai/dsh installation (needed for the dsh-base bundle and its dependencies)\n`)
  process.exit(1)
}
healProfilesModuleFallback(anchor, acpHome)
const bareModuleBaseUrl = pathToFileURL(join(acpHome, 'profiles', 'node_modules') + '/').href

const ctx = await boot(NAME, EMPTY_CONFIG, patches, undefined, bareModuleBaseUrl)

// Once the loopback server is up, serve ACP JSON-RPC over our own stdio.
ctx.inject(['webServer'], (webCtx) => {
  const endpoint = `http://127.0.0.1:${webCtx.webServer.port}`
  process.stderr.write(`dsh-acp-server: loopback ${endpoint} (stdin/stdout ACP)\n`)
  attachBridge(process.stdin, process.stdout, endpoint, () => {
    void ctx.fiber.dispose().then(() => process.exit(0))
  })
})
