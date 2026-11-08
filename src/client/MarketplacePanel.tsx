/**
 * Marketplace panel — full-height center-column component rendered when
 * the 应用市场 sidebar entry is active. Renders the three tabs (Experts /
 * Skills / Connectors) and the active detail overlay. Identical content
 * surface as the previous settings page, with a top-bar close button and
 * a fixed viewport (no longer inside a settings modal).
 *
 * The top-bar carries two affordances: a ⚙ settings icon (opens the
 * global MarketplaceSettingsDialog so the user can paste the
 * skill.dualpaw.com API token regardless of the active tab) and the
 * existing close (×) button. Both live in the header, so the settings
 * dialog is the canonical entry — the duplicated dialog inside ExpertsTab
 * exists only for legacy discoverability and shares the same backing
 * store.
 */
import { useEffect, useState } from 'react'
import {
  IconAgentPresetOutlineRegular, IconDataOutlineRegular,
  IconCloseOutlineRegular, IconLinkOutlineRegular, IconSettingsOutlineRegular,
  IconSearchOutlineRegular, IconPlusOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useMarketplaceSnapshot } from './store.ts'
import type { MarketplaceStore, MarketplaceTab } from './store.ts'
import { ExpertsTab } from './ExpertsTab.tsx'
import { SkillsTab } from './SkillsTab.tsx'
import { ConnectorsTab } from './ConnectorsTab.tsx'
import { ExpertDetail } from './ExpertDetail.tsx'
import { SkillDetail } from './SkillDetail.tsx'
import { MarketplaceSettingsDialog } from './MarketplaceSettingsDialog.tsx'
import { type MarketplaceKey } from './locales.ts'
import styles from './styles.module.css'

/** Injected props for the panel component. */
export interface MarketplacePanelProps {
  controller: MarketplaceStore
  /** Localized label accessor. */
  t: (key: MarketplaceKey) => string
  /** Close-panel callback (wires the top-bar X button). */
  onClose: () => void
  /** Initial tab to focus (defaults to the store's current `activeTab`). */
  initialTab?: MarketplaceTab | undefined
}

const TAB_META: Record<MarketplaceTab, { labelKey: MarketplaceKey; icon: typeof IconAgentPresetOutlineRegular }> = {
  experts: { labelKey: 'tabExperts', icon: IconAgentPresetOutlineRegular },
  skills: { labelKey: 'tabSkills', icon: IconDataOutlineRegular },
  connectors: { labelKey: 'tabConnectors', icon: IconLinkOutlineRegular },
}

