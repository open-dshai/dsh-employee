/**
 * Skill detail overlay — opened when a skill card is clicked. Shows the
 * version, stats, description, and instructions. The "试用" button
 * closes the overlay and emits `dsh:invoke-skill` for the host to wire
 * into a session.
 */

import { Button, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketplaceStore, SkillDetail as SkillDetailModel } from './store.ts'
import type { en } from './locales.ts'
import styles from './styles.module.css'

export interface SkillDetailProps {
  controller: MarketplaceStore
  detail: SkillDetailModel
  loading: boolean
  error: string | null
  t: (key: keyof typeof en) => string
}

function formatDate(epoch: number): string {
  if (epoch === 0) return ''
  const ms = epoch > 1e12 ? epoch : epoch * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function SkillDetail({ controller, detail, loading, error, t }: SkillDetailProps): JSX.Element {
  const handleClose = (): void => { controller.closeSkillDetail() }
  const handleTry = (): void => {
    controller.closeSkillDetail()
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dsh:invoke-skill', {
        detail: { slug: detail.slug, displayName: detail.displayName, version: detail.version },
      }))
    }
  }

  return (
    <div className={styles.detailOverlay} onClick={(e) => { if (e.target === e.currentTarget) handleClose() }}>
      <div className={styles.detailPanel} role="dialog" aria-labelledby="marketplace-skill-name">
        <div className={styles.detailHeader}>
          <div className={styles.detailAvatar}>
            {(detail.displayName || detail.slug).slice(0, 1).toUpperCase()}
          </div>
          <div className={styles.detailTitle}>
            <h2 id="marketplace-skill-name" className={styles.detailName}>{detail.displayName || detail.slug}</h2>
            <p className={styles.detailMeta}>v{detail.version} · {formatDate(detail.updatedAt)}</p>
          </div>
          <button type="button" className={styles.detailClose} onClick={handleClose} aria-label={t('close')}>
            <IconCloseOutline16 size={16} />
          </button>
        </div>

        <div className={styles.detailBody}>
          {loading && <div className={styles.center}>{t('loading')}</div>}
          {error !== null && <div className={styles.errorBox}>{error}</div>}

          <div className={styles.detailSection}>
            <h3>Stats</h3>
            <p>
              ↓ {detail.stats.downloads} {t('skillDownloads')} · ★ {detail.stats.stars} {t('skillStars')}
            </p>
          </div>

          {detail.summary.length > 0 && (
            <div className={styles.detailSection}>
              <h3>Summary</h3>
              <p>{detail.summary}</p>
            </div>
          )}

          {detail.description !== undefined && detail.description.length > 0 && (
            <div className={styles.detailSection}>
              <h3>{t('skillDescription')}</h3>
              <p>{detail.description}</p>
            </div>
          )}

          {detail.instructions !== undefined && detail.instructions.length > 0 && (
            <div className={styles.detailSection}>
              <h3>{t('skillInstructions')}</h3>
              <pre>{detail.instructions}</pre>
            </div>
          )}

          {Object.keys(detail.tags).length > 0 && (
            <div className={styles.detailSection}>
              <h3>{t('skillTags')}</h3>
              <div className={styles.cardTags}>
                {Object.entries(detail.tags).map(([k, v]) => (
                  <span key={k} className={`${styles.tag} ${styles.tagAccent}`}>{String(v ?? k)}</span>
                ))}
              </div>
            </div>
          )}

          {detail.moderation !== undefined && (
            <div className={styles.detailSection}>
              <h3>Moderation</h3>
              <p>
                verdict: <code>{detail.moderation.verdict}</code>
                {detail.moderation.isSuspicious ? ' · suspicious' : ''}
                {detail.moderation.isMalwareBlocked ? ' · malware-blocked' : ''}
              </p>
            </div>
          )}
        </div>

        <div className={styles.detailFooter}>
          <Button onClick={handleClose}>{t('cancel')}</Button>
          <Button variant="primary" onClick={handleTry}>{t('skillTry')}</Button>
        </div>
      </div>
    </div>
  )
}
