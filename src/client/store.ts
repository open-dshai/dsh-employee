/**
 * Marketplace store: one snapshot joining the three list sources
 * (experts + skills from skill.dualpaw.com via the plugin fetcher,
 * connectors from the built-in static catalog). The store never reads
 * from another plugin; the fetcher (`api.ts`) carries the CORS relay,
 * and every mutation updates the snapshot in place.
 */

import { useSyncExternalStore } from 'react'
import { fetchJson, postJson, isMockInUse, absolutize, UPSTREAM_BASE as UPSTREAM } from './api.ts'

/* ── localStorage keys ──
 * Declared FIRST, on purpose. `initial` (below) calls `loadConnectorParams()`
 * while this module is still evaluating; if these keys were declared after it
 * they would be in their temporal dead zone, the reader's try/catch would eat
 * the ReferenceError, and every saved connector token would read back empty. */

/** Per-connector runtime parameters (API tokens, tenant ids, namespaces, …),
 *  shaped `{[connectorId]: {key: value}}`. These flow into the composer when
 *  the user invokes the connector. */
const LS_CONNECTOR_PARAMS = 'dsh.marketplace.connector.params.v1'
/** Per-connector enable flag for the composer popover. Absence of a key means
 *  enabled, so only explicit opt-outs are stored. */
const LS_CONNECTOR_ENABLED = 'dsh.marketplace.connector.enabled.v1'
/** Per-connector OAuth-granted flag, written after a successful callback. */
const LS_CONNECTOR_CONNECTED = 'dsh.marketplace.connector.connected.v1'
/** Global API token for skill.dualpaw.com experts/skills. A single token
 *  authorizes every expert connection, so it is stored as a plain string
 *  rather than a per-expert map. */
const LS_EXPERT_TOKEN = 'dsh.marketplace.expert.token.v1'
/** Locally toggled expert favorites (ids), persisted across sessions. */
const LS_FAVORITE_EXPERTS = 'dsh.marketplace.favorite.experts.v1'
/** Locally toggled skill favorites (slugs), persisted across sessions. */
const LS_FAVORITE_SKILLS = 'dsh.marketplace.favorite.skills.v1'

/* ── Wire shapes (re-declared to keep the bundle Node-free) ── */

export interface ExpertRow {
  readonly id: number
  readonly name: string
  readonly slug?: string | undefined
  readonly avatarUrl: string
  readonly intro: string
  readonly category: { id: number; name: string; code: string; icon: string }
  readonly favoriteCount: number
  readonly favorited: boolean
}

export interface ExpertDetail extends ExpertRow {
  readonly content?: string | undefined
  readonly soulPersonality?: string | undefined
  readonly skills?: ReadonlyArray<{ id: number; skillSlug: string; skillName: string; skillIconUrl?: string | undefined; skillSummary?: string | undefined }> | undefined
}

export interface ExpertCategoryRow {
  readonly id: number
  readonly name: string
  readonly code: string
  readonly icon: string
  readonly strategistCount: number
}

export interface SkillRow {
  readonly slug: string
  readonly displayName: string
  readonly summary: string
  readonly version: string
  readonly tags: Readonly<Record<string, string>>
  readonly stats: { downloads: number; stars: number }
  readonly updatedAt: number
}

export interface SkillDetail extends SkillRow {
  readonly description?: string | undefined
  readonly instructions?: string | undefined
  readonly latestVersion?: { version: string; changelog?: string | null; license?: string | null; createdAt: number } | undefined
  readonly moderation?: { verdict: string; isSuspicious?: boolean; isMalwareBlocked?: boolean } | undefined
}

export interface ConnectorRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly iconUrl: string
  readonly connected: boolean
  readonly source: 'builtin' | 'external'
  readonly tags: readonly string[]
  /** OAuth / authorization URL to open in a new window when the user clicks
   *  连接. When undefined, the action is a pure on/off toggle (rare). */
  readonly authUrl?: string
  readonly docsUrl?: string
}

/** State of a single download attempt. */
export type DownloadStatus = 'idle' | 'downloading' | 'ready' | 'error'

/** Local install state mirrors — persisted to localStorage so the user
 *  does not re-download the same skill on every page load.
 *  `downloadingSkills` tracks in-flight installs so the UI can show a spinner. */
export interface InstallState {
  installedSkills: ReadonlySet<string>
  downloadingSkills: ReadonlySet<string>
  installedExperts: ReadonlySet<number>
  downloadingExperts: ReadonlySet<number>
}

const LS_KEY = 'dsh.marketplace.install.v1'

function loadInstallState(): InstallState {
  if (typeof localStorage === 'undefined') {
    return { installedSkills: new Set(), downloadingSkills: new Set(), installedExperts: new Set(), downloadingExperts: new Set() }
  }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw === null) return { installedSkills: new Set(), downloadingSkills: new Set(), installedExperts: new Set(), downloadingExperts: new Set() }
    const parsed = JSON.parse(raw) as { skills?: string[]; experts?: Array<number | string> }
    return {
      installedSkills: new Set(parsed.skills ?? []),
      downloadingSkills: new Set(),
      installedExperts: new Set((parsed.experts ?? []).map((v) => Number(v))),
      downloadingExperts: new Set(),
    }
  } catch {
    return { installedSkills: new Set(), downloadingSkills: new Set(), installedExperts: new Set(), downloadingExperts: new Set() }
  }
}

function saveInstallState(state: InstallState): void {
  if (typeof localStorage === 'undefined') return
  try {
    const payload = {
      skills: [...state.installedSkills],
      experts: [...state.installedExperts].map((n) => Number(n)),
    }
    localStorage.setItem(LS_KEY, JSON.stringify(payload))
  } catch { /* quota / private mode — ignore */ }
}

export type MarketplaceTab = 'experts' | 'skills' | 'connectors'

export interface MarketplaceState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  activeTab: MarketplaceTab
  error: string | null
  experts: {
    status: 'idle' | 'loading' | 'ready' | 'error'
    items: readonly ExpertRow[]
    total: number
    page: number
    size: number
    error: string | null
    categoryId: number | null
    query: string
  }
  expertCategories: readonly ExpertCategoryRow[]
  expertDetail: { status: 'idle' | 'loading' | 'ready' | 'error'; expert: ExpertDetail | null; error: string | null }
  skills: {
    status: 'idle' | 'loading' | 'ready' | 'error'
    items: readonly SkillRow[]
    nextCursor: string | null
    error: string | null
    query: string
    sort: 'newest' | 'relevance'
    starredOnly: boolean
  }
  skillDetail: { status: 'idle' | 'loading' | 'ready' | 'error'; skill: SkillDetail | null; error: string | null }
  connectors: {
    status: 'idle' | 'loading' | 'ready' | 'error'
    items: readonly ConnectorRow[]
    error: string | null
  }
  pendingConnectorId: string | null
  /** True when the most recent experts/skills fetch fell back to the
   *  bundled mock dataset (every CORS proxy failed). Drives the
   *  "本地数据" pill in the tabs. */
  isOffline: boolean
  install: InstallState
  /** Per-connector runtime params (API tokens, namespaces, …). Loaded once
   *  from localStorage; persisted on each `setConnectorParams`. */
  connectorParams: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Per-connector composer-popover enable flag. Absence means ON (default).
   *  Persisted to localStorage; reflected via `isConnectorEnabled`. */
  connectorEnabled: Readonly<Record<string, boolean>>
  /** Global API token for skill.dualpaw.com experts/skills. Loaded once from
   *  localStorage; persisted on each `setExpertToken`. Empty string means unset. */
  expertToken: string
  /** Locally toggled expert favorites (expert ids). Persisted to localStorage;
   *  reflected via `isExpertFavorited`. Overrides the API `favorited` flag. */
  favoriteExperts: ReadonlySet<number>
  /** Locally toggled skill favorites (slugs). Persisted to localStorage;
   *  reflected via `isSkillFavorited`. */
  favoriteSkills: ReadonlySet<string>
}

