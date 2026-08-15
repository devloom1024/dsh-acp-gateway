/**
 * Stdio bridge core: newline-delimited JSON-RPC in, single-line JSON out.
 *
 * Shared by the standalone `dsh-acp-agent` executable and the embedded
 * `dsh-acp-server` (which attaches its own process stdio to the in-process
 * loopback endpoint). Requests are forwarded to the gateway's HTTP loopback
 * channel; `session/update` notifications are forwarded from its SSE stream.
 *
 * Endpoint candidates are tried in order (env → endpoint file → default) and
 * the bridge remembers the first reachable one, failing over to the next
 * candidate when the active endpoint stops responding (e.g. a stale
 * `~/.dsh/acp/endpoint` file pointing at a dead instance).
 *
 * @module dsh-acp-gateway/bridge
 */
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Writable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

/** How long a single connection attempt may take before failing over. */
const CONNECT_TIMEOUT_MS = 2000

/**
 * Arm a connect-phase-only timeout: `req.setTimeout` is an IDLE timeout and
 * would destroy long-lived requests (a 30s LLM turn) and SSE streams as soon
 * as the socket goes quiet. Only the time until the socket connects counts.
 */
function armConnectTimeout(req: http.ClientRequest, ms: number): void {
  req.on('socket', (socket) => {
    if (!socket.connecting) return
    const timer = setTimeout(() => req.destroy(new Error('connect timeout')), ms)
    socket.once('connect', () => clearTimeout(timer))
  })
}

/**
 * Ordered endpoint candidates: env var, then the endpoint file the gateway
 * writes, then the default DSH web port. Duplicates are removed.
 * @returns endpoint base URLs, e.g. `['http://127.0.0.1:56045', 'http://127.0.0.1:3080']`.
 */
export function resolveEndpoints(): string[] {
  const list = []
  if (process.env.DSH_ACP_URL) list.push(process.env.DSH_ACP_URL)
  try {
    const p = path.join(os.homedir(), '.dsh', 'acp', 'endpoint')
    const v = fs.readFileSync(p, 'utf8').trim()
    if (v) list.push(v)
  } catch (e) {
    /* no endpoint file */
  }
  list.push('http://127.0.0.1:3080')
  return [...new Set(list)]
}

/**
 * First endpoint candidate (backwards-compatible convenience).
 * @returns endpoint base URL, e.g. `http://127.0.0.1:3080`.
 */
export function resolveEndpoint(): string {
  return resolveEndpoints()[0]
}

/**
 * POST one JSON-RPC body to one endpoint with a connection timeout.
 * @returns the response text.
 */
