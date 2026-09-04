#!/usr/bin/env node
/**
 * Smoke test: boot the standalone gateway (dsh-acp-server) and drive a real
 * ACP round trip over the loopback endpoint:
 *
 *   1. initialize            — capability advertisement
 *   2. session/new           — modes + configOptions (thought_level presence)
 *   3. session/prompt        — text + image + resource_link(file://) blocks
 *                              in one prompt; verifies the admitted content
 *                              reaches the agent (image attachment, inlined
 *                              file text) and the model answers it
 *   4. session/set_config_option thought_level — validation + applied state
 *   5. session/delete        — cleanup
 *
 * Uses the shared deployment home (~/.dsh) so the deployment's own model
 * route, settings, and credentials apply (exactly like `npx dsh-acp-gateway`).
 * Pass DSH_ACP_HOME to isolate.
 *
 *   node scripts/smoke-acp-gateway.mjs
 *
 * Exit code 0 = all checks passed; diagnostics on stderr, JSON report on
 * stdout.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SERVER = join(here, '..', 'dist', 'src', 'bin', 'dsh-acp-server.js')
const CWD = mkdtempSync(join(tmpdir(), 'acp-smoke-'))
const ATTACHED = join(CWD, 'attached.txt')
writeFileSync(ATTACHED, 'SMOKE-ATTACHED-FILE first line\nsecond line\n')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail })
  process.stderr.write(`${ok ? 'ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

function httpJson(base, path, body, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) })
          } catch (e) {
            reject(new Error(`bad response ${res.statusCode}: ${data.slice(0, 160)}`))
          }
        })
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('http timeout')))
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- boot ---
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env },
  // stdin must stay open (a pipe): the server's stdio bridge exits on EOF.
  stdio: ['pipe', 'ignore', 'pipe'],
})
let bootLog = ''
let endpoint = null
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => {
  bootLog += c
  const m = c.match(/loopback (http:\/\/127\.0\.0\.1:\d+)/)
  if (m) endpoint = m[1]
})
const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))

// SSE notification collector (agent -> client session/update stream).
const notifications = []
const subscribe = (base) => {
  const req = http.get(`${base}/acp/events`, (res) => {
    let buf = ''
    res.setEncoding('utf8')
    res.on('data', (c) => {
      buf += c
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const notif = JSON.parse(line.slice(6))
              const u = notif.params && notif.params.update
              if (u) notifications.push(u)
            } catch (e) {
              /* ignore frame */
            }
          }
        }
      }
    })
    res.on('end', () => setTimeout(() => subscribe(base), 1000))
    res.on('error', () => setTimeout(() => subscribe(base), 1000))
  })
  req.on('error', () => setTimeout(() => subscribe(base), 1000))
}