/** The marketplace panel: top bar + tabs + body + detail overlay. */
export function MarketplacePanel({ controller, t, onClose, initialTab }: MarketplacePanelProps): JSX.Element {
  const state = useMarketplaceSnapshot(controller)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Unified top-bar search. Each tab owns its query in the store
  // (experts/skills refetch after a debounce; connectors filter locally),
  // so the single input binds to whichever tab is active.
  const activeQuery = state.activeTab === 'experts'
    ? state.experts.query
    : state.activeTab === 'skills'
      ? state.skills.query
      : state.connectorQuery
  const [searchDraft, setSearchDraft] = useState(activeQuery)
  useEffect(() => { setSearchDraft(activeQuery) }, [state.activeTab]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const handle = setTimeout(() => {
      const q = searchDraft
      if (state.activeTab === 'experts') {
        if (q !== controller.store.getSnapshot().experts.query) {
          controller.setExpertQuery(q)
          void controller.loadExperts()
        }
      } else if (state.activeTab === 'skills') {
        if (q !== controller.store.getSnapshot().skills.query) {
          controller.setSkillQuery(q)
          void controller.loadSkills()
        }
      } else {
        if (q !== controller.store.getSnapshot().connectorQuery) controller.setConnectorQuery(q)
      }
    }, 250)
    return () => clearTimeout(handle)
  }, [searchDraft, state.activeTab, controller])

  /** Whether the publish-skill button may show (token configured, skills tab). */
  const canPublishSkill = state.activeTab === 'skills' && state.expertToken.length > 0

  // Apply the initial tab request — used by the composer connector popover's
  // "管理连接器" affordance to deep-link to the connector tab.
  useEffect(() => {
    if (initialTab !== undefined && controller.store.getSnapshot().activeTab !== initialTab) {
      controller.setTab(initialTab)
    }
  }, [controller, initialTab])

  // Deep-link channel. The panel is mounted once and merely hidden when
  // closed, so a static `initialTab` prop cannot express "switch to the
  // connector tab now" — the composer chip's 管理连接器 button therefore
  // fires an event that we translate into a live tab switch.
  useEffect(() => {
    const onSetTab = (event: Event): void => {
      const detail = (event as CustomEvent).detail as { tab?: unknown } | undefined
      const tab = detail?.tab
      if (tab !== 'experts' && tab !== 'skills' && tab !== 'connectors') return
      if (controller.store.getSnapshot().activeTab !== tab) controller.setTab(tab)
    }
    window.addEventListener('dsh:marketplace-set-tab', onSetTab as EventListener)
    return () => { window.removeEventListener('dsh:marketplace-set-tab', onSetTab as EventListener) }
  }, [controller])

  // First mount: ensure the active tab's data is loaded. The store's setTab
  // already triggers a load on tab switch, but the panel itself is what the
  // user sees first — relying on a tab click to kick off the fetch makes
  // every cold start look empty until the user touches 技能 + 专家. We pull
  // the active tab's loader here (and a quick categories prefetch for the
  // default experts tab so the rail doesn't pop in late). The store guards
  // against duplicate loads via the `status === 'idle'` check.
  useEffect(() => {
    const tab = controller.store.getSnapshot().activeTab
    if (tab === 'experts') {
      if (controller.store.getSnapshot().experts.status === 'idle') void controller.loadExperts()
      else if (controller.store.getSnapshot().expertCategories.length === 0) void controller.loadExpertCategories()
    } else if (tab === 'skills') {
      if (controller.store.getSnapshot().skills.status === 'idle') void controller.loadSkills()
    } else if (tab === 'connectors') {
      if (controller.store.getSnapshot().connectors.status === 'idle') void controller.loadConnectors()
    }
  }, [controller])

  return (
    <div className={styles.panelRoot}>
      <div className={styles.topBar}>
        <div className={styles.tabs} role="tablist">
        {(Object.keys(TAB_META) as MarketplaceTab[]).map((tab) => {
          const meta = TAB_META[tab]
          const Icon = meta.icon
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={state.activeTab === tab}
              className={`${styles.tab} ${state.activeTab === tab ? styles.active : ''}`}
              onClick={() => controller.setTab(tab)}
            >
              <Icon size={16} className={styles.tabIcon} />
              {t(meta.labelKey)}
            </button>
          )
        })}
        </div>
        <div className={styles.topBarActions}>
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
          <div className={styles.search}>
            <IconSearchOutlineRegular size={16} className={styles.searchIcon} />
            <input
              type="text"
              className={styles.searchInput}
              placeholder={t('searchPlaceholder')}
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
            />
          </div>
          {canPublishSkill && (
            <button
              type="button"
              className={styles.toolbarActionBtn}
              title={t('skillPublishHint')}
              aria-label={t('skillPublish')}
              onClick={() => window.dispatchEvent(new CustomEvent('dsh:open-publish-skill'))}
            >
              <IconPlusOutlineRegular size={16} />
              <span>{t('skillPublish')}</span>
            </button>
          )}
          {state.activeTab === 'connectors' && (
            <button
              type="button"
              className={styles.iconBtn}
              title={t('connectorParamsTitle')}
              aria-label={t('connectorParamsTitle')}
              onClick={() => window.dispatchEvent(new CustomEvent('dsh:open-connector-params'))}
            >
              <IconSettingsOutlineRegular size={18} />
            </button>
          )}
          <button
            type="button"
            className={styles.panelSettingsBtn}
            data-configured={state.expertToken.length > 0 ? 'true' : 'false'}
            aria-label={t('marketplaceSettingsTitle')}
            title={state.expertToken.length > 0 ? t('marketplaceSettingsConfigured') : t('marketplaceSettingsTitle')}
            onClick={() => setSettingsOpen(true)}
          >
            <IconSettingsOutlineRegular size={18} />
          </button>
          <button
            type="button"
            className={styles.panelClose}
            aria-label={t('close')}
            title={t('close')}
            onClick={onClose}
          >
            <IconCloseOutlineRegular size={18} />
          </button>
        </div>
      </div>

      <div className={styles.panelBody}>
        {state.activeTab === 'experts' && <ExpertsTab controller={controller} t={t} />}
        {state.activeTab === 'skills' && <SkillsTab controller={controller} t={t} />}
        {state.activeTab === 'connectors' && <ConnectorsTab controller={controller} t={t} />}

        {state.expertDetail.status !== 'idle' && state.expertDetail.expert !== null && (
          <ExpertDetail
            controller={controller}
            detail={state.expertDetail.expert}
            loading={state.expertDetail.status === 'loading'}
            error={state.expertDetail.error}
            t={t}
          />
        )}

        {state.skillDetail.status !== 'idle' && state.skillDetail.skill !== null && (
          <SkillDetail
            controller={controller}
            detail={state.skillDetail.skill}
            loading={state.skillDetail.status === 'loading'}
            error={state.skillDetail.error}
            t={t}
          />
        )}
      </div>

      {settingsOpen && (
        <MarketplaceSettingsDialog
          controller={controller}
          onClose={() => setSettingsOpen(false)}
          t={t}
        />
      )}
    </div>
  )
}