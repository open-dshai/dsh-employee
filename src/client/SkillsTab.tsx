/**
 * Skills tab — search + sort + starred filter on top, then a card grid.
 *
 * Card top-right icon: replaces the legacy footer "试一试" button.
 *   - default: `+`  (always visible, label "下载")
 *   - on click: spinner ("下载中…")
 *   - after download: `✓` is always visible (label "已下载"). Two pills
 *     sit to the left of the ✓: 「试一试」 (jumps to the composer with
 *     the skill prefilled) and 「卸载」 (removes the skill from
 *     ~/.agents/skills). Both pills are always rendered for installed
 *     cards; hovering each pill recolors it (accent / danger-red) for
 *     click feedback.
 */

import { useState, useEffect } from 'react'
import { IconLikeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketplaceStore, SkillRow } from './store.ts'
import { useMarketplaceSnapshot } from './store.ts'
import { PublishSkillDialog } from './PublishSkillDialog.tsx'
import type { en } from './locales.ts'
import styles from './styles.module.css'

export interface SkillsTabProps {
  controller: MarketplaceStore
  t: (key: keyof typeof en) => string
}

/** First character of the skill slug/name as a fallback avatar. */
function avatarFallback(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  return Array.from(trimmed)[0]?.toUpperCase() ?? '?'
}

function SkillAvatar({ name, slug }: { name: string; slug: string }): JSX.Element {
  return <div className={`${styles.avatar} ${styles.avatarSquare} ${styles.skillLogo}`}>{avatarFallback(name || slug)}</div>
}

/** Format an ISO timestamp / epoch into a short Chinese date string. */
function formatUpdated(epoch: number): string {
  if (epoch === 0) return ''
  const ms = epoch > 1e12 ? epoch : epoch * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/** Tag rendering: take the first 2-3 keys from the dict-shaped `tags`. */
function renderTags(tags: Readonly<Record<string, string>>): JSX.Element {
  const keys = Object.keys(tags).slice(0, 3)
  if (keys.length === 0) return <></>
  return (
    <>
      {keys.map((k) => (
        <span key={k} className={styles.tag}>{String(tags[k] ?? k)}</span>
      ))}
    </>
  )
}

export function SkillsTab({ controller, t }: SkillsTabProps): JSX.Element {
  // Reactively bind to the store so query/install mutations re-render the
  // card grid; otherwise the component reads once and silently drifts.
  const state = useMarketplaceSnapshot(controller)
  /** Publish-skill dialog — opened from the unified top-bar button. */
  const [publishOpen, setPublishOpen] = useState(false)

  // The publish button lives in the panel top bar; it asks us to open the
  // dialog through a window event so the dialog state stays local here.
  useEffect(() => {
    const onOpen = (): void => setPublishOpen(true)
    window.addEventListener('dsh:open-publish-skill', onOpen as EventListener)
    return () => window.removeEventListener('dsh:open-publish-skill', onOpen as EventListener)
  }, [])

  // Same client-side filter as ExpertsTab — upstream `/skills?q=` is a
  // pass-through that does not trim the catalog today.
  const visibleSkills = (() => {
    const q = state.skills.query.trim().toLowerCase()
    if (q.length === 0) return state.skills.items
    return state.skills.items.filter((row) => {
      if (row.displayName.toLowerCase().includes(q)) return true
      if (row.slug.toLowerCase().includes(q)) return true
      if (row.summary.toLowerCase().includes(q)) return true
      for (const v of Object.values(row.tags)) {
        if (typeof v === 'string' && v.toLowerCase().includes(q)) return true
      }
      return false
    })
  })()

  return (
    <>
      <div>
        {state.skills.status === 'loading' && state.skills.items.length === 0 && <SkillsSkeleton />}
        {state.skills.status === 'error' && (
          <div className={styles.errorBox}>
            <span>{state.skills.error ?? t('skillLoadFailed')}</span>
          </div>
        )}
        {state.skills.status === 'ready' && state.skills.items.length === 0 && (
          <div className={styles.center}>{t('skillNoResults')}</div>
        )}
        {state.skills.items.length > 0 && (
          <div className={styles.grid}>
            {visibleSkills.map((row) => (
              <SkillCard
                key={row.slug}
                row={row}
                controller={controller}
                onOpen={() => void controller.loadSkillDetail(row.slug)}
                onTry={() => {
                  if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('dsh:invoke-skill', {
                      detail: { slug: row.slug, displayName: row.displayName, version: row.version },
                    }))
                  }
                }}
                t={t}
              />
            ))}
          </div>
        )}
        {state.skills.status === 'ready' && state.skills.items.length > 0 && visibleSkills.length === 0 && (
          <div className={styles.center}>{t('skillNoResults')}</div>
        )}
      </div>

      {publishOpen && (
        <PublishSkillDialog
          controller={controller}
          onClose={() => setPublishOpen(false)}
          t={t}
        />
      )}
    </>
  )
}

