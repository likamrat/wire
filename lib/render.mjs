import { styles } from "../web/styles.mjs";
import { mountEvidence, createFilterState, createAnalysisSlice } from "../web/client.mjs";
import { createActivityProjection } from "./activity-projection.mjs";
import { createBoardTransport } from "./client-transport.mjs";
import { initializeTheme } from "../web/theme.mjs";
import { createReportDraft, createReportSaveIdentity } from "../web/report-draft.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons, lucideLicense } from "../web/ux-icons.mjs";
import { mountThemeControl } from "../web/theme-control.mjs";
import { createTimeContext } from "./time.mjs";
import { createServiceCategories } from "./service-categories.mjs";
import { createDimensionalCharts } from "./dimensional-charts.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { initializeNavigationPreference, mountSidebarNavigation } from "../web/sidebar-navigation.mjs";
import { createReportScope } from "../web/report-scope.mjs";
import { createInlineMetadata } from "../web/metadata.mjs";
import { createSelectControls } from "../web/select-control.mjs";
import { createControlHelp } from "./control-help.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createLiveState } from "../web/live-state.mjs";
import { createDisclosureState } from "../web/disclosure-state.mjs";
import { createReaderSections } from "../web/reader-sections.mjs";
import { createCollectionStatus } from "./collection-status.mjs";
import { createSessionJourney } from "../web/session-journey.mjs";
import { createReportJourney, createPreparedReportFrame } from "../web/report-journey.mjs";
import { createReportExperience, createReportSaveWarning, decoratePreparedReport, reportWorkspacePresentation } from "../web/report-experience.mjs";
import { createDateRangeCalendar } from "../web/date-range-calendar.mjs";
import { enhanceReportReading } from "../web/report-reading.mjs";
import { settingsMarkup, mountCollectionSettings, mountDisplayTimeSettings } from "../web/settings.mjs";
import { createTextAccess } from "../web/text-access.mjs";
import { createRequestContext } from "../web/request-context.mjs";
import { createCallInvestigation } from "../web/call-investigation.mjs";
import { createPromptAuthorship } from "./prompt-authorship.mjs";
import { createPeriodFlow } from "../web/period-flow.mjs";
import { chatCopy, createChatCopy } from "./chat-copy.mjs";
import { createLocalSearch } from "../web/local-search.mjs";
import { createSettingsNavigation } from "../web/settings-navigation.mjs";
import { createFreshActivity } from "../web/fresh-activity.mjs";
import { createRefreshSources } from "../web/refresh-sources.mjs";
import { createPercentageCharts } from "./percentage-charts.mjs";
import { mountDashboardLayout } from "../web/dashboard-layout.mjs";
import { createRequestTiming } from "../web/request-timing.mjs";
import { mountRecorderDiagnostics } from "../web/recorder-diagnostics.mjs";
import { createDeletionFlow, mountDeletion } from "../web/deletion-flow.mjs";
import { deletionStyles } from "../web/deletion-styles.mjs";
import { mountRecollection, recollectionMarkup, recollectionStyles, describeRecollection } from "../web/recollection-flow.mjs";
import { PRODUCT_TITLE, FAVICON_PATH, brandMark, brandDarkMark, brandV1Mark, brandV1DarkMark, brandLockup, brandDarkLockup, brandCompactMark } from "./branding.mjs";
import { createAssessmentPresentation, createAssessmentWording, assessmentPresentationStyles, createTimingPresentation, renderRecordedTiming } from "../web/assessment-presentation.mjs";
import { createAssessmentControls } from "../web/assessment-controls.mjs";
import { mountConsentSetup } from "../web/assessment-control-views.mjs";
import { createAssessmentExperience } from "../web/assessment-experience.mjs";
import { createReportComparison, reportComparisonStyles } from "../web/report-comparison.mjs";
import { mountReportComparisonJourney } from "../web/report-comparison-journey.mjs";
import { createSavedArtifactDeletion } from "../web/saved-artifact-deletion.mjs";
import { createPeriodComparisonState, createPeriodComparisonPresentation, mountPeriodComparison, periodComparisonStyles } from "../web/period-comparison.mjs";
import { mountTrends, trendsStyles } from "../web/trends.mjs";
import { mountTrendsChart } from "../web/trends-chart.mjs";
import { createLiveSearchState } from "../web/live-search-state.mjs";
import { createSearchMembership } from "../web/search-membership.mjs";
import { mountLiveSearch, createFrozenReportFrame, liveSearchMarkup, liveSearchStyles, searchHitPresentation } from "../web/live-search.mjs";
import { createSearchWireContract, searchWireContract } from "./search-wire-contract.mjs";
import { createReportIdentity } from "./report-identity.mjs";
import { searchFieldMarkup, searchFieldStyles, createSearchFields } from "../web/search-field.mjs";
import { createAnalyzeScope } from "../web/analyze-scope.mjs";
import { mountAnalyzeReferenceEntry } from "../web/analyze-reference-entry.mjs";
import { mountChartReference, chartReferenceMarkup, chartReferenceFacts } from "../web/chart-reference.mjs";
import { createChartReferenceState } from "../web/chart-reference-state.mjs";
import { chartReferenceStyles } from "../web/chart-reference-styles.mjs";
import { mountAnalyzeControls } from "../web/analyze-controls.mjs";
import { mountAccountSettingsPresentation } from "../web/account-settings-presentation.mjs";
import { createAccountProfile } from "../web/account-profile.mjs";
import { createMicrosoftEnrollmentState } from "../web/microsoft-enrollment-state.mjs";
import { mountMicrosoftEnrollment } from "../web/microsoft-enrollment.mjs";
import { createNativeConnectionState } from "../web/native-connection-state.mjs";
import { createNativeConfigurationState } from "../web/native-configuration-state.mjs";
import { createSourceCollectionState } from "../web/source-collection-state.mjs";
import { mountSourceCollectionSettings } from "../web/source-collection-settings.mjs";
import { createBoundedNativeState } from "../web/bounded-native-state.mjs";
import { createArtifactEligibilityState } from "../web/artifact-eligibility-state.mjs";
import { createNativeReportPublicationState } from "../web/native-report-publication-state.mjs";
import { mountBoundedNative, boundedNativeStyles } from "../web/bounded-native.mjs";
import { accountSettingsStyles } from "../web/account-settings-styles.mjs";
import { createNativeActivityPresentation } from "../web/native-activity.mjs";
import { activityPage } from "../web/activity-page.mjs";
import { createSavedFilePreview, createPreparedFileInspection, savedFilePreviewStyles } from "../web/saved-file-preview.mjs";

