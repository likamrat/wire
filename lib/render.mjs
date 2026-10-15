import { styles } from "../web/styles.mjs";
import { mountEvidence, createFilterState, createAnalysisSlice } from "../web/client.mjs";
import { createActivityProjection } from "./activity-projection.mjs";
import { createBoardTransport } from "./client-transport.mjs";
import { initializeTheme } from "../web/theme.mjs";
import { createReportDraft } from "../web/report-draft.mjs";
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
import { createCollectionStatus } from "./collection-status.mjs";
import { createSessionJourney } from "../web/session-journey.mjs";
import { createReportJourney, createPreparedReportFrame } from "../web/report-journey.mjs";
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
import { createPercentageCharts } from "./percentage-charts.mjs";
import { createRequestTiming } from "../web/request-timing.mjs";
import { mountRecorderDiagnostics } from "../web/recorder-diagnostics.mjs";
import { createDeletionFlow, mountDeletion } from "../web/deletion-flow.mjs";
import { deletionStyles } from "../web/deletion-styles.mjs";
import { mountRecollection, recollectionMarkup, recollectionStyles } from "../web/recollection-flow.mjs";
import { PRODUCT_DESCRIPTION, PRODUCT_TITLE, brandMark, brandDarkMark, brandCompactMark } from "./branding.mjs";
import { createAssessmentPresentation, createAssessmentWording, renderAssessmentSummary, assessmentPresentationStyles, createTimingPresentation, renderRecordedTiming } from "../web/assessment-presentation.mjs";
import { createAssessmentControls } from "../web/assessment-controls.mjs";
import { mountConsentSetup, mountPersonalFeedback } from "../web/assessment-control-views.mjs";
import { createAssessmentExperience } from "../web/assessment-experience.mjs";
import { createReportComparison, reportComparisonStyles } from "../web/report-comparison.mjs";
import { mountReportComparisonJourney } from "../web/report-comparison-journey.mjs";
import { createSavedArtifactDeletion } from "../web/saved-artifact-deletion.mjs";
import { createAutomaticScoreClient } from "../web/automatic-score-client.mjs";
import { createAutomaticScoreExperience } from "../web/automatic-score-experience.mjs";
import { mountAutomaticScoresRow, mountAutomaticScoresApproval, automaticScoreStyles } from "../web/automatic-score-views.mjs";
import { createPeriodComparisonState, mountPeriodComparison, periodComparisonStyles } from "../web/period-comparison.mjs";
import { createLiveSearchState } from "../web/live-search-state.mjs";
import { createSearchMembership } from "../web/search-membership.mjs";
import { mountLiveSearch, createFrozenReportFrame, liveSearchMarkup, liveSearchStyles, searchHitPresentation } from "../web/live-search.mjs";
import { createSearchWireContract, searchWireContract } from "./search-wire-contract.mjs";