interface SkillCardProps {
  row: SkillRow
  controller: MarketplaceStore
  onOpen: () => void
  onTry: () => void
  t: (k: keyof typeof en) => string
}

/**
 * Card body. The corner icon (`SkillCardCorner`) owns install state and the
 * "试一试" hover popover; everything else here is layout + meta.
 */
function SkillCard({ row, controller, onOpen, onTry, t }: SkillCardProps): JSX.Element {
  return (
    <div className={styles.card} role="button" tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
      <SkillCardCorner
        slug={row.slug}
        controller={controller}
        onTry={onTry}
        t={t}
      />
      <div className={styles.cardHeader}>
        <SkillAvatar name={row.displayName} slug={row.slug} />
        <div className={styles.cardBody}>
          <h3 className={styles.cardName}>{row.displayName || row.slug}</h3>
          <p className={styles.cardCategory}>v{row.version} · {formatUpdated(row.updatedAt)}</p>
        </div>
      </div>
      <p className={styles.cardIntro}>{row.summary}</p>
      <div className={styles.cardFooter}>
        <div className={styles.cardTags}>
          {renderTags(row.tags)}
          {row.stats.downloads > 0 && <span className={styles.tag}>↓ {row.stats.downloads}</span>}
          {row.stats.stars > 0 && <span className={`${styles.tag} ${styles.tagAccent}`}>★ {row.stats.stars}</span>}
        </div>
      </div>
    </div>
  )
}

/**
 * Top-right corner of a skill card. Reads install state from the store on
 * every render, dispatches downloads / invokes as the user clicks.
 *
 * Layout: a chip area absolutely-positioned in the card's top-right corner
 * (`styles.cardCorner`). The download icon (`✓` once installed) sits at the
 * right end; the 「试一试」 and 「卸载」 pills always render to its left
 * on installed cards (no hover gating — the affordance is permanent).
 */
function SkillCardCorner({
  slug,
  controller,
  onTry,
  t,
}: {
  slug: string
  controller: MarketplaceStore
  onTry: () => void
  t: (k: keyof typeof en) => string
}): JSX.Element {
  // Reactive read — re-renders on every snapshot change so the corner
  // icon flips + → spinner → ✓ with the actual install state.
  const state = useMarketplaceSnapshot(controller)
  const installed = state.install.installedSkills.has(slug)
  const downloading = state.install.downloadingSkills.has(slug)
  const favorited = state.favoriteSkills.has(slug)
  // Favorites are upstream mutations gated on the API token — hide the
  // heart entirely while no token is saved (it would be a silent no-op).
  const canFavorite = state.expertToken.length > 0

  const handleDownload = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (installed || downloading) return
    void controller.installSkill(slug)
  }

  const handleTry = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onTry()
  }

  const handleUninstall = (e: React.MouseEvent): void => {
    e.stopPropagation()
    void controller.uninstallSkill(slug).catch(() => {
      if (typeof window !== 'undefined') window.alert(t('skillUninstallFailed'))
    })
  }

  // Choose the label/tooltip/icon for the current state.
  let label: string
  let icon: string
  let disabled = false
  if (downloading) {
    label = t('skillAdding')
    icon = '⏳'
    disabled = true
  } else if (installed) {
    label = t('skillAdded')
    icon = '✓'
    disabled = false
  } else {
    label = t('skillAdd')
    icon = '+'
    disabled = false
  }

  return (
    <div className={styles.cardCorner}>
      {canFavorite && (
        <button
          type="button"
          className={`${styles.favoriteBtnInline} ${favorited ? styles.favoriteBtnActive : ''}`}
          aria-label={favorited ? t('expertFavorited') : t('expertFavorite')}
          title={favorited ? t('expertFavorited') : t('expertFavorite')}
          onClick={(e) => { e.stopPropagation(); controller.toggleSkillFavorite(slug) }}
        >
          <IconLikeOutlineRegular size={16} />
        </button>
      )}
      {installed && (
        <button
          type="button"
          className={`${styles.cornerPill} ${styles.cornerPillTry}`}
          title={t('skillTryHint')}
          aria-label={t('skillTryHint')}
          onClick={handleTry}
        >
          {t('skillTryHint')}
        </button>
      )}
      {installed && !downloading && (
        <button
          type="button"
          className={`${styles.cornerPill} ${styles.cornerPillUninstall}`}
          title={t('skillUninstall')}
          aria-label={t('skillUninstall')}
          onClick={handleUninstall}
        >
          {t('skillUninstall')}
        </button>
      )}
      <button
        type="button"
        className={`${styles.cornerIconBtn} ${installed ? styles.cornerIconBtnInstalled : ''}`}
        title={label}
        aria-label={label}
        disabled={disabled}
        onClick={installed ? handleTry : handleDownload}
      >
        <span className={styles.cornerIcon}>{icon}</span>
      </button>
    </div>
  )
}

function SkillsSkeleton(): JSX.Element {
  return (
    <div className={styles.grid}>
      {Array.from({ length: 8 }).map((_, i) => (
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
