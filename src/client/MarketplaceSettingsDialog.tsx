/**
 * Global marketplace settings dialog — token entry, registration link, and
 * publish-skill affordances. Mounted from the panel header ⚙ icon so it is
 * reachable regardless of which tab the user is on (sibling of the older
 * ExpertsTab-internal copy).
 *
 * The token is the single credential that gates every marketplace mutation
 * that hits the upstream skill.dualpaw.com registry — favorite an expert,
 * publish a skill, invoke a connector that requires real auth. Local-only
 * actions (download / summon) are unaffected. Keeping the entry surface
 * gated on the token means the UI is honest about which actions will
 * actually do something and which will be no-ops because of missing auth.
 */
import { useState } from 'react'
import { IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketplaceStore } from './store.ts'
import type { en } from './locales.ts'
import styles from './styles.module.css'

/** Public registration page where users sign up, then mint an API Token. */
export const MARKETPLACE_REGISTER_URL = 'https://skill.dualpaw.com/register'

export interface MarketplaceSettingsDialogProps {
  controller: MarketplaceStore
  onClose: () => void
  t: (key: keyof typeof en) => string
}

/**
 * The settings dialog has three logical sections, separated by a header
 * divider for readability:
 *   1. Token entry — the only state we persist (single string).
 *   2. Get-token help block — direct link to the registration page.
 *   3. Side-effect flush — none today (downloads / favorites are persisted
 *      independently by their respective tabs).
 */
export function MarketplaceSettingsDialog({
  controller,
  onClose,
  t,
}: MarketplaceSettingsDialogProps): JSX.Element {
  const initial = controller.getExpertToken()
  const [draft, setDraft] = useState(initial)
  const [saved, setSaved] = useState(false)

  const handleSave = (): void => {
    controller.setExpertToken(draft.trim())
    setSaved(true)
  }

  return (
    <div className={styles.paramsDrawerOverlay} onClick={onClose}>
      <div className={styles.connectorParamDialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.paramsDrawerHeader}>
          <h2 className={styles.paramsDrawerTitle}>{t('marketplaceSettingsTitle')}</h2>
          <button type="button" className={styles.paramsDrawerClose} aria-label={t('close')} onClick={onClose}>×</button>
        </div>
        <div className={styles.paramsDrawerIntro}>
          {t('marketplaceSettingsIntro')}
        </div>
        <div className={styles.connectorParamDialogBody}>
          <label className={styles.paramsLabel}>
            <span>{t('expertParamsTokenLabel')}</span>
            <input
              className={styles.paramsInput}
              type="password"
              placeholder={t('expertParamsTokenPlaceholder')}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setSaved(false) }}
              autoFocus
            />
          </label>
        </div>
        <div className={styles.expertTokenHelp}>
          <span className={styles.expertTokenHelpText}>{t('marketplaceSettingsGetTokenHint')}</span>
          <a
            className={styles.expertTokenHelpLink}
            href={MARKETPLACE_REGISTER_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            <IconLinkOutlineRegular size={14} className={styles.expertTokenHelpLinkIcon} />
            {t('marketplaceSettingsGetToken')}
          </a>
        </div>
        <div className={styles.paramsDrawerFooter}>
          <button type="button" className={styles.actionBtn} onClick={onClose}>{t('cancel')}</button>
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
            disabled={draft.trim().length === 0}
            onClick={handleSave}
          >
            {saved ? t('expertParamsSaved') : t('expertParamsSave')}
          </button>
        </div>
      </div>
    </div>
  )
}
