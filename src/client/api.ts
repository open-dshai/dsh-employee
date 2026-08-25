/**
 * Browser-only data access for the Marketplace plugin.
 *
 * `skill.dualpaw.com` does not send CORS headers, so a direct `fetch` from
 * the browser is blocked. This module relays every call through a small
 * rotation of public CORS proxies, falling back on failure. When EVERY
 * proxy is unreachable (network down, DNS blocked, 4xx/5xx) we serve a
 * small bundled dataset so the marketplace still has real-shaped entries
 * to show; the UI surfaces this with a "本地数据" pill. A production
 * deployment would instead proxy these calls through its own host
 * (`/api/marketplace/*`); the proxy list below is the zero-backend path
 * that keeps the plugin self-contained.
 */

const UPSTREAM_BASE = 'https://skill.dualpaw.com/api/v1'

/** Public CORS proxies — each wraps the target URL into a fetchable URL. */
const PROXIES: ReadonlyArray<(target: string) => string> = [
  (target) => `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
  (target) => `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
  (target) => `https://thingproxy.freeboard.io/fetch/${target}`,
]

/** Per-proxy fetch timeout. 3s is enough to ride out a slow proxy without
 *  making the user wait too long when everything is down. */
const PROXY_TIMEOUT_MS = 3000

/** Whether the most recent `fetchJson` call fell back to bundled mock data.
 *  The store reads this flag after each call to flip the UI's "本地数据"
 *  pill. Reset at the start of every call so the flag always reflects the
 *  outcome of the *current* call, not a stale one. */
let mockInUse = false
export function isMockInUse(): boolean { return mockInUse }

/* ── Bundled fallback dataset ──────────────────────────────────────────────
 * Loaded only when every upstream proxy fails. Shapes match what the
 * upstream returns, so the existing `asExpert` / `asSkill` / `asCategory`
 * mappers do not need to know whether the payload is real or mocked. */

/** Stamp `updatedAt` on the mock skills so the "newest" sort order is
 *  stable across loads. Numbers decrease per entry so the first items are
 *  the freshest. */
const MOCK_NOW = Math.floor(Date.now() / 1000)

const MOCK_CATEGORIES: ReadonlyArray<Record<string, unknown>> = [
  { id: 1, name: '财务金融', code: 'finance', icon: '💰', strategistCount: 2 },
  { id: 2, name: '电商服务', code: 'ecommerce', icon: '🛒', strategistCount: 2 },
  { id: 3, name: '办公效率', code: 'office', icon: '📋', strategistCount: 2 },
  { id: 4, name: '内容创作', code: 'content', icon: '✍️', strategistCount: 2 },
  { id: 5, name: '开发编程', code: 'dev', icon: '💻', strategistCount: 2 },
  { id: 6, name: '数据分析', code: 'data', icon: '📊', strategistCount: 2 },
]