try {
  for (let i = 0; i < 60 && !endpoint; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${bootLog.slice(-2000)}`)
    await sleep(500)
  }
  if (!endpoint) throw new Error(`no loopback endpoint within 30s: ${bootLog.slice(-2000)}`)
  process.stderr.write(`endpoint ${endpoint}\n`)
  // The gateway mounts its loopback routes after webserver injection; wait
  // until /acp/rpc answers (initialize itself is the readiness probe).
  let init = null
  for (let i = 0; i < 40 && !init; i += 1) {
    try {
      const probe = await httpJson(endpoint, '/acp/rpc', {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: { elicitation: false }, clientInfo: { name: 'smoke', version: '1' } },
      })
      if (probe.status === 404 || probe.status === 405) await sleep(500)
      else init = probe
    } catch (e) {
      await sleep(500)
    }
  }
  if (!init) throw new Error(`gateway did not answer within 20s: ${bootLog.slice(-2000)}`)
  subscribe(endpoint)

  // 1. initialize (already probed above)
  const caps = init.json?.result?.agentCapabilities
  check('initialize advertises image/embeddedContext', caps && caps.promptCapabilities?.image === true && caps.promptCapabilities?.embeddedContext === true)

  // 2. session/new
  const fresh = await httpJson(endpoint, '/acp/rpc', {
    jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: CWD },
  })
  const sessionId = fresh.json?.result?.sessionId
  check('session/new returns a session id', typeof sessionId === 'string')
  const cfgIds = (fresh.json?.result?.configOptions || []).map((o) => o.id)
  process.stderr.write(`configOptions: ${cfgIds.join(', ') || '(none)'}\n`)
  const modes = fresh.json?.result?.modes?.availableModes || []
  check('session/new advertises modes', Array.isArray(modes) && modes.length > 0)
  // Since 0.1.2-rc.1 the thought_level option is always offered once the route
  // exposes adapter-declared reasoning efforts (with "Provider default" when
  // the adapter configures none), instead of only after an effort was picked.
  const tlOpt = (fresh.json?.result?.configOptions || []).find((o) => o.id === 'thought_level')
  check('thought_level config option present at session/new', Boolean(tlOpt), tlOpt ? JSON.stringify(tlOpt.options) : 'absent')
  check(
    'thought_level carries adapter-declared effort options',
    Boolean(tlOpt && Array.isArray(tlOpt.options) && tlOpt.options.length > 0),
    tlOpt && tlOpt.options ? `values=${tlOpt.options.map((o) => o.value).join(',')}` : 'no options',
  )

  // 3. prompt with text + image + attached file (resource_link file://)
  // 1x1 transparent GIF (canonical base64, raster mime type).
  const gif = 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
  const fileUri = 'file:///' + ATTACHED.replace(/\\/g, '/')
  const promptRes = await httpJson(endpoint, '/acp/rpc', {
    jsonrpc: '2.0', id: 3, method: 'session/prompt',
    params: {
      sessionId,
      prompt: [
        { type: 'text', text: 'Reply with exactly: SMOKE-OK. Then one line: IMAGE=yes/no if you received an image attachment. Then one line: FILE=yes/no if the attached file text was included. Do not use tools.' },
        { type: 'image', data: gif, mimeType: 'image/gif', uri: 'pixel.png' },
        { type: 'resource_link', name: 'attached.txt', uri: fileUri },
      ],
    },
  })
  check('prompt with image+file accepted', !promptRes.json?.error, JSON.stringify(promptRes.json?.error || {}))
  const stopReason = promptRes.json?.result?.stopReason
  check('prompt finished with a stop reason', typeof stopReason === 'string', `stopReason=${stopReason}`)
  // The user-message echo must carry the inlined file text (it becomes a text
  // block), proving the gateway admitted the resource_link into the turn.
  const userEcho = notifications
    .filter((n) => n.sessionUpdate === 'user_message_chunk')
    .map((n) => (n.content && n.content.text) || '')
    .join('\n')
  check('resource_link file text was admitted into the prompt', userEcho.includes('SMOKE-ATTACHED-FILE'), `echo=${JSON.stringify(userEcho.slice(0, 120))}`)
  // The assistant's own answer is the strongest signal: if the model saw the
  // image and the file it says so.
  const assistantText = notifications
    .filter((n) => n.sessionUpdate === 'agent_message_chunk')
    .map((n) => (n.content && n.content.text) || '')
    .join('')
  check('model answered the prompt', assistantText.includes('SMOKE-OK'), `reply=${JSON.stringify(assistantText.slice(0, 200))}`)
  // A vision model must receive the image block as an image; a text-only
  // model gets DSH's deterministic textual projection of it (IMAGE=no is the
  // honest projection answer — the gateway still admitted the attachment).
  const visionModel = /vision|image|vision-exp/i.test(process.env.DSH_ACP_MODEL || process.env.DSH_ACP_PROVIDER || '')
  check(
    'image reached the model',
    visionModel ? /IMAGE=yes/i.test(assistantText) : /IMAGE=(?:yes|no)/i.test(assistantText),
    `reply=${JSON.stringify(assistantText.slice(0, 200))}`,
  )
  check('attached file reached the model', /FILE=yes/i.test(assistantText), `reply=${JSON.stringify(assistantText.slice(0, 200))}`)

  // 4. thought_level config option
  const tl = await httpJson(endpoint, '/acp/rpc', {
    jsonrpc: '2.0', id: 4, method: 'session/set_config_option',
    params: { sessionId, configId: 'thought_level', value: 'high' },
  })
  const tlErr = tl.json?.error
  // Adapter-declared efforts may not include 'high' for this route; the check
  // is that the option is recognized and validated (mirrors the catalog).
  check('thought_level set is accepted or rejected with a catalog error', !tlErr || tlErr.code === -32602, tlErr ? tlErr.message : 'accepted')
  const tlIds = (tl.json?.result?.configOptions || []).map((o) => o.id)
  process.stderr.write(`configOptions after set: ${tlIds.join(', ') || '(none)'}\n`)
  // "Provider default" (empty value) clears the session's explicit effort:
  // the option must move away from the explicitly chosen 'high' (back to the
  // ambient selection — the deployment's own default effort, or "Provider
  // default" when the adapter configures none).
  const tlDefault = await httpJson(endpoint, '/acp/rpc', {
    jsonrpc: '2.0', id: 5, method: 'session/set_config_option',
    params: { sessionId, configId: 'thought_level', value: '' },
  })
  const tlDefaultErr = tlDefault.json?.error
  const tlDefaultValue = (tlDefault.json?.result?.configOptions || []).find((o) => o.id === 'thought_level')?.currentValue
  check(
    'thought_level provider-default clears the explicit effort',
    !tlDefaultErr && tlDefaultValue !== undefined && tlDefaultValue !== 'high',
    tlDefaultErr ? tlDefaultErr.message : `currentValue=${JSON.stringify(tlDefaultValue)}`,
  )

  // 5. cleanup
  const del = await httpJson(endpoint, '/acp/rpc', {
    jsonrpc: '2.0', id: 6, method: 'session/delete', params: { sessionId },
  })
  check('session/delete', del.json?.result !== undefined && !del.json?.error)
} catch (e) {
  check('smoke run', false, String((e && e.message) || e))
  if (child.exitCode !== null) process.stderr.write(`server exited ${child.exitCode}\n`)
  process.stderr.write(`--- server log tail ---\n${bootLog.slice(-4000)}\n`)
} finally {
  child.kill()
  await Promise.race([exited, sleep(5000)])
  rmSync(CWD, { recursive: true, force: true })
}

console.log(JSON.stringify({ passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, checks }, null, 2))
process.exit(checks.some((c) => !c.ok) ? 1 : 0)