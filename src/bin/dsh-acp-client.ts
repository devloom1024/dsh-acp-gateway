#!/usr/bin/env node
/**
 * DSH ACP test client — drive the gateway the way an editor would.
 *
 * Interactive or scripted ACP v1 client over the bridge (stdio) or directly
 * against the gateway's loopback endpoint. Useful for verifying the gateway
 * without an editor:
 *
 *   node bin/dsh-acp-client.js                      # interactive, via bridge
 *   node bin/dsh-acp-client.js --endpoint http://127.0.0.1:56045
 *   echo 'new /tmp' | node bin/dsh-acp-client.js   # scripted (one command per line)
 *
 * Commands (interactive or scripted):
 *   init                          initialize
 *   new [cwd]                     session/new (prints sessionId)
 *   prompt <text...>              session/prompt (streams notifications)
 *   mode <code|plan>              session/set_mode
 *   set <configId> <value>        session/set_config_option
 *   cancel                        session/cancel (active prompt)
 *   list                          session/list
 *   load <sessionId>              session/load
 *   delete <sessionId>            session/delete
 *   quit                          exit
 */
import { createInterface } from 'node:readline'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { resolveEndpoints } from '../bridge.js'

const args = process.argv.slice(2)
let endpoint: string | null = null
const epIdx = args.indexOf('--endpoint')
if (epIdx >= 0) endpoint = args[epIdx + 1]
args.splice(epIdx >= 0 ? epIdx : args.length, 2)

/** Minimal JSON-RPC transport over HTTP loopback. */
function makeRpc(base: string): any {
  const pending = new Map()
  let nextId = 1
  const post = (body: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `${base}/acp/rpc`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (data += c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(data))
            } catch (e) {
              reject(new Error(`bad response: ${data.slice(0, 120)}`))
            }
          })
        },
      )
      req.setTimeout(8000, () => req.destroy(new Error('rpc timeout')))
      req.on('error', reject)
      req.end(body)
    })
  const subscribe = () => {
    const req = http.get(`${base}/acp/events`, (res: any) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        buf += (c as string)
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of frame.split('\n')) {
            if ((line as string).startsWith('data: ')) {
              try {
                const notif: any = JSON.parse((line as string).slice(6))
                const u = notif.params && notif.params.update
                if (u) renderUpdate(u)
              } catch (e) {
                /* ignore */
              }
            }
          }
        }
      })
      res.on('end', () => setTimeout(subscribe, 1000))
      res.on('error', () => setTimeout(subscribe, 1000))
    })
    req.on('error', () => setTimeout(subscribe, 1000))
  }
  return {
    call: (method: string, params: any): Promise<any> => {
      const id = nextId++
      return post(JSON.stringify({ jsonrpc: '2.0', id, method, params })).then((r) => {
        if (r.error) throw new Error(`[${r.error.code}] ${r.error.message}`)
        return r.result
      })
    },
    subscribe,
  }
}

let lastChunkLine = ''
function renderUpdate(u: any): void {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = (u.content && u.content.text) || ''
      process.stdout.write(text)
      lastChunkLine = text
      if (u.stopReason) process.stdout.write(`\n  ⏹ stopReason: ${u.stopReason}\n`)
      break
    }
    case 'user_message_chunk':
      process.stdout.write(`\n👤 ${(u.content && u.content.text) || ''}\n`)
      break
    case 'tool_call':
      process.stdout.write(
        `\n🔧 tool_call [${u.toolCallId}] ${(u.rawInput && u.rawInput.name) || u.title || ''} ${JSON.stringify((u.rawInput && u.rawInput.arguments) || {})}\n`,
      )
      break
    case 'tool_call_update':
      process.stdout.write(`  ↳ tool_call_update [${u.toolCallId}] ${u.status}\n`)
      break
    case 'usage_update':
      process.stdout.write(`  📊 usage: ${u.used} tokens\n`)
      break
    case 'current_mode_update':
      process.stdout.write(`  🌀 mode: ${u.modeId}\n`)
      break
    case 'available_commands_update':
      process.stdout.write(`  ⌘ commands: ${(u.availableCommands || []).map((c: any) => c.name).join(', ')}\n`)
      break
    case 'config_option_update':
      process.stdout.write(`  ⚙ config: ${(u.configOptions || []).map((o: any) => `${o.id}=${o.currentValue}`).join(', ')}\n`)
      break
    default:
      break
  }
}

function renderResult(label: string, r: any): void {
  const text = JSON.stringify(r)
  process.stdout.write(`${label}: ${text.length > 400 ? text.slice(0, 400) + '…' : text}\n`)
}

