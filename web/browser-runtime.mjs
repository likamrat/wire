import { mountEvidence, createFilterState, createAnalysisSlice } from "./client.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { createBoardTransport } from "../lib/client-transport.mjs";
import { createReportDraft, createReportSaveIdentity } from "./report-draft.mjs";
import { createEvidenceUX } from "./ux.mjs";
import { uxIcons } from "./ux-icons.mjs";
import { createOperationIcons } from "./operation-icons.mjs";
import { mountThemeControl } from "./theme-control.mjs";
import { createTimeContext } from "../lib/time.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { dimensionalIcons } from "./dimensional-icons.mjs";
import { mountSidebarNavigation } from "./sidebar-navigation.mjs";
import { createReportScope } from "./report-scope.mjs";
import { createInlineMetadata } from "./metadata.mjs";
import { createSelectControls } from "./select-control.mjs";
import { createControlHelp } from "../lib/control-help.mjs";
import { createRecordedResults } from "./recorded-results.mjs";
import { createLiveState } from "./live-state.mjs";
import { createDisclosureState } from "./disclosure-state.mjs";
import { createReaderSections } from "./reader-sections.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { createSessionJourney } from "./session-journey.mjs";
import { createPagePaths } from "../lib/page-path.mjs";
import { createReportJourney, createPreparedReportFrame } from "./report-journey.mjs";
import { createReportExperience, createReportSaveWarning, decoratePreparedReport, reportFileChoices, reportWorkspacePresentation } from "./report-experience.mjs";
import { createDateRangeCalendar } from "./date-range-calendar.mjs";
import { enhanceReportReading } from "./report-reading.mjs";
import { mountSavedReportBrief } from "./saved-report-brief.mjs";
import { mountCollectionSettings, mountDisplayTimeSettings } from "./settings.mjs";
import { createTextAccess } from "./text-access.mjs";
import { createRequestContext } from "./request-context.mjs";
import { createCallInvestigation } from "./call-investigation.mjs";
import { createPromptAuthorship } from "../lib/prompt-authorship.mjs";
import { createPeriodFlow } from "./period-flow.mjs";
import { createChatCopy } from "../lib/chat-copy.mjs";
import { createLocalSearch } from "./local-search.mjs";
import { createSettingsNavigation } from "./settings-navigation.mjs";
import { createFreshActivity } from "./fresh-activity.mjs";
import { createRefreshSources } from "./refresh-sources.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { mountDashboardLayout } from "./dashboard-layout.mjs";
import { homepageRows, mountAnalyzeHomepage } from "./analyze-homepage.mjs";
import { createRequestTiming } from "./request-timing.mjs";
import { mountRecorderDiagnostics } from "./recorder-diagnostics.mjs";
import { createDeletionFlow, mountDeletion } from "./deletion-flow.mjs";
import { mountRecollection, describeRecollection } from "./recollection-flow.mjs";
import { createAssessmentPresentation, createAssessmentWording, createTimingPresentation, renderRecordedTiming } from "./assessment-presentation.mjs";
import { createAssessmentControls } from "./assessment-controls.mjs";
import { mountConsentSetup } from "./assessment-control-views.mjs";
import { createAssessmentExperience } from "./assessment-experience.mjs";
import { createReportComparison } from "./report-comparison.mjs";
import { createSavedArtifactDeletion } from "./saved-artifact-deletion.mjs";
import { createPeriodComparisonState, createPeriodComparisonPresentation, mountPeriodComparison } from "./period-comparison.mjs";
import { mountTrends } from "./trends.mjs";
import { mountTrendsChart } from "./trends-chart.mjs";
import { createTrendPairModel, mountTrendPair } from "./trends-pair.mjs";
import { createLiveSearchState } from "./live-search-state.mjs";
import { createSearchMembership } from "./search-membership.mjs";
import { mountLiveSearch, createFrozenReportFrame, searchHitPresentation } from "./live-search.mjs";
import { createSearchWireContract } from "../lib/search-wire-protocol.mjs";
import { createReportIdentity } from "../lib/report-identity.mjs";
import { createSearchFields } from "./search-field.mjs";
import { createAnalyzeScope } from "./analyze-scope.mjs";
import { createAnalyzeTrendsEntry } from "./analyze-trends-entry.mjs";
import { mountAnalyzeReferenceEntry } from "./analyze-reference-entry.mjs";
import { mountChartReference, chartReferenceFacts } from "./chart-reference.mjs";
import { createChartReferenceState } from "./chart-reference-state.mjs";
import { mountAnalyzeControls } from "./analyze-controls.mjs";
import { mountAccountSettingsPresentation } from "./account-settings-presentation.mjs";
import { createAccountProfile } from "./account-profile.mjs";
import { createMicrosoftEnrollmentState } from "./microsoft-enrollment-state.mjs";
import { mountMicrosoftEnrollment } from "./microsoft-enrollment.mjs";
import { createNativeConnectionState } from "./native-connection-state.mjs";
import { createNativeConfigurationState } from "./native-configuration-state.mjs";
import { createSourceCollectionState } from "./source-collection-state.mjs";
import { mountSourceCollectionSettings } from "./source-collection-settings.mjs";
import { createBoundedNativeState } from "./bounded-native-state.mjs";
import { createArtifactEligibilityState } from "./artifact-eligibility-state.mjs";
import { createNativeReportPublicationState } from "./native-report-publication-state.mjs";
import { mountBoundedNative } from "./bounded-native.mjs";
import { createNativeActivityPresentation } from "./native-activity.mjs";
import { createMessageMarkdown } from "./message-markdown.mjs";
import { marked } from "marked";
import { activityPage } from "./activity-page.mjs";
import { createSavedFilePreview, createPreparedFileInspection } from "./saved-file-preview.mjs";
import { mountFirstConnection } from "./first-connection.mjs";
import { mountAppUpdate } from "./app-update.mjs";
import { createPageDefaults, bindPageDefaults, pageDefaultSpecs } from "./page-defaults.mjs";
import { createCardVisibility } from "./card-visibility.mjs";
import { createWorkspaceState } from "./frontend/workspace-state.ts";
import { createReportDraftPicker } from "./report-draft-picker.mjs";
import { normalizeSearchText } from "../lib/search-normalize.mjs";
import { createUsageReading } from "./usage-reading.mjs";
import { renderDailyTokenChart } from "./daily-token-chart.mjs";
import { mountDocumentation } from "./documentation.mjs";
import * as usage from "../lib/interaction-usage.mjs";