const MOCK_EXPERTS: ReadonlyArray<Record<string, unknown>> = [
  { id: 101, name: '财报分析', slug: 'finance-report', avatarUrl: '', intro: '快速解读上市公司财报，提取关键财务指标、利润结构与现金流变动，用自然语言回答投资相关问题。', category: { id: 1, name: '财务金融', code: 'finance', icon: '💰' }, favoriteCount: 128, favorited: false },
  { id: 102, name: '量化回测', slug: 'quant-backtest', avatarUrl: '', intro: '基于历史行情数据回测多因子选股策略、动量反转与均线交叉等常见量化模型，输出收益曲线与风险指标。', category: { id: 1, name: '财务金融', code: 'finance', icon: '💰' }, favoriteCount: 96, favorited: true },
  { id: 201, name: '选品分析', slug: 'product-selection', avatarUrl: '', intro: '覆盖 Amazon、Temu、TikTok Shop 等平台的爆款筛选、利润测算与 1688 进货价对比，输出可落地的选品建议。', category: { id: 2, name: '电商服务', code: 'ecommerce', icon: '🛒' }, favoriteCount: 256, favorited: false },
  { id: 202, name: '广告文案', slug: 'ad-copy', avatarUrl: '', intro: '结合 AIDA / PAS / FAB 文案框架与各平台爆款公式，生成高转化的落地页、详情页与广告标题文案。', category: { id: 2, name: '电商服务', code: 'ecommerce', icon: '🛒' }, favoriteCount: 312, favorited: false },
  { id: 301, name: '会议纪要', slug: 'meeting-summary', avatarUrl: '', intro: '接入飞书、腾讯会议、Zoom，自动转写并整理结构化的会议纪要、待办与责任人。', category: { id: 3, name: '办公效率', code: 'office', icon: '📋' }, favoriteCount: 89, favorited: false },
  { id: 302, name: '周报生成', slug: 'weekly-report', avatarUrl: '', intro: '汇总本周代码提交、文档更新与沟通记录，按模板自动生成结构化周报草稿。', category: { id: 3, name: '办公效率', code: 'office', icon: '📋' }, favoriteCount: 145, favorited: true },
  { id: 401, name: '视频脚本', slug: 'video-script', avatarUrl: '', intro: '为短视频口播、剧情号、种草视频设计开篇钩子、节奏分镜与 CTA 收尾，支持多平台调性。', category: { id: 4, name: '内容创作', code: 'content', icon: '✍️' }, favoriteCount: 198, favorited: false },
  { id: 402, name: '公众号写作', slug: 'wechat-writing', avatarUrl: '', intro: '针对公众号长文的选题策划、标题打磨、首段钩子与排版美化，输出可直接发布的内容。', category: { id: 4, name: '内容创作', code: 'content', icon: '✍️' }, favoriteCount: 167, favorited: false },
  { id: 501, name: '代码审查', slug: 'code-review', avatarUrl: '', intro: '对 Git 提交的 diff 做静态分析与最佳实践审查，给出可读性、性能、安全与可维护性建议。', category: { id: 5, name: '开发编程', code: 'dev', icon: '💻' }, favoriteCount: 234, favorited: true },
  { id: 502, name: 'API 设计', slug: 'api-design', avatarUrl: '', intro: 'RESTful / GraphQL 接口的命名、版本控制、错误码与分页设计评审，输出可直接落地的接口契约。', category: { id: 5, name: '开发编程', code: 'dev', icon: '💻' }, favoriteCount: 76, favorited: false },
  { id: 601, name: '数据可视化', slug: 'data-viz', avatarUrl: '', intro: '根据数据维度推荐最合适的图表类型与配色方案，给出 ECharts / Recharts 可直接复用的代码。', category: { id: 6, name: '数据分析', code: 'data', icon: '📊' }, favoriteCount: 123, favorited: false },
  { id: 602, name: '商业分析', slug: 'business-analysis', avatarUrl: '', intro: '拆解 DAU / 留存 / 转化漏斗等核心指标，结合 A/B 测试结果输出业务归因与下一步动作建议。', category: { id: 6, name: '数据分析', code: 'data', icon: '📊' }, favoriteCount: 187, favorited: false },
]

