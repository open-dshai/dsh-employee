/**
 * Package root — the node half of the cordis plugin. The browser half ships
 * the Marketplace sidebar entry + center panel through exports["./client"],
 * discovered from the package.json dsh.client declaration.
 *
 * The node half owns the skill install/uninstall routes: the browser
 * cannot write to the filesystem, so the client store POSTs the skill
 * payload to `/plugins/ui-marketplace/install-skill` and this side
 * materializes it as `~/.agents/skills/<slug>/SKILL.md` — the standard
 * agent-skills layout the rest of the ecosystem (npx skills, Trae, …)
 * reads from. `/plugins/ui-marketplace/uninstall-skill` removes that
 * directory again.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Empty type import carries the webServer Context merge.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Plugin identity — matches the `id` in cordis.patch.yml. */
export const name = 'ui-marketplace'

/** Browser endpoint for skill installs (served by this plugin's node half). */
export const INSTALL_SKILL_ENDPOINT = '/plugins/ui-marketplace/install-skill'

/** Browser endpoint for skill uninstalls (mirrors the install route). */
export const UNINSTALL_SKILL_ENDPOINT = '/plugins/ui-marketplace/uninstall-skill'

/** Root directory every marketplace skill installs into. */
export const SKILLS_ROOT = join(homedir(), '.agents', 'skills')

/**
 * Prefix route of the same-origin reverse proxy. The upstream
 * (skill.dualpaw.com) sends no CORS headers, so a browser fetch is blocked;
 * this node-half route relays the call loopback-side instead. The client
 * keeps its public-CORS-proxy rotation as a secondary fallback for hosts
 * without the node route (e.g. Electron file://).
 */
export const UPSTREAM_PROXY_ENDPOINT = '/plugins/ui-marketplace/upstream'

/** Upstream API origin + versioned base. Only this origin may be proxied. */
const UPSTREAM_ORIGIN = 'https://skill.dualpaw.com'
const UPSTREAM_API_BASE = UPSTREAM_ORIGIN + '/api/v1'
/** HTTP methods allowed through the proxy — writes stay limited to POST. */
const PROXY_ALLOWED_METHODS = new Set(['GET', 'POST', 'HEAD', 'OPTIONS'])
/** Request headers safe to relay; host/connection/cookie etc. are dropped. */
const PROXY_RELAY_HEADERS = new Set(['accept', 'authorization', 'content-type'])
/** Hard timeout for one upstream relay so a hung upstream cannot pin the route. */
const PROXY_TIMEOUT_MS = 20000

/** POST body the client store sends for one skill install. */
export interface InstallSkillRequest {
  slug: string
  displayName?: string
  summary?: string
  version?: string
  description?: string
  instructions?: string
}

/**
 * Slugs become directory names under {@link SKILLS_ROOT}. Originally this
 * only allowed `[a-zA-Z0-9._-]`, which rejected skills whose name is Chinese
 * (e.g. a skill whose slug *is* its Chinese display name, or a slug locally
 * derived from a Chinese display name). We now accept Unicode letters/digits
 * (so CJK slugs install) and the usual separators, while still rejecting
 * characters that would break a filesystem path or the
 * `~/.agents/skills/<slug>/` layout (path separators, Windows-illegal chars,
 * and leading/trailing whitespace).
 */
const SLUG_PATTERN = /^[^\s/\\:*?"<>|][^\s/\\:*?"<>|]*$/u

/** Render the SKILL.md body (agentskills frontmatter + instructions). */
export function renderSkillMarkdown(input: InstallSkillRequest): string {
  const name = input.slug
  const summary = (input.summary ?? '').trim()
  const description = (input.description ?? '').trim()
  const oneLine = (summary || description || `Marketplace skill ${input.displayName ?? name}.`).replace(/\s+/g, ' ')
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(input.version && input.version.trim().length > 0 ? `${oneLine} (v${input.version.trim()})` : oneLine)}`,
    '---',
    '',
    `# ${input.displayName?.trim() || name}`,
    '',
  ]
  if (summary.length > 0) lines.push(summary, '')
  const instructions = (input.instructions ?? '').trim()
  if (instructions.length > 0) lines.push(instructions, '')
  if (description.length > 0 && description !== summary) lines.push(description, '')
  return `${lines.join('\n').trimEnd()}\n`
}

