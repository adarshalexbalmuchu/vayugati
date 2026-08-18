import { SearchX } from 'lucide-react'
import IncidentEvidencePanel from '../IncidentEvidencePanel'
import InterventionPanel from '../InterventionPanel'
import SourceAttributionPanel from '../SourceAttributionPanel'
import TaskDispatchPanel from '../TaskDispatchPanel'
import { ErrorState, Skeleton, TabPanel, Tabs, type TabItem } from '../ui'
import { useIncidentActions } from '../../lib/useIncidentActions'
import type { AsyncState } from '../../lib/useAsync'
import type { IncidentDetail } from '../../lib/incidents'
import EmptyIncidentState from './EmptyIncidentState'
import IncidentCaseHeader from './IncidentCaseHeader'
import IncidentSummaryTab from './IncidentSummaryTab'
import IncidentTimelinePanel from './IncidentTimelinePanel'

const DETAIL_TABS: TabItem[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'evidence', label: 'Evidence' },
  { key: 'action', label: 'Action' },
  { key: 'timeline', label: 'Timeline' },
]

/** The right pane: loading/error/empty states, then the persistent case
 *  header and the 4 tab-body panels. Evidence folds in the full source
 *  attribution / hypothesis review workflow (it's fundamentally evidence
 *  work); Action folds in intervention tracking + dispatch/routing status
 *  (both are "what's being done about it"). Summary's own quick attribution
 *  line links straight into Evidence instead of repeating that analysis. */
interface DetailPanelProps {
  activeTab: string
  onTabChange: (key: string) => void
  onRefresh: () => void
  onBack: () => void
  onPrev?: () => void
  onNext?: () => void
  position: { index: number; total: number } | null
  queueLabel: string
  wardAqi: number | null
}

export default function IncidentDetailPanel({
  detail,
  ...rest
}: DetailPanelProps & { detail: AsyncState<IncidentDetail | null> }) {
  if (detail.loading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (detail.error) {
    return <ErrorState message={detail.error} onRetry={() => detail.refresh()} />
  }
  if (!detail.data) {
    return <EmptyIncidentState icon={SearchX}>This incident is no longer available.</EmptyIncidentState>
  }
  return <LoadedIncidentDetailPanel detail={detail.data} {...rest} />
}

/** Split out so useIncidentActions (which itself calls useAuth/useState) is
 *  only ever called once `detail.data` genuinely exists - no fabricated
 *  placeholder Incident needed to satisfy the Rules of Hooks. */
function LoadedIncidentDetailPanel({
  detail,
  activeTab,
  onTabChange,
  onRefresh,
  onBack,
  onPrev,
  onNext,
  position,
  queueLabel,
  wardAqi,
}: DetailPanelProps & { detail: IncidentDetail }) {
  const actions = useIncidentActions(detail, onRefresh)

  return (
    <>
      <IncidentCaseHeader
        detail={detail}
        wardAqi={wardAqi}
        detectionPollutant={detail.anomalyCandidates[0]?.pollutant ?? null}
        actions={actions}
        position={position}
        queueLabel={queueLabel}
        onBack={onBack}
        onPrev={onPrev}
        onNext={onNext}
      />
      <Tabs tabs={DETAIL_TABS} active={activeTab} onChange={onTabChange} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TabPanel active={activeTab === 'summary'}>
          <IncidentSummaryTab
            detail={detail}
            actions={actions}
            onRefresh={onRefresh}
            onGoToEvidence={() => onTabChange('evidence')}
          />
        </TabPanel>
        <TabPanel active={activeTab === 'evidence'}>
          <SourceAttributionPanel detail={detail} onRefresh={onRefresh} />
          <IncidentEvidencePanel detail={detail} />
        </TabPanel>
        <TabPanel active={activeTab === 'action'}>
          <InterventionPanel detail={detail} onRefresh={onRefresh} />
          <TaskDispatchPanel detail={detail} onRefresh={onRefresh} />
        </TabPanel>
        <TabPanel active={activeTab === 'timeline'}>
          <IncidentTimelinePanel detail={detail} />
        </TabPanel>
      </div>
    </>
  )
}