function factories() {
    const timing = createTimingPresentation(createActivityProjection(null, null, ["unknown"]).summarize, { compact: true });
    const wording = createAssessmentWording(), searchContract = createSearchWireContract(__WIRE_TEXT_POLICY__);
    return {
        createOperationIcons, timing, renderTiming: renderRecordedTiming, wording, reportIdentity: createReportIdentity(), preparedFrame: createPreparedReportFrame,
        mountDocumentation, createPagePaths, createSearchFields, createAnalyzeScope, createAnalyzeTrendsEntry, mountAnalyzeControls, mountFirstConnection, createWorkspaceState,
        createPageDefaults: () => createPageDefaults(pageDefaultSpecs),
        createCardVisibility, renderDailyTokenChart, ...createUsageReading(usage),
        mountAnalyzeHomepage: options => mountAnalyzeHomepage({ ...options, standard: pageDefaultSpecs.analyzeLayout.initial, rowsFor: homepageRows }),
        bindPageDefaults: (prefs, sync) => bindPageDefaults(prefs, pageDefaultSpecs, sync, homepageRows),
        mountAccountSettings: options => mountAccountSettingsPresentation({
            ...options, createNativeConnectionState,
            mountEnrollment: options => mountMicrosoftEnrollment({ ...options, createState: createMicrosoftEnrollmentState }),
        }),
        createAccountProfile, createNativeActivityPresentation, createMessageMarkdown: () => createMessageMarkdown({ marked }), activityPage, createNativeConfigurationState,
        createSourceCollectionState, createRefreshSources, mountSourceCollectionSettings, createBoundedNativeState,
        createNativeReportPublicationState, mountBoundedNative,
        savedFilePreview: createSavedFilePreview, preparedFileInspection: createPreparedFileInspection, createReportDraftPicker, normalizeSearchText,
        createReportSaveIdentity, reportWorkspacePresentation, reportFileChoices, createDateRangeCalendar,
        mountTrends: options => mountTrends({ ...options, createCalendar: createDateRangeCalendar, mountChart: mountTrendsChart, createTrendPairModel, mountTrendPair }),
        createReportExperience: options => createReportExperience({ ...options, createCalendar: createDateRangeCalendar }),
        createReportSaveWarning, decoratePreparedReport, enhanceReportReading, mountSavedReportBrief, mountAnalyzeReferenceEntry,
        chartReference: { facts: chartReferenceFacts, mount: options => mountChartReference({ ...options, createState: createChartReferenceState }) },
        liveSearch: { presentHit: searchHitPresentation,
            mount: options => mountLiveSearch({ ...options, contract: searchContract, presentHit: searchHitPresentation }),
            createState: () => createLiveSearchState(searchContract), contract: searchContract,
            membership: (...args) => createSearchMembership(...args, searchContract), frozenFrame: createFrozenReportFrame },
        periodComparison: { createState: options => createPeriodComparisonState({ ...options, searchContract }),
            createPresentation: createPeriodComparisonPresentation, mount: mountPeriodComparison },
        createExperience: createAssessmentExperience, readerSections: createReaderSections,
        createPresentation: contract => createAssessmentPresentation({ ...contract, timing, wording }),
        createControls: createAssessmentControls, mountConsent: mountConsentSetup,
        createReportComparison: () => createReportComparison(wording, timing.duration),
        createArtifactDeletion: options => createSavedArtifactDeletion({ ...options, createEligibilityState: createArtifactEligibilityState }),
        mountRecollection, describeRecollection,
    };
}

