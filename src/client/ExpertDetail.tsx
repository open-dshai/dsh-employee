/**
 * Expert detail overlay — shown when an expert card is clicked. Renders
 * the persona, the bundled skills, and the intro / content body. The
 * "召唤" button in the footer closes the overlay and emits the
 * `dsh:invoke-expert` event the host listens for to spawn a new session.
 */

import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketplaceStore, ExpertDetail as ExpertDetailModel } from './store.ts'
import type { en } from './locales.ts'
import styles from './styles.module.css'

export interface ExpertDetailProps {
  controller: MarketplaceStore
  detail: ExpertDetailModel
  loading: boolean
  error: string | null
  t: (key: keyof typeof en) => string
}

function avatarFallback(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  return Array.from(trimmed)[0]?.toUpperCase() ?? '?'
}

function Avatar({ name, url }: { name: string; url: string }): JSX.Element {
  if (url.length > 0) {
    return (
      <div className={styles.detailAvatar}>
        <img src={url} alt="" onError={(e) => { (e.currentTarget.style.display = 'none') }} />
      </div>
    )
  }
  return <div className={styles.detailAvatar}>{avatarFallback(name)}</div>
}

/** Strip a leading YAML frontmatter block from markdown content if present. */
function stripFrontmatter(md: string): string {
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3)
    if (end > 0) {
      return md.slice(end + 4).trimStart()
    }
  }
  return md
}

export function ExpertDetail({ controller, detail, loading, error, t }: ExpertDetailProps): JSX.Element {
  const handleClose = (): void => { controller.closeExpertDetail() }
  const handleInvoke = (): void => {
    controller.closeExpertDetail()
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dsh:invoke-expert', {
        detail: { id: detail.id, name: detail.name, slug: detail.slug, intro: detail.intro, avatarUrl: detail.avatarUrl },
      }))
    }
  }

  return (
    <div className={styles.detailOverlay} onClick={(e) => { if (e.target === e.currentTarget) handleClose() }}>
      <div className={styles.detailPanel} role="dialog" aria-labelledby="marketplace-expert-name">
        <div className={styles.detailHeader}>
          <Avatar name={detail.name} url={detail.avatarUrl} />
          <div className={styles.detailTitle}>
            <h2 id="marketplace-expert-name" className={styles.detailName}>{detail.name}</h2>
            <p className={styles.detailMeta}>{detail.category.name}</p>
          </div>
          <button type="button" className={styles.detailClose} onClick={handleClose} aria-label={t('close')}>
            <IconCloseOutlineRegular size={16} />
          </button>
        </div>

        <div className={styles.detailBody}>
          {loading && <div className={styles.center}>{t('loading')}</div>}
          {error !== null && <div className={styles.errorBox}>{error}</div>}

          {detail.intro.length > 0 && (
            <div className={styles.detailSection}>
              <h3>{t('expertContent')}</h3>
              <p>{detail.intro}</p>
            </div>
          )}

          {detail.soulPersonality !== undefined && detail.soulPersonality.length > 0 && (
            <div className={styles.detailSection}>
              <h3>{t('expertPersonality')}</h3>
              <p>{detail.soulPersonality}</p>
            </div>
          )}

          {detail.skills !== undefined && detail.skills.length > 0 && (
            <div className={styles.detailSection}>
              <h3>{t('expertSkills')}</h3>
              <div className={styles.cardTags}>
                {detail.skills.map((s) => (
                  <span key={s.id} className={`${styles.tag} ${styles.tagAccent}`}>
                    {s.skillName}
                  </span>
                ))}
              </div>
            </div>
          )}

          {detail.content !== undefined && detail.content.length > 0 && (
            <div className={styles.detailSection}>
              <h3>Markdown</h3>
              <pre>{stripFrontmatter(detail.content)}</pre>
            </div>
          )}
        </div>

        <div className={styles.detailFooter}>
          <Button onClick={handleClose}>{t('cancel')}</Button>
          <Button variant="primary" onClick={handleInvoke}>{t('expertInvoke')}</Button>
        </div>
      </div>
    </div>
  )
}
