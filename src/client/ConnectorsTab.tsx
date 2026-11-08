/**
 * Connectors tab — a card grid of available external / built-in connectors.
 *
 * Layout additions (compared to the simple grid):
 *  • Each card has its own ⚙ icon in the top-right that opens a single-
 *    connector parameter dialog (the toolbar's bulk-editing ⚙ is kept as
 *    a shortcut for batch edits).
 *  • ⚠ icon on the card name when any required parameter is missing.
 *  • Per-card enable/disable toggle — defaults to ON. Disabled cards are
 *    moved into a collapsible "已禁用" section so the main list only shows
 *    active cards. The state persists to localStorage and propagates to
 *    the composer connector popover.
 *  • "管理连接器" in the composer popover still deep-links to this tab.
 */

import { useState, useEffect, useMemo } from 'react'
import { IconLinkOutlineRegular, IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  type MarketplaceStore,
  type ConnectorRow,
  useMarketplaceSnapshot,
  getConnectorSchema,
  getConnectorConfigStatus,
} from './store.ts'
import type { en } from './locales.ts'
import styles from './styles.module.css'

export interface ConnectorsTabProps {
  controller: MarketplaceStore
  t: (key: keyof typeof en) => string
}

interface ConnectorAvatarProps {
  name: string
  url: string
}

function ConnectorAvatar({ name, url }: ConnectorAvatarProps): JSX.Element {
  if (url.length > 0) {
    return (
      <div className={`${styles.avatar} ${styles.avatarSquare} ${styles.connectorLogo}`}>
        <img src={url} alt="" loading="lazy" onError={(e) => { (e.currentTarget.style.display = 'none') }} />
      </div>
    )
  }
  const fallback = name.trim().length === 0 ? '?' : Array.from(name.trim())[0]?.toUpperCase() ?? '?'
  return <div className={`${styles.avatar} ${styles.avatarSquare} ${styles.connectorLogo}`}>{fallback}</div>
}

