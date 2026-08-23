/**
 * Experts tab — left rail of categories, right grid of expert cards. Each
 * card opens a detail overlay; the overlay holds the "召唤" (Invoke) button.
 *
 * Behaviour:
 *  • Hover over a card reveals the summon button. It is hidden by default
 *    so the card stays visually quiet in long lists.
 *  • The summon button prefix icon shows install state (✓ installed /
 *    ⊘ not installed). It swaps the moment the user clicks.
 *  • Clicking 召唤 on a not-installed expert triggers `installExpert` first,
 *    shows "下载中" / "召唤中" inside the same button, then dispatches the
 *    `dsh:invoke-expert` event so the composer takes over as usual.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { IconLikeOutline16, IconSearchOutline16, IconSettingsOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketplaceStore, ExpertRow, ExpertCategoryRow } from './store.ts'
import { useMarketplaceSnapshot } from './store.ts'
import { MarketplaceSettingsDialog } from './MarketplaceSettingsDialog.tsx'
import type { en } from './locales.ts'
import styles from './styles.module.css'

export interface ExpertsTabProps {
  controller: MarketplaceStore
  t: (key: keyof typeof en) => string
}

/** First character of the expert name as a fallback avatar. */
function avatarFallback(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  // Prefer a CJK character; otherwise the first ASCII letter.
  return Array.from(trimmed)[0]?.toUpperCase() ?? '?'
}

/** Card avatar (image or fallback character). */
function Avatar({ name, url }: { name: string; url: string }): JSX.Element {
  if (url.length > 0) {
    return (
      <div className={styles.avatar}>
        <img src={url} alt="" loading="lazy" onError={(e) => { (e.currentTarget.style.display = 'none') }} />
      </div>
    )
  }
  return <div className={styles.avatar}>{avatarFallback(name)}</div>
}

/**
 * The experts tab body: search + category rail + grid. A debounce of 250ms
 * keeps the upstream call from firing on every keystroke; clearing the box
 * resets the page so the user lands back on the first batch.
 */