export function mountBrowser(extraFactories = {}, renderer = "bundled", loadedEntry) {
    const element = document.getElementById("wireBootstrap");
    const bootstrap = JSON.parse(element?.textContent ?? "null");
    const appearance = globalThis.__wireAppearance;
    if (!bootstrap || Object.keys(bootstrap).sort().join(",") !== "accessBootstrap,capability,renderer,schemaVersion"
        || bootstrap.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(bootstrap.capability)
        || bootstrap.renderer !== renderer
        || typeof appearance?.theme?.subscribe !== "function" || typeof appearance?.navigation?.subscribe !== "function") {
        throw new TypeError("WIRE browser bootstrap is invalid. Reload this panel; no action was started.");
    }
    element.textContent = ""; element.remove();
    delete globalThis.__wireAppearance;
    if (!extraFactories.mountActivityList) mountDashboardLayout(document.querySelector(".analyze-dashboard"));
    return mountEvidence(bootstrap.capability, createBoardTransport, appearance.theme, createReportDraft,
        createEvidenceUX, uxIcons, mountThemeControl, createTimeContext, createServiceCategories, createDimensionalCharts,
        dimensionalIcons, ux => mountSidebarNavigation(ux, appearance.navigation), createReportScope, createSelectControls,
        createInlineMetadata, createControlHelp, createRecordedResults, createLiveState, createDisclosureState,
        createCollectionStatus, createSessionJourney, createReportJourney, mountCollectionSettings, createTextAccess,
        createPeriodFlow, createChatCopy, mountDisplayTimeSettings, createLocalSearch, createSettingsNavigation,
        createFreshActivity, createPercentageCharts, createRequestTiming, mountRecorderDiagnostics, createDeletionFlow, mountDeletion,
        { ...factories(), mountAppUpdate: options => mountAppUpdate({ ...options, loadedEntry, runtimeId: bootstrap.accessBootstrap?.runtimeId }),
            ...extraFactories }, createPromptAuthorship, createFilterState, createAnalysisSlice,
        createActivityProjection, createRequestContext, createCallInvestigation, bootstrap.accessBootstrap);
}