function saveEnabledState(state: Readonly<Record<string, boolean>>): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(LS_CONNECTOR_ENABLED, JSON.stringify(state)) } catch { /* quota */ }
}

function loadEnabledState(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(LS_CONNECTOR_ENABLED)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (v === false) out[k] = false
    }
    return out
  } catch { return {} }
}

const initial: MarketplaceState = {
  status: 'idle',
  activeTab: 'experts',
  error: null,
  experts: { status: 'idle', items: [], total: 0, page: 0, size: 24, error: null, categoryId: null, query: '' },
  expertCategories: [],
  expertDetail: { status: 'idle', expert: null, error: null },
  skills: { status: 'idle', items: [], nextCursor: null, error: null, query: '', sort: 'newest', starredOnly: false },
  skillDetail: { status: 'idle', skill: null, error: null },
  connectors: { status: 'idle', items: [], error: null },
  pendingConnectorId: null,
  isOffline: false,
  install: loadInstallState(),
  connectorParams: loadConnectorParams(),
  connectorEnabled: loadEnabledState(),
  expertToken: loadExpertToken(),
  favoriteExperts: loadFavoriteExperts(),
  favoriteSkills: loadFavoriteSkills(),
}

/** Human text for a rejected call. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asExpert(raw: Record<string, unknown>, upstream: string): ExpertRow {
  const cat = (raw['category'] && typeof raw['category'] === 'object' ? raw['category'] : {}) as Record<string, unknown>
  return {
    id: Number(raw['id'] ?? 0),
    name: String(raw['name'] ?? ''),
    slug: typeof raw['slug'] === 'string' ? raw['slug'] : undefined,
    avatarUrl: absolutize(upstream, raw['avatarUrl'] as string | undefined),
    intro: String(raw['intro'] ?? ''),
    category: {
      id: Number(cat['id'] ?? 0),
      name: String(cat['name'] ?? ''),
      code: String(cat['code'] ?? ''),
      icon: String(cat['icon'] ?? ''),
    },
    favoriteCount: Number(raw['favoriteCount'] ?? 0),
    favorited: Boolean(raw['favorited'] ?? false),
  }
}

function asExpertDetail(raw: Record<string, unknown>, upstream: string): ExpertDetail {
  const base = asExpert(raw, upstream)
  const skills = Array.isArray(raw['skills']) ? (raw['skills'] as Array<Record<string, unknown>>).map((s) => ({
    id: Number(s['id'] ?? 0),
    skillSlug: String(s['skillSlug'] ?? ''),
    skillName: String(s['skillName'] ?? ''),
    skillIconUrl: typeof s['skillIconUrl'] === 'string' ? absolutize(upstream, s['skillIconUrl']) : undefined,
    skillSummary: typeof s['skillSummary'] === 'string' ? s['skillSummary'] : undefined,
  })) : undefined
  return {
    ...base,
    content: typeof raw['content'] === 'string' ? raw['content'] : undefined,
    soulPersonality: typeof raw['soulPersonality'] === 'string' ? raw['soulPersonality'] : undefined,
    skills,
  }
}

function asSkill(raw: Record<string, unknown>): SkillRow {
  const tags = (raw['tags'] && typeof raw['tags'] === 'object' ? raw['tags'] : {}) as Record<string, string>
  const stats = (raw['stats'] && typeof raw['stats'] === 'object' ? raw['stats'] : {}) as Record<string, number>
  return {
    slug: String(raw['slug'] ?? ''),
    displayName: String(raw['displayName'] ?? raw['slug'] ?? ''),
    summary: String(raw['summary'] ?? ''),
    version: String(raw['version'] ?? '0.0.0'),
    tags,
    stats: { downloads: Number(stats['downloads'] ?? 0), stars: Number(stats['stars'] ?? 0) },
    updatedAt: Number(raw['updatedAt'] ?? 0),
  }
}

function asSkillDetail(raw: Record<string, unknown>): SkillDetail {
  const base = asSkill(raw)
  const moderation = (raw['moderation'] && typeof raw['moderation'] === 'object' ? raw['moderation'] : undefined) as Record<string, unknown> | undefined
  return {
    ...base,
    description: typeof raw['description'] === 'string' ? raw['description'] : undefined,
    instructions: typeof raw['instructions'] === 'string' ? raw['instructions'] : undefined,
    latestVersion: typeof raw['latestVersion'] === 'object' && raw['latestVersion'] !== null
      ? (raw['latestVersion'] as Record<string, unknown>) as SkillDetail['latestVersion']
      : undefined,
    ...(moderation === undefined ? {} : {
      moderation: {
        verdict: String(moderation['verdict'] ?? ''),
        isSuspicious: Boolean(moderation['isSuspicious']),
        isMalwareBlocked: Boolean(moderation['isMalwareBlocked']),
      },
    }),
  }
}

function asCategory(raw: Record<string, unknown>): ExpertCategoryRow {
  return {
    id: Number(raw['id'] ?? 0),
    name: String(raw['name'] ?? ''),
    code: String(raw['code'] ?? ''),
    icon: String(raw['icon'] ?? ''),
    strategistCount: Number(raw['strategistCount'] ?? 0),
  }
}

/**
 * Built-in connector catalog — mirrors WorkBuddy's exposed connector
 * surface. A future revision could pull this from a remote registry; a
 * static list keeps the plugin self-contained (no backend, no CORS).
 *
 * Each entry's `authUrl` is opened in a new window when the user clicks
 * 连接. When the callback page (provided by the host app or by the upstream
 * service) posts back via `BroadcastChannel('dsh-connector-auth')` with
 * `{ id, ok: true }`, the store flips the row to connected. The host can
 * also set `localStorage[LS_CONNECTOR_CONNECTED]` directly to mark a
 * connector as connected without a popup round-trip (used by the gateway
 * during read-only probes).
 */