async function main() {
  // Transport: direct HTTP when --endpoint given, else spawn the bridge.
  let rpc
  if (endpoint) {
    rpc = makeRpc(endpoint)
    rpc.subscribe()
  } else {
    const candidates = resolveEndpoints()
    endpoint = candidates[0]
    const bridge = spawn(process.execPath, ['bin/dsh-acp-agent.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    bridge.stdout.setEncoding('utf8')
    let buf = ''
    bridge.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let obj
        try {
          obj = JSON.parse(line)
        } catch (e) {
          continue
        }
        if (obj.id !== undefined) {
          const pending = (bridge as any).__pending
          if (pending && pending.has(obj.id)) {
            pending.get(obj.id)(obj)
            pending.delete(obj.id)
          }
        } else {
          const u = obj.params && obj.params.update
          if (u) renderUpdate(u)
        }
      }
    })
    const pending = new Map<number, (r: any) => void>()
    ;(bridge as any).__pending = pending
    rpc = {
      call: (method: string, params: any): Promise<any> =>
        new Promise((resolve, reject) => {
          const id = Math.floor(Math.random() * 1e9)
          pending.set(id, (r: any) => {
            if (r.error) reject(new Error(`[${r.error.code}] ${r.error.message}`))
            else resolve(r.result)
          })
          bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
        }),
      subscribe: () => {},
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
  if (process.stdin.isTTY) {
    process.stdout.write(`dsh-acp test client — endpoint ${endpoint}\n  type 'help' for commands\n`)
  }

  const runLine = async (line: string): Promise<void> => {
    const parts = line.trim().split(/\s+/)
    const cmd = parts[0]
    const rest = line.trim().slice(cmd.length).trim()
    try {
      switch (cmd) {
        case 'init':
          renderResult('initialize', await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-acp-client', version: '3.7.0' } }))
          break
        case 'new': {
          const cwd = rest || process.cwd()
          const r = await rpc.call('session/new', { sessionId: `client_${Date.now().toString(36)}`, cwd })
          renderResult('session/new', r)
          break
        }
        case 'prompt': {
          const text = rest
          if (!text) { process.stdout.write('usage: prompt <text>\n'); break }
          const r = await rpc.call('session/prompt', { sessionId: currentSession(), prompt: [{ type: 'text', text }] })
          process.stdout.write(`\n✅ ${JSON.stringify(r)}\n`)
          break
        }
        case 'mode':
          renderResult('set_mode', await rpc.call('session/set_mode', { sessionId: currentSession(), modeId: rest }))
          break
        case 'set':
          renderResult('set_config_option', await rpc.call('session/set_config_option', { sessionId: currentSession(), configId: parts[1], value: inferValue(rest.slice(parts[1].length).trim()) }))
          break
        case 'cancel':
          renderResult('cancel', await rpc.call('session/cancel', { sessionId: currentSession() }))
          break
        case 'list':
          renderResult('session/list', await rpc.call('session/list', {}))
          break
        case 'load':
          renderResult('session/load', await rpc.call('session/load', { sessionId: rest }))
          break
        case 'delete':
          renderResult('session/delete', await rpc.call('session/delete', { sessionId: rest }))
          break
        case 'help':
          process.stdout.write(`commands: init | new [cwd] | prompt <text> | mode <code|plan> | set <id> <value> | cancel | list | load <id> | delete <id> | quit\n`)
          break
        case 'quit':
        case 'exit':
          process.exit(0)
          break
        default:
          if (line.trim()) process.stdout.write(`unknown command: ${cmd} (try 'help')\n`)
      }
    } catch (e: unknown) {
      process.stdout.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }

  let current: string | null = null
  function currentSession(): string {
    return current ?? ''
  }
  // remember the last created/loaded session
  const origCall = rpc.call
  rpc.call = async (method: string, params: any): Promise<any> => {
    const r = await origCall(method, params)
    if (method === 'session/new' || method === 'session/load') {
      if (r && r.sessionId) current = r.sessionId
    }
    return r
  }

  for await (const line of rl) {
    await runLine(line)
    if (process.stdin.isTTY) process.stdout.write('> ')
  }
  // EOF (scripted input or Ctrl-D): tear down the bridge and exit.
  process.exit(0)
}

function inferValue(v: string): string | boolean {
  if (v === 'true') return true
  if (v === 'false') return false
  return v
}

main().catch((e) => {
  process.stderr.write(`client error: ${e.message}\n`)
  process.exit(1)
})