const MOCK_SKILLS: ReadonlyArray<Record<string, unknown>> = [
  { slug: 'git-commit-helper', displayName: 'Git 提交规范助手', summary: '检查 commit message 是否符合 Conventional Commits 规范，自动建议 type / scope 拆分。', version: '1.2.0', tags: { 开发: '开发', git: 'git' }, stats: { downloads: 1234, stars: 56 }, updatedAt: MOCK_NOW - 0 * 86400, favorited: false },
  { slug: 'dockerfile-optimizer', displayName: 'Dockerfile 优化建议', summary: '分析 Dockerfile 层级、缓存命中率与镜像体积，给出多阶段构建与基础镜像替换建议。', version: '2.0.1', tags: { 运维: '运维', docker: 'docker' }, stats: { downloads: 892, stars: 34 }, updatedAt: MOCK_NOW - 1 * 86400, favorited: false },
  { slug: 'seo-keyword-analyzer', displayName: 'SEO 关键词分析', summary: '拆解目标关键词的搜索量、竞争度与语义相关性，输出长尾词与内容大纲建议。', version: '1.5.0', tags: { 营销: '营销', seo: 'seo' }, stats: { downloads: 2156, stars: 102 }, updatedAt: MOCK_NOW - 2 * 86400, favorited: true },
  { slug: 'chart-codegen', displayName: '图表代码生成', summary: '把自然语言描述的数据自动转成 ECharts / Recharts / Chart.js 的可运行代码片段。', version: '3.1.0', tags: { 开发: '开发', 可视化: '可视化' }, stats: { downloads: 1678, stars: 89 }, updatedAt: MOCK_NOW - 3 * 86400, favorited: false },
  { slug: 'csv-cleaner', displayName: 'CSV 数据清洗', summary: '识别 CSV 中的脏数据、空值、编码问题与重复行，输出清洗后的结构化表格。', version: '1.0.3', tags: { 数据: '数据', csv: 'csv' }, stats: { downloads: 543, stars: 21 }, updatedAt: MOCK_NOW - 4 * 86400, favorited: false },
  { slug: 'json-formatter', displayName: 'JSON 格式化校验', summary: '格式化压缩的 JSON、检测语法错误、按 key 排序并支持 schema 校验。', version: '0.9.5', tags: { 开发: '开发', json: 'json' }, stats: { downloads: 3421, stars: 145 }, updatedAt: MOCK_NOW - 5 * 86400, favorited: true },
  { slug: 'regex-tester', displayName: '正则表达式测试', summary: '可视化测试正则匹配结果，给出常见陷阱与性能优化建议，支持多 flag 组合。', version: '1.3.2', tags: { 开发: '开发', regex: 'regex' }, stats: { downloads: 1876, stars: 67 }, updatedAt: MOCK_NOW - 6 * 86400, favorited: false },
  { slug: 'zh-en-translator', displayName: '中英互译助手', summary: '针对技术文档与商务场景优化的中英互译，支持术语表与语域切换。', version: '2.4.0', tags: { 翻译: '翻译', 语言: '语言' }, stats: { downloads: 4521, stars: 198 }, updatedAt: MOCK_NOW - 7 * 86400, favorited: true },
  { slug: 'markdown-beautifier', displayName: 'Markdown 排版美化', summary: '统一标题层级、列表样式、代码块围栏与表格对齐，输出可读性更强的 Markdown。', version: '1.1.0', tags: { 写作: '写作', markdown: 'markdown' }, stats: { downloads: 2890, stars: 112 }, updatedAt: MOCK_NOW - 8 * 86400, favorited: false },
  { slug: 'cron-explainer', displayName: 'Cron 表达式解读', summary: '把 Cron 表达式翻译成自然语言描述，支持 * / , - 等符号与 @every / @daily 简写。', version: '0.8.0', tags: { 运维: '运维', cron: 'cron' }, stats: { downloads: 678, stars: 28 }, updatedAt: MOCK_NOW - 9 * 86400, favorited: false },
]

/** Return a mock payload for `path`, or `undefined` when no mock covers it.
 *  The shapes mirror the upstream so the existing mappers (`asExpert`,
 *  `asSkill`, `asCategory`, `asExpertDetail`, `asSkillDetail`) accept the
 *  result without branching on real-vs-mock. Client-side filters in
 *  ExpertsTab / SkillsTab handle search / category / sort refinement on
 *  top of the full mock, so the fallback does not need to honour them. */
function mockPayloadFor<T>(path: string): T | undefined {
  const [base, query] = path.split('?')

  if (base === '/strategist/categories') {
    return { code: 0, data: MOCK_CATEGORIES } as unknown as T
  }

  if (base === '/strategist') {
    const params = new URLSearchParams(query ?? '')
    const size = Math.max(1, Math.min(50, Number(params.get('size') ?? '20')))
    const page = Math.max(0, Number(params.get('page') ?? '0'))
    const start = page * size
    const slice = MOCK_EXPERTS.slice(start, start + size)
    return {
      code: 0,
      data: {
        items: slice,
        total: MOCK_EXPERTS.length,
        page,
        size,
      },
    } as unknown as T
  }

  if (base === '/skills') {
    const params = new URLSearchParams(query ?? '')
    const starredOnly = params.get('starredOnly') === 'true'
    let items = MOCK_SKILLS.slice()
    if (starredOnly) items = items.filter((s) => s['favorited'] === true)
    const sort = params.get('sort') ?? 'newest'
    if (sort === 'newest') {
      items.sort((a, b) => Number(b['updatedAt'] ?? 0) - Number(a['updatedAt'] ?? 0))
    }
    return { items, nextCursor: null } as unknown as T
  }

  // Detail endpoints — return a single record that the mapper can shape.
  // Match the upstream envelope: `/strategist/{id}` → `{ code, data }`,
  // `/skills/{slug}` → `{ skill }`.
  if (base !== undefined && base.startsWith('/strategist/')) {
    const id = Number(base.slice('/strategist/'.length))
    const expert = MOCK_EXPERTS.find((e) => e['id'] === id)
    if (expert !== undefined) {
      return {
        code: 0,
        data: {
          ...expert,
          content: `${String(expert['intro'] ?? '')}\n\n（当前为离线数据，详细内容请稍后重试。）`,
        },
      } as unknown as T
    }
  }
  if (base !== undefined && base.startsWith('/skills/')) {
    const slug = decodeURIComponent(base.slice('/skills/'.length))
    // A skill may be looked up under its Chinese display name when the
    // upstream left `slug` empty and the client derived the install slug
    // from the (sanitized) display name. Match either form.
    const slugify = (s: string): string => s.trim().replace(/[\s/\\]+/g, '-').replace(/^-+|-+$/g, '')
    const skill = MOCK_SKILLS.find(
      (s) => s['slug'] === slug || slugify(String(s['displayName'] ?? '')) === slug,
    )
    if (skill !== undefined) {
      return {
        code: 0,
        skill: {
          ...skill,
          description: `${String(skill['summary'] ?? '')}\n\n（当前为离线数据，详细说明请稍后重试。）`,
          instructions: '把自然语言需求交给本技能即可，遵循上文「summary」中描述的边界与输出格式。',
        },
      } as unknown as T
    }
  }

  return undefined
}