export function ConnectorsTab({ controller, t }: ConnectorsTabProps): JSX.Element {
  // Subscribe — same reason as the other tabs: the input/state must update.
  const state = useMarketplaceSnapshot(controller)
  /** id of the connector that hit a pop-up blocker — shows a hint inline. */
  const [popupBlockedId, setPopupBlockedId] = useState<string | null>(null)
  /** id awaiting the OAuth popup callback. */
  const [awaitingId, setAwaitingId] = useState<string | null>(null)
  /** Bulk parameter drawer (one row per connector). */
  const [bulkParamsOpen, setBulkParamsOpen] = useState(false)
  /** Single-connector parameter dialog (when a card's ⚙ is clicked). */
  const [paramsDialogId, setParamsDialogId] = useState<string | null>(null)
  /** Per-card "fill composer" pending flag so we can show a spinner. */
  const [fillingId, setFillingId] = useState<string | null>(null)
  const [lastFilledAt, setLastFilledAt] = useState<number>(0)

  // The bulk-params gear lives in the panel top bar; it asks us to open the
  // drawer through a window event so the dialog state stays local here.
  useEffect(() => {
    const onOpen = (): void => setBulkParamsOpen(true)
    window.addEventListener('dsh:open-connector-params', onOpen as EventListener)
    return () => window.removeEventListener('dsh:open-connector-params', onOpen as EventListener)
  }, [])

  // The keyword filter lives in the store now so the unified top-bar
  // search box can drive it.
  const items = useMemo(() => state.connectors.items.filter((c) => {
    if (state.connectorQuery.trim().length === 0) return true
    const q = state.connectorQuery.toLowerCase()
    return c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
  }), [state.connectors.items, state.connectorQuery])

  const enabledItems = useMemo(
    () => items.filter((c) => controller.isConnectorEnabled(c.id)),
    [items, state.connectorEnabled, controller],
  )
  const disabledItems = useMemo(
    () => items.filter((c) => !controller.isConnectorEnabled(c.id)),
    [items, state.connectorEnabled, controller],
  )

  const handleToggle = async (row: ConnectorRow): Promise<void> => {
    setPopupBlockedId(null)
    const result = await controller.setConnector(row.id, !row.connected)
    if (!result.openedPopup) {
      setPopupBlockedId(row.id)
      return
    }
    if (result.awaiting) {
      setAwaitingId(row.id)
      const interval = setInterval(() => {
        const pending = controller.store.getSnapshot().pendingConnectorId
        if (pending !== row.id) {
          setAwaitingId(null)
          clearInterval(interval)
        }
      }, 500)
      setTimeout(() => {
        clearInterval(interval)
        setAwaitingId(null)
      }, 6 * 60 * 1000)
    }
  }

  const handleEnable = (row: ConnectorRow, next: boolean): void => {
    controller.setConnectorEnabled(row.id, next)
  }

  /** Pull a connector-specific snippet and insert it into the composer.
   *  Uses the `dsh:connector-fill` CustomEvent so `invoke.ts` can apply
   *  it using the same DOM helpers it uses for skill/expert invokes. */
  const handleFill = async (row: ConnectorRow): Promise<void> => {
    if (!row.connected || fillingId !== null) return
    const params = controller.getConnectorParams(row.id)
    const status = getConnectorConfigStatus(row.id, params)
    // Required parameters missing — refuse to dispatch the fill event and
    // surface the reason instead, mirroring the popover's behaviour.
    if (!status.configured) {
      window.dispatchEvent(new CustomEvent('dsh:connector-fill', {
        detail: {
          id: row.id,
          name: row.name,
          snippet: `[${row.name}] ${t('connectorMissingParams')}：${status.missingRequired.join(', ')}\n`,
        },
      }))
      return
    }
    setFillingId(row.id)
    try {
      const snippet = await controller.fetchConnectorSnippet(row.id)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('dsh:connector-fill', {
          detail: { id: row.id, name: row.name, snippet },
        }))
      }
      setLastFilledAt(Date.now())
    } finally {
      setFillingId(null)
    }
  }

  const renderCard = (row: ConnectorRow): JSX.Element => {
    const isEnabled = controller.isConnectorEnabled(row.id)
    const status = getConnectorConfigStatus(row.id, controller.getConnectorParams(row.id))
    return (
      <ConnectorCard
        key={row.id}
        row={row}
        isEnabled={isEnabled}
        isConfigured={status.configured}
        missingRequired={status.missingRequired}
        pending={state.pendingConnectorId === row.id || awaitingId === row.id}
        awaitingCallback={awaitingId === row.id}
        popupBlocked={popupBlockedId === row.id}
        filling={fillingId === row.id}
        onToggle={() => void handleToggle(row)}
        onEnable={(next) => handleEnable(row, next)}
        onFill={() => void handleFill(row)}
        onOpenParams={() => setParamsDialogId(row.id)}
        t={t}
      />
    )
  }

  return (
    <>
      {lastFilledAt > 0 && Date.now() - lastFilledAt < 4000 && (
        <div className={styles.fillToastRow}>
          <span className={styles.fillToast}>{t('connectorFillDone')}</span>
        </div>
      )}

      <div>
        {state.connectors.status === 'loading' && state.connectors.items.length === 0 && <ConnectorsSkeleton />}
        {state.connectors.status === 'error' && (
          <div className={styles.errorBox}>
            <span>{state.connectors.error ?? t('connectorLoadFailed')}</span>
          </div>
        )}
        {state.connectors.status === 'ready' && items.length === 0 && (
          <div className={styles.center}>{t('empty')}</div>
        )}
        {state.connectors.status === 'ready' && items.length > 0 && enabledItems.length === 0 && (
          <div className={styles.center}>{t('connectorEmptyEnabled')}</div>
        )}
        {enabledItems.length > 0 && (
          <div className={styles.grid}>
            {enabledItems.map(renderCard)}
          </div>
        )}
        {items.length > 0 && disabledItems.length > 0 && (
          <details className={styles.connectorDisabledSection}>
            <summary>{t('connectorDisabledSectionTitle')}（{disabledItems.length}）</summary>
            <p className={styles.connectorDisabledSectionHint}>{t('connectorDisabledSectionHint')}</p>
            <div className={styles.grid}>
              {disabledItems.map(renderCard)}
            </div>
          </details>
        )}
      </div>

      {bulkParamsOpen && <ConnectorBulkParamsDrawer controller={controller} t={t} onClose={() => setBulkParamsOpen(false)} />}
      {paramsDialogId !== null && (
        <ConnectorCardParamsDialog
          controller={controller}
          id={paramsDialogId}
          onClose={() => setParamsDialogId(null)}
          t={t}
        />
      )}
    </>
  )
}

interface ConnectorCardProps {
  row: ConnectorRow
  isEnabled: boolean
  isConfigured: boolean
  missingRequired: readonly string[]
  pending: boolean
  awaitingCallback: boolean
  popupBlocked: boolean
  filling: boolean
  onToggle: () => void
  onEnable: (enabled: boolean) => void
  onFill: () => void
  onOpenParams: () => void
  t: (k: keyof typeof en) => string
}