const BUILTIN_CONNECTORS: ConnectorRow[] = [
  { id: 'github', name: 'GitHub', description: '在 GitHub 上克隆、推送代码，查看和管理仓库与 Pull Request，用自然语言完成代码协作。', iconUrl: 'https://avatars.githubusercontent.com/u/9919?v=4', connected: false, source: 'external', tags: ['代码托管', '代码协作'], authUrl: 'https://github.com/login/oauth/authorize?client_id=dsh-marketplace' },
  { id: 'notion', name: 'Notion', description: '创建、搜索和管理 Notion 工作区。用自然语言读取页面、查询数据库、更新内容、管理知识库。', iconUrl: '', connected: false, source: 'external', tags: ['云文档', '知识库'], authUrl: 'https://www.notion.so/api/v1/oauth/authorize?response_type=code&client_id=dsh-marketplace&redirect_uri=' + encodeURIComponent(typeof location !== 'undefined' ? `${location.origin}/oauth/notion/callback` : '') },
  { id: 'feishu', name: '飞书', description: '连接飞书 IM、文档、日历、审批等全套能力。用自然语言发送消息、读写文档、查询日程。', iconUrl: '', connected: false, source: 'external', tags: ['办公协作', 'IM'], authUrl: 'https://open.feishu.cn/open-apis/authen/v2/index?app_id=dsh-marketplace&redirect_uri=' + encodeURIComponent(typeof location !== 'undefined' ? `${location.origin}/oauth/feishu/callback` : '') },
  { id: 'wecom', name: '企业微信', description: '连接企业微信通讯录、消息、应用。批量发送通知、读取消息、管理客户。', iconUrl: '', connected: false, source: 'external', tags: ['IM', '客户管理'], authUrl: 'https://login.work.weixin.qq.com/wwlogin/sso/login?appid=dsh-marketplace&redirect_uri=' + encodeURIComponent(typeof location !== 'undefined' ? `${location.origin}/oauth/wecom/callback` : '') },
  { id: 'dingtalk', name: '钉钉', description: '连接钉钉的全平台能力：AI 表格、考勤、日历、群聊与机器人、通讯录、开放平台文档、DING 消息、钉钉文档。', iconUrl: '', connected: false, source: 'external', tags: ['IM', '考勤'], authUrl: 'https://oapi.dingtalk.com/connect/oauth2/sns_authorize?appid=dsh-marketplace&response_type=code&scope=snsapi_login&redirect_uri=' + encodeURIComponent(typeof location !== 'undefined' ? `${location.origin}/oauth/dingtalk/callback` : '') },
  { id: 'tmeet', name: '腾讯会议', description: '通过命令行管理腾讯会议：即时通讯、视频会议、日程、日历、云文档、电子表格、多维表格（Base）、幻灯片。', iconUrl: '', connected: false, source: 'external', tags: ['会议', '视频'], authUrl: 'https://meeting.tencent.com/oauth/authorize?client_id=dsh-marketplace&redirect_uri=' + encodeURIComponent(typeof location !== 'undefined' ? `${location.origin}/oauth/tmeet/callback` : '') },
  { id: 'tencent-docs', name: '腾讯文档', description: '腾讯文档个人版。在线云文档平台，创建、编辑、管理文档的首选工具。', iconUrl: '', connected: false, source: 'external', tags: ['云文档'], authUrl: 'https://docs.qq.com/oauth/authorize?client_id=dsh-marketplace&redirect_uri=' + encodeURIComponent(typeof location !== 'undefined' ? `${location.origin}/oauth/tencent-docs/callback` : '') },
  { id: 'tencent-map', name: '腾讯地图', description: '调用腾讯地图全套能力：地点搜索、路线规划、地址解析、行政区划、IP 定位。', iconUrl: '', connected: false, source: 'external', tags: ['地图', '位置'], authUrl: 'https://lbs.qq.com/webapi/oauth/authorize?key=dsh-marketplace&redirect_uri=' + encodeURIComponent(typeof location !== 'undefined' ? `${location.origin}/oauth/tencent-map/callback` : '') },
  { id: 'tencent-weiyun', name: '腾讯微云', description: '查看、下载、删除微云文件，并直接从云端上传文件。生成分享链接，帮助管理微云文件。', iconUrl: '', connected: false, source: 'external', tags: ['云盘'], authUrl: 'https://www.weiyun.com/oauth/authorize?client_id=dsh-marketplace&redirect_uri=' + encodeURIComponent(typeof location !== 'undefined' ? `${location.origin}/oauth/tencent-weiyun/callback` : '') },
  { id: 'kdocs', name: '金山文档', description: '创建和管理金山文档（WPS 云文档）。支持编辑多种文档类型（Word/Excel/PDF/PPT）。', iconUrl: '', connected: false, source: 'external', tags: ['云文档', 'WPS'], authUrl: 'https://www.kdocs.cn/oauth/authorize?client_id=dsh-marketplace&redirect_uri=' + encodeURIComponent(typeof location !== 'undefined' ? `${location.origin}/oauth/kdocs/callback` : '') },
  { id: 'lark-doc', name: '飞书云文档', description: '创建、编辑飞书文档；用自然语言管理在线表格、文档和幻灯片；轻松完成内容查询、数据管理和团队协作。', iconUrl: '', connected: false, source: 'external', tags: ['云文档', '协作'], authUrl: 'https://open.feishu.cn/open-apis/authen/v2/index?app_id=dsh-marketplace-doc&redirect_uri=' + encodeURIComponent(typeof location !== 'undefined' ? `${location.origin}/oauth/lark-doc/callback` : '') },
  { id: 'lark-base', name: '飞书多维表格', description: '管理飞书多维表格（Base）：建表、字段、记录、视图、统计、公式/lookup、表单、仪表盘、workflow、角色权限。', iconUrl: '', connected: false, source: 'external', tags: ['多维表格', '数据'], authUrl: 'https://open.feishu.cn/open-apis/authen/v2/index?app_id=dsh-marketplace-base&redirect_uri=' + encodeURIComponent(typeof location !== 'undefined' ? `${location.origin}/oauth/lark-base/callback` : '') },
  { id: 'github-cli', name: 'GitHub', description: '通过命令行管理 GitHub 平台：仓库、Issue、PR、流水线制品发布操作。', iconUrl: 'https://avatars.githubusercontent.com/u/9919?v=4', connected: false, source: 'external', tags: ['代码托管', 'CI/CD'], authUrl: 'https://github.com/login/oauth/authorize?client_id=dsh-marketplace-cli' },
  { id: 'agent-mail', name: 'Agent Mail', description: '智能体邮箱 — 跨 Agent 收发邮件。', iconUrl: '', connected: false, source: 'builtin', tags: ['邮件', '智能体'], authUrl: typeof location !== 'undefined' ? `${location.origin}/oauth/agent-mail/callback` : '' },
]

/** Local-storage key that mirrors `connectorState` so a page refresh keeps
 *  the user's connection selections. Only the boolean is persisted; the
 *  OAuth round-trip still runs on every host load to pick up server-side
 *  revocations. */