/** Drain the request body; the install payload is tiny (a few KB at most). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

/**
 * Register the install + uninstall routes once the optional webServer service
 * is composed (the web profile always composes it; Electron loads the client
 * over file:// and never boots these routes).
 */
export function apply(ctx: Context): void {
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => {
        const installDisposer = httpCtx.webServer.register({
          kind: 'exact',
          path: INSTALL_SKILL_ENDPOINT,
          handler: makeInstallHandler(httpCtx),
        })
        const uninstallDisposer = httpCtx.webServer.register({
          kind: 'exact',
          path: UNINSTALL_SKILL_ENDPOINT,
          handler: makeUninstallHandler(httpCtx),
        })
        const proxyDisposer = httpCtx.webServer.register({
          kind: 'prefix',
          path: UPSTREAM_PROXY_ENDPOINT,
          handler: makeUpstreamProxyHandler(httpCtx),
        })
        return () => {
          installDisposer?.()
          uninstallDisposer?.()
          proxyDisposer?.()
        }
      },
      'ui-marketplace: skill install/uninstall routes',
    )
  })
}

/** Validate + materialize one skill into `~/.agents/skills/<slug>/SKILL.md`. */
function makeInstallHandler(httpCtx: Context): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    let payload: InstallSkillRequest
    try {
      payload = JSON.parse(await readBody(req)) as InstallSkillRequest
    } catch {
      sendJson(res, 400, { error: 'invalid json body' })
      return
    }
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : ''
    if (!SLUG_PATTERN.test(slug)) {
      sendJson(res, 400, { error: `invalid skill slug: ${slug}` })
      return
    }
    try {
      const dir = join(SKILLS_ROOT, slug)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), renderSkillMarkdown({ ...payload, slug }), 'utf8')
      sendJson(res, 200, { ok: true, path: dir })
    } catch (error) {
      httpCtx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Delete `~/.agents/skills/<slug>/` so the skill is gone from disk. */
function makeUninstallHandler(httpCtx: Context): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    let payload: { slug?: unknown }
    try {
      payload = JSON.parse(await readBody(req)) as { slug?: unknown }
    } catch {
      sendJson(res, 400, { error: 'invalid json body' })
      return
    }
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : ''
    if (!SLUG_PATTERN.test(slug)) {
      sendJson(res, 400, { error: `invalid skill slug: ${slug}` })
      return
    }
    try {
      const dir = join(SKILLS_ROOT, slug)
      await rm(dir, { recursive: true, force: true })
      sendJson(res, 200, { ok: true, path: dir })
    } catch (error) {
      httpCtx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Same-origin reverse proxy handler. Takes the URL suffix after
 * {@link UPSTREAM_PROXY_ENDPOINT} (e.g. '/strategist?page=0&size=24') and
 * relays it to the upstream '/api/v1' base, streaming the JSON response back.
 * Loopback-only by construction (the webServer binds 127.0.0.1) and locked to
 * a single origin + the /api/v1/ path, so it cannot become an open proxy.
 */
function makeUpstreamProxyHandler(httpCtx: Context): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const method = req.method ?? 'GET'
      if (!PROXY_ALLOWED_METHODS.has(method)) {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      if (method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*' })
        res.end()
        return
      }
      // req.url keeps the full pathname + query even on a prefix match.
      const rest = (req.url ?? '/').slice(UPSTREAM_PROXY_ENDPOINT.length) || '/'
      const target = new URL(UPSTREAM_API_BASE + rest)
      // Defence in depth: reject path traversal or any origin/path escape.
      if (target.origin !== UPSTREAM_ORIGIN || !target.pathname.startsWith('/api/v1/')) {
        sendJson(res, 403, { error: 'upstream path rejected' })
        return
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined && PROXY_RELAY_HEADERS.has(key.toLowerCase())) {
          headers.set(key, Array.isArray(value) ? value.join(',') : value)
        }
      }
      const init: RequestInit = { method, headers }
      if (method === 'POST') init.body = await readBody(req)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)
      let upstream: Response
      try {
        upstream = await fetch(target, { ...init, signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      const buffer = Buffer.from(await upstream.arrayBuffer())
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(method === 'HEAD' ? undefined : buffer)
    } catch (error) {
      httpCtx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      if (!res.headersSent) sendJson(res, 502, { error: 'upstream fetch failed' })
      else res.end()
    }
  }
}

export type { MarketplaceState, MarketplaceStore, MarketplaceTab } from './client/store.ts'
export type { MarketplaceKey } from './client/locales.ts'