function ConnectorCard({
  row,
  isEnabled,
  isConfigured,
  missingRequired,
  pending,
  awaitingCallback,
  popupBlocked,
  filling,
  onToggle,
  onEnable,
  onFill,
  onOpenParams,
  t,
}: ConnectorCardProps): JSX.Element {
  const isOAuth = typeof row.authUrl === 'string' && row.authUrl.length > 0
  let buttonLabel: string
  if (pending && awaitingCallback) {
    buttonLabel = t('connectorReloading')
  } else if (pending) {
    buttonLabel = t('loading')
  } else if (row.connected) {
    buttonLabel = t('connectorDisconnect')
  } else if (isOAuth) {
    buttonLabel = t('connectorOAuth')
  } else {
    buttonLabel = t('connectorConnect')
  }
  return (
    <div className={`${styles.card} ${styles.connectorCard}`} data-enabled={isEnabled ? 'true' : 'false'}>
      <div className={styles.cardCornerConnector}>
        <button
          type="button"
          className={styles.cardCornerParamsBtn}
          data-configured={isConfigured ? 'true' : 'false'}
          aria-label={t('connectorBtnParams')}
          title={isConfigured ? t('connectorConfigured') : `${t('connectorUnconfigured')}：${missingRequired.join(', ') || '—'}`}
          onClick={(e) => { e.stopPropagation(); onOpenParams() }}
        >
          <IconSettingsOutlineRegular size={14} />
        </button>
      </div>
      <div className={styles.cardHeader}>
        <ConnectorAvatar name={row.name} url={row.iconUrl} />
        <div className={styles.cardBody}>
          <h3 className={styles.cardName}>
            <span className={styles.connectorNameText}>{row.name}</span>
            <span
              className={`${styles.statusDot} ${row.connected ? styles.statusDotConnected : ''}`}
              title={row.connected ? t('connectorConnected') : t('connectorNotConnected')}
            />
            {!isConfigured && missingRequired.length > 0 && (
              <span
                className={styles.connectorWarnIcon}
                title={`${t('connectorMissingParams')}：${missingRequired.join(', ')}`}
              >⚠</span>
            )}
          </h3>
          <p className={styles.cardCategory}>
            {row.source === 'builtin' ? t('connectorBuiltin') : t('connectorExternal')}
            <span className={styles.connectorMetaSep}>·</span>
            {row.connected ? t('connectorConnected') : t('connectorNotConnected')}
          </p>
        </div>
      </div>
      <p className={styles.cardIntro}>{row.description}</p>
      <div className={styles.cardFooter}>
        <div className={styles.cardTags}>
          {row.tags.map((tag) => (
            <span key={tag} className={styles.tag}>{tag}</span>
          ))}
        </div>
        <div className={styles.cardActions}>
          {row.connected && isConfigured && (
            <button
              type="button"
              className={`${styles.actionBtn} ${filling ? '' : styles.actionBtnFill}`}
              disabled={filling}
              title={t('connectorFillHint')}
              onClick={onFill}
            >
              {filling ? t('connectorFilling') : t('connectorFill')}
            </button>
          )}
          <button
            type="button"
            className={styles.cardSwitch}
            data-on={isEnabled ? 'true' : 'false'}
            aria-label={isEnabled ? t('connectorDisableToggle') : t('connectorEnableToggle')}
            title={isEnabled ? t('connectorDisableToggle') : t('connectorEnableToggle')}
            onClick={() => onEnable(!isEnabled)}
          />
          <button
            type="button"
            className={`${styles.actionBtn} ${row.connected ? styles.actionBtnDanger : styles.actionBtnPrimary} ${
              !row.connected && !pending ? styles.actionBtnIconOnly : ''
            } ${!row.connected && !pending ? styles.actionBtnHoverOnly : ''}`}
            disabled={pending}
            onClick={onToggle}
            aria-label={row.connected ? t('connectorDisconnect') : (isOAuth ? t('connectorOAuth') : t('connectorConnect'))}
            title={row.connected ? t('connectorDisconnect') : (isOAuth ? t('connectorOAuthHint') : '')}
          >
            {!row.connected && !pending ? (
              <IconLinkOutlineRegular size={16} />
            ) : (
              buttonLabel
            )}
          </button>
        </div>
      </div>
      {popupBlocked && (
        <div className={styles.popupBlockedHint}>
          <span>{t('connectorOAuthPopupBlocked')}</span>
        </div>
      )}
    </div>
  )
}

/* ── single-connector parameter dialog ─────────────────────────────── */