/** Local-storage key for per-connector runtime parameters (API tokens,
 *  tenant ids, namespaces, …). The shape is `{[connectorId]: {key:value}}`.
 *  These flow into the composer when the user invokes the connector. */
/* The three LS_CONNECTOR_* keys are declared near the top of this module
   (above `initial`) — `initial` calls `loadConnectorParams()` during module
   evaluation, and a `const` declared further down would still be in its
   temporal dead zone at that point. The resulting ReferenceError got
   swallowed by the function's own try/catch and silently produced an empty
   param map, so saved tokens never reached the composer. Do not move them
   back down here. */

/** Per-connector runtime parameters (API tokens, namespaces, …).
 *  One schema entry per built-in connector; the keys array lists the
 *  editable fields. `required` flags keys that must be filled before the
 *  connector is considered "configured" (otherwise the card carries a ⚠
 *  marker and the composer popover surfaces the missing params). */
const CONNECTOR_PARAM_SCHEMA: ReadonlyArray<{ id: string; keys: ReadonlyArray<{ key: string; required: boolean; placeholder?: string }> }> = [
  { id: 'github',          keys: [{ key: 'token', required: true, placeholder: 'ghp_xxx (PAT)' }, { key: 'org', required: false, placeholder: 'acme-corp' }] },
  { id: 'notion',          keys: [{ key: 'token', required: true, placeholder: 'secret_xxx' }, { key: 'database_id', required: false, placeholder: '32位 ID' }] },
  { id: 'feishu',          keys: [{ key: 'app_id', required: true, placeholder: 'cli_xxx' }, { key: 'app_secret', required: true }] },
  { id: 'wecom',           keys: [{ key: 'corp_id', required: true }, { key: 'agent_id', required: true }, { key: 'secret', required: true }] },
  { id: 'dingtalk',        keys: [{ key: 'app_key', required: true }, { key: 'app_secret', required: true }, { key: 'robot_code', required: false }] },
  { id: 'tmeet',           keys: [{ key: 'sdk_app_id', required: true, placeholder: '1400xxx' }, { key: 'secret', required: true, placeholder: '应用密钥' }] },
  { id: 'tencent-docs',    keys: [{ key: 'client_id', required: true }, { key: 'client_secret', required: true }] },
  { id: 'tencent-map',     keys: [{ key: 'key', required: true }] },
  { id: 'tencent-weiyun',  keys: [{ key: 'access_token', required: true }] },
  { id: 'kdocs',           keys: [{ key: 'access_token', required: true }, { key: 'space_id', required: false }] },
  { id: 'lark-doc',        keys: [{ key: 'app_id', required: true }, { key: 'app_secret', required: true }] },
  { id: 'lark-base',       keys: [{ key: 'app_id', required: true }, { key: 'app_secret', required: true }] },
  { id: 'github-cli',      keys: [{ key: 'token', required: true }] },
  { id: 'agent-mail',      keys: [{ key: 'inbox', required: false, placeholder: 'agent@your-domain.com' }] },
]

/** Lookup helpers — single source of truth for the schema. */
export function getConnectorSchema(id: string): ReadonlyArray<{ key: string; required: boolean; placeholder?: string }> {
  return CONNECTOR_PARAM_SCHEMA.find((s) => s.id === id)?.keys ?? []
}

/** Required (config-blocking) keys for a connector. */
export function getConnectorRequiredParams(id: string): readonly string[] {
  return getConnectorSchema(id).filter((k) => k.required).map((k) => k.key)
}

/** All editable param keys (required + optional) for a connector. */
export function getConnectorAllParamKeys(id: string): readonly string[] {
  return getConnectorSchema(id).map((k) => k.key)
}

/** Detailed config status: configured flag + list of missing required keys.
 *  Used by the card ⚠ indicator and the composer popover rejection copy. */
export function getConnectorConfigStatus(id: string, params: Readonly<Record<string, string>>): {
  configured: boolean
  requiredTotal: number
  missingRequired: readonly string[]
  configuredKeys: readonly string[]
} {
  const required = getConnectorRequiredParams(id)
  const missing = required.filter((k) => (params[k] ?? '').trim().length === 0)
  const allKeys = getConnectorAllParamKeys(id).filter((k) => (params[k] ?? '').trim().length > 0)
  return {
    configured: missing.length === 0,
    requiredTotal: required.length,
    missingRequired: missing,
    configuredKeys: allKeys,
  }
}

/** Convenience: is *every* required param filled for this connector? */
export function isConnectorConfigured(id: string, params: Readonly<Record<string, string>>): boolean {
  return getConnectorConfigStatus(id, params).configured
}

/** Persisted per-connector parameters. Loaded once at module init; mutated
 *  through `setConnectorParams` from the ConnectorsTab settings drawer. */
interface ConnectorParamDict {
  [key: string]: string
}

function loadConnectorParams(): Record<string, ConnectorParamDict> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(LS_CONNECTOR_PARAMS)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Record<string, ConnectorParamDict>
    const out: Record<string, ConnectorParamDict> = {}
    for (const [id, dict] of Object.entries(parsed)) {
      if (dict === null || typeof dict !== 'object') continue
      const clean: ConnectorParamDict = {}
      for (const [k, v] of Object.entries(dict)) {
        if (typeof v === 'string' && v.length > 0) clean[k] = v
      }
      if (Object.keys(clean).length > 0) out[id] = clean
    }
    return out
  } catch { return {} }
}

function saveConnectorParams(state: Record<string, ConnectorParamDict>): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(LS_CONNECTOR_PARAMS, JSON.stringify(state)) } catch { /* quota */ }
}

/** Global expert/skill API token. Loaded once at module init; mutated through
 *  `setExpertToken` from the ExpertsTab toolbar settings dialog. */
function loadExpertToken(): string {
  if (typeof localStorage === 'undefined') return ''
  try {
    const raw = localStorage.getItem(LS_EXPERT_TOKEN)
    return typeof raw === 'string' ? raw : ''
  } catch { return '' }
}

function saveExpertToken(token: string): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(LS_EXPERT_TOKEN, token) } catch { /* quota */ }
}

/** Locally toggled expert favorites (ids). Persisted across sessions. */
function loadFavoriteExperts(): Set<number> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(LS_FAVORITE_EXPERTS)
    if (raw === null) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    const out = new Set<number>()
    for (const v of parsed) if (typeof v === 'number') out.add(v)
    return out
  } catch { return new Set() }
}

function saveFavoriteExperts(set: ReadonlySet<number>): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(LS_FAVORITE_EXPERTS, JSON.stringify(Array.from(set))) } catch { /* quota */ }
}

/** Locally toggled skill favorites (slugs). Persisted across sessions. */
function loadFavoriteSkills(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(LS_FAVORITE_SKILLS)
    if (raw === null) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    const out = new Set<string>()
    for (const v of parsed) if (typeof v === 'string') out.add(v)
    return out
  } catch { return new Set() }
}