function postTo(endpoint: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${endpoint}/acp/rpc`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume() // drain and drop the body
          reject(new Error(`HTTP ${res.statusCode} from ${endpoint}`))
          return
        }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          data += c
        })
        res.on('end', () => resolve(data))
      },
    )
    armConnectTimeout(req, CONNECT_TIMEOUT_MS)
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * Whether this request must be answered before notifications for its session
 * are forwarded. Zed (zed#60199) drops `session/update` notifications that
 * arrive before the `session/new` (or `session/load`) response — the session
 * is still "unknown" to it — so the bridge holds notification frames while
 * such a request is in flight and flushes them after the response line.
 */
function holdsNotifications(line: string): boolean {
  try {
    const parsed = JSON.parse(line)
    const method = parsed && typeof parsed === 'object' ? parsed.method : undefined
    return method === 'session/new' || method === 'session/load'
  } catch (e) {
    return false
  }
}

/**
 * Attach the bridge loop to the given stdio streams.
 * @param input - readable stream (JSON-RPC request lines).
 * @param output - writable stream (single-line JSON responses and notifications).
 * @param endpoints - one endpoint or an ordered candidate list (see `resolveEndpoints`).
 * @param onClose - invoked once when input closes (default: exit the process).
 * @returns an object with a `close()` disposer.
 */
export interface BridgeHandle {
  close(): void
}

export function attachBridge(
  input: NodeJS.ReadableStream,
  output: Writable,
  endpoints: string | string[],
  onClose: () => void = () => process.exit(0),
): BridgeHandle {
  const candidates = (Array.isArray(endpoints) ? endpoints : [endpoints]).filter(Boolean)
  // Multi-candidate mode (the standalone bridge): the endpoint file may point
  // at a restarted server's new port, so re-resolve it on failover. The
  // in-process server mode passes a single loopback endpoint and must never
  // fall out to file/env candidates.
  const multiCandidate = Array.isArray(endpoints)
  let active = candidates[0] || 'http://127.0.0.1:3080'
  let closed = false
  /** Notifications held while a session/new or session/load request is in flight. */
  let holdingNotifications = false
  const heldNotifications: string[] = []

  const write = (text: string): void => {
    if (closed) return
    try {
      output.write(text + '\n')
    } catch (e) {
      /* stream closed */
    }
  }
  const note = (text: string): void => {
    try {
      process.stderr.write(`bridge: ${text}\n`)
    } catch (e) {
      /* stderr closed */
    }
  }
  /** Run `fn` against the active endpoint, failing over through the others. */
  const withEndpoint = async <T>(fn: (candidate: string) => Promise<T>): Promise<T> => {
    const tried: string[] = []
    for (const round of [0, 1]) {
      // Round 1 re-resolves the endpoint file: a restarted server (or a stale
      // file) moves to a new port, and a fresh read picks it up automatically.
      const list = round === 0 || !multiCandidate ? candidates : resolveEndpoints()
      for (const candidate of [active, ...list.filter((c) => c !== active)]) {
        if (tried.includes(candidate)) continue
        tried.push(candidate)
        try {
          const result = await fn(candidate)
          if (candidate !== active) {
            note(`switched endpoint to ${candidate}`)
            active = candidate
          }
          return result
        } catch (e) {
          /* try the next candidate */
        }
      }
      if (round === 0) note(`no reachable endpoint yet; re-reading endpoint file`)
    }
    throw new Error(`no reachable endpoint in [${resolveEndpoints().join(', ')}]`)
  }

  const post = (body: string): Promise<string> => withEndpoint((candidate) => postTo(candidate, body))

  // Subscribe to Agent -> Client notifications (SSE) and forward each as one line.
  // Reconnect after a drop; failed attempts fail over like requests do.
  const connectEvents = (candidate: string): Promise<IncomingMessage> =>
    new Promise((resolve, reject) => {
      const req = http.get(`${candidate}/acp/events`, (res) => resolve(res))
      armConnectTimeout(req, CONNECT_TIMEOUT_MS)
      req.on('error', reject)
    })
  const subscribeEvents = () => {
    if (closed) return
    withEndpoint(connectEvents)
      .then((res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          buf += c
          let idx
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            for (const line of frame.split('\n')) {
              if (line.startsWith('data: ')) {
                const text = line.slice(6)
                if (holdingNotifications) heldNotifications.push(text)
                else write(text)
              }
            }
          }
        })
        res.on('end', () => setTimeout(subscribeEvents, 1000))
        res.on('error', () => setTimeout(subscribeEvents, 1000))
      })
      .catch(() => setTimeout(subscribeEvents, 1000))
  }
  subscribeEvents()

  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    // The request id for the error reply (best effort; dropped on malformed JSON).
    let reqId: unknown = null
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && 'id' in parsed) reqId = parsed.id
    } catch (e) {
      /* not JSON; no id to echo */
    }
    // Zed drops notifications for sessions it does not know yet, so hold them
    // while a session-creating/loading request is in flight (see
    // holdsNotifications).
    if (holdsNotifications(trimmed)) holdingNotifications = true
    try {
      const response = await post(trimmed)
      if (response) write(response)
    } catch (e: unknown) {
      const message = String((e instanceof Error && e.message) || e)
      note(`request failed: ${message}`)
      // Never leave the client hanging on an unreachable endpoint: answer with
      // a JSON-RPC error so the editor shows a failure instead of loading.
      if (reqId !== null) write(JSON.stringify({ jsonrpc: '2.0', id: reqId, error: { code: -32000, message } }))
    } finally {
      // The request has settled: forward notifications held while it was in
      // flight, in order, after the response line.
      if (holdingNotifications) {
        holdingNotifications = false
        for (const held of heldNotifications) write(held)
        heldNotifications.length = 0
      }
    }
  })
  rl.on('close', () => close())
  const close = () => {
    if (closed) return
    closed = true
    onClose()
  }
  return { close }
}

export default { attachBridge, resolveEndpoint, resolveEndpoints }