/** Whether a URL is absolute (proxy output) or relative (needs the upstream host). */
function absolutize(upstream: string, maybe: string | undefined | null): string {
  if (maybe === undefined || maybe === null || maybe === '') return ''
  if (maybe.startsWith('http://') || maybe.startsWith('https://') || maybe.startsWith('data:')) return maybe
  if (maybe.startsWith('/')) return `${upstream.replace(/\/api\/v1$/, '')}${maybe}`
  return maybe
}

/** Wrap a fetch in an `AbortController` with a hard timeout. The timer is
 *  cleared on both success and failure so it never leaks. */
function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

/** Fetch JSON from the upstream, trying each proxy in order. If every proxy
 *  fails (network down, DNS blocked, 4xx/5xx), falls back to a bundled mock
 *  payload when one exists for the path. Throws only when no fallback is
 *  available. After every call, `isMockInUse()` reflects whether the
 *  fallback was used — the store reads that to show a "本地数据" pill. */
export async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  mockInUse = false
  const target = `${UPSTREAM_BASE}${path}`
  let lastErr: unknown = new Error('All CORS proxies failed')
  for (const wrap of PROXIES) {
    try {
      const init: RequestInit = { headers: { 'Accept': 'application/json' } }
      if (signal !== undefined) init.signal = signal
      const resp = await fetchWithTimeout(wrap(target), init, PROXY_TIMEOUT_MS)
      if (!resp.ok) {
        lastErr = new Error(`proxy returned ${resp.status} for ${target}`)
        continue
      }
      return (await resp.json()) as T
    } catch (error) {
      lastErr = error
    }
  }
  const mock = mockPayloadFor<T>(path)
  if (mock !== undefined) {
    mockInUse = true
    return mock
  }
  throw lastErr
}

export { absolutize, UPSTREAM_BASE }

/** POST JSON to the upstream through the same proxy rotation. Used by
 *  authenticated mutations (publish skill, upstream favorites) — there is
 *  deliberately NO mock fallback: a total proxy failure must surface as a
 *  thrown error so the UI can show "发布失败" instead of a silent no-op.
 *  Returns the first non-2xx-free `Response`; throws when every proxy
 *  fails or every reachable proxy answers non-OK. */
export async function postJson(path: string, body: unknown, token: string): Promise<void> {
  mockInUse = false
  const target = `${UPSTREAM_BASE}${path}`
  let lastErr: unknown = new Error('All CORS proxies failed')
  for (const wrap of PROXIES) {
    try {
      const resp = await fetchWithTimeout(wrap(target), {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      }, PROXY_TIMEOUT_MS)
      if (!resp.ok) {
        lastErr = new Error(`proxy returned ${resp.status} for ${target}`)
        continue
      }
      // Drain the body so the connection is released before we return.
      await resp.text()
      return
    } catch (error) {
      lastErr = error
    }
  }
  throw lastErr
}
