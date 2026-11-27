import { searchFieldMarkup } from "./search-field.mjs";
import { sourceCollectionMarkup } from "./source-collection-settings.mjs";
import { currentPaletteSwatches, paletteGallery, palettePreview } from "./palette-gallery.mjs";
import { uxIcons } from "./ux-icons.mjs";
import { defaultField } from "./page-defaults.mjs";

function pageSettings(id, title, purpose, fields) {
    return `<section class="settings-section" data-settings-section="${id}" aria-labelledby="${id}SettingsTitle" hidden>
      <h2 id="${id}SettingsTitle" tabindex="-1">${title}</h2><p class="settings-intro">${purpose}</p>
      ${fields.map(key => defaultField(key, uxIcons)).join("")}</section>`;
}

function sourcePathField(id, label) {
    return `<div class="settings-field"><label for="${id}">${label}</label><div class="source-path-choice">
      <input id="${id}" type="text" autocomplete="off" spellcheck="false" aria-describedby="sourcePathsHelp approvalScope settingsMessage">
      <button type="button" id="${id}Browse" aria-label="Browse for ${label.toLowerCase()}" disabled>Browse</button></div></div>`;
}

export const settingsMarkup = `
<section id="settingsView" class="settings-view" aria-label="Settings" hidden>
  <p id="settingsRouteNotice" class="notice" role="status" hidden></p>
  <div class="settings-layout">
  <aside class="settings-rail" aria-label="Settings navigation">
  <div class="scoped-search settings-search">
    <label for="settingsSearch" class="visually-hidden">Search settings</label>
    ${searchFieldMarkup({ id: "settingsSearch", clearId: "clearSettingsSearch", placeholder: "Search settings" })}
    <p id="settingsSearchCount" class="search-count" role="status" hidden></p>
    <ul id="settingsSearchResults" class="settings-search-results" aria-label="Matching settings" hidden></ul>
  </div>
  <details id="settingsCategories" class="settings-categories" open><summary id="settingsCategorySummary">Category: Collection</summary><nav id="settingsCategoryNav" aria-label="Settings categories"></nav></details>
  </aside>
  <div class="settings-content">
  <p id="settingsMessage" class="notice" role="status" tabindex="-1" hidden></p>
  <a id="firstCollectionActivity" class="button-link" href="/" data-settings-link hidden>View activity</a>
  <p id="settingsConnectionError" class="notice error" role="alert" hidden></p>
  <button id="reloadSettings" type="button" hidden>Read current connection</button>
  <button id="settingsGeneralBack" type="button" class="quiet" hidden>${uxIcons.back} Back to General</button>
  <section class="settings-section" data-settings-section="general" aria-labelledby="generalTitle" hidden>
    <h2 id="generalTitle" tabindex="-1">General</h2>
    <div class="settings-task-row app-version-card"><img src="/favicon.svg" width="32" height="32" alt=""><div class="settings-row-copy"><h3 id="appUpdateVersion">WIRE</h3>
      <p id="appUpdateStatus" role="status">Reading update status…</p>
      <a id="availableReleaseNotes" class="navigation-action" hidden>What's new in this update ${uxIcons.forward}</a>
      <a id="installedReleaseNotes" class="navigation-action" hidden>Installed release notes ${uxIcons.forward}</a>
      </div>
      <div class="settings-actions"><button id="appUpdateCheck" type="button" disabled><span class="check-action-label">Check for updates</span><span class="check-action-pending" hidden><span class="update-spinner" aria-hidden="true"></span>Checking</span></button>
        <a id="appUpdateGuide" class="button-link" href="https://github.com/likamrat/wire/blob/main/docs/development.md#updating-wire" target="_blank" rel="noopener noreferrer" hidden>Update instructions</a>
        <button id="settingsAppUpdate" class="primary app-update-action" type="button" hidden>Update and restart</button></div>
    </div>
    <div class="settings-task-row" id="appUpdateAutoRow" hidden><div class="settings-row-copy"><h3><label for="appUpdateAuto">Automatically check for updates</label></h3></div>
      <label class="settings-switch"><input id="appUpdateAuto" type="checkbox" role="switch" disabled><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></label>
    </div>
    <section class="general-appearance" aria-labelledby="generalThemeTitle">
      <h3 id="generalThemeTitle">Current theme</h3>
      <a id="general-themes" class="settings-preference-link" href="/settings?section=themes" data-settings-link data-general-shortcut
        aria-labelledby="generalThemeAction" aria-describedby="generalThemeValue">
        ${palettePreview("petrol","light")}
        <span class="general-palette-summary"><span id="generalThemeValue"><strong id="generalPaletteName"></strong><span id="generalMode">Unavailable</span></span>
          ${currentPaletteSwatches}</span>
        <span class="preference-destination" id="generalThemeAction">Change theme ${uxIcons.disclosure}</span>
      </a>
    </section>
    <a id="general-regional" class="settings-preference-link" href="/settings?section=regional" data-settings-link data-general-shortcut>
      <span><strong>Time zone</strong><span id="generalTimeValue">Unavailable</span></span>
      <span class="preference-destination">Regional ${uxIcons.disclosure}</span>
    </a>
  </section>
  <article class="settings-section release-reader" data-settings-section="release-notes" aria-labelledby="releaseNotesHeading" hidden>
    <a class="navigation-action" href="/settings" data-settings-link>${uxIcons.back} General</a>
    <header><img src="/favicon.svg" width="32" height="32" alt=""><h2 id="releaseNotesHeading" tabindex="-1">What's new in WIRE</h2></header>
    <div class="release-meta"><strong id="releaseReaderVersion"></strong><span id="releaseReaderStatus" role="status"></span>
      <a id="releaseReaderGitHub" class="navigation-action" target="_blank" rel="noopener noreferrer" hidden>View on GitHub ${uxIcons["doc-external"]}</a></div>
    <div id="releaseNotesBody"></div>
    <button type="button" class="primary app-update-action" id="releaseReaderApply" hidden>Update and restart</button>
  </article>
  <section class="settings-section" data-settings-section="privacy" aria-labelledby="dataManagementTitle" hidden>
    <h2 id="dataManagementTitle" tabindex="-1">Privacy &amp; saved data</h2>
    <p class="settings-intro">Review what WIRE keeps on this device and what you can remove.</p>
    <section id="assessmentSetupTitle" class="settings-reply-row" aria-label="Recorded replies" tabindex="-1">
      <h3 class="settings-reply-fallback">Save Copilot replies locally</h3>
      <div id="assessmentSetup"><p>Loading response-saving settings.</p></div>
    </section>
    <div class="settings-task-row"><div class="settings-row-copy">
    <h3>Collected activity</h3>
    <p id="deleteActivityHelp">Delete WIRE’s copy of the activity for good. Your Copilot chats and saved reports stay.</p>
    </div>
    <button id="deleteActivity" type="button" class="danger" aria-describedby="deleteActivityHelp">Review deletion</button>
    </div>
    <div class="settings-task-row"><div class="settings-row-copy">
    <h3>Read history again</h3>
    <p id="recollectActivityHelp">Missing history, deleted replies and past annotations aren't restored.</p>
    <p id="recollectionUpdateStatus" role="status" aria-live="polite" hidden></p>
    </div><button id="recollectActivity" type="button" aria-describedby="recollectActivityHelp">Choose chats</button></div>
    <div class="settings-task-row"><div class="settings-row-copy"><h3>Saved reports</h3></div><a class="button-link quiet" href="/reports" data-settings-link>Open saved reports ${uxIcons.forward}</a></div>
  </section>
  <section class="settings-section" data-settings-section="themes" aria-labelledby="themesTitle" hidden>
    <h2 id="themesTitle" tabindex="-1">Themes</h2>
    <p class="settings-intro">Change how WIRE looks in this browser.</p>
    <div class="settings-task-row settings-theme-row"><div class="settings-row-copy">
      <h3>Appearance mode</h3><span id="settingsModeLabel"></span>
    </div><button id="settingsThemePreference" type="button" class="theme-trigger" aria-label="Use dark theme" aria-describedby="themeStorageNotice">Change theme</button></div>
    ${paletteGallery}
  </section>
  <section class="settings-section" data-settings-section="regional" aria-labelledby="regionalTitle" hidden>
    <h2 id="regionalTitle" tabindex="-1">Regional</h2>
    <p class="settings-intro">Choose how WIRE displays dates and groups activity into days.</p>
    <div class="settings-field settings-display-field display-time-field">
      <div class="settings-row-copy"><h3><label for="displayTimeZone">Time zone</label></h3><p>Saved reports keep their original time zone.</p></div>
      <select id="displayTimeZone" aria-describedby="displayTimeEffective displayTimeHelp timeZoneNotice"></select>
      <p id="displayTimeHelp" class="settings-help" hidden></p>
      <p id="displayTimeEffective" class="settings-help" role="status" hidden></p>
    </div>
  </section>
  <div id="collectionForm">
    <section class="settings-section" data-settings-section="connection" aria-labelledby="connectionTitle">
      <h2 id="connectionTitle" tabindex="-1">Sources</h2>
      <p class="settings-intro">What WIRE reads on this device, and how often.</p>
      <div class="settings-task-row settings-collection-state">
        <div class="settings-row-copy"><div class="collection-state-line"><h3 id="automaticCollectionTitle">Collection</h3><p id="connectionStatus" class="connection-status">Checking connection</p></div><p id="connectionSourceHelp" class="settings-help" hidden></p></div>
        <div class="collection-state-actions"><span id="settingsStatusLink" class="settings-status-link"><a class="button-link quiet" href="/collection-status" data-settings-link>Collection status ${uxIcons.forward}</a></span>
          <div id="approvedConnection" hidden><div class="settings-actions"><button id="pauseCollection" type="button" disabled>Pause collection</button><button id="collectNow" type="button" class="quiet" hidden disabled>Refresh</button></div></div></div>
      </div>
      <div id="settingsRefreshSlot"></div>
      <div id="microsoftConnectionHost" hidden></div>
      <div id="sourceFoldControls" class="source-list-heading">
        <h3 id="sourceListTitle">Local sources</h3>
        <button id="toggleAllSources" type="button" class="quiet" data-state="expanded">${uxIcons["collapse-sections"]}<span>Collapse all</span></button>
      </div>
      <section id="connectionSource" class="settings-group source-block" aria-labelledby="connectionSourceName">
        <div class="source-block-heading">
          <h3 class="source-block-title"><button id="connectionSourceToggle" type="button" class="source-toggle" aria-expanded="true" aria-controls="connectionSourceBody">
            <span class="source-toggle-chevron">${uxIcons.chevron}</span><span class="source-toggle-name">${uxIcons["source-github"]}<span id="connectionSourceName"><span id="connectionSourceTitle">GitHub Copilot app</span></span></span></button></h3>
          <p id="connectionSourceSummary" class="source-block-summary"></p>
        </div>
        <div id="connectionSourceBody" class="source-block-body">
        <div id="sourceEditor" class="source-editor">
          <p id="sourceSuggestion" class="settings-help" hidden></p>
          <div id="sourcePathFields" class="settings-preferences source-path-fields">
          ${sourcePathField("sourceDatabase", "Metadata database")}
          ${sourcePathField("sourceSessions", "Chat history folder")}
          </div>
          <p id="sourcePathsHelp" class="settings-help">Prompts are saved on this device. Replies stay off unless you turn them on in Privacy &amp; saved data.</p>
          <div id="sourceUsageRecordsRow" class="source-records">
            <div class="source-records-heading"><div class="source-records-title"><h4><label for="sourceUsageRecords">Token records</label></h4><span id="sourceUsageRecordsState" class="source-records-state"></span></div>
              <label class="settings-switch"><input id="sourceUsageRecords" type="checkbox" role="switch" aria-describedby="sourceUsageRecordsHelp sourceUsageRecordsState sourceUsageRecordsFacts approvalScope"><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></label></div>
            <p id="sourceUsageRecordsHelp" class="source-cost-note">${uxIcons.info}<span><strong>Reading token records uses no tokens and costs nothing.</strong> WIRE reads counts Copilot already recorded to fill gaps in older chats.</span></p>
            <dl id="sourceUsageRecordsFacts" class="source-records-facts"><dt>Reads</dt><dd>Each call's model, token count, time and whether it came from a sub-agent</dd><dt>Prompts</dt><dd>WIRE uses prompts from this file to match calls but doesn't save them.</dd><dt>File</dt><dd><span id="sourceUsageRecordsFile"></span><span id="sourceUsageRecordsAccount"></span></dd></dl>
            <div id="tokenPermissionActions" class="settings-actions" hidden>
              <button id="approveUsageRecords" type="button" aria-describedby="sourceUsageRecordsFile">Approve token records</button>
              <button id="declineUsageRecords" type="button" class="quiet">Keep off</button>
            </div>
            <div id="usageCountRow" class="source-records-count" hidden><div class="settings-row-copy"><h4>Count tokens in chats already read</h4>
              <p id="usageCountHelp" class="settings-help">Nothing is saved until you confirm.</p>
              <p id="usageCountNotice" class="settings-help" role="status" hidden></p></div>
              <button id="countUsageRecords" type="button" aria-describedby="usageCountHelp usageCountNotice">Check chats</button></div>
          </div>
        </div>
        </div>
      </section>
      <p id="registeredSourceNotice" hidden>Local Copilot source paths are not available in this runtime. <a href="/settings" data-settings-link>Open collection</a></p>
      <section id="connectionPreferences" class="settings-group" aria-labelledby="preferencesTitle">
      <h3 id="preferencesTitle" class="settings-subheading" tabindex="-1">Schedule</h3>
      <p id="preferencesHelp" class="settings-help" hidden></p>
      <div id="collectionPreferenceFields" class="settings-preferences">
        <div id="nativeCollectionSourceField" class="settings-field" hidden><label for="nativeCollectionSurfaces">Microsoft sources</label><select id="nativeCollectionSurfaces" disabled></select></div>
        <div class="settings-field"><label for="collectionWindow">History to include</label><select id="collectionWindow"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></div>
        <div class="settings-field"><label for="collectionCadence">Check frequency</label><select id="collectionCadence"><option value="5" selected>Every 5 seconds</option><option value="15">Every 15 seconds</option><option value="30">Every 30 seconds</option><option value="60">Every 60 seconds</option></select></div>
      </div>
      <div id="preferenceActions" class="settings-actions"><button id="saveCollection" type="button" class="primary" disabled>Save preferences</button><button id="cancelPreferences" type="button" class="quiet" disabled>Cancel changes</button></div>
      <p id="settingsDraftStatus" class="settings-help" role="status"></p>
      </section>
      <section id="sourceCommit" class="source-commit" aria-labelledby="sourceCommitTitle" hidden>
        <h3 id="sourceCommitTitle" tabindex="-1">What changes</h3>
        <ul id="approvalScope" class="source-impact"></ul>
        <p id="sourceChangeImpact" class="settings-help" role="status"></p>
        <div id="sourceDraftStatusSlot"></div>
        <div class="settings-actions"><button id="connectCollection" type="button" class="primary">Approve source and start collection</button><button id="cancelSource" type="button" class="quiet">Cancel</button></div>
        <p id="firstCollectionWait" class="settings-help" hidden>The first read may take a few minutes.</p>
      </section>
      ${sourceCollectionMarkup}
      <dialog id="usageCountDialog" class="deletion-dialog decision-frame" aria-labelledby="usageCountTitle" aria-describedby="usageCountBoundary">
        <div class="delete-heading"><span id="usageCountIcon" class="delete-warning-icon" aria-hidden="true"></span><h2 id="usageCountTitle">Count tokens in chats already read</h2></div>
        <div class="decision-body">
          <p id="usageCountBoundary">WIRE checks saved interactions that have no token total against Copilot's token records for the same chats. Checking doesn't save anything.</p>
          <section id="usageCountPreviewResult" hidden><h3 id="usageCountSummary"></h3><p id="usageCountRefused"></p><ul id="usageCountReasons"></ul>
            <p id="usageCountKept" class="settings-help">Confirming adds these totals only. Totals already counted, prompts, replies, saved reports and Copilot's files stay as they are. The check expires after two minutes.</p></section>
          <p id="usageCountStatus" class="decision-status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
        </div>
        <div class="delete-actions"><button id="usageCountClose" type="button">Cancel</button><button id="usageCountRetry" type="button" data-decision-action="check" hidden>Check again</button><button id="usageCountCheck" type="button" data-decision-action="check" hidden>Check result</button><button id="usageCountConfirm" type="button" data-decision-action="commit" hidden>Count tokens</button></div>
      </dialog>
    </section>
  </div>
  ${pageSettings("analyze", "Analyze", "Arrange your homepage and choose the defaults for Analyze.", ["analyzeLayout", "analyzeRange", "analyzeSort", "guideStart", "cardHideDuration"])}
  ${pageSettings("trends", "Trends", "Set the chart Trends opens by default.", ["trendChart"])}
  ${pageSettings("reports", "Reports", "Set defaults for new reports. Existing drafts and saved files stay as they are.", ["reportFormats", "reportPeriod"])}
  ${pageSettings("compare", "Compare", "Set the default period length for new comparisons.", ["compareDays"])}
  </div>
  </div>
</section>
<section id="collectionStatusView" class="collection-status-view" aria-label="Collection status" hidden>
  <div class="settings-section collection-health">
    <div id="collectionStrip" class="collection-status-details" aria-label="Local collection">
      <div class="collection-health-heading"><h2 id="collectionStatus">Checking history</h2><a id="collectionStatusAction" class="button-link" data-settings-link hidden></a></div>
      <p id="collectionStatusGuidance">Reading collection status.</p>
    </div>
    <p id="settingsDiagnosticError" class="notice error" role="alert" hidden></p>
    <p id="collectionTimes" class="muted"><span id="collectionChecked"></span><span id="collectionNewActivity"></span></p>
    <p id="collectionCoverageCounts"></p>
    <p id="collectionCoveragePending" class="settings-help" hidden></p>
    <div class="collection-status-actions"><a id="collectionSourceLink" href="/settings?section=connection&setting=source-paths" data-settings-link>Sources</a><a id="collectionHistoryLink" href="/settings?section=connection&setting=history-window" data-settings-link>Schedule</a><a href="/" data-settings-link>Go to Analyze</a></div>
  </div>
  <section id="collectionIssues" class="collection-issues settings-section" aria-labelledby="collectionIssuesTitle">
    <h2 id="collectionIssuesTitle" tabindex="-1">Chat history</h2>
    <p id="collectionIssueLabel"></p>
    <div id="collectionIssuesBody" class="collection-issues-body">
      <p id="collectionIssueCounts" class="muted"></p><p id="collectionIssueImpact"></p>
      <div class="scoped-search"><label for="issueSearch">Find a chat with gaps</label>${searchFieldMarkup({ id: "issueSearch", clearId: "clearIssueSearch", describedBy: "issueSearchHelp" })}<p id="issueSearchHelp" class="settings-help">Search all affected chat names, projects, IDs and reasons. No prompts or source paths.</p><p id="issueSearchCount" class="search-count" role="status"></p></div>
      <p id="collectionIssuesMessage" role="status" hidden></p><div id="collectionIssueGroups"></div>
      <p class="settings-help">Each chat appears under one primary reason; other limits may overlap. History gaps are not failed Work IQ or Graph requests.</p>
    </div>
  </section>
  <details id="collectionSetup" class="settings-advanced"><summary>Technical details</summary>
      <p class="settings-help">A check with no new activity is normal. It does not establish complete history or mean that a Work IQ request failed.</p>
      <dl class="settings-diagnostics"><dt>Last local check</dt><dd id="collectionExactCheck"></dd><dt>Last new evidence</dt><dd id="collectionExactNew"></dd><dt>Check frequency</dt><dd id="collectionExactTimes"></dd></dl>
      <div id="collectionDiagnostics"></div>
      <div id="collectionEvidenceDetails"></div>
    </details>
  <details id="recorderDiagnostics" class="settings-advanced"><summary>Optional network diagnostic</summary>
    <p id="recorderPurpose" hidden>Test the HTTP recorder, not collection. Sends one public request to Microsoft Graph and saves the result locally.</p>
    <p id="recorderEffect" class="settings-help" hidden>GET graph.microsoft.com/v1.0/$metadata, without credentials, saved response body or retries. This cannot verify Work IQ or access to workplace data.</p>
    <button id="recordBtn" type="button" aria-describedby="recorderPurpose recorderEffect recorderStatus" hidden disabled>Test HTTP recorder</button>
    <p id="recorderStatus" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">Open to read the last saved diagnostic.</p>
    <p id="recorderEvidence" class="settings-help" hidden></p>
    <p id="recorderStorageWarning" class="notice error" role="status" hidden></p>
    <a id="recorderResultLink" class="text-link" href="/" hidden>View HTTP recorder evidence</a>
  </details>
</section>`;