export function renderHtmlShell(capability, nonce) {
    const safeCapability = JSON.stringify(capability).replaceAll("<", "\\u003c");
    const safeNonce = String(nonce).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    const features = `(() => {
        const timing = (${createTimingPresentation.toString()})((${createActivityProjection.toString()})(null, null, ["unknown"]).summarize, { compact: true });
        const renderTiming = ${renderRecordedTiming.toString()};
        const wording = (${createAssessmentWording.toString()})();
        const searchContract = (${createSearchWireContract.toString()})(${JSON.stringify({
            matchPolicyId: searchWireContract.matchPolicyId, types: searchWireContract.allTypes,
        })});
        return {
        timing, renderTiming, wording, preparedFrame: ${createPreparedReportFrame.toString()},
        liveSearch: { mount: options => (${mountLiveSearch.toString()})({ ...options, contract: searchContract, presentHit: ${searchHitPresentation.toString()} }),
            createState: () => (${createLiveSearchState.toString()})(searchContract), contract: searchContract,
            membership: (...args) => (${createSearchMembership.toString()})(...args, searchContract), frozenFrame: ${createFrozenReportFrame.toString()} },
        periodComparison: { createState: options => (${createPeriodComparisonState.toString()})({ ...options, searchContract }),
            mount: ${mountPeriodComparison.toString()} },
        createExperience:${createAssessmentExperience.toString()},
        createPresentation: contract => (${createAssessmentPresentation.toString()})({ ...contract, timing, wording }),
        renderSummary: (root, model, options) => (${renderAssessmentSummary.toString()})(root, model, { ...options, renderTiming, wording }),
        createControls:${createAssessmentControls.toString()},
        mountConsent:${mountConsentSetup.toString()},
        mountFeedback: (root, options) => (${mountPersonalFeedback.toString()})(root, { ...options, wording }),
        createReportComparison: () => (${createReportComparison.toString()})(wording),
        mountComparison:${mountReportComparisonJourney.toString()},
        createArtifactDeletion:${createSavedArtifactDeletion.toString()},
        createAutomaticClient:${createAutomaticScoreClient.toString()},
        createAutomaticExperience:${createAutomaticScoreExperience.toString()},
        mountAutomaticRow:${mountAutomaticScoresRow.toString()},
        mountAutomaticApproval:${mountAutomaticScoresApproval.toString()},
        mountRecollection:${mountRecollection.toString()}
    }; })()`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Inspect recorded Work IQ evidence from GitHub Copilot chats and prepare reviewed product feedback reports.">
<title>${PRODUCT_TITLE}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<script nonce="${safeNonce}">const evidenceTheme = (${initializeTheme.toString()})();const evidenceNavigation = (${initializeNavigationPreference.toString()})();const mountNavigation = ux => (${mountSidebarNavigation.toString()})(ux, evidenceNavigation);</script>
<style>${styles}${deletionStyles}${recollectionStyles}${assessmentPresentationStyles}${reportComparisonStyles}${automaticScoreStyles}${periodComparisonStyles}${liveSearchStyles}</style></head>
<body class="analyze-shell"><template id="wireIconLicense">${lucideLicense.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</template><a class="skip-link" href="#main">Skip to content</a>
<header class="app-header"><div class="header-inner">
  <div id="shellBrand" class="brand"><a class="brand-home" href="#analyze" data-nav="analyze" aria-label="${PRODUCT_TITLE} - Analyze">${brandMark}${brandDarkMark}${brandCompactMark}</a><span class="brand-caption">${PRODUCT_DESCRIPTION}</span></div>
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
    <nav class="primary-navigation" aria-label="Main navigation">
      <a href="#analyze" data-nav="analyze"><span class="navigation-label">Analyze</span></a>
      <a href="#reports" data-nav="reports"><span class="navigation-label">Reports</span></a>
      <a href="#settings" data-nav="settings"><span class="navigation-label">Settings</span></a>
    </nav>
  </div>
</aside>
<dialog id="navigationDrawer" class="navigation-drawer" aria-labelledby="navigationTitle"><div class="drawer-heading"><h2 id="navigationTitle">Navigation</h2><button type="button" id="closeNavigation" class="quiet" aria-label="Close navigation">Close</button></div><div id="drawerBrand"></div><div id="drawerContent"></div></dialog>
<main id="main" tabindex="-1">
  <p id="wireAnalysisSearchNotice" class="notice" role="status" hidden></p>
  <p id="themeStorageNotice" class="notice" role="status" hidden>Theme preference cannot be saved in this browser. Your choice applies to this panel only.</p>
  <p id="navigationStorageNotice" class="notice" role="status" hidden>Navigation preference cannot be saved in this browser. Your choice applies to this panel only.</p>
  <p id="timeZoneNotice" class="notice" role="status" hidden></p>
  <div id="message" class="notice" role="status" aria-live="polite" hidden></div>
  <section id="loading" class="loading-state" aria-label="Loading your activity" aria-busy="true"><div class="skeleton heading"></div><div class="skeleton summary"></div><div class="skeleton chart-placeholder"></div><p id="loadingStatus" role="status">Loading your recorded activity...</p></section>
  <div id="workspace" hidden>
    <nav id="breadcrumbs" class="breadcrumbs" aria-label="Breadcrumb"></nav>
    <div class="page-heading"><div><p id="pageIdentity" class="session-label" hidden>${chatCopy.nameLabel}</p><h1 id="pageTitle">Analyze</h1><p id="pageIntro">Explore recorded interactions, calls and their results.</p><div id="pageProject"></div></div><div id="pagePrimaryActions" class="page-actions"><a id="resultsLink" class="text-link" href="#activityView">Results</a><a id="pageAction" class="button-link" href="#reports?task=create">Create report</a></div>
    <div id="reportSelectionBar" class="report-selection-bar contextual-bar" aria-label="View and report selection" hidden>
      <div id="activitySelectionContext" class="contextual-summary"><p id="activitySelectionSummary" role="status">No requests selected</p><span id="activitySelectionScope" class="muted"></span></div>
      <div id="pageHeadingActions" class="contextual-actions" role="group" aria-label="View and report selection actions"><span id="contextReturn" hidden></span><button id="activityClearSelection" type="button" data-clear-selection>Clear selection</button></div>
    </div>
    </div>
    <section id="analyzePopulation" class="analyze-population" aria-label="Choose recorded activity"><section id="periodComparisonSetup" aria-labelledby="periodComparisonTitle" hidden></section></section>
    <section id="freshActivity" class="fresh-activity" aria-label="Update recorded activity" hidden>
      <h3 id="freshHeading" hidden>Recorded activity</h3>
      <div class="fresh-controls">
        <button id="checkActivity" type="button" class="primary" aria-describedby="freshScope">Refresh</button>
        <div class="fresh-details">
          <a id="freshSourceSetup" href="#settings?section=connection&setting=source" data-settings-link hidden>Review source &amp; connect</a>
          <details id="freshHelp"><summary>Source and collection</summary><div id="freshHelpBody" class="fresh-help-body"><div class="fresh-context"><p id="freshScope" class="muted"></p><div class="fresh-links" role="group" aria-label="Source and collection"><a class="button-link" href="#settings?section=connection&setting=source-paths" data-settings-link>Source</a><a class="button-link" href="#settings?section=collection" data-settings-link>Collection settings</a></div></div><p>Refresh checks approved local history; without approval, it reads stored activity only. Paused collection stays paused. It does not run Work IQ or Graph queries.</p><p>History coverage is for all eligible chats, not this view's filters. No new records does not mean complete history.</p><div id="freshCoverageDetails" hidden></div><p id="freshCheckDetails" hidden></p></div></details>
        </div>
        <div id="freshResult" class="fresh-result">
          <div role="status" aria-live="polite" aria-atomic="true"><p id="freshStatus" hidden></p><p id="freshContextMessage" class="muted" hidden></p><span id="freshCoverageAnnouncement" class="visually-hidden"></span></div>
          <div class="fresh-result-meta"><p id="freshChecked" class="muted"></p><a id="freshIssues" href="#collection-status?setting=issues" data-settings-link hidden>Some history incomplete</a></div>
          <div id="storedRefresh" class="stored-refresh" hidden><button id="refreshBtn" type="button" class="quiet" aria-describedby="freshStatus freshContextMessage storedRefreshHelp">Read stored activity</button><p id="storedRefreshHelp" hidden></p></div>
        </div>
      </div>
    </section>
    <p id="freshAwayNotice" class="notice" role="status" hidden><strong>Recorded activity update:</strong><span id="freshAwayStatus"></span> <a id="freshAwayLink" href="#settings?section=connection&setting=collect-now" data-settings-link>View activity update</a></p>
    <div id="collectionNotice" class="collection-notice" hidden><p id="collectionNoticeText" role="status" aria-live="polite"></p><button id="collectionRetry" hidden>Retry</button><a id="collectionNoticeAction" href="#settings" data-settings-link class="text-link">Open Settings</a></div>
    <p id="activityCollectionLink" hidden><a href="#collection-status?setting=issues" data-settings-link>Collection status &amp; history gaps</a> <button id="activityDeleteShortcut" type="button" class="danger" aria-describedby="deleteActivityHelp">Delete collected activity</button></p>
    <p id="newDataNotice" class="notice" role="status" hidden>New data is available. Your report preview stays frozen; close it to update the activity view.</p>
    <div id="settingsDraftNotice" class="notice settings-draft-notice" role="status" hidden><span>Unsaved Settings changes are kept in this panel.</span><a href="#settings" data-settings-link>Return to Settings</a></div>
    ${settingsMarkup}
    <section id="sessionAnalysis" class="session-analysis" aria-label="Copilot chat analysis" hidden></section>
    <form id="filters" class="filters" aria-label="Activity filters">
      <div class="filter-scroll" role="region" aria-label="Filter row" aria-describedby="filterScrollHelp" tabindex="0" data-ux-tooltip-boundary><div class="period-controls">
      <label>Dates<select id="dateFilter"><option value="capture">All dates</option><option value="day">Today</option><option value="week">This week</option><option value="month">This month</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="custom">Custom dates</option></select></label>
      <label>Tool<select id="toolFilter"><option value="all">All tools</option></select></label>
      <label>Service<select id="serviceAssociationFilter" aria-describedby="serviceFocusScope"><option value="all">All services</option></select></label>
      <div id="resultSummary" class="home-result-filter" role="group" aria-labelledby="resultFilterLabel" aria-describedby="resultFilterScope"><div class="result-filter-field"><label id="resultFilterLabel" for="outcomeFilter">Outcome</label><div class="local-filter-row"><select id="outcomeFilter" multiple data-select-mode="multiple" aria-describedby="resultFilterScope"></select><span class="filter-clear-slot"><button id="clearResultFilter" type="button" class="quiet filter-clear" aria-label="Clear recorded result filter" hidden></button></span></div></div></div>
      <div id="promptAuthorSummary" class="prompt-author-filter result-filter-field" role="group" aria-labelledby="promptAuthorFilterLabel">
        <label id="promptAuthorFilterLabel" for="promptAuthorFilter">Author</label>
        <div class="local-filter-row"><select id="promptAuthorFilter" multiple data-select-mode="multiple" data-all-label="All authors" data-draft-hint="Choose prompt authors, then Apply." data-empty-hint="Select at least one prompt author." data-selection-noun="authors" aria-describedby="promptAuthorFilterHelp"><option value="user" selected>Your prompts</option><option value="agent" selected>Agent prompts</option><option value="unknown" selected>Author unverified</option></select><span class="filter-clear-slot"><button id="clearPromptAuthorFilter" type="button" class="quiet filter-clear" aria-label="Clear prompt author filter" hidden></button></span></div>
        <p id="promptAuthorFilterHelp" class="visually-hidden">Filters by the originating prompt. Calls made by an agent stay with the prompt they belong to. All includes unverified authors.</p>
      </div>
      </div></div>
      <div class="filter-utilities"><details id="moreFilters" class="more-filters"><summary id="moreFiltersToggle">More filters</summary><div class="secondary-filters period-controls">
      <label>Category<select id="serviceFilter"><option value="all">All categories</option></select></label>
      <label>Project<select id="projectFilter" aria-describedby="projectContextHelp"><option value="all">All projects</option></select></label>
      <label>Chat<select id="chatFilter"><option value="all">All chats</option></select></label>
      <label>Activity<select id="layerFilter"><option value="tool">Work IQ calls</option><option value="direct-request">Graph API call sites</option><option value="recorded-http">Graph statuses</option><option value="reported-api">Returned API entries</option><option value="http">HTTP recorder</option><option value="code-reference">Graph code references</option></select></label>
      <label>Collection<select id="scopeFilter"><option value="history">Current</option><option value="legacy">Earlier snapshot</option><option value="all">Both collections</option></select></label>
      </div></details>
      <div id="filterTools" class="filter-tools"><button id="resetView" class="reset-view quiet" type="button" aria-describedby="resetScopeHelp" disabled>Reset Analyze</button></div></div>
      <p id="filterScrollHelp" class="visually-hidden">Dates, Tool, Service, Outcome and Author. More filters contains Category, Project, Chat, Activity evidence and Collection. Applied choices remain visible below.</p>
      <p id="projectContextHelp" class="visually-hidden">GitHub Copilot project context, not necessarily a GitHub repository.</p>
      <p id="resultFilterScope" class="visually-hidden"></p>
      <div id="dateFields" class="date-fields" hidden><label><span>From</span><input id="fromFilter" type="date" aria-describedby="dateHint dateError"></label><label><span>To</span><input id="toFilter" type="date" aria-describedby="dateHint dateError"></label><div class="date-actions"><button id="applyDates" type="submit">Apply dates</button><button id="clearDates" type="button" class="quiet" aria-label="Clear date filter">Clear</button></div><p id="dateHint" class="visually-hidden">Both dates are included. For one day, use the same date twice. Filters retained evidence only.</p><p id="dateError" class="error" role="alert" hidden></p></div>
      <p id="resetScopeHelp" class="visually-hidden">Clear browsing filters, private search, chat and request scope, and the results page. Return all widgets and records to Analyze interactions with all retained dates and Work IQ tool calls. Report selections, report options, review labels and theme stay unchanged.</p>
    </form>
    <div id="filterChips" class="filter-chips" aria-label="Applied filters"></div>
    <div id="serviceFocus" class="service-focus" hidden><p id="serviceFocusScope" role="status"></p><button id="addServiceContext" type="button" class="quiet" hidden>Include calls with missing service details</button></div>
    <section id="periodComparison" class="period-comparison" aria-labelledby="periodComparisonResultsTitle" hidden></section>
    <section id="periodFeedback" class="period-feedback" aria-label="Period results"><div><p id="periodResult" role="status" aria-live="polite"></p><p id="periodHint"></p></div><div id="periodActions"><button id="comparePeriods" type="button" class="quiet" hidden>Compare periods</button></div><div id="periodCoverage" class="period-coverage" hidden><p id="periodCoverageText"></p><a id="periodHistoryLink" href="#settings?section=history" data-settings-link>History settings</a></div></section>
    <div id="viewingContext" class="viewing-context" role="region" aria-label="Current viewing context"></div>
    <div id="scopeResetActions" class="scope-reset-actions" hidden></div>
    <section id="serviceEvidenceSummary" class="service-evidence-summary" aria-labelledby="serviceEvidenceTitle" hidden></section>
    <section id="homeView" aria-labelledby="chartTitle">
      <div class="analyze-dashboard">
      <div class="analyze-chart-grid">
      <div class="analyze-outcome-summary"><div id="outcomeChart"></div><div id="homeFindings" data-presentation="compact"></div></div>
      <section class="analyze-chart-main" aria-labelledby="chartTitle">
      <div class="insight-header"><div class="view-switch" role="group" aria-label="Chart view"><button data-chart="time" aria-pressed="true">Over time</button><button data-chart="workload" aria-pressed="false">By category</button><button data-chart="endpoint" aria-pressed="false">By path or operation</button></div></div>
      <div class="chart-panel"><div class="chart-heading"><h2 id="chartTitle">Assistant activity</h2></div><div id="chart"></div><div id="chartFooter" class="chart-footer"></div></div>
      </section>
      </div>
      <div id="percentageCharts"></div>
      </div>
      <section class="analyze-review" aria-label="Full-interaction reviews">
      <details id="analyzeReviewDetails" class="analyze-review-details"><summary>Saved reviews</summary><div id="homeInsights"></div></details>
      </section>
      <div class="chart-actions"><details id="meaning" class="reading-section"><summary>Chart data and definitions</summary>
        <section aria-labelledby="meaningScopeTitle"><h3 id="meaningScopeTitle">Current scope</h3><dl class="scope-facts"><div><dt>Period</dt><dd id="periodLabel"></dd></div><div><dt>Matched activity</dt><dd id="meaningMatched"></dd></div><div><dt>Sources</dt><dd id="meaningSources"></dd></div><div><dt>Insights</dt><dd id="homeInsightScope"></dd></div></dl><p id="takeaway" hidden></p></section>
        <section id="tableDisclosure"><h3 id="chartDataTitle">Chart counts</h3><div id="countTable" role="region" aria-label="Exact chart data, scroll horizontally for more columns" tabindex="0"></div></section>
        <div id="percentageData"></div>
        <section aria-labelledby="meaningResultsTitle"><h3 id="meaningResultsTitle">Result meanings</h3><div id="meaningBody"></div></section>
        <section id="meaningReading" class="reading-notes"><h3>Reading counts and dates</h3><div id="chartReadingNotes"></div></section>
        <section id="serviceDefinitions" class="service-definitions"></section>
        <section><h3>Timing</h3><p>Time to recorded final response runs from the recorded message to its final answer, when a completed turn confirms that answer. Call duration runs from the recorded call start to completion. Missing timing is not zero. Call durations are not added together to estimate response time or the time for a whole task.</p></section>
      </details><a id="exploreLink" class="text-link" href="#activity" hidden>Explore the requests behind this chart</a></div>
    </section>
    <section id="activityView" hidden aria-labelledby="activityTitle"><div class="section-heading"><h2 id="activityTitle" tabindex="-1">Interactions</h2><div id="analyzeModes" class="view-switch" role="group" aria-label="Analyze results"><a class="button-link" href="#analyze" data-analyze-mode="interactions">Interactions</a><a class="button-link" href="#analyze?mode=calls" data-analyze-mode="calls">Calls</a></div><button id="openAnalysisSearch" type="button" class="quiet">Search this Analyze scope</button><label class="search-label" hidden>Legacy private search<input id="activitySearch" type="search" placeholder="Search" autocomplete="off"></label><button id="clearActivitySearch" type="button" class="quiet" hidden>Clear legacy search</button></div><div id="analyzeResultActions" class="analyze-result-actions"></div><div id="callSortControls" class="call-sort-controls" hidden>        <label for="callSort">Duration</label><select id="callSort"><option value="slowest">Slowest first</option><option value="fastest">Fastest first</option></select><p id="callTimingScope" class="context-help-note"></p></div><p id="activityListSummary" class="list-summary" role="status"></p><div id="activityPager" class="pager"></div><div id="activityList"></div></section>
    <section id="reportsView" hidden aria-labelledby="pageTitle">
      <nav id="reportTaskNav" class="report-task-nav" aria-label="Reports tasks"><a id="reportLibraryLink" class="button-link" href="#reports">Saved reports</a><a id="reportCreateLink" class="button-link" href="#reports?task=create">Create a report</a></nav>
      <div class="report-start"><div id="reportPreviewContext" class="report-preview-controls contextual-bar"><p id="previewSelectionSummary" role="status">No requests selected</p><div id="reportSelectionActions" class="report-selection-actions"><button id="reportClearSelection" type="button" data-clear-selection>Clear selection</button><button id="exportBtn" class="primary" disabled>Preview report</button></div></div></div>
      <p id="reportTimeContext" class="muted"></p>
      <fieldset class="export-scope"><legend class="visually-hidden">Activity to include</legend><div class="scope-choices">
        <label class="scope-choice"><input type="radio" name="reportScope" value="all"><span><strong>All saved sessions</strong><small id="scopeCount-all">Loading scope...</small></span></label>
        <label class="scope-choice"><input type="radio" name="reportScope" value="current"><span><strong>Current Analyze view</strong><small id="scopeCount-current">Loading scope...</small></span></label>
        <label class="scope-choice"><input type="radio" name="reportScope" value="selected" checked><span><strong>Selected interactions</strong><small id="scopeCount-selected">0 interactions</small></span></label>
      </div><p id="reportScopeChoiceHelp" class="scope-choice-help"></p><p id="scopeSummary" class="scope-summary" role="status"></p><p id="scopeExplanation" class="scope-explanation"></p>
      <div class="report-author-choice"><label for="reportPromptAuthorFilter">Prompt authors</label><select id="reportPromptAuthorFilter" multiple data-select-mode="multiple" data-all-label="All prompt authors" data-draft-hint="Choose prompt authors, then Apply." data-empty-hint="Select at least one prompt author." data-selection-noun="authors"><option value="user" selected>Your prompts</option><option value="agent" selected>Agent prompts</option><option value="unknown" selected>Author unverified</option></select><p id="reportPromptAuthorSummary" class="scope-summary" role="status"></p><p id="reportPopulationNote" class="context-help-note" role="status"></p></div>
      <div id="reportMatchingContext" class="report-matching-context"></div>
      <p class="scope-explanation">Draft choices are kept while you navigate, but not after reloading.</p>
      <details id="scopeDetails" class="detail-disclosure"><summary>Scope and exclusions</summary><div id="scopeExclusions"></div></details></fieldset>
      <div class="report-options">
        <div class="report-text-options">
        <fieldset id="promptOptions"><legend>Prompts in this report</legend>
          <label class="prompt-choice"><input type="radio" name="promptMode" value="none"><span><strong>No prompts</strong><span>Activity and technical evidence only. No request, follow-up or tool question text.</span></span></label>
          <label class="prompt-choice"><input type="radio" name="promptMode" value="masked" checked><span><strong>Masked prompts <small>Default</small></strong><span>Your wording, with detected personal values masked. Review names and confidential meaning yourself.</span></span></label>
          <label class="prompt-choice"><input type="radio" name="promptMode" value="original"><span><strong>Original prompts</strong><span>Include retained personal wording in local files. Detected credentials are still removed and labeled.</span></span></label>
        </fieldset>
          <label class="prompt-choice"><input id="reportRecordedContext" type="checkbox" aria-describedby="reportRecordedContextHelp"><span><strong>Include linked requests and replies</strong><span>Up to one linked group on either side, not the whole chat.</span></span></label>
          <p id="reportRecordedContextHelp" class="context-help-note" hidden></p>
        </div>
        <fieldset id="formatOptions"><legend>Files to save</legend><div class="format-choices">
          <label><input type="checkbox" value="html" checked>Web page (HTML)</label><label><input type="checkbox" value="pdf">PDF</label><label><input type="checkbox" value="json">Data (JSON)</label><label><input type="checkbox" value="markdown">Markdown</label>
        </div><p id="formatError" class="notice error" role="alert" hidden>Select at least one format before previewing.</p>
        <details id="additionalMasking" class="detail-disclosure"><summary>Additional masking</summary><label class="report-field" for="manualTerms">Names or phrases to mask everywhere in the prompt copies</label><textarea id="manualTerms" rows="4" autocomplete="off" spellcheck="false" placeholder="One exact name or phrase per line"></textarea><p>Local, case-insensitive matching. These terms and your edited copies are not saved as preferences.</p></details>
        </fieldset>
        <p class="report-privacy-note">Scans stay on this device. Check names and confidential details yourself; saving locally is not permission to share.</p>
      </div>
      <section id="reportRequests" class="report-scope-details" aria-labelledby="reportRequestsTitle"><h3 id="reportRequestsTitle" class="visually-hidden">Choose interactions</h3><div class="scoped-search"><label for="reportRequestSearch">Find an interaction</label><div class="search-input-row"><input id="reportRequestSearch" type="search" placeholder="Copilot Chat or prompt" autocomplete="off" spellcheck="false" aria-describedby="reportRequestSearchHelp"><button id="clearReportRequestSearch" type="button" class="quiet" hidden>Clear</button></div><p id="reportRequestSearchHelp" class="visually-hidden">Only this list is filtered. Your report selection stays unchanged.</p><p id="reportRequestSearchCount" class="search-count" role="status"></p></div><div id="reportList" class="report-selection-list"></div></section>
      <section id="savedReportsPanel" aria-label="Saved report library"><section id="bundles" class="saved-library" aria-labelledby="savedLibraryTitle"><h2 id="savedLibraryTitle" tabindex="-1">Saved reports</h2>
        <div class="saved-library-context"><p id="savedReportCount"></p></div>
        <div class="saved-library-tools"><div class="scoped-search"><label for="savedReportSearch">Find a saved report</label><div class="search-input-row"><input id="savedReportSearch" type="search" placeholder="Search saved reports" autocomplete="off" spellcheck="false" aria-describedby="savedReportSearchHelp"><button id="clearSavedReportSearch" type="button" class="quiet" hidden>Clear</button></div></div></div>
        <details id="savedLibraryHelp"><summary>About saved reports</summary><div id="savedLibraryHelpBody"><p id="savedReportSearchHelp">Search IDs, dates, formats, prompt modes and time zones, not report contents.</p><p>Newest prepared first. Open and download use the saved copy, not current activity or draft choices.</p></div></details>
        <p id="savedReportSearchCount" class="search-count" role="status"></p><div id="bundleList"></div>
        <details id="savedLibraryManagement"><summary>Manage saved reports</summary><div class="saved-library-management-body"><p>Delete all saved reports, not just search results. A separate confirmation shows what will be removed.</p><button id="deleteAllReports" type="button" class="quiet danger">Delete all saved reports</button></div></details>
      </section><section id="comparisonWorkspace" aria-label="Compare saved reports" hidden></section></section></section>
    <details id="coverage" class="coverage supporting reading-section"><summary>About this evidence</summary><p id="evidenceExplanation">Work IQ activity shows tool calls and recorded results. A successful tool result does not confirm that the whole task was completed correctly.</p><p id="coverageNotice">Counts use retained evidence; unavailable Copilot chat history may leave gaps. Graph requests made inside hosted Work IQ are not visible in local logs.</p><div id="coverageBody"></div><p class="coverage-destination"><a href="#collection-status?setting=collection-details" data-settings-link>Collection status</a> explains coverage, history gaps and how the evidence was recorded.</p></details>
  </div>
</main>
<div id="contextSidebarParking" hidden></div>
<dialog id="contextSidebar" aria-labelledby="contextSidebarTitle">
  <header class="context-sidebar-header"><h2 id="contextSidebarTitle" tabindex="-1">Interaction</h2><button id="closeContextSidebar" type="button" class="quiet" aria-label="Close interaction"></button></header>
  <div id="contextSidebarGuard" role="alert" hidden></div>
  <div id="contextSidebarBody"><section id="requestView" aria-labelledby="contextSidebarTitle"><div id="requestContent"></div></section></div>
  <footer id="contextSidebarFooter"></footer>
</dialog>
<dialog id="overlay" aria-labelledby="dialogTitle"><div class="dialog-head"><h2 id="dialogTitle"></h2><div class="report-selection-actions"><button type="button" id="clearPreviewSelection" data-clear-selection hidden>Clear selection</button><button id="closeDialog" class="quiet">Close</button></div></div><div id="detail" class="dialog-body"></div></dialog>
<dialog id="deleteDialog" aria-labelledby="deleteTitle" aria-describedby="deleteBoundary">
  <div class="delete-heading"><span id="deleteWarningIcon" aria-hidden="true"></span><h2 id="deleteTitle">Delete collected activity</h2></div>
  <p id="deleteBoundary">Deletes this app's collected activity and associated local copies, not your Copilot chats or source files.</p>
  <form id="deleteScopeForm">
    <fieldset><legend>Choose what to delete</legend><label class="delete-choice"><input type="radio" name="deletionScope" id="deleteRange" value="range" checked>Custom date range</label><label class="delete-choice"><input type="radio" name="deletionScope" id="deleteAll" value="all">All collected activity</label></fieldset>
    <div id="deleteDateFields"><label>From<input id="deleteFrom" type="date"></label><label>To<input id="deleteTo" type="date"></label></div>
    <p class="muted">Independent of view filters. Both dates are included in the current display time zone. Unknown-time records are kept for date-range deletion.</p>
    <button id="deletePreview" type="submit">Preview deletion</button>
  </form>
  <div id="deleteConfirmation" hidden><p id="deleteSummary"></p><p id="deleteBreakdown"></p><p id="deleteLinkedInsights" hidden></p><p id="deleteCopies"></p><p>Deleted activity will not return during normal collection. New calls can still be collected.</p><p class="delete-irreversible">Permanent local deletion. This cannot be undone.</p><details class="reading-section"><summary>Deletion details</summary><p id="deleteZone" class="muted"></p><p id="deleteLinkedDetails" class="muted" hidden></p><p class="muted">The preview expires after two minutes. Changes require a fresh confirmation. Only existing collected identities are deleted; previously unread history may still arrive. To deliberately reread available approved history later, use Recollect from approved sources in Data management. That separate confirmation does not recover deleted feedback or response captures.</p><p class="muted">Source approval and collection preferences stay unchanged. Saved reports, downloads and unmanaged backups may retain copies; this is not forensic erasure. Managed migration snapshots and collector context are cleaned.</p></details></div>
  <p id="deleteStatus" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
  <div class="delete-actions"><button id="deleteChangeScope" type="button" class="quiet" hidden>Change scope</button><button id="deleteCheck" type="button" hidden>Check deletion result</button><button id="deleteCancel" type="button" autofocus>Cancel</button><button id="deleteConfirm" type="button" class="danger" disabled>Delete records</button></div>
</dialog>
${recollectionMarkup}
<script nonce="${safeNonce}">(${mountEvidence.toString()})(${safeCapability},${createBoardTransport.toString()},evidenceTheme,${createReportDraft.toString()},${createEvidenceUX.toString()},${JSON.stringify(uxIcons).replaceAll("<", "\\u003c")},${mountThemeControl.toString()},${createTimeContext.toString()},${createServiceCategories.toString()},${createDimensionalCharts.toString()},${JSON.stringify(dimensionalIcons).replaceAll("<", "\\u003c")},mountNavigation,${createReportScope.toString()},${createSelectControls.toString()},${createInlineMetadata.toString()},${createControlHelp.toString()},${createRecordedResults.toString()},${createLiveState.toString()},${createDisclosureState.toString()},${createCollectionStatus.toString()},${createSessionJourney.toString()},${createReportJourney.toString()},${mountCollectionSettings.toString()},${createTextAccess.toString()},${createPeriodFlow.toString()},${createChatCopy.toString()},${mountDisplayTimeSettings.toString()},${createLocalSearch.toString()},${createSettingsNavigation.toString()},${createFreshActivity.toString()},${createPercentageCharts.toString()},${createRequestTiming.toString()},${mountRecorderDiagnostics.toString()},${createDeletionFlow.toString()},${mountDeletion.toString()},${features},${createPromptAuthorship.toString()},${createFilterState.toString()},${createAnalysisSlice.toString()},${createActivityProjection.toString()},${createRequestContext.toString()},${createCallInvestigation.toString()});</script></body></html>`;
}