export function renderHtmlShell(capability, nonce, accessBootstrap) {
    const safeCapability = JSON.stringify(capability).replaceAll("<", "\\u003c");
    const safeAccessBootstrap = JSON.stringify(accessBootstrap ?? null).replaceAll("<", "\\u003c");
    const safeNonce = String(nonce).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    const features = `(() => {
        const timing = (${createTimingPresentation.toString()})((${createActivityProjection.toString()})(null, null, ["unknown"]).summarize, { compact: true });
        const renderTiming = ${renderRecordedTiming.toString()};
        const wording = (${createAssessmentWording.toString()})();
        const dateRangeCalendar = ${createDateRangeCalendar.toString()};
        const searchContract = (${createSearchWireContract.toString()})(${JSON.stringify({
            matchPolicyId: searchWireContract.matchPolicyId, types: searchWireContract.allTypes,
        })});
        return {
        timing, renderTiming, wording, reportIdentity: (${createReportIdentity.toString()})(), preparedFrame: ${createPreparedReportFrame.toString()},
        createSearchFields: ${createSearchFields.toString()},
        createAnalyzeScope: ${createAnalyzeScope.toString()}, mountAnalyzeControls: ${mountAnalyzeControls.toString()},
        mountAccountSettings: options => (${mountAccountSettingsPresentation.toString()})({
            ...options, createNativeConnectionState: ${createNativeConnectionState.toString()},
            mountEnrollment: options => (${mountMicrosoftEnrollment.toString()})({
                ...options, createState: ${createMicrosoftEnrollmentState.toString()} }) }),
        createAccountProfile: ${createAccountProfile.toString()},
        createNativeActivityPresentation: ${createNativeActivityPresentation.toString()},
        activityPage: ${activityPage.toString()},
        createNativeConfigurationState: ${createNativeConfigurationState.toString()},
        createSourceCollectionState: ${createSourceCollectionState.toString()},
        createRefreshSources: ${createRefreshSources.toString()},
        mountSourceCollectionSettings: ${mountSourceCollectionSettings.toString()},
        createBoundedNativeState: ${createBoundedNativeState.toString()},
        createNativeReportPublicationState: ${createNativeReportPublicationState.toString()},
        mountBoundedNative: ${mountBoundedNative.toString()},
        savedFilePreview: ${createSavedFilePreview.toString()},
        preparedFileInspection: ${createPreparedFileInspection.toString()},
        createReportSaveIdentity: ${createReportSaveIdentity.toString()},
        reportWorkspacePresentation: ${reportWorkspacePresentation.toString()},
        createDateRangeCalendar: dateRangeCalendar,
        mountTrends: options => (${mountTrends.toString()})({ ...options, createCalendar: dateRangeCalendar, mountChart: ${mountTrendsChart.toString()} }),
        createReportExperience: options => (${createReportExperience.toString()})({ ...options, createCalendar: dateRangeCalendar }),
        createReportSaveWarning: ${createReportSaveWarning.toString()},
        decoratePreparedReport: ${decoratePreparedReport.toString()},
        enhanceReportReading: ${enhanceReportReading.toString()},
        mountAnalyzeReferenceEntry: ${mountAnalyzeReferenceEntry.toString()},
        chartReference: { facts: ${chartReferenceFacts.toString()},
            mount: options => (${mountChartReference.toString()})({ ...options, createState: ${createChartReferenceState.toString()} }) },
        liveSearch: { presentHit: ${searchHitPresentation.toString()}, mount: options => (${mountLiveSearch.toString()})({ ...options, contract: searchContract, presentHit: ${searchHitPresentation.toString()} }),
            createState: () => (${createLiveSearchState.toString()})(searchContract), contract: searchContract,
            membership: (...args) => (${createSearchMembership.toString()})(...args, searchContract), frozenFrame: ${createFrozenReportFrame.toString()} },
        periodComparison: { createState: options => (${createPeriodComparisonState.toString()})({ ...options, searchContract }),
            createPresentation: ${createPeriodComparisonPresentation.toString()},
            mount: ${mountPeriodComparison.toString()} },
        createExperience:${createAssessmentExperience.toString()},
        readerSections:${createReaderSections.toString()},
        createPresentation: contract => (${createAssessmentPresentation.toString()})({ ...contract, timing, wording }),
        createControls:${createAssessmentControls.toString()},
        mountConsent:${mountConsentSetup.toString()},
        createReportComparison: () => (${createReportComparison.toString()})(wording, timing.duration),
        mountComparison:${mountReportComparisonJourney.toString()},
        createArtifactDeletion: options => (${createSavedArtifactDeletion.toString()})({
            ...options, createEligibilityState: ${createArtifactEligibilityState.toString()} }),
        mountRecollection:${mountRecollection.toString()},describeRecollection:${describeRecollection.toString()}
    }; })()`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Inspect recorded Work IQ evidence from GitHub Copilot chats and prepare reviewed product feedback reports.">
<title>${PRODUCT_TITLE}</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_PATH}">
<script nonce="${safeNonce}">const evidenceTheme = (${initializeTheme.toString()})();const evidenceNavigation = (${initializeNavigationPreference.toString()})();const mountNavigation = ux => (${mountSidebarNavigation.toString()})(ux, evidenceNavigation);</script>
<style>${styles}${deletionStyles}${recollectionStyles}${assessmentPresentationStyles}${reportComparisonStyles}${periodComparisonStyles}${trendsStyles}${searchFieldStyles}${liveSearchStyles}${chartReferenceStyles}${accountSettingsStyles}${boundedNativeStyles}${savedFilePreviewStyles}</style></head>
<body class="analyze-shell"><template id="wireIconLicense">${lucideLicense.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</template><a class="skip-link" href="#main">Skip to content</a>
<header class="app-header"><div class="header-inner">
  <div id="shellBrand" class="brand"><a class="brand-home" href="#analyze" data-nav="analyze" aria-label="${PRODUCT_TITLE} - Analyze">${brandLockup}${brandDarkLockup}${brandCompactMark}</a></div>
  <div class="workspace-toolbar"><div class="workspace-toolbar-inner">
  <button id="navigationToggle" class="navigation-toggle quiet" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="navigationDrawer" hidden></button>
  ${liveSearchMarkup}
  <div class="workspace-utilities">
  <div class="theme-control"><button type="button" id="themePreference" class="theme-trigger" role="switch" aria-label="Dark theme" aria-checked="false"></button></div>
  </div>
  </div></div>
</div></header>
<aside id="sidebar" class="app-sidebar" aria-label="Navigation">
  <button id="navigationCollapse" class="navigation-collapse" type="button" aria-label="Collapse navigation" aria-expanded="true" aria-controls="navigationContent">${uxIcons["navigation-collapse"]}</button>
  <div id="navigationContent" class="navigation-content">
    <section class="navigation-workspace" aria-labelledby="workspaceNavigationTitle">
      <h2 id="workspaceNavigationTitle" class="navigation-group-label">Workspace</h2>
      <nav class="primary-navigation" aria-label="Main navigation">
        <a href="#analyze" data-nav="analyze"><span class="navigation-label">Analyze</span></a>
        <a href="#trends" data-nav="trends"><span class="navigation-label">Trends</span></a>
        <a href="#reports" data-nav="reports"><span class="navigation-label">Reports</span></a>
        <a id="comparePeriods" href="#analyze?compare=periods" data-nav="compare"><span class="navigation-label">Compare periods</span></a>
      </nav>
    </section>
    <section id="analyzeTools" class="analyze-tools" aria-label="Analyze tools" hidden>
      <h2 class="navigation-group-label">Analyze tools</h2><div id="analyzeReturnActions"></div><div id="analyzeToolActions"></div>
    </section>
    <div id="navigationFooter" class="navigation-footer">
      <div id="wireAccountEntry" hidden></div>
      <nav class="primary-navigation" aria-label="Utility navigation">
        <a href="#settings" data-nav="settings"><span class="navigation-label">Settings</span></a>
      </nav>
    </div>
  </div>
</aside>
<template id="reportBrand">${brandMark}${brandDarkMark}</template>
<template id="reportBrandV1">${brandV1Mark}${brandV1DarkMark}</template>
<template id="reportBrandV2">${brandLockup}${brandDarkLockup}</template>
<dialog id="navigationDrawer" class="navigation-drawer" aria-labelledby="navigationTitle"><div class="drawer-heading"><h2 id="navigationTitle">Navigation</h2><button type="button" id="closeNavigation" class="quiet" aria-label="Close navigation">Close</button></div><div id="drawerBrand"></div><div id="drawerContent"></div></dialog>
<main id="main" tabindex="-1">
  <p id="wireAnalysisSearchNotice" class="notice" role="status" hidden></p>
  <p id="themeStorageNotice" class="notice" role="status" hidden>Theme preference cannot be saved in this browser. Your choice applies to this panel only.</p>
  <p id="navigationStorageNotice" class="notice" role="status" hidden>Navigation preference cannot be saved in this browser. Your choice applies to this panel only.</p>
  <p id="timeZoneNotice" class="notice" role="status" hidden></p>
  <section id="accessShell" class="page-heading" aria-label="WIRE workspace" hidden>
    <div><h1 id="accessPageTitle">Analyze</h1><p>Saved activity on this device</p></div>
    <div class="page-actions"><a id="accessSettings" class="text-link" href="#settings?section=connection">Connection settings</a><button id="accessAccount" type="button" class="quiet">WIRE account</button><button id="accessRetry" type="button" class="quiet" hidden>Read current access</button></div>
  </section>
  <div id="message" class="notice" role="status" aria-live="polite" hidden></div>
  <section id="loading" class="loading-state" aria-label="Loading your activity" aria-busy="true"><div class="skeleton heading"></div><div class="skeleton summary"></div><div class="skeleton chart-placeholder"></div><p id="loadingStatus" role="status">Loading your recorded activity...</p></section>
  <div id="workspace" hidden>
    <p id="navigationPending" class="navigation-pending" role="status" hidden></p>
    <nav id="breadcrumbs" class="breadcrumbs" aria-label="Breadcrumb"></nav>
    <div class="page-heading"><div><p id="pageIdentity" class="session-label" hidden>${chatCopy.nameLabel}</p><h1 id="pageTitle">Analyze</h1><p id="pageIntro">Explore recorded interactions, calls and their results.</p><div id="pageProject"></div></div><div id="pagePrimaryActions" class="page-actions"><a id="pageAction" class="button-link" href="#reports?task=create">Create report</a></div>
    <div id="reportSelectionBar" class="report-selection-bar contextual-bar" aria-label="View and report selection" hidden>
      <div id="activitySelectionContext" class="contextual-summary"><p id="activitySelectionSummary" role="status">No requests selected</p><span id="activitySelectionScope" class="muted"></span></div>
      <div id="pageHeadingActions" class="contextual-actions" role="group" aria-label="View and report selection actions"><span id="contextReturn" hidden></span><a id="reportContextAction" class="button-link" href="#analyze" hidden>Back to Analyze</a><button id="activityClearSelection" type="button" data-clear-selection>Clear selection</button></div>
    </div>
    </div>
    <div id="analyzeToolbar" class="analyze-toolbar" hidden><span id="analyzeReferenceEntry" hidden><button id="openChartReference" class="quiet" type="button" aria-label="Chart guide: How to read these charts" aria-controls="meaning"><span class="analyze-entry-label">Chart guide</span></button></span><button id="analyzeRefresh" class="quiet" type="button" aria-label="Refresh"><span id="analyzeRefreshLabel">Refresh</span></button><button id="openAnalyzeFilters" class="quiet" type="button" aria-label="Filters and view" aria-haspopup="dialog" aria-expanded="false" aria-controls="analyzeFilterDialog">${uxIcons.filter}<span class="analyze-entry-label">Filters</span><span id="analyzeFilterCount" class="analyze-filter-count" aria-hidden="true" hidden></span></button><span id="analyzeRefreshStatus" class="visually-hidden" role="status" aria-live="polite"></span></div>
    <section id="analyzePopulation" class="analyze-population" aria-label="Choose recorded activity"><h2 id="filterHeading" class="filter-heading">${uxIcons.filter}Filters</h2><section id="periodComparisonSetup" aria-labelledby="periodComparisonTitle" hidden></section></section>
    <dialog id="analyzeFilterDialog" class="analyze-filter-dialog" aria-labelledby="filterHeading"><div id="analyzeFilterPanel" class="analyze-filter-panel">
      <div class="analyze-filter-heading"><div id="analyzeFilterHeading"></div><button id="closeAnalyzeFilters" type="button" class="quiet icon-only" aria-label="Close filters and view">${uxIcons.close}</button></div>
      <div id="analyzeFilterFields"></div><div id="analyzeAppliedFilters"></div>
      <fieldset id="analyzeViewControls" class="analyze-view-controls"><legend>View</legend></fieldset>
      <div id="analyzeSourceContext"></div>
    </div></dialog>
    <section id="freshActivity" class="fresh-activity" aria-label="Update recorded activity" hidden>
      <h3 id="freshHeading" hidden>Recorded activity</h3>
      <div class="fresh-controls">
        <button id="checkActivity" type="button" class="quiet">Refresh</button>
        <button id="freshStoredRead" type="button" class="quiet icon-action" hidden>${uxIcons.database}<span>Reload saved data</span></button>
        <div class="fresh-details">
          <details id="freshHelp"><summary>Update details</summary><div id="freshHelpBody" class="fresh-help-body"><p>Refresh checks approved local history; without approval, it reads stored activity only. Paused collection stays paused. It does not run Work IQ or Graph queries.</p><p>History coverage is for all eligible chats, not this view's filters. No new records does not mean complete history.</p><div id="freshCoverageDetails" hidden></div><p id="freshCheckDetails" hidden></p></div></details>
        </div>
        <div id="freshResult" class="fresh-result">
          <div role="status" aria-live="polite" aria-atomic="true"><div class="fresh-result-summary"><p id="freshStatus" hidden></p><p id="freshChecked" class="muted" hidden></p></div><p id="freshContextMessage" class="muted" hidden></p><span id="freshCoverageAnnouncement" class="visually-hidden"></span></div>
          <div class="fresh-result-meta"><a id="freshIssues" href="#settings?section=connection&setting=source-paths" data-settings-link hidden>Review source</a></div>
          <div id="storedRefresh" class="stored-refresh" hidden><button id="refreshBtn" type="button" class="quiet" aria-describedby="freshStatus freshContextMessage storedRefreshHelp">Read stored activity</button><p id="storedRefreshHelp" hidden></p></div>
        </div>
      </div>
    </section>
    <p id="freshAwayNotice" class="notice" role="status" hidden><strong>Recorded activity update:</strong><span id="freshAwayStatus"></span> <a id="freshAwayLink" href="#settings?section=connection&setting=collect-now" data-settings-link>View activity update</a></p>
    <div id="collectionNotice" class="collection-notice" hidden><p id="collectionNoticeText" role="status" aria-live="polite"></p><button id="collectionRetry" hidden>Retry</button><a id="collectionNoticeAction" href="#settings" data-settings-link class="text-link">Open Settings</a></div>
    <p id="newDataNotice" class="notice" role="status" hidden>New data is available. Your report preview stays frozen; close it to update the activity view.</p>
    <div id="settingsDraftNotice" class="notice settings-draft-notice" role="status" hidden><span>Unsaved Settings changes are kept in this panel.</span><a href="#settings" data-settings-link>Return to Settings</a></div>
    ${settingsMarkup}
    <section id="sessionAnalysis" class="session-analysis" aria-label="Copilot chat analysis" hidden></section>
    <form id="filters" class="filters" aria-label="Activity filters">
      <div class="filter-scroll" role="region" aria-label="Filter row" aria-describedby="filterScrollHelp" tabindex="0" data-ux-tooltip-boundary><div class="period-controls"><div class="primary-single-fields">
      <label>Dates<select id="dateFilter"><option value="capture">All dates</option><option value="day">Today</option><option value="week">This week (Mon-Sun)</option><option value="month">This month</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="custom">Custom dates</option></select></label>
      <label>Source<select id="sourceFilter"><option value="all">All sources</option></select></label>
      <label>Tool<select id="toolFilter"><option value="all">All tools</option></select></label>
      <label>Service involved<select id="serviceAssociationFilter" aria-describedby="serviceFocusScope"><option value="all">All services</option></select></label>
      </div><div class="primary-multiple-fields">
      <div id="resultSummary" class="home-result-filter" role="group" aria-labelledby="resultFilterLabel" aria-describedby="resultFilterScope"><div class="result-filter-field"><label id="resultFilterLabel" for="outcomeFilter">Outcome</label><div class="local-filter-row"><select id="outcomeFilter" multiple data-select-mode="multiple" aria-describedby="resultFilterScope"></select><span class="filter-clear-slot"><button id="clearResultFilter" type="button" class="quiet filter-clear" aria-label="Cancel pending outcome filter" hidden></button></span></div></div></div>
      <div id="promptAuthorSummary" class="prompt-author-filter result-filter-field" role="group" aria-labelledby="promptAuthorFilterLabel">
        <label id="promptAuthorFilterLabel" for="promptAuthorFilter">Prompt author</label>
        <div class="local-filter-row"><select id="promptAuthorFilter" multiple data-select-mode="multiple" data-all-label="All authors" data-empty-hint="Select at least one prompt author." data-selection-noun="authors" aria-describedby="promptAuthorFilterHelp"><option value="user" selected>My prompts</option><option value="agent" selected>Agent prompts</option><option value="unknown" selected>Author unverified</option></select><span class="filter-clear-slot"><button id="clearPromptAuthorFilter" type="button" class="quiet filter-clear" aria-label="Cancel pending author filter" hidden></button></span></div>
        <p id="promptAuthorFilterHelp" class="visually-hidden">Filters by the originating prompt. Calls made by an agent stay with the prompt they belong to. All includes unverified authors.</p>
      </div>
      </div></div></div>
      <div class="filter-utilities"><details id="moreFilters" class="more-filters"><summary id="moreFiltersToggle">More filters</summary><div class="secondary-filters period-controls">
      <label>Activity category<select id="serviceFilter"><option value="all">All categories</option></select></label>
      <label>Copilot project<select id="projectFilter"><option value="all">All projects</option></select></label>
      <label>Copilot chat<select id="chatFilter"><option value="all">All Copilot chats</option></select></label>
      <label>Evidence layer<select id="layerFilter"><option value="tool">Work IQ calls</option><option value="direct-request">Graph API call sites</option><option value="recorded-http">Call sites with HTTP status</option><option value="reported-api">Tool-returned API entries</option><option value="http">HTTP recorder captures</option><option value="code-reference">Graph code references</option></select></label>
      <label>Collection<select id="scopeFilter"><option value="history">Saved collection</option><option value="legacy">Earlier snapshot</option><option value="all">Both collections</option></select></label>
      </div></details></div>
      <p id="filterScrollHelp" class="visually-hidden"></p>
      <p id="resultFilterScope" class="visually-hidden"></p>
      <div id="dateFields" class="date-fields" hidden><label><span>From</span><input id="fromFilter" type="date" aria-describedby="dateHint dateError"></label><label><span>To</span><input id="toFilter" type="date" aria-describedby="dateHint dateError"></label><div class="date-actions"><button id="applyDates" type="submit">Apply dates</button><button id="clearDates" type="button" class="quiet" aria-label="Clear date filter">Clear</button></div><p id="dateHint" class="date-scope">Both dates included.</p><p id="dateError" class="error" role="alert" hidden></p></div>
      <p id="resetScopeHelp" class="visually-hidden">Clear filters and Search. Report choices and saved activity stay unchanged.</p>
    </form>
    <div id="appliedFilters" class="applied-filters"><div id="filterChips" class="filter-chips" aria-label="Applied filters"></div><div id="filterTools" class="filter-tools"><button id="resetView" class="reset-view quiet" type="button" aria-describedby="resetScopeHelp" disabled>Reset filters</button></div></div>
    <div id="serviceFocus" class="service-focus" hidden><p id="serviceFocusScope" role="status"></p><button id="addServiceContext" type="button" class="quiet" hidden>Include calls with missing service details</button></div>
    <p id="periodResult" role="status" aria-live="polite"></p><p id="periodHint"></p>
    <div id="periodCoverage" class="period-coverage" hidden><p id="periodCoverageText"></p><a id="periodHistoryLink" href="#settings?section=history" data-settings-link>History settings</a></div>
    <section id="periodComparison" class="period-comparison" aria-labelledby="periodComparisonResultsTitle" hidden></section>
    <div id="viewingContext" class="viewing-context" role="region" aria-label="Current viewing context"></div>
    <div id="scopeResetActions" class="scope-reset-actions" hidden></div>
    <section id="serviceEvidenceSummary" class="service-evidence-summary" aria-labelledby="serviceEvidenceTitle" hidden></section>
    <section id="homeView" aria-labelledby="chartTitle">
      <div id="analyzeEmptyScope" hidden></div>
      <div id="analyzeScopeSummary" class="analyze-scope-summary"><p id="analyzeScopeError" class="analyze-scope-error" role="alert" hidden>${uxIcons.warning}<span id="analyzeScopeErrorText"></span></p><p id="analyzeScopeStatus" class="analyze-scope-status" role="status" hidden></p>      <p id="analyzeScopeCaption" class="analyze-scope-caption"></p><div id="analyzeSourceCoverage" hidden></div></div>
      <div class="analyze-dashboard">
      <div class="analyze-chart-grid">
      <div class="analyze-outcome-summary"><div id="outcomeChart"></div></div>
      <section class="analyze-chart-main" aria-labelledby="chartTitle">
      <div class="insight-header"><div class="view-switch" role="group" aria-label="Chart view"><button data-chart="time" aria-pressed="true">Over time</button><button data-chart="workload" aria-pressed="false">By category</button><button data-chart="endpoint" aria-pressed="false">By path or operation</button></div></div>
      <div class="chart-panel"><div class="chart-heading"><h2 id="chartTitle">Assistant activity</h2></div><div id="chart"></div><div id="chartFooter" class="chart-footer"></div></div>
      </section>
      </div>
      <div id="percentageCharts"></div>
      </div>
      <div class="chart-actions"><a id="exploreLink" class="text-link" href="#activity" hidden>Explore the requests behind this chart</a></div>
    </section>
    <section id="activityView" hidden aria-labelledby="activityTitle"><div id="activityListContext" class="section-heading activity-list-context"><h2 id="activityTitle" class="visually-hidden" tabindex="-1">Activity</h2><p id="activityListSummary" class="list-summary" role="status" tabindex="-1" aria-describedby="activityListScope"></p><p id="activityListScope" class="activity-list-scope" hidden></p><label class="search-label" hidden>Legacy private search<input id="activitySearch" type="search" placeholder="Search" autocomplete="off"></label><button id="clearActivitySearch" type="button" class="quiet" hidden>Clear legacy search</button></div><div id="analyzeResultActions" class="analyze-result-actions"></div><div id="activityPager" class="pager"></div><div id="activityList"></div></section>
    <section id="analyzeReference" class="analyze-reference" hidden aria-label="Chart guide">${chartReferenceMarkup}</section>
    <section id="trendsView" hidden aria-label="Trends"></section>
    <section id="reportsView" hidden aria-label="Reports">
      <nav id="reportTaskNav" class="report-task-nav" aria-label="Reports tasks"><a id="reportLibraryLink" class="button-link quiet" href="#reports">Back to Reports</a><a id="reportCompareLink" class="button-link quiet" href="#reports?task=compare">Compare saved reports</a><a id="reportCreateLink" class="button-link" href="#reports" hidden>Reports</a></nav>
      <div class="report-start"><div id="reportPreviewContext" class="report-preview-controls contextual-bar"><p id="previewSelectionSummary" role="status">No requests selected</p><div id="reportSelectionActions" class="report-selection-actions"><button id="reportClearSelection" type="button" data-clear-selection>Clear selection</button><button id="exportBtn" class="primary" disabled>Preview report</button></div></div></div>
      <p id="reportTimeContext" class="muted"></p>
      <fieldset class="export-scope"><legend class="visually-hidden">Activity to include</legend><div class="scope-choices">
        <label class="scope-choice"><input type="radio" name="reportScope" value="all"><span><strong>All collected activity</strong><small id="scopeCount-all">Loading scope...</small></span></label>
        <label class="scope-choice"><input type="radio" name="reportScope" value="current"><span><strong>Current Analyze view</strong><small id="scopeCount-current">Loading scope...</small></span></label>
        <label class="scope-choice"><input type="radio" name="reportScope" value="selected" checked><span><strong>Selected interactions</strong><small id="scopeCount-selected">0 interactions</small></span></label>
      </div><p id="reportScopeChoiceHelp" class="scope-choice-help"></p><p id="scopeSummary" class="scope-summary" role="status"></p><p id="scopeExplanation" class="scope-explanation"></p>
      <div class="report-author-choice"><label for="reportPromptAuthorFilter">Authors in report</label><select id="reportPromptAuthorFilter" multiple data-select-mode="multiple" data-select-presentation="filter" data-all-label="All prompt authors" data-empty-hint="Select at least one prompt author." data-selection-noun="authors"><option value="user" selected>My prompts</option><option value="agent" selected>Agent prompts</option><option value="unknown" selected>Author unverified</option></select><p id="reportPromptAuthorSummary" class="scope-summary" role="status"></p><p id="reportPopulationNote" class="context-help-note" role="status"></p></div>
      <div id="reportMatchingContext" class="report-matching-context"></div>
      <p class="scope-explanation">Reloading discards this draft.</p>
      <details id="scopeDetails" class="detail-disclosure"><summary>Scope and exclusions</summary><div id="scopeExclusions"></div></details></fieldset>
      <div class="report-options">
        <div class="report-text-options">
        <div class="report-title-field"><label for="reportTitle">Report name</label><input id="reportTitle" type="text" maxlength="200" autocomplete="off" spellcheck="false" aria-describedby="reportTitleHelp"><p id="reportTitleHelp" class="context-help-note">Detected personal details in the name are hidden in saved files.</p></div>
        <fieldset id="promptOptions"><legend>Personal details from your chats</legend>
          <label class="prompt-choice"><input type="radio" name="promptMode" value="none"><span><strong>Leave out prompts and replies</strong><span>Keep the recorded calls and results.</span></span></label>
          <label class="prompt-choice"><input type="radio" name="promptMode" value="masked" checked><span><strong>Hide personal details</strong><span>WIRE may miss names or sensitive context. Your saved chats stay unchanged.</span></span></label>
          <label class="prompt-choice"><input type="radio" name="promptMode" value="original"><span><strong>Keep chat details</strong><span>Detected passwords and other credentials are still removed.</span></span></label>
        </fieldset>
          <label class="prompt-choice"><input id="reportRecordedContext" type="checkbox" aria-describedby="reportRecordedContextHelp"><span><strong>Include linked requests and replies</strong><span>Up to one linked request before and one after each included interaction, with available replies. Not the whole chat.</span></span></label>
          <p id="reportRecordedContextHelp" class="context-help-note" hidden></p>
          <label class="prompt-choice"><input id="reportResultText" type="checkbox"><span><strong>Include error messages from the calls</strong><span>Only error details WIRE retained. Detected personal details stay hidden.</span></span></label>
        </div>
        <fieldset id="formatOptions"><legend>Files to save</legend><div class="format-choices">
          <label><input type="checkbox" value="html" checked>Web page (HTML)</label><label><input type="checkbox" value="pdf">PDF</label><label><input type="checkbox" value="json">Data (JSON)</label><label><input type="checkbox" value="markdown">Markdown</label>
        </div><p id="formatError" class="notice error" role="alert" hidden>Select at least one format before previewing.</p>
        <details id="additionalMasking" class="detail-disclosure"><summary>Additional masking</summary><label class="report-field" for="manualTerms">Names or phrases to mask in report copies</label><textarea id="manualTerms" rows="4" autocomplete="off" spellcheck="false" placeholder="One exact name or phrase per line"></textarea><p>Case-insensitive. Terms aren't saved as preferences.</p></details>
        </fieldset>
        <p class="report-privacy-note">Scanned on this device. Local saving isn't permission to share.</p>
      </div>
      <section id="reportRequests" class="report-scope-details" aria-labelledby="reportRequestsTitle"><h3 id="reportRequestsTitle" class="visually-hidden">Choose interactions</h3><div class="scoped-search"><label for="reportRequestSearch">Find an interaction</label>${searchFieldMarkup({ id: "reportRequestSearch", clearId: "clearReportRequestSearch", placeholder: "Prompt, conversation or source", describedBy: "reportRequestSearchHelp" })}<p id="reportRequestSearchHelp" class="visually-hidden">Filters available cards only; report selection is unchanged.</p><p id="reportRequestSearchCount" class="search-count" role="status"></p></div><div id="reportList" class="report-selection-list"></div></section>
      <section id="savedReportsPanel" aria-label="Saved report library"><section id="bundles" class="saved-library" aria-labelledby="savedLibraryTitle"><div class="saved-library-heading"><div class="saved-library-title"><h2 id="savedLibraryTitle" tabindex="-1">Saved reports</h2>
        <div class="saved-library-context"><p id="savedReportCount"></p></div></div>
        <div class="saved-library-tools"><div class="scoped-search"><label for="savedReportSearch" class="visually-hidden">Find a saved report</label>${searchFieldMarkup({ id: "savedReportSearch", clearId: "clearSavedReportSearch", placeholder: "Search reports", describedBy: "savedReportSearchHelp" })}<p id="savedReportSearchHelp" class="visually-hidden">Search titles, IDs, dates, formats, prompt modes and time zones, not report contents.</p></div><label for="savedReportOrder" class="visually-hidden">Preparation order</label><select id="savedReportOrder" data-select-presentation="filter"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div></div>
        <p id="savedReportSearchCount" class="search-count" role="status"></p><div id="bundleList"></div>
        <div id="savedLibraryManagement" class="saved-report-menu" popover="auto" role="dialog" aria-label="Saved-report options"><button id="deleteAllReports" type="button" class="quiet danger">Delete all saved reports</button></div>
      </section></section><section id="comparisonWorkspace" aria-label="Compare saved reports" hidden></section><section id="savedReportReader" aria-labelledby="pageTitle" hidden></section></section>
    <details id="coverage" class="coverage supporting reading-section"><summary>About this evidence</summary><p id="evidenceExplanation">Work IQ activity shows tool calls and recorded results. A successful tool result does not confirm that the whole task was completed correctly.</p><p id="coverageNotice">Counts use retained evidence; unavailable Copilot chat history may leave gaps. Graph requests made inside hosted Work IQ are not visible in local logs.</p><div id="coverageBody"></div><p class="coverage-destination"><a href="#collection-status?setting=collection-details" data-settings-link>Collection status</a> explains coverage, history gaps and how the evidence was recorded.</p></details>
  </div>
</main>
<div id="contextSidebarParking" hidden></div>
<dialog id="contextSidebar" aria-labelledby="contextSidebarTitle">
  <header class="context-sidebar-header"><h2 id="contextSidebarTitle" tabindex="-1">Interaction</h2><div class="context-sidebar-controls"><div id="readerWidthControls" hidden><button id="narrowInteraction" type="button" class="quiet" aria-label="Narrow interaction"></button><button id="widenInteraction" type="button" class="quiet" aria-label="Widen interaction"></button></div><button id="expandInteraction" type="button" class="quiet" hidden></button><button id="closeContextSidebar" type="button" class="quiet" aria-label="Close interaction"></button></div></header>
  <div id="readerResize" role="separator" aria-label="Interaction width" aria-orientation="vertical" aria-controls="contextSidebarBody" tabindex="0" hidden></div>
  <div id="contextSidebarBody"><section id="requestView" aria-labelledby="contextSidebarTitle"><div id="requestContent"></div></section></div>
  <footer id="contextSidebarFooter"></footer>
</dialog>
<dialog id="overlay" aria-labelledby="dialogTitle"><div class="dialog-head"><h2 id="dialogTitle"></h2><div class="report-selection-actions"><button type="button" id="clearPreviewSelection" data-clear-selection hidden>Clear selection</button><button id="closeDialog" class="quiet">Close</button></div></div><div id="detail" class="dialog-body"></div></dialog>
<dialog id="deleteDialog" class="decision-frame" data-decision-kind="destructive" aria-labelledby="deleteTitle" aria-describedby="deleteBoundary">
  <div class="delete-heading"><span id="deleteWarningIcon" aria-hidden="true"></span><h2 id="deleteTitle">Delete collected activity</h2></div>
  <div class="decision-body">
  <form id="deleteScopeForm">
    <p id="deleteBoundary">Deletes this app's collected activity and associated local copies, not your Copilot chats or source files.</p>
    <fieldset><legend>Choose what to delete</legend><label class="delete-choice"><input type="radio" name="deletionScope" id="deleteRange" value="range" checked>Custom date range</label><label class="delete-choice"><input type="radio" name="deletionScope" id="deleteAll" value="all">All collected activity</label></fieldset>
    <div id="deleteDateFields"><label>From<input id="deleteFrom" type="date"></label><label>To<input id="deleteTo" type="date"></label></div>
    <p class="muted">Independent of view filters. Both dates are included in the current display time zone. Unknown-time records are kept for date-range deletion.</p>
    <button id="deletePreview" type="submit">Preview deletion</button>
  </form>
  <div id="deleteConfirmation" hidden><div class="decision-scope"><p id="deleteSummary"></p><button id="deleteChangeScope" type="button" class="quiet" hidden>Change scope</button></div><p id="deleteBreakdown"></p><p id="deleteLinkedInsights" hidden></p><p id="deleteCopies"></p><p>Deleted activity will not return during normal collection. New calls can still be collected.</p><p class="delete-irreversible">Permanent local deletion. This cannot be undone.</p><details class="reading-section"><summary>Deletion details</summary><p id="deleteZone" class="muted"></p><p id="deleteLinkedDetails" class="muted" hidden></p><p class="muted">The preview expires after two minutes. Changes require a fresh confirmation. Only existing collected identities are deleted; previously unread history may still arrive. To deliberately reread available approved history later, use Recollect from approved sources in Data management. That separate confirmation does not recover deleted historical annotations or response captures.</p><p class="muted">Source approval and collection preferences stay unchanged. Saved reports, downloads and unmanaged backups may retain copies; this is not forensic erasure. Managed migration snapshots and collector context are cleaned.</p></details></div>
  <p id="deleteStatus" class="decision-status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
  </div>
  <div class="delete-actions"><button id="deleteCancel" type="button" autofocus>Cancel</button><button id="deleteCheck" type="button" data-decision-action="check" hidden>Check deletion result</button><button id="deleteConfirm" type="button" class="danger" data-decision-action="commit" disabled>Delete records</button></div>
</dialog>
${recollectionMarkup}
<script nonce="${safeNonce}">(${mountDashboardLayout.toString()})(document.querySelector(".analyze-dashboard"));</script>
<script nonce="${safeNonce}">(${mountEvidence.toString()})(${safeCapability},${createBoardTransport.toString()},evidenceTheme,${createReportDraft.toString()},${createEvidenceUX.toString()},${JSON.stringify(uxIcons).replaceAll("<", "\\u003c")},${mountThemeControl.toString()},${createTimeContext.toString()},${createServiceCategories.toString()},${createDimensionalCharts.toString()},${JSON.stringify(dimensionalIcons).replaceAll("<", "\\u003c")},mountNavigation,${createReportScope.toString()},${createSelectControls.toString()},${createInlineMetadata.toString()},${createControlHelp.toString()},${createRecordedResults.toString()},${createLiveState.toString()},${createDisclosureState.toString()},${createCollectionStatus.toString()},${createSessionJourney.toString()},${createReportJourney.toString()},${mountCollectionSettings.toString()},${createTextAccess.toString()},${createPeriodFlow.toString()},${createChatCopy.toString()},${mountDisplayTimeSettings.toString()},${createLocalSearch.toString()},${createSettingsNavigation.toString()},${createFreshActivity.toString()},${createPercentageCharts.toString()},${createRequestTiming.toString()},${mountRecorderDiagnostics.toString()},${createDeletionFlow.toString()},${mountDeletion.toString()},${features},${createPromptAuthorship.toString()},${createFilterState.toString()},${createAnalysisSlice.toString()},${createActivityProjection.toString()},${createRequestContext.toString()},${createCallInvestigation.toString()},${safeAccessBootstrap});</script></body></html>`;
}