function ConnectorCardParamsDialog({
  controller,
  id,
  t,
  onClose,
}: {
  controller: MarketplaceStore
  id: string
  t: (k: keyof typeof en) => string
  onClose: () => void
}): JSX.Element {
  const schema = getConnectorSchema(id)
  const initial = controller.getConnectorParams(id)
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const { key } of schema) out[key] = initial[key] ?? ''
    return out
  })
  const [saved, setSaved] = useState(false)

  const setField = (key: string, value: string): void => {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const handleSave = (): void => {
    controller.setConnectorParams(id, draft)
    setSaved(true)
  }

  return (
    <div className={styles.paramsDrawerOverlay} onClick={onClose}>
      <div className={styles.connectorParamDialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.paramsDrawerHeader}>
          <h2 className={styles.paramsDrawerTitle}>{t('connectorParamsTitle')} — {id}</h2>
          <button type="button" className={styles.paramsDrawerClose} aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className={styles.paramsDrawerIntro}>
          {t('connectorParamsIntro')}
        </div>
        <div className={styles.connectorParamDialogBody}>
          {schema.map(({ key, required, placeholder }) => {
            const isSecret = /token|secret|key|password/i.test(key)
            return (
              <label key={key} className={styles.paramsLabel}>
                <span>
                  {key}
                  {required && <span className={styles.connectorParamRequired}>{t('connectorParamRequiredAsterisk')}</span>}
                </span>
                <input
                  className={styles.paramsInput}
                  type={isSecret ? 'password' : 'text'}
                  placeholder={placeholder ?? ''}
                  value={draft[key] ?? ''}
                  onChange={(e) => setField(key, e.target.value)}
                />
              </label>
            )
          })}
        </div>
        <div className={styles.paramsDrawerFooter}>
          <button type="button" className={styles.actionBtn} onClick={onClose}>{t('cancel')}</button>
          <button type="button" className={`${styles.actionBtn} ${styles.actionBtnPrimary}`} onClick={handleSave}>{saved ? t('connectorParamsSaved') : t('connectorParamsSave')}</button>
        </div>
      </div>
    </div>
  )
}

/* ── bulk parameter drawer (one <input> per connector parameter, persisted) ── */

function ConnectorBulkParamsDrawer({ controller, t, onClose }: { controller: MarketplaceStore; t: (k: keyof typeof en) => string; onClose: () => void }): JSX.Element {
  /** The bulk editor iterates the live connector list rather than a hard-
   *  coded id list, so newly registered connectors show up automatically. */
  const items = controller.store.getSnapshot().connectors.items
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>(() => {
    const out: Record<string, Record<string, string>> = {}
    for (const row of items) {
      const existing = controller.getConnectorParams(row.id)
      out[row.id] = { ...existing }
    }
    return out
  })
  const [saved, setSaved] = useState(false)

  const setField = (id: string, key: string, value: string): void => {
    setDraft((prev) => {
      const cur = prev[id] ?? {}
      const next = { ...cur }
      if (value.length === 0) delete next[key]
      else next[key] = value
      return { ...prev, [id]: next }
    })
    setSaved(false)
  }

  const handleSave = (): void => {
    for (const id of Object.keys(draft)) {
      controller.setConnectorParams(id, draft[id] ?? {})
    }
    setSaved(true)
  }

  return (
    <div className={styles.paramsDrawerOverlay} onClick={onClose}>
      <div className={styles.paramsDrawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.paramsDrawerHeader}>
          <h2 className={styles.paramsDrawerTitle}>{t('connectorParamsTitle')}</h2>
          <button type="button" className={styles.paramsDrawerClose} aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className={styles.paramsDrawerIntro}>
          {t('connectorParamsIntro')}
        </div>
        <div className={styles.paramsDrawerBody}>
          {items.map((row) => {
            const schema = getConnectorSchema(row.id)
            return (
              <fieldset key={row.id} className={styles.paramsGroup}>
                <legend className={styles.paramsLegend}>{row.name}（{row.id}）</legend>
                {schema.length === 0 && <span style={{ fontSize: 12, color: '#888' }}>—</span>}
                {schema.map(({ key, required, placeholder }) => (
                  <label key={key} className={styles.paramsLabel}>
                    <span>
                      {key}
                      {required && <span className={styles.connectorParamRequired}>{t('connectorParamRequiredAsterisk')}</span>}
                    </span>
                    <input
                      className={styles.paramsInput}
                      type="text"
                      placeholder={placeholder ?? ''}
                      value={draft[row.id]?.[key] ?? ''}
                      onChange={(e) => setField(row.id, key, e.target.value)}
                    />
                  </label>
                ))}
              </fieldset>
            )
          })}
        </div>
        <div className={styles.paramsDrawerFooter}>
          <button type="button" className={styles.actionBtn} onClick={onClose}>{t('cancel')}</button>
          <button type="button" className={`${styles.actionBtn} ${styles.actionBtnPrimary}`} onClick={handleSave}>{saved ? t('connectorParamsSaved') : t('connectorParamsSave')}</button>
        </div>
      </div>
    </div>
  )
}

function ConnectorsSkeleton(): JSX.Element {
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
            <div className={`${styles.skeleton} ${styles.skeletonLine}`} style={{ width: 90, height: 28 }} />
          </div>
        </div>
      ))}
    </div>
  )
}