// Display preferences are browser-local and never enter collection configuration.
export function mountDisplayTimeSettings({ time, onChange }) {
    const $ = id => document.getElementById(id), key = "workiq-evidence.time-zone";
    let preference = null, warning = "", choicesKey = "", current, busy = false, stale = false;
    function accept(value) {
        try {
            preference = value === null ? null : time.zone(value);
            warning = "";
        } catch {
            preference = null;
            warning = "Saved time zone is invalid or unavailable. Device default is being used. Choose a listed zone to replace it.";
        }
    }
    try { accept(localStorage.getItem(key)); }
    catch { warning = "Time zone preference cannot be read in this browser. Device default is being used."; }
    function resolve() { return time.resolve(preference); }
    function receive(context, state = {}) {
        current = context;
        busy = Boolean(state.busy);
        stale = Boolean(state.stale);
        const device = time.detect(), signature = JSON.stringify([device.timeZone, preference]);
        if (signature !== choicesKey) {
            const select = $("displayTimeZone"), automatic = document.createElement("option");
            automatic.value = "";
            automatic.textContent = `Device default (${time.label(device)})`;
            select.replaceChildren(automatic);
            try {
                const choices = time.zoneChoices(device, preference);
                for (const entry of choices.zones) {
                    const option = document.createElement("option");
                    option.value = entry.timeZone;
                    option.textContent = entry.label;
                    select.append(option);
                }
                $("displayTimeHelp").textContent = choices.available
                    ? ""
                    : "This browser cannot provide the full time zone list. Device default, UTC and any saved valid choice remain available.";
            } catch {
                warning = "The browser's time zone list is unavailable. Device default remains available.";
                $("displayTimeHelp").textContent = warning;
                if (preference) {
                    const option = document.createElement("option");
                    option.value = preference; option.textContent = preference; select.append(option);
                }
            }
            $("displayTimeHelp").hidden = !$("displayTimeHelp").textContent;
            choicesKey = signature;
        }
        $("displayTimeZone").value = preference ?? "";
        $("displayTimeZone").disabled = busy;
        const changingZone = context.timeZone !== resolve().timeZone;
        $("generalTimeValue").textContent = changingZone ? `Still using ${time.label(context)}`
            : preference === null && !context.timeZoneFallback ? `Device default (${time.displayLabel(context)})` : time.label(context);
        $("displayTimeEffective").textContent = changingZone && stale
            ? `The selected zone has not loaded. Still using ${time.label(context)}; retry the view update.`
            : changingZone && state.pending ? `Updating time zone. Still using ${time.label(context)}.` : "";
        $("displayTimeEffective").hidden = !$("displayTimeEffective").textContent;
    }
    $("displayTimeZone").addEventListener("change", () => {
        if (busy) return;
        try { preference = $("displayTimeZone").value === "" ? null : time.zone($("displayTimeZone").value); }
        catch {
            warning = "Choose a valid, available time zone from the list. The current view is unchanged.";
            receive(current, { busy, stale });
            onChange();
            return;
        }
        try {
            if (preference === null) localStorage.removeItem(key);
            else localStorage.setItem(key, preference);
            warning = "";
        } catch { warning = "Time zone could not be saved. This choice applies to this panel only until reload."; }
        onChange();
    });
    window.addEventListener("storage", event => {
        if (event.key !== key && event.key !== null) return;
        accept(event.key === null ? null : event.newValue);
        onChange();
    });
    receive(resolve());
    return { resolve, receive, warning: () => warning };
}

