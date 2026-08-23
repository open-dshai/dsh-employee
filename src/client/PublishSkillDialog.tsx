/**
 * Publish-skill dialog — create a new skill and push it to
 * skill.dualpaw.com. Token-gated: the submit button is hidden until the
 * user saved an API token via the ⚙ settings dialog (publishing without
 * auth is an upstream 401, so the UI says so up front instead).
 *
 * Mounted from the Skills tab toolbar "发布技能" button, which is itself
 * only rendered when a token exists — the `canPublish` check inside the
 * dialog is a second line of defence for callers that mount it directly.
 */
import { useState } from 'react'
import type { MarketplaceStore } from './store.ts'
import { useMarketplaceSnapshot } from './store.ts'
import type { en } from './locales.ts'
import styles from './styles.module.css'

export interface PublishSkillDialogProps {
  controller: MarketplaceStore
  onClose: () => void
  t: (key: keyof typeof en) => string
}

export function PublishSkillDialog({
  controller,
  onClose,
  t,
}: PublishSkillDialogProps): JSX.Element {
  const state = useMarketplaceSnapshot(controller)
  const canPublish = state.expertToken.length > 0

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [phase, setPhase] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')

  const valid = name.trim().length > 0 && description.trim().length > 0 && instructions.trim().length > 0

  const handleSubmit = (): void => {
    if (!valid || phase === 'submitting') return
    setPhase('submitting')
    setError('')
    controller.publishSkill({
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
    })
      .then(() => { setPhase('done') })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      })
  }

  return (
    <div className={styles.paramsDrawerOverlay} onClick={onClose}>
      <div className={styles.connectorParamDialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.paramsDrawerHeader}>
          <h2 className={styles.paramsDrawerTitle}>{t('skillPublishTitle')}</h2>
          <button type="button" className={styles.paramsDrawerClose} aria-label={t('close')} onClick={onClose}>×</button>
        </div>
        <div className={styles.paramsDrawerIntro}>
          {canPublish ? t('skillPublishIntro') : t('skillPublishNeedToken')}
        </div>
        <div className={styles.connectorParamDialogBody}>
          <label className={styles.paramsLabel}>
            <span>{t('skillPublishNameLabel')}</span>
            <input
              className={styles.paramsInput}
              type="text"
              placeholder={t('skillPublishNamePlaceholder')}
              value={name}
              onChange={(e) => { setName(e.target.value); setPhase('idle') }}
              autoFocus
            />
          </label>
          <label className={styles.paramsLabel}>
            <span>{t('skillPublishDescLabel')}</span>
            <input
              className={styles.paramsInput}
              type="text"
              placeholder={t('skillPublishDescPlaceholder')}
              value={description}
              onChange={(e) => { setDescription(e.target.value); setPhase('idle') }}
            />
          </label>
          <label className={styles.paramsLabel}>
            <span>{t('skillPublishContentLabel')}</span>
            <textarea
              className={styles.paramsTextarea}
              placeholder={t('skillPublishContentPlaceholder')}
              value={instructions}
              onChange={(e) => { setInstructions(e.target.value); setPhase('idle') }}
              rows={8}
            />
          </label>
        </div>
        {phase === 'error' && (
          <div className={styles.errorBox}>
            <span>{t('skillPublishFailed')}{error.length > 0 ? `：${error}` : ''}</span>
          </div>
        )}
        <div className={styles.paramsDrawerFooter}>
          <button type="button" className={styles.actionBtn} onClick={onClose}>{t('cancel')}</button>
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
            disabled={!canPublish || !valid || phase === 'submitting'}
            onClick={handleSubmit}
          >
            {phase === 'submitting'
              ? t('skillPublishSubmitting')
              : phase === 'done'
                ? t('skillPublishSuccess')
                : t('skillPublishSubmit')}
          </button>
        </div>
      </div>
    </div>
  )
}