function saveFavoriteSkills(set: ReadonlySet<string>): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(LS_FAVORITE_SKILLS, JSON.stringify(Array.from(set))) } catch { /* quota */ }
}

function loadConnectedState(): Map<string, boolean> {
  const next = new Map<string, boolean>()
  if (typeof localStorage === 'undefined') return next
  try {
    const raw = localStorage.getItem(LS_CONNECTOR_CONNECTED)
    if (raw === null) return next
    const parsed = JSON.parse(raw) as Record<string, boolean>
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'boolean') next.set(k, v)
    }
  } catch { /* ignore corrupted localStorage */ }
  return next
}

function saveConnectedState(state: Map<string, boolean>): void {
  if (typeof localStorage === 'undefined') return
  try {
    const payload: Record<string, boolean> = {}
    for (const [k, v] of state) payload[k] = v
    localStorage.setItem(LS_CONNECTOR_CONNECTED, JSON.stringify(payload))
  } catch { /* quota / private mode */ }
}

/** In-process connection state (mirrors a settings-namespace in a fuller build). */
const connectorState: Map<string, boolean> = loadConnectedState()
for (const row of BUILTIN_CONNECTORS) {
  if (!connectorState.has(row.id)) connectorState.set(row.id, false)
}

function snapshotConnectors(): ConnectorRow[] {
  return BUILTIN_CONNECTORS.map((c) => ({ ...c, connected: connectorState.get(c.id) ?? c.connected }))
}

/**
 * Direct, browser-side content recipes for connectors whose upstream API is
 * CORS-friendly. Returns `undefined` when no recipe exists for the id, so the
 * caller can fall back to the "needs a server proxy" message. Throws on a
 * genuine transport/auth failure so the caller can surface the reason.
 *
 * GitHub is the one provider that reliably works from a browser: `api.github.com`
 * sends `Access-Control-Allow-Origin: *` and accepts a PAT via `Authorization`.
 */
async function fetchConnectorContentDirect(
  id: string,
  name: string,
  params: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  if (id !== 'github' && id !== 'github-cli') return undefined
  const token = params['token'] ?? ''
  if (token.length === 0) {
    return `[${name} 已授权] 请先在 ⚙ 参数设置里填写 token 后再调用\n`
  }
  const org = params['org'] ?? ''
  // `/user/repos` is auth-only; `/orgs/{org}/repos` also serves public repos
  // unauthenticated — that gives us a useful degradation path when the saved
  // token is stale.
  const url = org.length > 0
    ? `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?per_page=5&sort=updated`
    : 'https://api.github.com/user/repos?per_page=5&sort=updated'
  const call = async (withToken: boolean): Promise<Response> => fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(withToken ? { authorization: `Bearer ${token}` } : {}),
    },
  })

  let res = await call(true)
  let degraded = ''
  if ((res.status === 401 || res.status === 403) && org.length > 0) {
    // Stale / revoked token, but the org's public repos are still readable.
    // Say so out loud rather than pretending the call succeeded.
    const authStatus = res.status
    const anon = await call(false)
    if (anon.ok) {
      res = anon
      degraded = `⚠️ 保存的 token 已失效（HTTP ${authStatus}），以下为 ${org} 的公开数据\n`
    }
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json() as { message?: unknown }
      if (typeof body.message === 'string') detail = `${res.status} ${body.message}`
    } catch { /* non-JSON error body */ }
    throw new Error(detail)
  }
  const repos = await res.json() as Array<{ full_name?: unknown; description?: unknown; updated_at?: unknown }>
  if (!Array.isArray(repos) || repos.length === 0) {
    return `[${name}] ${org.length > 0 ? `组织 ${org}` : '当前账号'} 下没有可读仓库\n`
  }
  const lines = repos.map((r) => {
    const full = typeof r.full_name === 'string' ? r.full_name : '(未知仓库)'
    const desc = typeof r.description === 'string' && r.description.length > 0 ? ` — ${r.description}` : ''
    const at = typeof r.updated_at === 'string' ? ` (更新于 ${r.updated_at.slice(0, 10)})` : ''
    return `- ${full}${at}${desc}`
  })
  const scope = org.length > 0 ? `组织 ${org}` : '我的账号'
  return `${degraded}【来自 ${name} · ${scope}】最近更新的 ${lines.length} 个仓库：\n${lines.join('\n')}\n`
}

/** A tiny snapshot store loosely matching the uSES contract the shell provides. */

/** Set of connector ids currently waiting on an OAuth popup callback. The
 *  BroadcastChannel listener below flips them to connected on receipt. */
const authBroadcastSubscribers = new Set<string>()

if (typeof BroadcastChannel !== 'undefined') {
  try {
    const channel = new BroadcastChannel('dsh-connector-auth')
    channel.addEventListener('message', (event) => {
      const data = event.data as { id?: unknown; ok?: unknown } | null
      if (data === null || typeof data !== 'object') return
      if (typeof data.id !== 'string') return
      // Pick up only the connectors we currently await — prevents a stale
      // popup from a previous page load from flipping unrelated state.
      if (!authBroadcastSubscribers.has(data.id)) return
      authBroadcastSubscribers.delete(data.id)
      // The store instance owns the write — but we need access to the
      // active instance. The instance subscribes lazily on first use
      // (see constructor).
    })
  } catch { /* BroadcastChannel unavailable */ }
}

export class MarketplaceStore {
  private snapshot: MarketplaceState = initial
  private listeners = new Set<() => void>()
  readonly store: {
    getSnapshot: () => MarketplaceState
    subscribe: (cb: () => void) => () => void
    update: (fn: (s: MarketplaceState) => MarketplaceState) => void
  }
  /** Bound so the BroadcastChannel handler (defined at module scope) can
   *  route a callback to this specific instance. */
  private readonly _handleAuthBroadcast: (event: MessageEvent) => void