// Serialized into the local shell. Polls update status, never the in-progress form.
export function mountCollectionSettings({ api, ux, write, read, invalidate, onDraftChange, collectionStatus, createNativeConfigurationState, sourceCollection, onCommitted }) {
    if (typeof api?.publicationToken !== "function" || typeof api?.isCurrent !== "function") {
        throw new TypeError("Collection Settings requires the shared publication interface.");
    }
    const $ = id => document.getElementById(id);
    // An approval to read token records holds only while the collector says it still names this file and account.
    const grantedRecords = status => status?.config?.usageRecords === true && status.usageRecords !== "approval-changed";
    const usageRecordsFile = database => database.replace(/[^\\/]*$/, "session-store.db");
    const fields = ["sourceDatabase", "sourceSessions", "sourceUsageRecords", "collectionWindow", "collectionCadence"];
    const pathFields = [["sourceDatabase", "appDbPath"], ["sourceSessions", "sessionRoot"]];
    const nativeConfiguration = typeof createNativeConfigurationState === "function" ? createNativeConfigurationState() : null;
    const nativeView = () => nativeConfiguration?.view(api.accessState?.().state);
    const sourceView = () => sourceCollection?.controlsActive ? sourceCollection.view(api.accessState()) : null;
    const legacyWindows = [...$("collectionWindow").options].map(option => option.cloneNode(true));
    let nativeWindows = false, nativeGesture = null;
    const explanations = new Map();
    let latest, baseline, initialized = false, busy = false, stale = false, uncertain = false, readError = "", pendingAction = "", checking = false, visibleSection, visibleSetting;
    let sharedRecovery = false, recoveryHidden = true;
    let guidedReview = false, reviewReturn = null, firstApprovalConfirmed = false, sourceExpanded = true;
    let picker = null;
    function closePicker() { picker?.abort(); picker = null; }
    const publicationCurrent = token => token !== null && token !== undefined
        && typeof token.then !== "function" && api.isCurrent(token) === true;
    let withdrawn = !publicationCurrent(api.publicationToken()), epoch = 0, safeDraft = null, pendingOperation = null, revokedWrite = false;
    const capture = () => ({ token: api.publicationToken(), epoch });
    const current = stamp => !withdrawn && stamp.epoch === epoch && publicationCurrent(stamp.token);
    function delivered(token) {
        if (token === undefined) throw new TypeError("Collection Settings delivery requires its publication token.");
        return current({ token, epoch });
    }
    function native(status = latest) {
        if (status?.nativeControl === undefined) return null;
        if (typeof collectionStatus?.native !== "function" || typeof collectionStatus.page !== "function") {
            throw new TypeError("Microsoft read controls require the shared collection status presentation.");
        }
        return collectionStatus.native(status);
    }
    function version(status) { return native(status)?.revision ?? status?.configVersion ?? JSON.stringify(status?.config ?? null); }
    function values() {
        return { appDbPath: $("sourceDatabase").value.trim(), sessionRoot: $("sourceSessions").value.trim(),
            usageRecords: $("sourceUsageRecords").checked,
            windowDays: Number($("collectionWindow").value), pollSeconds: Number($("collectionCadence").value) };
    }
    function sourceValues(status) {
        const source = status?.config || status?.suggestedSource;
        return { appDbPath: source?.appDbPath || "", sessionRoot: source?.sessionRoot || "",
            usageRecords: status?.config?.approved !== true || grantedRecords(status),
            windowDays: source?.windowDays ?? 30, pollSeconds: source?.pollSeconds ?? 5 };
    }
    function dirty() { return initialized && (native() ? Boolean(nativeView()?.dirty)
        : JSON.stringify(values()) !== JSON.stringify(sourceValues(baseline))); }
    function windowOptions(isNative) {
        if (nativeWindows === isNative) return;
        nativeWindows = isNative;
        $("collectionWindow").replaceChildren(...(isNative ? Array.from({ length: 90 }, (_, index) => {
            const option = document.createElement("option"), days = index + 1;
            option.value = String(days); option.textContent = `${days} ${days === 1 ? "day" : "days"}`; return option;
        }) : legacyWindows.map(option => option.cloneNode(true))));
    }
    function syncNativeValues() {
        const configuration = nativeView();
        windowOptions(Boolean(configuration?.present));
        for (const id of ["sourceDatabase", "sourceSessions", "collectionCadence"]) { $(id).value = ""; clearAttribute($(id), "value"); }
        if (!$("nativeCollectionSurfaces").options.length) {
            for (const [value, label] of [["chat,cowork", "Chat and Cowork"], ["chat", "Chat"], ["cowork", "Cowork"]]) {
                const option = document.createElement("option"); option.value = value; option.textContent = label;
                $("nativeCollectionSurfaces").append(option);
            }
        }
        $("nativeCollectionSurfaces").value = configuration?.values?.surfaces.join(",") ?? "";
        $("collectionWindow").value = configuration?.values ? String(configuration.values.windowDays) : "";
    }
    function clearText(element) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) walker.currentNode.data = "";
    }
    function clearAttribute(element, name) {
        const attribute = element.getAttributeNode(name);
        if (attribute) { attribute.value = ""; element.removeAttribute(name); }
    }
    function setText(id, text) {
        const element = $(id);
        if (element.textContent !== text) { clearText(element); element.textContent = text; }
    }
    function hideRecovery(value) {
        recoveryHidden = value;
        $("reloadSettings").hidden = value || sharedRecovery && !uncertain;
    }
    function message(text, error = false, origin = visibleSection) {
        if (!current(capture())) return;
        if (!error && !uncertain && origin !== visibleSection) text = "";
        setText("settingsMessage", text);
        $("settingsMessage").className = "notice" + (error ? " error" : "");
        $("settingsMessage").setAttribute("role", error ? "alert" : "status");
        $("settingsMessage").hidden = !text;
    }
    const inConfiguration = () => visibleSection === "connection";
    function reset() {
        baseline = latest;
        guidedReview = false;
        if (native()) {
            nativeConfiguration?.cancel(); syncNativeValues();
            initialized = true; stale = false;
            return;
        }
        windowOptions(false);
        const next = sourceValues(latest);
        for (const [id, key] of [["sourceDatabase", "appDbPath"], ["sourceSessions", "sessionRoot"], ["collectionWindow", "windowDays"], ["collectionCadence", "pollSeconds"]]) $(id).value = String(next[key]);
        $("sourceUsageRecords").checked = next.usageRecords;
        $("sourceDatabase").classList.remove("settings-target");
        initialized = true; stale = false;
    }
    function paintNative(control) {
        const stamp = capture();
        if (!current(stamp)) return;
        const working = busy || checking, state = collectionStatus.page(latest), saved = collectionStatus.persistence(latest);
        const allowed = control.enabled ? control.canPause : control.canResume;
        const reason = working ? "Wait for the current Microsoft read setting to finish."
            : uncertain || readError ? "Read the current connection before another change."
            : !control.retained ? "Current WIRE access is required."
            : !allowed ? control.connected ? "This Microsoft read action is not available."
                : "Microsoft reads cannot resume while the connection is unavailable." : "";
        for (const id of ["sourceFoldControls", "sourceCommit",
            "connectionPreferences", "preferenceActions", "collectNow"]) $(id).hidden = true;
        $("approvedConnection").hidden = false;
        $("pauseCollection").hidden = false;
        for (const id of fields.concat(["collectNow", "connectCollection", "saveCollection", "cancelPreferences", "cancelSource"])) $(id).disabled = true;
        for (const id of ["sourceUsageRecordsFile", "sourceUsageRecordsAccount", "sourceUsageRecordsState", "connectionSourceSummary", "sourceChangeImpact",
            "sourceSuggestion", "settingsDraftStatus"]) setText(id, "");
        $("approvalScope").replaceChildren();
        if ($("settingsDraftStatus").parentElement !== $("connectionPreferences")) $("connectionPreferences").append($("settingsDraftStatus"));
        setText("connectionSourceTitle", "Microsoft 365 activity");
        $("connectionSource").hidden = true;
        $("registeredSourceNotice").hidden = false;
        setText("connectionSourceHelp", "");
        $("connectionSourceHelp").hidden = true;
        setText("connectionStatus", readError ? "Last known: " + state.label : state.label);
        setText("pauseCollection", control.enabled ? "Pause Microsoft reads" : "Resume Microsoft reads");
        $("pauseCollection").disabled = working || uncertain || Boolean(readError) || !control.retained || !allowed;
        setText("settingsConnectionError", readError ? "Microsoft settings could not be read." : "");
        $("settingsConnectionError").hidden = !readError || !inConfiguration();
        hideRecovery(!uncertain && (!readError || !inConfiguration()));
        $("reloadSettings").disabled = working;
        explanations.set("pauseCollection", reason);
        explanations.set("collectNow", saved ? working ? "Update in progress."
            : uncertain || readError ? "Read current settings."
            : collectionStatus.persistenceReason(latest) || (saved.actions.includes("collect-now")
                ? "" : "Collection unavailable.")
            : "Collection unavailable.");
        ux.tooltip($("pauseCollection"), reason);
        if (!current(stamp)) return;
        ux.explainDisabled($("pauseCollection"), reason, { compact: true });
        if (!current(stamp)) return;
        ux.tooltip($("reloadSettings"), working ? reason : "");
        if (!current(stamp)) return;
        ux.explainDisabled($("reloadSettings"), working ? reason : "", { compact: true });
        if (!current(stamp)) return;
        ux.pending($("settingsDraftStatus"), false);
        if (!current(stamp)) return;
        paintNativeConfiguration(control, stamp);
    }
    function paintNativeConfiguration(control, stamp) {
        const configuration = nativeView(), present = configuration?.present === true;
        $("nativeCollectionSourceField").hidden = !present;
        $("nativeCollectionSurfaces").disabled = true;
        $("collectionCadence").closest(".settings-field").hidden = true;
        if (!present) { onDraftChange(false); return; }
        const working = busy || checking;
        const blocker = {
            NATIVE_CONFIGURATION_ACCOUNT_REQUIRED: "Connect Microsoft 365 first.",
            NATIVE_CONFIGURATION_IDENTITY_REQUIRED: "Connect Microsoft 365 first.",
            NATIVE_CONFIGURATION_ACCESS_UNAVAILABLE: "Microsoft access is required.",
        };
        const reason = working ? "Update in progress."
            : uncertain || readError || configuration.needsRead ? "Read current settings."
            : configuration.stale ? "Settings changed. Cancel edits to reload."
            : configuration.blockers.length ? blocker[configuration.blockers[0]]
            : configuration.validation || "";
        $("connectionPreferences").hidden = $("preferenceActions").hidden = false;
        setText("preferencesTitle", "Microsoft collection");
        setText("preferencesHelp", configuration.intent === "enable" ? "Save prompts, replies and tool activity locally. Microsoft may cache activity during sign-in."
            : configuration.values?.windowDays < latest?.nativePersistence?.configuration?.settings.windowDays ? "Saved activity is kept." : "");
        $("preferencesHelp").hidden = !$("preferencesHelp").textContent;
        setText("saveCollection", configuration.intent === "enable" ? "Enable Microsoft collection" : "Save Microsoft preferences");
        if (configuration.intent === "enable" && !readError && !collectionStatus.persistence(latest)?.configured) {
            setText("connectionStatus", "Not enabled");
        }
        $("saveCollection").disabled = working || uncertain || Boolean(readError) || !configuration.canSubmit;
        $("cancelPreferences").disabled = working || !(configuration.dirty || configuration.stale);
        $("nativeCollectionSurfaces").disabled = $("collectionWindow").disabled =
            working || uncertain || Boolean(readError) || !configuration.canEdit;
        $("pauseCollection").hidden = configuration.intent === "enable";
        if (configuration.dirty || configuration.stale) {
            $("pauseCollection").disabled = true;
            const hold = reason || "Save or cancel your Microsoft preferences before another collection action.";
            explanations.set("pauseCollection", hold); explanations.set("collectNow", hold);
            ux.tooltip($("pauseCollection"), hold);
            if (!current(stamp)) return;
            ux.explainDisabled($("pauseCollection"), hold, { compact: true });
            if (!current(stamp)) return;
        }
        const guidance = configuration.stale ? "Settings changed. Cancel edits to reload."
            : uncertain ? "Change unconfirmed."
            : working ? "Saving..." : configuration.validation || (configuration.dirty ? "Unsaved changes." : "");
        setText("settingsDraftStatus", guidance); $("settingsDraftStatus").hidden = !guidance;
        hideRecovery(!uncertain && !readError && !configuration.needsRead);
        $("reloadSettings").disabled = working;
        explanations.set("saveCollection", reason);
        explanations.set("nativeCollectionSurfaces", reason);
        explanations.set("collectionWindow", reason);
        for (const id of ["saveCollection", "cancelPreferences"]) {
            const help = id === "saveCollection" ? explanations.get(id)
                : working ? reason : "";
            ux.tooltip($(id), $(id).disabled ? help : "");
            if (!current(stamp)) return;
            ux.explainDisabled($(id), help, { compact: true });
            if (!current(stamp)) return;
        }
        ux.pending($("settingsDraftStatus"), working);
        if (current(stamp)) onDraftChange(configuration.dirty || configuration.stale);
    }
    function paint() {
        if (!current(capture())) return;
        const sources = sourceView();
        if (sources && !sources.current && initialized) readError ||= "Collection settings could not be read.";
        const control = native();
        paintCount();
        if (control) { paintNative(control); return; }
        $("nativeCollectionSourceField").hidden = true;
        $("nativeCollectionSurfaces").disabled = true;
        $("collectionCadence").closest(".settings-field").hidden = false;
        $("pauseCollection").hidden = sourceCollection?.copilotOnly && sources?.status?.global.paused === true;
        setText("preferencesTitle", "Schedule");
        setText("preferencesHelp", "");
        $("preferencesHelp").hidden = !$("preferencesHelp").textContent;
        setText("saveCollection", "Save preferences");
        const approved = latest?.config?.approved === true, changed = dirty(), working = busy || checking || picker !== null;
        setText("connectionSourceTitle", "GitHub Copilot app");
        setText("connectionSourceHelp", "");
        $("connectionSourceHelp").hidden = true;
        const next = values();
        const pathsChanged = approved && (next.appDbPath !== baseline?.config?.appDbPath || next.sessionRoot !== baseline?.config?.sessionRoot);
        const offered = baseline?.usageRecordsReview === true && !pathsChanged;
        const recordsChanged = next.usageRecords !== sourceValues(baseline).usageRecords;
        const sourceChanged = pathsChanged || recordsChanged;
        const recordsOnly = approved && recordsChanged && !pathsChanged;
        $("approvedConnection").hidden = !approved;
        $("connectionSource").hidden = false;
        $("registeredSourceNotice").hidden = true;
        $("sourceFoldControls").hidden = false;
        $("connectionSourceBody").hidden = !sourceExpanded;
        $("connectionSourceToggle").setAttribute("aria-expanded", String(sourceExpanded));
        const bulkState = sourceExpanded ? "expanded" : "collapsed";
        if ($("toggleAllSources").dataset.state !== bulkState) {
            const label = document.createElement("span");
            label.textContent = sourceExpanded ? "Collapse all" : "Expand all";
            $("toggleAllSources").replaceChildren(ux.icon(sourceExpanded ? "collapse-sections" : "expand-sections"), label);
            $("toggleAllSources").dataset.state = bulkState;
        }
        const pendingConfigure = busy && pendingAction === "/api/collection/configure";
        $("sourceCommit").hidden = approved && !changed && !stale && !uncertain && (!pendingConfigure || offered);
        $("firstCollectionWait").hidden = approved || uncertain || Boolean(readError);
        $("firstCollectionActivity").hidden = visibleSection !== "connection" || !firstApprovalConfirmed || !approved || uncertain || Boolean(readError);
        $("connectionPreferences").hidden = false;
        if ($("settingsDraftStatus").parentElement !== $("sourceDraftStatusSlot")) $("sourceDraftStatusSlot").append($("settingsDraftStatus"));
        const connectionState = !latest ? "Checking connection" : !approved ? "Not connected" : latest.error ? "Connection issue"
            : !latest.config.enabled || sourceCollection?.copilotOnly && sources?.status?.global.paused ? "Paused"
            : latest.connected ? "Collection on" : "Checking connection";
        setText("connectionStatus", readError ? latest ? `Last known: ${connectionState}` : "Status unavailable" : connectionState);
        setText("settingsConnectionError", readError ? "Collection settings could not be read." : "");
        $("settingsConnectionError").hidden = !readError || !inConfiguration();
        const recordsStopped = approved && latest.usageRecords === "approval-changed" && !next.usageRecords;
        const recordsState = offered ? "Off until you approve"
            : recordsChanged && initialized && approved ? "Changed" : recordsStopped ? "Stopped: the Copilot account or path changed"
            : approved ? grantedRecords(latest) ? "On" : "Off" : "";
        setText("sourceUsageRecordsState", latest ? recordsState : "");
        $("sourceUsageRecordsState").dataset.state = recordsState === "On" ? "on" : recordsState === "Changed" ? "changed" : recordsStopped ? "attention" : "off";
        setText("sourceUsageRecordsFile", next.appDbPath ? usageRecordsFile(next.appDbPath) : "");
        const grantAccount = grantedRecords(latest) && !pathsChanged ? latest.config.usageRecordsGrant?.account : "";
        setText("sourceUsageRecordsAccount", grantAccount ? ` · ${grantAccount}` : "");
        const sourcePartChanged = initialized && (pathsChanged || recordsChanged);
        setText("connectionSourceSummary", !latest ? "" : [approved ? "WIRE can read this" : "WIRE can't read this yet",
            sourceExpanded ? "" : `Token records ${recordsStopped ? "stopped" : (approved ? grantedRecords(latest) : next.usageRecords) ? "on" : "off"}`,
            !sourceExpanded && sourcePartChanged ? "Changed" : ""].filter(Boolean).join(" · "));
        setText("sourceChangeImpact", stale ? "Settings changed. Cancel edits to reload."
            : uncertain ? "Change unconfirmed."
            : pendingConfigure ? approved ? "Saving..." : "Checking the source and starting collection..." : "");
        $("sourceChangeImpact").hidden = !$("sourceChangeImpact").textContent;
        setText("sourceSuggestion", !approved && latest?.suggestedSource?.error ? latest.suggestedSource.error : "");
        $("sourceSuggestion").hidden = !$("sourceSuggestion").textContent;
        setText("sourceCommitTitle", approved ? "What changes" : "What approving allows");
        const items = latest && initialized ? changeItems(approved, pathsChanged, recordsChanged) : [];
        paintImpact(items);
        const widens = items.some(item => item.risk === "widen");
        $("sourceCommit").dataset.risk = widens ? "widen" : "";
        setText("connectCollection", approved ? sourceChanged ? recordsOnly ? next.usageRecords ? "Approve token records" : "Stop reading token records"
            : "Approve and switch source" : "Save preferences" : "Approve source and start collection");
        $("connectCollection").dataset.intent = approved && !sourceChanged ? "save-preferences" : "approve-source";
        $("connectCollection").dataset.risk = widens ? "widen" : "";
        $("connectCollection").classList.toggle("primary", !widens);
        setText("pauseCollection", latest?.config?.enabled ? "Pause collection" : "Resume collection");
        for (const id of fields) $(id).disabled = working || !initialized;
        for (const id of ["collectNow", "pauseCollection"]) $(id).disabled = !approved || working || uncertain || readError || stale || changed;
        $("connectCollection").disabled = working || uncertain || readError || stale || !next.appDbPath || !next.sessionRoot || (approved && !changed);
        $("saveCollection").disabled = true;
        if (sources) {
            $("connectCollection").disabled ||= !sources.actions.github.includes("configure");
            $("pauseCollection").disabled ||= !sources.actions.github.includes("set-interval");
            $("collectNow").disabled ||= !sources.actions.github.includes("collect-now");
        }
        const canSelect = initialized && !working && !uncertain && !readError && !stale
            && (!sources || sources.actions.github.includes("configure"));
        for (const [id] of pathFields) $(id + "Browse").disabled = !canSelect;
        $("sourceUsageRecords").closest("label").hidden = offered;
        $("sourceUsageRecords").disabled ||= offered;
        $("tokenPermissionActions").hidden = !offered;
        for (const id of ["approveUsageRecords", "declineUsageRecords"]) $(id).disabled = !canSelect || changed;
        $("preferenceActions").hidden = true;
        $("cancelPreferences").disabled = true;
        $("cancelSource").disabled = working || approved && !changed && !stale;
        hideRecovery(!uncertain && (!readError || !inConfiguration()));
        $("reloadSettings").disabled = working;
        const progress = revokedWrite && busy ? "Earlier change pending."
            : busy && !["/api/collection/now", "/api/collection/status"].includes(pendingAction) ? "Saving..." : "Checking...";
        const blocked = working ? progress
            : uncertain || readError ? "Read current settings."
            : stale ? "Cancel edits to reload."
            : changed ? "Save or cancel your changes first."
            : "Approve a source first.";
        for (const id of ["pauseCollection", "collectNow", "connectCollection", "cancelSource", "reloadSettings"]) {
            const control = $(id);
            let reason = blocked;
            if (control.disabled) {
                if (id === "cancelSource") reason = working ? progress : "";
                else if (!busy && !uncertain && !readError && !stale && id === "connectCollection") reason = !next.appDbPath || !next.sessionRoot
                    ? "Enter both source paths."
                    : "";
            }
            if (id !== "collectNow") {
                ux.tooltip(control, control.disabled ? reason : "");
                ux.explainDisabled(control, control.disabled ? reason : "", { compact: true });
            }
            explanations.set(id, control.disabled ? reason : "");
        }
        explanations.set("saveCollection", explanations.get("connectCollection"));
        explanations.set("sourceDatabase", working || uncertain || readError || stale ? blocked
            : "");
        setText("settingsDraftStatus", "");
        $("settingsDraftStatus").hidden = true;
        ux.pending($("settingsDraftStatus"), false);
        ux.pending($("sourceChangeImpact"), pendingConfigure);
        onDraftChange(Boolean(safeDraft?.changed) || changed);
    }
    // What the current draft would change, read from the draft and the last confirmed settings.
    function changeItems(approved, pathsChanged, recordsChanged) {
        const next = values(), saved = baseline?.config ?? {}, items = [];
        const records = () => ({ risk: "widen", title: "Read token records", tag: "Reads more",
            text: `${usageRecordsFile(next.appDbPath)}. WIRE won't save prompts from this file. It won't recount unchanged chats unless you choose to count them.` });
        if (!approved) {
            items.push({ risk: "widen", title: "Read your Copilot chats", tag: "Reads more", text: "Prompts are saved on this device. Replies stay off." });
            if (next.usageRecords) items.push(records());
            items.push({ risk: "schedule", title: "Start collecting", text: `Last ${next.windowDays} days, then every ${next.pollSeconds} seconds.` });
            return items;
        }
        if (pathsChanged) items.push({ risk: "widen", title: "Switch source", tag: "Reads more",
            changes: [next.appDbPath !== saved.appDbPath && ["Database", saved.appDbPath, next.appDbPath],
                next.sessionRoot !== saved.sessionRoot && ["Chat history", saved.sessionRoot, next.sessionRoot]].filter(Boolean),
            text: "Saved activity stays." + (grantedRecords(baseline) && !next.usageRecords ? " Token records stop until you approve them again." : "") });
        if (next.usageRecords && (pathsChanged || recordsChanged)) items.push(records());
        else if (recordsChanged && !pathsChanged) items.push({ risk: "narrow", title: "Stop reading token records", tag: "Reads less", text: "Counted totals stay." });
        if (next.windowDays !== saved.windowDays) items.push({ risk: "schedule", title: next.windowDays > saved.windowDays ? "Read more history" : "Read less history",
            changes: [["History", `${saved.windowDays} days`, `${next.windowDays} days`]], text: next.windowDays < saved.windowDays ? "Saved activity stays." : "" });
        if (next.pollSeconds !== saved.pollSeconds) items.push({ risk: "schedule", title: next.pollSeconds < saved.pollSeconds ? "Check more often" : "Check less often",
            changes: [["Frequency", `Every ${saved.pollSeconds} seconds`, `Every ${next.pollSeconds} seconds`]] });
        if (items.length && latest?.config?.enabled === false) items.push({ risk: "info", title: "Collection stays paused" });
        return items;
    }
    function paintImpact(items) {
        const list = $("approvalScope"), signature = JSON.stringify(items);
        if (list.dataset.signature === signature) return;
        clearText(list);
        list.dataset.signature = signature;
        list.replaceChildren(...items.map(item => {
            const row = document.createElement("li"), body = document.createElement("div"), title = document.createElement("strong");
            row.dataset.risk = item.risk;
            title.textContent = item.title;
            body.append(title);
            if (item.tag) { const tag = document.createElement("span"); tag.className = "source-impact-tag"; tag.textContent = ` · ${item.tag}`; body.append(tag); }
            for (const [name, was, now] of item.changes ?? []) {
                const change = document.createElement("div"), before = document.createElement("del"), after = document.createElement("span");
                change.className = "source-impact-change"; before.textContent = was; after.textContent = now;
                change.append(`${name}: `, before, " → ", after);
                body.append(change);
            }
            if (item.text) { const text = document.createElement("div"); text.textContent = item.text; body.append(text); }
            row.append(ux.icon(`change-${item.risk}`), body);
            return row;
        }));
        list.hidden = !items.length;
    }
    function receive(status, token) {
        if (!delivered(token)) return false;
        const control = native(status);
        const saved = collectionStatus?.persistence?.(status), previousSaved = collectionStatus?.persistence?.(latest);
        if (saved && previousSaved?.accountRef === saved.accountRef && previousSaved.generation === saved.generation
            && previousSaved.revision > saved.revision) return false;
        if (control && native()?.revision > control.revision) return false;
        if (status.nativeConfigurationOffer !== undefined && (!control || !nativeConfiguration || typeof api.accessState !== "function")) {
            throw new TypeError("Microsoft collection configuration requires its native Settings interface.");
        }
        if (nativeConfiguration && !nativeConfiguration.receive(control ? status.nativeConfigurationOffer : undefined)) return false;
        readError = "";
        latest = status;
        if (control) {
            safeDraft = null; baseline = latest; syncNativeValues();
            initialized = true; stale = false;
        }
        else if (safeDraft) {
            const saved = safeDraft;
            reset();
            if (saved.changed) {
                $("collectionWindow").value = saved.window;
                $("collectionCadence").value = saved.cadence;
            }
            safeDraft = null;
        } else if (!initialized || (!dirty() && !busy && !uncertain)) reset();
        else if (version(status) !== version(baseline)) stale = true;
        if (revokedWrite && uncertain) message(busy
            ? "The earlier settings change is still pending. No action was replayed."
            : "The earlier settings change is unconfirmed. Read the current connection before another change. No action was replayed.", true);
        paint();
        return delivered(token);
    }
    function cancel() {
        const stamp = capture();
        if (!current(stamp) || busy) return;
        closePicker();
        const returnToOrigin = reviewReturn;
        reviewReturn = null;
        const next = values(), saved = sourceValues(baseline);
        const changedControl = next.appDbPath !== saved.appDbPath ? "sourceDatabase" : next.sessionRoot !== saved.sessionRoot ? "sourceSessions"
            : next.usageRecords !== saved.usageRecords ? "sourceUsageRecords" : next.pollSeconds !== saved.pollSeconds ? "collectionCadence-control" : "collectionWindow-control";
        reset();
        message(uncertain ? "Earlier change unconfirmed. Read current connection." : "");
        paint();
        if (!current(stamp)) return;
        let target = visibleSection !== "connection" ? document.querySelector("[data-settings-section]:not([hidden]) h2")
            : nativeView()?.present ? $("nativeCollectionSurfaces-control")
            : $("connectionSourceBody").contains($(changedControl)) && !sourceExpanded ? $("connectionSourceToggle") : $(changedControl);
        ux.restoreFocus(target?.disabled ? target.closest(".ux-disabled-help") : target);
        if (current(stamp) && !uncertain) returnToOrigin?.();
    }
    async function act(endpoint, input, success) {
        const stamp = capture();
        if (!current(stamp) || busy || uncertain || readError || stale) return;
        const origin = visibleSection;
        const operation = { kind: "write", dispatched: false };
        pendingOperation = operation;
        busy = true; pendingAction = endpoint;
        try {
            message("");
            if (!current(stamp)) return;
            if (!(native() && endpoint === "/api/collection/enabled")) invalidate();
            if (!current(stamp)) return;
            paint();
            if (!current(stamp)) return;
            operation.dispatched = true;
            const request = write(endpoint, input);
            input = null;
            const status = await request;
            if (!current(stamp)) { uncertain = true; revokedWrite = true; return; }
            const updated = native(status);
            if (updated && native()?.revision > updated.revision) {
                throw new Error("Microsoft read settings changed again. Read the current connection.");
            }
            latest = status;
            reset();
            message(typeof success === "function" ? success(latest) : success, false, origin);
        } catch (error) {
            const refused = endpoint === "/api/collection/configure" && error.configuration === "not-saved" && current(stamp);
            if (operation.dispatched && !refused) uncertain = true;
            if (!current(stamp)) { revokedWrite ||= operation.dispatched; return; }
            const detail = error.reason === "runtime_unavailable" ? "WIRE is not responding."
                : error.reason === "invalid_response" ? "The response could not be read."
                : error.reason === "wire_access_stale" ? "WIRE access changed." : error.message;
            message(detail + (refused ? " Settings were not saved." : operation.dispatched ? " Change unconfirmed." : " Change not started."), true);
        } finally {
            input = null; success = null;
            if (pendingOperation === operation) {
                pendingOperation = null; busy = false; pendingAction = "";
            }
            if (current(stamp)) {
                paint();
                if (current(stamp)) $("settingsMessage").focus({ preventScroll: true });
            }
        }
    }
    function guard() {
        return latest?.configVersion !== undefined ? { expectedConfigVersion: baseline.configVersion } : {};
    }
    function configure(reviewingSource, tokenChoice) {
        if (!current(capture()) || !initialized || busy || stale || uncertain) return;
        const oneTimeChoice = typeof tokenChoice === "boolean";
        if (oneTimeChoice) {
            if (!inConfiguration() || !sourceExpanded || picker || !canReviewSource() || !baseline?.usageRecordsReview || dirty()) return;
        } else if (reviewingSource ? $("connectCollection").disabled : $("saveCollection").disabled) return;
        if (native()) {
            const configuration = nativeView();
            if (reviewingSource || !configuration?.canSubmit) {
                message("Read current Microsoft settings before saving.", true); paint(); return;
            }
            const command = nativeConfiguration.command(api.accessState().state);
            const gesture = nativeGesture;
            nativeGesture = null;
            if (gesture && (!current(gesture.stamp) || JSON.stringify(gesture.command) !== JSON.stringify(command))) {
                message("Microsoft settings changed before activation. Review current settings and try again.", true);
                paint(); return;
            }
            const paused = collectionStatus.persistence(latest)?.configuration?.settings.paused;
            if (command.intent === "save" && typeof paused !== "boolean") {
                message("The committed Microsoft collection state is unavailable. Read current Settings.", true); return;
            }
            act("/api/collection/configure", command, status => {
                const saved = collectionStatus.persistence(status), result = saved?.configuration;
                if (!saved?.configured || !result || result.settings.windowDays !== command.windowDays
                    || JSON.stringify([...result.surfaces].sort()) !== JSON.stringify([...command.surfaces].sort())
                    || result.settings.paused !== (command.intent === "enable" ? false : paused)) {
                    throw new Error("The Microsoft settings change was not confirmed.");
                }
                return command.intent === "enable" ? "Microsoft collection enabled." : "Preferences saved.";
            });
            return;
        }
        const next = values();
        if (oneTimeChoice) next.usageRecords = tokenChoice;
        const pathsDiffer = next.appDbPath !== baseline?.config?.appDbPath || next.sessionRoot !== baseline?.config?.sessionRoot;
        const recordsDiffer = oneTimeChoice || next.usageRecords !== grantedRecords(baseline);
        const sourceDiffers = pathsDiffer || recordsDiffer;
        const sourceApproval = reviewingSource && (baseline?.config?.approved !== true || sourceDiffers);
        if (!sourceApproval && sourceDiffers) {
            message("Changed source paths require fresh approval. Review the source before connecting.", true); return;
        }
        const firstApproval = baseline.config?.approved !== true;
        const recordsOnly = !firstApproval && next.appDbPath === baseline.config.appDbPath && next.sessionRoot === baseline.config.sessionRoot;
        // Persist a reviewed Off too. Never send a suggested On with an unrelated preference save.
        const { usageRecords, ...paths } = next;
        const confirmRecords = firstApproval || recordsDiffer || (pathsDiffer && usageRecords);
        const records = confirmRecords ? { usageRecords } : {};
        act("/api/collection/configure", { ...paths, ...records, approved: true, enabled: baseline.config?.enabled ?? true, ...guard() }, saved => {
            firstApprovalConfirmed = firstApproval;
            reviewReturn = null;
            // First connection keeps the source when WIRE can't identify the Copilot account; the saved state says so.
            if (firstApproval && usageRecords && !grantedRecords(saved)) return "Source connected. Token records are off because WIRE couldn't identify the Copilot account.";
            return !sourceApproval ? "Preferences saved." : !recordsOnly ? "Source approved."
                : usageRecords ? "Token records approved." : oneTimeChoice ? "Token records will stay off." : "Token records turned off.";
        });
    }
    $("collectionForm").addEventListener("submit", event => event.preventDefault());
    $("approveUsageRecords").addEventListener("click", () => configure(true, true));
    $("declineUsageRecords").addEventListener("click", () => configure(true, false));
    for (const id of [...fields, "nativeCollectionSurfaces"]) $(id).addEventListener("input", () => {
        if (!current(capture())) return;
        if (native() && nativeView()?.present && ["nativeCollectionSurfaces", "collectionWindow"].includes(id)) {
            nativeConfiguration.edit({ surfaces: $("nativeCollectionSurfaces").value.split(",").filter(Boolean),
                windowDays: Number($("collectionWindow").value) });
        }
        // Token records are approved for one database location; a changed path asks again.
        if (pathFields.some(([input]) => id === input) && baseline?.config?.approved === true) {
            if (baseline.usageRecordsReview || values().appDbPath !== baseline.config.appDbPath || values().sessionRoot !== baseline.config.sessionRoot) $("sourceUsageRecords").checked = false;
        }
        message(""); paint();
    });
    const canReviewSource = () => current(capture()) && Boolean(latest) && initialized && !native() && !busy && !checking && !uncertain && !readError
        && (!sourceView() || sourceView().actions.github.includes("configure"));
    for (const [id, field] of pathFields) $(id + "Browse").addEventListener("click", async () => {
        const button = $(id + "Browse"), stamp = capture();
        if (button.disabled || !inConfiguration() || !sourceExpanded || !canReviewSource() || stale || picker) return;
        const before = $(id).value, revision = version(baseline);
        const dialog = picker = new AbortController();
        const stillEditing = () => picker === dialog && current(stamp) && canReviewSource() && !stale
            && version(latest) === revision && inConfiguration() && sourceExpanded && $(id).value === before;
        paint();
        try {
            const result = await api("/api/collection/pick-path", { field }, { signal: dialog.signal });
            if (!stillEditing()) return;
            if (!result || result.path !== null && typeof result.path !== "string") throw new Error("The picker returned no usable path. Enter the path directly.");
            if (result.path !== null && result.path !== before) {
                $(id).value = result.path;
                $(id).dispatchEvent(new Event("input", { bubbles: true }));
            }
        } catch (error) {
            if (stillEditing()) message(error.message, true);
        } finally {
            if (picker === dialog) {
                picker = null;
                if (current(stamp)) { paint(); if (inConfiguration() && sourceExpanded && !button.disabled) button.focus({ preventScroll: true }); }
            }
        }
    });
    // First connection opens the same draft; Cancel then returns to where the person started.
    function openSourceReview({ onCancel } = {}) {
        const stamp = capture();
        if (!canReviewSource() || dirty()) return false;
        guidedReview = typeof onCancel === "function";
        reviewReturn = onCancel ?? null;
        firstApprovalConfirmed = false;
        sourceExpanded = true;
        message(""); paint();
        if (current(stamp)) (latest?.suggestedSource?.error ? $("sourceDatabase") : $("connectionSourceToggle")).focus();
        return current(stamp);
    }
    function setSourceExpanded(value, focusId) {
        if (!current(capture()) || sourceExpanded === value) return;
        if (!value) closePicker();
        sourceExpanded = value; paint();
        const target = $(focusId);
        ux.restoreFocus(target && !target.disabled ? target : $("connectionSourceToggle"));
    }
    $("connectionSourceToggle").addEventListener("click", () => setSourceExpanded(!sourceExpanded, "connectionSourceToggle"));
    $("toggleAllSources").addEventListener("click", () => setSourceExpanded(!sourceExpanded, "toggleAllSources"));
    $("cancelSource").addEventListener("click", cancel);
    $("cancelPreferences").addEventListener("click", cancel);
    $("connectCollection").addEventListener("click", () => configure(true));
    const captureNativeGesture = () => {
        if (!nativeView()?.present) return;
        const stamp = capture();
        nativeGesture = { stamp, command: current(stamp) && nativeView().canSubmit
            ? nativeConfiguration.command(api.accessState().state) : null };
    };
    $("saveCollection").addEventListener("pointerdown", event => { if (event.button === 0) captureNativeGesture(); });
    $("saveCollection").addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key) && !event.repeat) captureNativeGesture();
    });
    $("saveCollection").addEventListener("click", () => configure(false));
    $("pauseCollection").addEventListener("click", () => {
        if (!current(capture()) || $("pauseCollection").disabled) return;
        const control = native();
        if (control) {
            const enabled = !control.enabled;
            act("/api/collection/enabled", { enabled, expectedNativeRevision: control.revision }, status => {
                const updated = native(status);
                if (!updated || updated.enabled !== enabled) throw new Error("The Microsoft read change was not confirmed.");
                return enabled ? "Microsoft reads resumed." : "Microsoft reads paused.";
            });
            return;
        }
        act("/api/collection/enabled", { enabled: !latest.config.enabled, ...guard() }, latest.config.enabled ? "Collection paused." : "Collection resumed.");
    });
    $("collectNow").addEventListener("click", () => {
        if (current(capture()) && !$("collectNow").disabled) $("checkActivity").click();
    });
    $("reloadSettings").addEventListener("click", async () => {
        const stamp = capture();
        if (!current(stamp) || busy) return;
        const origin = visibleSection;
        const wasUncertain = uncertain;
        const recoveringNative = uncertain && nativeView()?.present === true;
        const operation = { kind: "read" };
        pendingOperation = operation;
        busy = true; pendingAction = "/api/collection/status";
        try {
            paint();
            if (!current(stamp)) return;
            const status = await read();
            if (!current(stamp)) return;
            uncertain = false; revokedWrite = false;
            receive(status, stamp.token);
            if (!current(stamp)) return;
            if (recoveringNative && nativeView()?.present) {
                reset();
            }
            message(wasUncertain ? "Current settings shown; earlier change unconfirmed." : "", false, origin);
        } catch (error) {
            if (!current(stamp)) return;
            if (readError && !uncertain) readError = error.message;
            else message("Current settings could not be read.", true);
        }
        finally {
            if (pendingOperation === operation) {
                pendingOperation = null; busy = false; pendingAction = "";
            }
            if (current(stamp)) paint();
        }
    });
    // Count tokens in chats already read: a read-only check, then a separate confirmation of exactly what it found.
    // Helpers stay inside this function because the standalone Settings page serializes only its body.
    const countKey = "workiq-evidence.usage-count-operation", countDialog = $("usageCountDialog");
    const countReasons = {
        "no-records": "Copilot has no token records for the chat", "prompt-not-matched": "The prompt doesn't match Copilot's records",
        "calls-outside-rounds": "Calls fall outside the chat's model rounds", "no-calls": "No calls are recorded for the prompt",
        "exchange-open": "The exchange is still open", "too-large": "The chat or its records are too large to read",
        "chat-unavailable": "The chat is no longer available", "chat-changed": "The chat changed while WIRE was checking",
        "records-unreadable": "Copilot's records couldn't be read", "journal-receipts": "The chat's log has its own counts; they're added when the chat next changes",
        "over-limit": "Beyond the 128 chats one check can read",
    };
    const count = { phase: "closed", preview: null, receipt: null, result: null, busy: false, timer: null, trigger: null, epoch: 0, suppressClose: false };
    const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
    function countAvailable() {
        const sources = sourceView();
        return !withdrawn && !native() && latest?.config?.approved === true && latest.config.enabled === true && latest.usageRecords === "on"
            && latest.recollection?.available === true && !(sourceCollection?.copilotOnly && sources?.status?.global.paused === true);
    }
    function storedCount() {
        try {
            const value = JSON.parse(sessionStorage.getItem(countKey) ?? "null");
            return value && /^[a-f0-9-]{36}$/.test(value.operationId) && /^[a-f0-9]{64}$/.test(value.receiptToken) ? value : null;
        } catch { return null; }
    }
    function forgetCount() { try { sessionStorage.removeItem(countKey); } catch { /* the receipt check stays offered */ } count.receipt = null; }
    function countStatus(text, error = false) {
        setText("usageCountStatus", text);
        $("usageCountStatus").classList.toggle("error", error);
    }
    function dropCountPreview() {
        clearTimeout(count.timer);
        const operationId = count.preview?.operationId;
        count.preview = null;
        if (operationId && !withdrawn) api("/api/usage-records/cancel", { operationId }).catch(() => {});
    }
    function renderCount() {
        const { phase, preview, busy: working } = count, counts = preview?.counts;
        setText("usageCountTitle", phase === "checking" ? "Checking chats..."
            : phase === "preview" ? `Count tokens for ${plural(counts.interactions, "interaction")}?`
            : phase === "empty" ? "No interactions can be counted" : phase === "pending" ? "Counting tokens..."
            : phase === "complete" ? "Tokens counted" : phase === "uncertain" ? working ? "Checking the result..." : "Result not yet confirmed"
            : phase === "not-saved" ? "Nothing was saved" : "Count tokens in chats already read");
        countDialog.dataset.decisionPhase = phase === "preview" ? "confirm" : phase === "uncertain" ? working ? "checking" : "unknown"
            : ["pending", "complete"].includes(phase) ? phase : ["not-saved", "error"].includes(phase) ? "error" : "";
        $("usageCountBoundary").hidden = !["checking", "error"].includes(phase);
        $("usageCountPreviewResult").hidden = !counts || !["preview", "empty", "pending"].includes(phase);
        setText("usageCountSummary", !counts ? "" : counts.interactions
            ? `${plural(counts.interactions, "interaction")} in ${plural(counts.chats, "chat")} can be counted · ${plural(counts.tokens, "token")}`
            : counts.refused ? "None of the interactions without a total in the approved chats and history window can be counted"
                : "No interaction without a total was found in the approved chats and history window");
        setText("usageCountRefused", counts?.refused ? `${counts.refused.toLocaleString()} can't be counted` : "");
        $("usageCountRefused").hidden = !counts?.refused;
        const reasons = (counts?.refused ? preview.refusals : []).map(({ reason, count: n }) => {
            const item = document.createElement("li"); item.textContent = `${countReasons[reason] ?? "Not counted"} · ${n.toLocaleString()}`; return item;
        });
        $("usageCountReasons").replaceChildren(...reasons);
        $("usageCountReasons").hidden = !reasons.length;
        $("usageCountKept").hidden = !counts?.interactions;
        $("usageCountConfirm").hidden = !["preview", "pending"].includes(phase);
        $("usageCountConfirm").disabled = phase !== "preview" || working;
        setText("usageCountConfirm", counts?.interactions ? `Count ${plural(counts.interactions, "interaction")}` : "Count tokens");
        $("usageCountRetry").hidden = !["error", "not-saved"].includes(phase);
        $("usageCountRetry").disabled = working || !countAvailable();
        $("usageCountCheck").hidden = phase !== "uncertain";
        $("usageCountCheck").disabled = working;
        $("usageCountClose").disabled = phase === "pending";
        setText("usageCountClose", ["checking", "preview", "pending"].includes(phase) ? "Cancel" : "Close");
        ux.pending($("usageCountConfirm"), phase === "pending");
        ux.pending($("usageCountCheck"), working && phase === "uncertain");
        const icon = phase === "complete" ? "check" : phase === "uncertain" && !working ? "unobserved" : working || phase === "pending" ? "pending" : "activity";
        if ($("usageCountIcon").dataset.icon !== icon) { $("usageCountIcon").replaceChildren(ux.icon(icon)); $("usageCountIcon").dataset.icon = icon; }
        $("usageCountIcon").firstElementChild?.classList.toggle("pending-indicator", working || phase === "pending");
    }
    function paintCount() {
        const available = countAvailable(), pending = storedCount() ?? count.receipt;
        $("usageCountRow").hidden = withdrawn || visibleSection !== "connection" || latest?.config?.approved !== true || !(available || pending);
        $("countUsageRecords").disabled = count.busy || busy || !pending && dirty();
        ux.explainDisabled($("countUsageRecords"), !count.busy && !busy && !pending && dirty() ? "Save or cancel your changes first." : "", { compact: true });
        setText("countUsageRecords", pending ? "Check result" : "Check chats");
        const notice = pending ? "A count's result wasn't confirmed. Check it before counting again."
            : count.result ? `Last count: ${plural(count.result.counts.interactions, "interaction")} · ${plural(count.result.counts.tokens, "token")}.` : "";
        setText("usageCountNotice", notice);
        $("usageCountNotice").hidden = !notice;
        // Turning records off, a lapsed approval or Pause retires an open check before anything is saved.
        if (countDialog.open && !available && ["checking", "preview", "empty"].includes(count.phase)) {
            count.epoch++; count.busy = false; dropCountPreview(); count.phase = "error";
            countStatus("Copilot's token records are off, paused or need a new approval. Nothing was saved.", true);
        }
        if (countDialog.open) renderCount();
    }
    async function previewCount() {
        const stamp = capture(), epoch = ++count.epoch;
        dropCountPreview();
        count.phase = "checking"; count.busy = true; countStatus(""); renderCount();
        try {
            const preview = await api("/api/usage-records/preview", {});
            if (!current(stamp) || epoch !== count.epoch || !countDialog.open) {
                if (preview?.operationId && current(stamp)) api("/api/usage-records/cancel", { operationId: preview.operationId }).catch(() => {});
                return;
            }
            count.preview = preview;
            count.phase = preview.operationId ? "preview" : "empty";
            if (preview.operationId) count.timer = setTimeout(() => {
                if (count.phase !== "preview" || count.preview !== preview || !current(stamp)) return;
                dropCountPreview(); count.phase = "error";
                countStatus("The check expired. Nothing was saved. Check again.", true); renderCount();
            }, Math.max(0, Date.parse(preview.expiresAt) - Date.now()));
        } catch (error) {
            if (!current(stamp) || epoch !== count.epoch) return;
            count.phase = "error"; countStatus(`${error.message} Nothing was saved.`, true);
        } finally {
            if (current(stamp) && epoch === count.epoch) { count.busy = false; renderCount(); }
        }
    }
    function finishCount(result) {
        if (result?.phase === "complete") {
            forgetCount(); count.phase = "complete"; count.result = result; count.preview = null;
            countStatus(`Counted ${plural(result.counts.interactions, "interaction")} in ${plural(result.counts.chats, "chat")} · ${plural(result.counts.tokens, "token")}. Saved reports are unchanged.`);
            onCommitted?.();
        } else if (result?.phase === "verification-incomplete") {
            count.phase = "uncertain";
            countStatus("WIRE is still counting. Check the result again in a moment; don't count again.", true);
        } else if (result?.phase === "not-started") {
            forgetCount(); count.phase = "not-saved"; count.preview = null;
            countStatus("No count was saved for that check. Check chats again to count them.", true);
        } else throw new Error("The result couldn't be read.");
    }
    async function confirmCount() {
        const stamp = capture(), preview = count.preview;
        if (!current(stamp) || count.phase !== "preview" || count.busy || !preview?.operationId || !countAvailable()) return;
        if (Date.parse(preview.expiresAt) <= Date.now()) {
            dropCountPreview(); count.phase = "error"; countStatus("The check expired. Nothing was saved. Check again.", true); renderCount(); return;
        }
        const receipt = { operationId: preview.operationId, receiptToken: preview.receiptToken };
        try { sessionStorage.setItem(countKey, JSON.stringify(receipt)); }
        catch { countStatus("This browser can't keep the result receipt, so nothing was counted. Allow session storage and check again.", true); return; }
        clearTimeout(count.timer);
        count.receipt = receipt; count.phase = "pending";
        countStatus("Rereading the checked chats and saving only their totals. Keep this panel open.");
        renderCount(); paintCount();
        $("usageCountStatus").focus();
        try {
            const result = await api("/api/usage-records/confirm", { operationId: receipt.operationId, confirmed: true });
            if (current(stamp)) finishCount(result);
        } catch (error) {
            if (!current(stamp)) return;
            if (error.recollection?.outcome === "not-saved" && error.recollection.operationId === receipt.operationId && error.outcome !== "unknown") {
                // Only the server can prove this confirmation was refused before anything was written.
                forgetCount(); count.phase = "not-saved"; count.preview = null; countStatus(error.message, true);
            } else { count.phase = "uncertain"; countStatus(`${error.message} Use Check result; counting won't run again.`, true); }
        } finally { if (current(stamp)) { renderCount(); paintCount(); } }
    }
    async function checkCount() {
        const stamp = capture(), receipt = count.receipt ?? storedCount();
        if (!current(stamp) || !receipt || count.busy) return;
        count.busy = true; renderCount();
        try {
            const result = await api("/api/usage-records/status", receipt);
            if (current(stamp)) finishCount(result);
        } catch (error) {
            if (current(stamp)) countStatus(`Couldn't read the result. ${error.message} Nothing was counted again.`, true);
        } finally { if (current(stamp)) { count.busy = false; renderCount(); paintCount(); } }
    }
    function openCount(event) {
        if (!current(capture()) || $("countUsageRecords").disabled || countDialog.open) return;
        count.trigger = event.currentTarget;
        count.receipt = storedCount() ?? count.receipt;
        count.preview = null; count.busy = false; countStatus("");
        count.phase = count.receipt ? "uncertain" : "checking";
        if (count.receipt) countStatus("A count's result wasn't confirmed. Check its result before counting again.", true);
        renderCount();
        countDialog.showModal();
        countDialog.querySelector(".decision-body").scrollTop = 0;
        $("usageCountClose").focus();
        if (!count.receipt) void previewCount();
    }
    $("countUsageRecords").addEventListener("click", openCount);
    $("usageCountConfirm").addEventListener("click", () => { void confirmCount(); });
    $("usageCountRetry").addEventListener("click", () => { if (countAvailable() && !count.busy) void previewCount(); });
    $("usageCountCheck").addEventListener("click", () => { void checkCount(); });
    $("usageCountClose").addEventListener("click", () => { if (count.phase !== "pending") countDialog.close(); });
    countDialog.addEventListener("cancel", event => { if (count.phase === "pending") event.preventDefault(); });
    countDialog.addEventListener("close", () => {
        if (count.suppressClose) { count.suppressClose = false; return; }
        count.epoch++; count.busy = false;
        if (count.phase !== "uncertain") { dropCountPreview(); count.phase = "closed"; }
        paintCount();
        const trigger = count.trigger;
        count.trigger = null;
        if (trigger?.isConnected && trigger.checkVisibility()) ux.restoreFocus(trigger);
    });
    countDialog.addEventListener("keydown", event => {
        if (event.key !== "Tab") return;
        const controls = [...countDialog.querySelectorAll("button")].filter(node => !node.disabled && node.checkVisibility());
        if (!controls.length) { event.preventDefault(); $("usageCountStatus").focus(); return; }
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !countDialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !countDialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    });
    function withdrawCount() {
        count.epoch++; clearTimeout(count.timer);
        // A dispatched confirmation stays checkable through its stored receipt; withdrawal isn't proof it failed.
        count.phase = count.phase === "pending" || count.receipt ? "uncertain" : "closed";
        count.preview = null; count.result = null; count.busy = false; count.trigger = null;
        if (countDialog.open) { count.suppressClose = true; countDialog.close(); }
        for (const id of ["usageCountSummary", "usageCountRefused", "usageCountStatus", "usageCountNotice"]) setText(id, "");
        $("usageCountReasons").replaceChildren();
        $("usageCountRow").hidden = true;
    }
    function withdrawAccess() {
        withdrawCount();
        if (!withdrawn) {
            const original = sourceValues(baseline);
            if (native()) safeDraft = null;
            else if (!safeDraft || initialized) safeDraft = {
                window: $("collectionWindow").value, cadence: $("collectionCadence").value,
                changed: initialized && ($("collectionWindow").value !== String(original.windowDays)
                    || $("collectionCadence").value !== String(original.pollSeconds)),
            };
            epoch++;
        }
        withdrawn = true;
        closePicker();
        for (const [id] of pathFields) $(id + "Browse").disabled = true;
        $("tokenPermissionActions").hidden = true;
        $("sourceUsageRecords").closest("label").hidden = false;
        reviewReturn = null;
        guidedReview = firstApprovalConfirmed = false;
        sharedRecovery = false; recoveryHidden = true;
        nativeConfiguration?.withdraw();
        $("nativeCollectionSurfaces").value = "";
        // A dispatched change stays uncertain; withdrawal is not proof of cancellation.
        uncertain ||= pendingOperation?.kind === "write" && pendingOperation.dispatched;
        revokedWrite ||= uncertain;
        if (pendingOperation?.kind !== "write" || !pendingOperation.dispatched) {
            pendingOperation = null; busy = false; pendingAction = "";
        }
        latest = baseline = null; readError = ""; initialized = false; stale = false; checking = false;
        explanations.clear();
        for (const id of ["sourceDatabase", "sourceSessions"]) {
            $(id).value = "";
            clearAttribute($(id), "value"); clearAttribute($(id), "title");
        }
        // The token-records path, account and switch describe the withdrawn account's grant.
        $("sourceUsageRecords").checked = false;
        delete $("sourceUsageRecordsState").dataset.state;
        clearText($("approvalScope")); $("approvalScope").replaceChildren(); delete $("approvalScope").dataset.signature;
        for (const id of ["sourceUsageRecordsFile", "sourceUsageRecordsAccount", "sourceUsageRecordsState", "connectionSourceSummary", "settingsMessage", "settingsConnectionError",
            "sourceChangeImpact", "sourceSuggestion", "settingsDraftStatus", "connectionStatus",
            "connectionSourceTitle", "connectionSourceHelp", "pauseCollection"]) {
            clearText($(id)); $(id).replaceChildren();
        }
        for (const id of ["approvedConnection", "sourceCommit", "registeredSourceNotice",
            "settingsMessage", "settingsConnectionError", "sourceChangeImpact", "sourceSuggestion", "approvalScope",
            "settingsDraftStatus", "reloadSettings", "firstCollectionWait", "firstCollectionActivity"]) $(id).hidden = true;
        for (const id of [...fields, "nativeCollectionSurfaces", "collectNow", "pauseCollection", "connectCollection",
            "saveCollection", "cancelPreferences", "cancelSource", "reloadSettings"]) {
            $(id).disabled = true;
            if (id !== "collectNow" && id !== "nativeCollectionSurfaces" && !fields.includes(id)) {
                ux.tooltip($(id), "Connection access is unavailable.");
                ux.explainDisabled($(id), "Connection access is unavailable.", { compact: true });
            }
        }
        $("connectCollection").removeAttribute("data-intent");
        ux.pending($("settingsDraftStatus"), false); ux.pending($("sourceChangeImpact"), false);
        ux.hideTooltip();
    }
    function resumeAccess() {
        const token = api.publicationToken();
        if (!publicationCurrent(token)) return false;
        withdrawn = false;
        return true;
    }
    window.addEventListener("beforeunload", event => {
        if (!dirty() && !busy && !safeDraft?.changed) return;
        event.preventDefault(); event.returnValue = "";
    });
    return { receive, withdrawAccess, resumeAccess, openSourceReview, canReviewSource,
        expandSource() { if (!sourceExpanded && current(capture())) { sourceExpanded = true; paint(); } },
        setSharedRecovery(value) {
            sharedRecovery = value;
            if (current(capture())) hideRecovery(recoveryHidden);
        },
        receiveAccess() { if (latest && current(capture())) paint(); },
        hasNativeConfiguration: () => nativeView()?.present === true,
        nativeConfigurationIntent: () => nativeView()?.intent ?? null,
        hasDraft: () => Boolean(safeDraft?.changed) || dirty() || nativeView()?.stale === true, isBusy: () => busy,
        hasUnconfirmedChange: () => uncertain || Boolean(pendingOperation) || checking,
        explain: id => current(capture()) ? explanations.get(id) || "" : "",
        canRefresh() {
            if (!current(capture())) return false;
            if (sourceCollection?.controlsActive && !sourceView().actions.github.includes("collect-now")) return false;
            const control = native();
            return (!control || control.enabled && control.retained && control.connected
                && collectionStatus.persistence(latest)?.actions.includes("collect-now") === true)
                && initialized && !busy && !uncertain && !readError && !stale && !dirty()
                && !nativeView()?.stale && !nativeView()?.needsRead;
        },
        unavailable(error, token) { if (!delivered(token)) return false; readError = error; paint(); return delivered(token); },
        setSection(section, setting) {
            if (visibleSection === section && visibleSetting === setting) return;
            const sectionChanged = visibleSection !== section;
            if (section !== "connection") { firstApprovalConfirmed = false; closePicker(); }
            visibleSection = section;
            visibleSetting = setting;
            if (sectionChanged && !busy && !uncertain && !$("settingsMessage").classList.contains("error")) message("");
            paint();
        },
        setChecking(value, token) { if (!delivered(token)) return false; if (checking !== value) { checking = value; paint(); } return delivered(token); } };
}