export function ExpertsTab({ controller, t }: ExpertsTabProps): JSX.Element {
  // Subscribe to the snapshot so query/category/load-status changes flip a
  // re-render. Without this hook the component reads the store once on
  // mount and never refreshes — making the search appear "broken".
  const state = useMarketplaceSnapshot(controller)
  const [queryDraft, setQueryDraft] = useState(state.experts.query)
  /** Whether the global token dialog is open. */
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false)

  // Sync the local draft when the store is reset externally (e.g. tab
  // switch) — but skip while the user is mid-typing.
  useEffect(() => {
    setQueryDraft((prev) => prev === state.experts.query ? prev : state.experts.query)
  }, [state.experts.query])

  // Debounce query updates so the upstream sees a stable text.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (queryDraft !== state.experts.query) {
        controller.setExpertQuery(queryDraft)
        void controller.loadExperts()
      }
    }, 250)
    return () => clearTimeout(handle)
  }, [queryDraft, controller, state.experts.query])

  const categories: readonly ExpertCategoryRow[] = useMemo(
    () => state.expertCategories,
    [state.expertCategories],
  )

  // Client-side fallback filter — the upstream `/strategist?q=` endpoint
  // does not currently honour `q` (returns the full catalog), so we re-
  // filter on `query` here to make search feel instant + correct. If the
  // upstream grows proper server-side filtering, this no-ops harmlessly
  // (subset of `items` filtered by the same string).
  const visibleItems = useMemo(() => {
    const q = queryDraft.trim().toLowerCase()
    if (q.length === 0) return state.experts.items
    return state.experts.items.filter((row) => {
      if (row.name.toLowerCase().includes(q)) return true
      if (row.intro.toLowerCase().includes(q)) return true
      if ((row.slug ?? '').toLowerCase().includes(q)) return true
      if (row.category.name.toLowerCase().includes(q)) return true
      return false
    })
  }, [state.experts.items, queryDraft])

  const handleInvoke = useCallback(async (row: ExpertRow): Promise<void> => {
    // Always close the detail first (overlay calls this too — safe).
    controller.closeExpertDetail()
    // If the expert is not yet installed, download first, then summon.
    // The button itself flips into a downloading / summoning state.
    if (!controller.isExpertInstalled(row.id)) {
      await controller.installExpert(row.id)
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dsh:invoke-expert', {
        detail: { id: row.id, name: row.name, slug: row.slug, intro: row.intro },
      }))
    }
  }, [controller])

  return (
    <>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <IconSearchOutline16 size={16} className={styles.searchIcon} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder={t('searchPlaceholder')}
            value={queryDraft}
            onChange={(e) => setQueryDraft(e.target.value)}
          />
        </div>
        <button
          type="button"
          className={styles.iconBtn}
          data-configured={state.expertToken.length > 0 ? 'true' : 'false'}
          title={t('expertParamsTitle')}
          aria-label={t('expertParamsTitle')}
          onClick={() => setTokenDialogOpen(true)}
        >
          <IconSettingsOutline16 size={18} />
        </button>
        {state.isOffline && (
          <span
            className={styles.offlineBadge}
            title={t('offlineDataHint')}
            aria-label={t('offlineDataHint')}
          >
            <span className={styles.offlineBadgeDot} aria-hidden="true" />
            {t('offlineDataBadge')}
          </span>
        )}
      </div>

      <div className={styles.bodySplit}>
        <aside className={styles.categoryRail}>
          <button
            type="button"
            className={`${styles.categoryItem} ${state.experts.categoryId === null ? styles.active : ''}`}
            onClick={() => controller.setExpertCategory(null)}
          >
            <span>{t('expertCategoryAll')}</span>
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`${styles.categoryItem} ${state.experts.categoryId === cat.id ? styles.active : ''}`}
              onClick={() => controller.setExpertCategory(cat.id)}
            >
              <span>{cat.name}</span>
              {cat.strategistCount > 0 && <span className={styles.categoryCount}>{cat.strategistCount}</span>}
            </button>
          ))}
        </aside>

        <div>
          {state.experts.status === 'loading' && state.experts.items.length === 0 && <ExpertsSkeleton />}
          {state.experts.status === 'error' && (
            <div className={styles.errorBox}>
              <span>{state.experts.error ?? t('expertLoadFailed')}</span>
            </div>
          )}
          {state.experts.status === 'ready' && state.experts.items.length > 0 && visibleItems.length === 0 && (
            <div className={styles.center}>{t('expertNoResults')}</div>
          )}
          {state.experts.items.length > 0 && (
            <div className={styles.grid}>
              {visibleItems.map((row) => (
                <ExpertCard
                  key={row.id}
                  row={row}
                  controller={controller}
                  onOpen={() => void controller.loadExpertDetail(row.id)}
                  onInvoke={() => void handleInvoke(row)}
                  t={t}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {tokenDialogOpen && (
        <ExpertTokenDialog
          controller={controller}
          onClose={() => setTokenDialogOpen(false)}
          t={t}
        />
      )}
    </>
  )
}

interface ExpertCardProps {
  row: ExpertRow
  controller: MarketplaceStore
  onOpen: () => void
  onInvoke: () => void
  t: (k: keyof typeof en) => string
}

function ExpertCard({ row, controller, onOpen, onInvoke, t }: ExpertCardProps): JSX.Element {
  // Pick install + downloading from the snapshot — render runs on every
  // snapshot update so the button label flips live when downloads finish.
  const state = useMarketplaceSnapshot(controller)
  const installed = state.install.installedExperts.has(row.id)
  const downloading = state.install.downloadingExperts.has(row.id)
  const favorited = state.favoriteExperts.has(row.id) || row.favorited
  // Favorites are upstream mutations gated on the API token — without a
  // token the heart would be a silent no-op, so hide it entirely.
  const canFavorite = state.expertToken.length > 0

  // Choose button content based on state.
  let btnIcon: string
  let btnText: string
  let disabled = false
  if (downloading) {
    btnIcon = '⏳'
    btnText = t('expertDownloading')
    disabled = true
  } else {
    btnIcon = installed ? '✓' : '⊘'
    btnText = t('expertInvoke')
    disabled = false
  }

  return (
    <div className={styles.card} role="button" tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
      {canFavorite && (
        <button
          type="button"
          className={`${styles.favoriteBtn} ${favorited ? styles.favoriteBtnActive : ''}`}
          aria-label={favorited ? t('expertFavorited') : t('expertFavorite')}
          title={favorited ? t('expertFavorited') : t('expertFavorite')}
          onClick={(e) => { e.stopPropagation(); controller.toggleExpertFavorite(row.id) }}
        >
          <IconLikeOutline16 size={16} />
        </button>
      )}
      <div className={styles.cardHeader}>
        <Avatar name={row.name} url={row.avatarUrl} />
        <div className={styles.cardBody}>
          <h3 className={styles.cardName}>{row.name}</h3>
          <p className={styles.cardCategory}>{row.category.name}</p>
        </div>
      </div>
      <p className={styles.cardIntro}>{row.intro || t('expertNoIntro')}</p>
      <div className={styles.cardFooter}>
        <div className={styles.cardTags}>
          <span className={`${styles.tag} ${installed ? styles.tagSuccess : styles.tagDanger}`}>
            {installed ? t('expertInstalled') : t('expertNotInstalled')}
          </span>
          {row.favoriteCount > 0 && <span className={`${styles.tag} ${styles.tagAccent}`}>★ {row.favoriteCount}</span>}
        </div>
      </div>
      <button
        type="button"
        className={`${styles.expertSummon} ${installed ? styles.expertSummonInstalled : styles.expertSummonNotInstalled}`}
        title={t('expertInvokeHint')}
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); onInvoke() }}
      >
        <span className={styles.expertSummonIcon}>{btnIcon}</span>
        <span className={styles.expertSummonText}>{btnText}</span>
      </button>
    </div>
  )
}

function ExpertsSkeleton(): JSX.Element {
  return (
    <div className={styles.grid}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className={`${styles.card} ${styles.skeletonCard}`}>
          <div className={styles.cardHeader}>
            <div className={`${styles.avatar} ${styles.skeleton} ${styles.skeletonAvatar}`} />
            <div className={styles.cardBody}>
              <div className={`${styles.skeleton} ${styles.skeletonTitle}`} />
              <div className={`${styles.skeleton} ${styles.skeletonLine}`} style={{ width: '40%' }} />
            </div>
          </div>
          <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
          <div className={`${styles.skeleton} ${styles.skeletonLine}`} style={{ width: '70%' }} />
          <div className={styles.cardFooter}>
            <div className={`${styles.skeleton} ${styles.skeletonLine}`} style={{ width: 50, height: 24 }} />
            <div className={`${styles.skeleton} ${styles.skeletonLine}`} style={{ width: 70, height: 28 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── token settings dialog ────────────────────────────────────────────
   The same dialog is reachable from the panel header (canonical entry)
   and the toolbar ⚙ (legacy discoverability for users who already
   hovered the experts tab). Both surfaces back the shared
   MarketplaceSettingsDialog, so the registration URL and copy stay
   in lockstep. */

function ExpertTokenDialog({
  controller,
  t,
  onClose,
}: {
  controller: MarketplaceStore
  t: (k: keyof typeof en) => string
  onClose: () => void
}): JSX.Element {
  return (
    <MarketplaceSettingsDialog controller={controller} onClose={onClose} t={t} />
  )
}