  constructor() {
    this._handleAuthBroadcast = (event: MessageEvent): void => {
      const data = event.data as { id?: unknown; ok?: unknown } | null
      if (data === null || typeof data !== 'object') return
      if (typeof data.id !== 'string') return
      if (!authBroadcastSubscribers.has(data.id)) return
      const ok = data.ok === true || data.ok === undefined
      this.markConnectorConnected(data.id, ok)
    }
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const channel = new BroadcastChannel('dsh-connector-auth')
        channel.addEventListener('message', this._handleAuthBroadcast)
      } catch { /* ignore */ }
    }
    if (typeof window !== 'undefined') {
      // Some host apps embed this client inside a sandbox that drops
      // BroadcastChannel. Accept `postMessage` from the OAuth popup as a
      // fallback (popup targets its opener with `*`).
      window.addEventListener('message', this._handleAuthBroadcast)
    }
    this.store = {
      getSnapshot: () => this.snapshot,
      subscribe: (cb) => {
        this.listeners.add(cb)
        return () => { this.listeners.delete(cb) }
      },
      update: (fn) => {
        this.snapshot = fn(this.snapshot)
        for (const cb of this.listeners) cb()
      },
    }
  }

  getSnapshot(): MarketplaceState { return this.snapshot }

  setTab(tab: MarketplaceTab): void {
    this.store.update((s) => s.activeTab === tab ? s : { ...s, activeTab: tab })
    if (tab === 'experts' && this.snapshot.experts.status === 'idle') void this.loadExperts()
    if (tab === 'skills' && this.snapshot.skills.status === 'idle') void this.loadSkills()
    if (tab === 'connectors' && this.snapshot.connectors.status === 'idle') void this.loadConnectors()
  }

  /* -------- experts -------- */

  setExpertQuery(query: string): void {
    this.store.update((s) => ({ ...s, experts: { ...s.experts, query } }))
  }
  setExpertCategory(categoryId: number | null): void {
    this.store.update((s) => ({ ...s, experts: { ...s.experts, categoryId, page: 0 } }))
    void this.loadExperts()
  }

  async loadExperts(): Promise<void> {
    this.store.update((s) => ({ ...s, experts: { ...s.experts, status: 'loading', error: null } }))
    try {
      const { experts } = this.snapshot
      const params = new URLSearchParams({ page: String(experts.page), size: String(experts.size) })
      if (experts.categoryId !== null) params.set('categoryId', String(experts.categoryId))
      if (experts.query.length > 0) params.set('q', experts.query)
      const raw = await fetchJson<{ code: number; data: { items: Array<Record<string, unknown>>; total: number; page: number; size: number } }>(`/strategist?${params.toString()}`)
      const offline = isMockInUse()
      this.store.update((s) => ({
        ...s,
        isOffline: offline,
        experts: {
          ...s.experts,
          status: 'ready',
          items: (raw.data?.items ?? []).map((it) => asExpert(it, UPSTREAM)),
          total: raw.data?.total ?? 0,
          page: raw.data?.page ?? experts.page,
          size: raw.data?.size ?? experts.size,
        },
      }))
      if (this.snapshot.expertCategories.length === 0) void this.loadExpertCategories()
    } catch (error) {
      this.store.update((s) => ({ ...s, isOffline: isMockInUse(), experts: { ...s.experts, status: 'error', error: messageOf(error) } }))
    }
  }

  async loadExpertCategories(): Promise<void> {
    try {
      const raw = await fetchJson<{ code: number; data: Array<Record<string, unknown>> }>('/strategist/categories')
      const offline = isMockInUse()
      this.store.update((s) => ({ ...s, isOffline: offline, expertCategories: (raw.data ?? []).map(asCategory) }))
    } catch { /* best-effort — keep the pill in whatever state it was */ }
  }

  async loadExpertDetail(id: number): Promise<void> {
    this.store.update((s) => ({ ...s, expertDetail: { status: 'loading', expert: null, error: null } }))
    try {
      const raw = await fetchJson<{ code: number; data: Record<string, unknown> }>(`/strategist/${id}`)
      this.store.update((s) => ({ ...s, expertDetail: { status: 'ready', expert: asExpertDetail(raw.data ?? {}, UPSTREAM), error: null } }))
    } catch (error) {
      this.store.update((s) => ({ ...s, expertDetail: { status: 'error', expert: null, error: messageOf(error) } }))
    }
  }

  closeExpertDetail(): void {
    this.store.update((s) => ({ ...s, expertDetail: { status: 'idle', expert: null, error: null } }))
  }

  /* -------- skills -------- */

  setSkillQuery(query: string): void {
    this.store.update((s) => ({ ...s, skills: { ...s.skills, query } }))
  }
  setSkillSort(sort: 'newest' | 'relevance'): void {
    this.store.update((s) => ({ ...s, skills: { ...s.skills, sort } }))
    void this.loadSkills()
  }
  setStarredOnly(starredOnly: boolean): void {
    this.store.update((s) => ({ ...s, skills: { ...s.skills, starredOnly } }))
    void this.loadSkills()
  }

  async loadSkills(): Promise<void> {
    this.store.update((s) => ({ ...s, skills: { ...s.skills, status: 'loading', error: null } }))
    try {
      const { skills } = this.snapshot
      const params = new URLSearchParams({ q: skills.query, sort: skills.sort, page: '0', starredOnly: String(skills.starredOnly) })
      let raw: { items: Array<Record<string, unknown>>; nextCursor: string | null }
      try {
        raw = await fetchJson<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>(`/skills?${params.toString()}`)
      } catch {
        // /skills may be unavailable in some deployments — fall back to /search.
        const fb = await fetchJson<{ results: Array<Record<string, unknown>> }>(`/search?${params.toString()}`)
        raw = { items: fb.results ?? [], nextCursor: null }
      }
      const offline = isMockInUse()
      this.store.update((s) => ({
        ...s,
        isOffline: offline,
        skills: {
          ...s.skills,
          status: 'ready',
          items: raw.items.map(asSkill),
          nextCursor: raw.nextCursor ?? null,
        },
      }))
    } catch (error) {
      this.store.update((s) => ({ ...s, isOffline: isMockInUse(), skills: { ...s.skills, status: 'error', error: messageOf(error) } }))
    }
  }

  async loadSkillDetail(slug: string): Promise<void> {
    this.store.update((s) => ({ ...s, skillDetail: { status: 'loading', skill: null, error: null } }))
    try {
      const raw = await fetchJson<{ skill: Record<string, unknown> }>(`/skills/${encodeURIComponent(slug)}`)
      this.store.update((s) => ({ ...s, skillDetail: { status: 'ready', skill: asSkillDetail(raw.skill ?? {}), error: null } }))
    } catch (error) {
      this.store.update((s) => ({ ...s, skillDetail: { status: 'error', skill: null, error: messageOf(error) } }))
    }
  }

  closeSkillDetail(): void {
    this.store.update((s) => ({ ...s, skillDetail: { status: 'idle', skill: null, error: null } }))
  }

  /* -------- connectors -------- */

  async loadConnectors(): Promise<void> {
    this.store.update((s) => ({ ...s, connectors: { ...s.connectors, status: 'loading', error: null } }))
    // Static catalog — simulate a fetch so the UI shows a brief loading state.
    await new Promise((r) => setTimeout(r, 120))
    this.store.update((s) => ({ ...s, connectors: { ...s.connectors, status: 'ready', items: snapshotConnectors() } }))
  }

  /** Connect / disconnect a connector. When the row carries an `authUrl`,
   *  connecting means opening that URL in a new window (the real OAuth
   *  step). The catalog page keeps showing 未连接 until the OAuth popup
   *  broadcasts back via `BroadcastChannel('dsh-connector-auth')` with
   *  `{ id, ok: true }` — see `subscribeToAuthBroadcast`. Disconnect
   *  flips local state synchronously and removes the persisted flag.
   *  Returns `{ openedPopup: boolean, awaiting: boolean }` so the caller
   *  can show appropriate copy (popup-blocked hint vs. awaiting-callback
   *  spinner). */
  async setConnector(id: string, connected: boolean): Promise<{ openedPopup: boolean; awaiting: boolean }> {
    const row = BUILTIN_CONNECTORS.find((c) => c.id === id)
    const authUrl = row?.authUrl
    if (connected && typeof authUrl === 'string' && authUrl.length > 0) {
      this.store.update((s) => ({ ...s, pendingConnectorId: id }))
      let popup: Window | null = null
      if (typeof window !== 'undefined') {
        popup = window.open(authUrl, '_blank', 'noopener=yes')
      }
      const openedPopup = popup !== null
      if (!openedPopup) {
        // Pop-up blocker or sandboxed embed: revert the pending flag and
        // surface a hint. We do NOT mark the connector connected — the
        // user has to approve the auth window for the OAuth round-trip.
        this.store.update((s) => ({ ...s, pendingConnectorId: null }))
        return { openedPopup: false, awaiting: false }
      }
      if (typeof authBroadcastSubscribers !== 'undefined') {
        authBroadcastSubscribers.add(id)
      }
      // Hard timeout: if the OAuth flow never reports back (server died,
      // user abandoned the tab) drop the pending flag and let them retry.
      setTimeout(() => {
        if (typeof authBroadcastSubscribers !== 'undefined') {
          authBroadcastSubscribers.delete(id)
        }
        this.store.update((s) => s.pendingConnectorId === id ? { ...s, pendingConnectorId: null } : s)
      }, 5 * 60 * 1000)
      return { openedPopup: true, awaiting: true }
    }
    // No auth URL → simple on/off toggle (used for 自定义 connectors that
    // wire straight to the host without a browser redirect).
    this.store.update((s) => ({ ...s, pendingConnectorId: id }))
    await new Promise((r) => setTimeout(r, 200))
    connectorState.set(id, connected)
    saveConnectedState(connectorState)
    this.store.update((s) => ({
      ...s,
      pendingConnectorId: null,
      connectors: {
        ...s.connectors,
        items: s.connectors.items.map((c) => c.id === id ? { ...c, connected } : c),
      },
    }))
    return { openedPopup: true, awaiting: false }
  }

  /** Finalize a connector connection — called by the OAuth popup's
   *  broadcast listener when the upstream sends back the success
   *  message. The popup also closes itself; we just persist. */
  markConnectorConnected(id: string, connected: boolean): void {
    if (!BUILTIN_CONNECTORS.some((c) => c.id === id)) return
    connectorState.set(id, connected)
    saveConnectedState(connectorState)
    this.store.update((s) => ({
      ...s,
      pendingConnectorId: null,
      connectors: {
        ...s.connectors,
        items: s.connectors.items.map((c) => c.id === id ? { ...c, connected } : c),
      },
    }))
  }

  /** Reload connectors from the gateway's authoritative list. Currently
   *  no-op (the static catalog is the source of truth here); the method
   *  exists so the UI 重试 button is wired to a real refresh path. */
  async reloadConnectors(): Promise<void> {
    await this.loadConnectors()
  }

  /* -------- install state (skills + experts) -------- */

  /** True iff the given skill has been locally downloaded. */
  isSkillInstalled(slug: string): boolean {
    return this.snapshot.install.installedSkills.has(slug)
  }

  /** True iff the given expert is fully installed (all bundled skills). */
  isExpertInstalled(expertId: number): boolean {
    return this.snapshot.install.installedExperts.has(expertId)
  }

  /** Simulate a skill download. Real builds would fetch a payload via api.ts;
   *  here we just toggle the flag after a short spinner window so the UI
   *  behavior (button → spinner → check) is testable end to end. */
  installSkill(slug: string): Promise<void> {
    if (this.snapshot.install.downloadingSkills.has(slug)) {
      return Promise.resolve()
    }
    this.store.update((s) => {
      const downloading = new Set(s.install.downloadingSkills)
      downloading.add(slug)
      return { ...s, install: { ...s.install, downloadingSkills: downloading } }
    })
    return new Promise((resolve) => {
      // Spinner window — ~700ms feels like a real install without burning time.
      setTimeout(() => {
        this.store.update((s) => {
          const installed = new Set(s.install.installedSkills)
          installed.add(slug)
          const downloading = new Set(s.install.downloadingSkills)
          downloading.delete(slug)
          const next: InstallState = { ...s.install, installedSkills: installed, downloadingSkills: downloading }
          saveInstallState(next)
          return { ...s, install: next }
        })
        resolve()
      }, 700)
    })
  }

  /** Read the persisted params for a connector (empty object if none). */
  getConnectorParams(id: string): Readonly<Record<string, string>> {
    return this.snapshot.connectorParams[id] ?? {}
  }

  /** Replace the params for a connector; persists immediately. Pass an
   *  empty object to wipe them. The store event triggers the composer
   *  popover (host-side wiring) to re-render enabled toggles. */
  setConnectorParams(id: string, params: Readonly<Record<string, string>>): void {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string' && v.length > 0) clean[k] = v
    }
    const next: Record<string, Readonly<Record<string, string>>> = { ...this.snapshot.connectorParams }
    if (Object.keys(clean).length === 0) delete next[id]
    else next[id] = clean
    saveConnectorParams(next as Record<string, ConnectorParamDict>)
    this.store.update((s) => ({ ...s, connectorParams: next }))
  }

  /** Read the persisted global API token (empty string if unset). */
  getExpertToken(): string {
    return this.snapshot.expertToken
  }

  /** Replace the global API token; persists immediately. Pass an empty string
   *  to wipe it. */
  setExpertToken(token: string): void {
    const next = token.trim()
    saveExpertToken(next)
    this.store.update((s) => ({ ...s, expertToken: next }))
  }

  /** Whether an expert is locally favorited. Overrides the API `favorited`. */
  isExpertFavorited(id: number): boolean {
    return this.snapshot.favoriteExperts.has(id)
  }

  /** Toggle an expert's local favorite flag; persists immediately. */
  toggleExpertFavorite(id: number): void {
    const next = new Set(this.snapshot.favoriteExperts)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    saveFavoriteExperts(next)
    this.store.update((s) => ({ ...s, favoriteExperts: next }))
  }

  /** Whether a skill is locally favorited. */
  isSkillFavorited(slug: string): boolean {
    return this.snapshot.favoriteSkills.has(slug)
  }

  /** Toggle a skill's local favorite flag; persists immediately. */
  toggleSkillFavorite(slug: string): void {
    const next = new Set(this.snapshot.favoriteSkills)
    if (next.has(slug)) next.delete(slug)
    else next.add(slug)
    saveFavoriteSkills(next)
    this.store.update((s) => ({ ...s, favoriteSkills: next }))
  }

  /** Read the persisted per-connector enabled flags for the composer
   *  popover. Stored separately so the user can toggle without
   *  disconnecting the connector (a disabled toggle hides the chip and
   *  skips the actual API roundtrip). Reads from the snapshot so the
   *  ConnectorsTab re-renders the moment the user flips a switch. */
  isConnectorEnabled(id: string): boolean {
    const v = this.snapshot.connectorEnabled[id]
    return v === undefined ? true : Boolean(v)
  }

  setConnectorEnabled(id: string, enabled: boolean): void {
    const next: Record<string, boolean> = { ...this.snapshot.connectorEnabled }
    if (enabled) delete next[id]
    else next[id] = false
    saveEnabledState(next)
    // Snapshot update → triggers uSES subscribers (ConnectorsTab cards
    // and the composer popover both re-render). The bridge's listener on
    // `dsh:connector-toggle` still re-renders the chip dot, but is no
    // longer the only path that keeps things fresh.
    this.store.update((s) => ({ ...s, connectorEnabled: next }))
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dsh:connector-toggle', { detail: { id, enabled } }))
    }
  }

  /** Pull real content out of a connected connector and return the text to
   *  insert into the composer.
   *
   *  Resolution order (first success wins):
   *    1. Host-side proxy `/api/connectors/{id}/content` — the correct route
   *       for OAuth-bearing APIs, because the browser must not hold upstream
   *       tokens and most providers send no CORS headers. Absent in this
   *       build (404), tried first so it lights up for free once it ships.
   *    2. A per-connector direct recipe, using the params the user saved in
   *       the ⚙ settings drawer. Only viable for CORS-friendly providers —
   *       GitHub is the one that genuinely works from the browser.
   *    3. An explicit failure line naming the connector, the params that
   *       were configured, and the concrete reason — never a silent no-op.
   */
  async fetchConnectorSnippet(id: string): Promise<string> {
    const row = BUILTIN_CONNECTORS.find((c) => c.id === id)
    const name = row?.name ?? id
    const params = this.getConnectorParams(id)

    // 1 — host proxy.
    try {
      const res = await fetch(`/api/connectors/${encodeURIComponent(id)}/content`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params }),
      })
      if (res.ok) {
        const data = await res.json() as { text?: unknown }
        if (typeof data.text === 'string' && data.text.trim().length > 0) {
          return `${data.text.trim()}\n`
        }
      }
    } catch { /* proxy absent — fall through to the direct recipe */ }

    // 2 — direct recipe.
    try {
      const direct = await fetchConnectorContentDirect(id, name, params)
      if (direct !== undefined) return direct
    } catch (error) {
      const cfg = Object.keys(params)
      const hint = cfg.length > 0 ? `已配置参数 ${cfg.join('/')}` : '未配置参数'
      return `[${name}] 取内容失败：${messageOf(error)}（${hint}）\n`
    }

    // 3 — no recipe for this connector.
    const cfg = Object.keys(params)
    const hint = cfg.length > 0 ? `已配置参数 ${cfg.join('/')}` : '尚未在 ⚙ 参数设置中填写凭据'
    return `[${name} 已授权] 该连接器需要服务端代理才能取内容（${hint}）\n`
  }

  /** Simulate downloading an expert + all its bundled skills. Tracks per-id
   *  downloading state so the UI can show "下载中" inside the summon button.
   *
   *  `skills` lists the slugs of the expert's bundled skills — summoning an
   *  expert downloads those skills to local too, so they are marked
   *  installed atomically with the expert itself. When omitted, the slugs
   *  are resolved from the expert detail endpoint (best-effort: on failure
   *  only the expert itself is marked installed). */
  async installExpert(expertId: number, skills?: ReadonlyArray<string>): Promise<void> {
    if (this.snapshot.install.downloadingExperts.has(expertId)) {
      return Promise.resolve()
    }
    this.store.update((s) => {
      const downloading = new Set(s.install.downloadingExperts)
      downloading.add(expertId)
      return { ...s, install: { ...s.install, downloadingExperts: downloading } }
    })
    // Resolve bundled skills while the spinner runs so the whole summon
    // stays a single user-visible download.
    let bundled: readonly string[] = skills ?? []
    if (skills === undefined) {
      bundled = await this.fetchExpertSkillSlugs(expertId)
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        this.store.update((s) => {
          const installed = new Set(s.install.installedExperts)
          installed.add(expertId)
          const downloading = new Set(s.install.downloadingExperts)
          downloading.delete(expertId)
          const next: InstallState = { ...s.install, installedExperts: installed, downloadingExperts: downloading }
          // Bundled skills land in local storage alongside the expert so
          // the Skills tab shows them as "已下载" without a second click.
          if (bundled.length > 0) {
            const installedSkills = new Set(next.installedSkills)
            for (const slug of bundled) installedSkills.add(slug)
            next.installedSkills = installedSkills
          }
          saveInstallState(next)
          return { ...s, install: next }
        })
        resolve()
      }, 800)
    })
  }

  /** Slugs of an expert's bundled skills from the detail endpoint.
   *  Best-effort: returns an empty array when the detail call fails — the
   *  expert alone still installs, the skills just stay "未下载". */
  private async fetchExpertSkillSlugs(expertId: number): Promise<readonly string[]> {
    try {
      const raw = await fetchJson<{ code: number; data: Record<string, unknown> }>(`/strategist/${expertId}`)
      const data = raw.data ?? {}
      if (!Array.isArray(data['skills'])) return []
      const slugs: string[] = []
      for (const entry of data['skills'] as Array<Record<string, unknown>>) {
        const slug = entry['skillSlug']
        if (typeof slug === 'string' && slug.length > 0) slugs.push(slug)
      }
      return slugs
    } catch {
      return []
    }
  }

  /** Publish a new skill to skill.dualpaw.com using the saved API token.
   *
   *  Goes through the same CORS relay as the catalog reads; if every relay
   *  hop fails the promise rejects with a descriptive message so the dialog
   *  can show `skillPublishFailed` instead of a silent no-op. A successful
   *  publish refreshes the skill list so the new entry appears. */
  async publishSkill(input: {
    name: string
    description: string
    instructions: string
  }): Promise<void> {
    const token = this.snapshot.expertToken
    if (token.length === 0) {
      return Promise.reject(new Error('missing token'))
    }
    await postJson('/skills', {
      name: input.name,
      displayName: input.name,
      summary: input.description,
      content: input.instructions,
    }, token)
    await this.loadSkills()
  }
}

/**
 * React hook binding a component to the marketplace store. Uses
 * `useSyncExternalStore` so the panel (and its tab children, which read
 * `controller.store.getSnapshot()` during the parent's re-render) refresh
 * whenever the snapshot is replaced.
 */
export function useMarketplaceSnapshot(store: MarketplaceStore): MarketplaceState {
  return useSyncExternalStore(
    (cb: () => void) => store.store.subscribe(cb),
    () => store.store.getSnapshot(),
    () => store.store.getSnapshot(),
  )
}
