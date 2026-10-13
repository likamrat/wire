export const settingsMarkup = `
<section id="settingsView" class="settings-view" aria-label="Settings" hidden>
  <p id="settingsRouteNotice" class="notice" role="status" hidden></p>
  <div class="settings-layout">
  <aside class="settings-rail" aria-label="Settings navigation">
  <div class="scoped-search settings-search">
    <label for="settingsSearch" class="visually-hidden">Search settings</label>
    <div class="search-input-row"><input id="settingsSearch" type="search" placeholder="Search settings" autocomplete="off" spellcheck="false"><button id="clearSettingsSearch" type="button" class="quiet" hidden>Clear</button></div>
    <p id="settingsSearchCount" class="search-count" role="status" hidden></p>
    <ul id="settingsSearchResults" class="settings-search-results" hidden></ul>
  </div>
  <details id="settingsCategories" class="settings-categories" open><summary id="settingsCategorySummary">Category: Connection &amp; updates</summary><nav id="settingsCategoryNav" aria-label="Settings categories"></nav></details>
  <p class="settings-status-link"><a href="#collection-status" data-settings-link>Collection status</a></p>
  </aside>
  <div class="settings-content">
  <p id="settingsMessage" class="notice" role="status" tabindex="-1" hidden></p>
  <button id="reloadSettings" type="button" hidden>Read current connection</button>
  <section class="settings-section" data-settings-section="privacy" aria-labelledby="dataManagementTitle" hidden>
    <h2 id="dataManagementTitle" tabindex="-1">Privacy &amp; saved data</h2>
    <section class="settings-reply-row" aria-labelledby="assessmentSetupTitle">
      <h3 id="assessmentSetupTitle" tabindex="-1">Recorded replies</h3>
      <div id="assessmentSetup"><p>Loading response-saving settings.</p></div>
    </section>
    <div class="settings-task-row"><div class="settings-row-copy">
    <h3>Delete collected activity</h3>
    <p id="deleteActivityHelp">Permanently remove all collected activity or a date range after preview. Copilot sources and saved reports stay unchanged.</p>
    </div>
    <button id="deleteActivity" type="button" class="danger" aria-describedby="deleteActivityHelp">Delete collected activity</button>
    </div>
    <div class="settings-task-row"><div class="settings-row-copy">
    <h3>Recollect activity</h3>
    <p id="recollectActivityHelp">Restore available activity from approved Copilot chats only after preview and confirmation. Missing source history cannot be recovered.</p>
    </div><button id="recollectActivity" type="button" aria-describedby="recollectActivityHelp">Recollect from approved sources</button></div>
    <a href="#reports" data-settings-link>Open saved reports</a>
  </section>
  <section class="settings-section" data-settings-section="ai" aria-labelledby="aiReviewsTitle" hidden>
    <h2 id="aiReviewsTitle" tabindex="-1">AI reviews</h2>
    <div id="automaticScoreSetup"></div>
    <p class="settings-help">Sending evidence to GitHub Copilot requires separate approval and an AI-credit budget. Charges can exceed the soft limit.</p>
  </section>
  <section class="settings-section" data-settings-section="display" aria-labelledby="displayTitle" hidden>
    <h2 id="displayTitle" tabindex="-1">Display</h2>
    <div class="settings-task-row settings-theme-row"><div class="settings-row-copy">
      <h3>Theme</h3>
    </div><button id="settingsThemePreference" type="button" aria-describedby="themeStorageNotice">Change theme</button></div>
    <div class="settings-field display-time-field">
      <h3><label for="displayTimeZone">Time zone</label></h3>
      <select id="displayTimeZone" aria-describedby="displayTimeEffective displayTimeHelp timeZoneNotice"></select>
      <p id="displayTimeHelp" class="settings-help" hidden></p>
      <p id="displayTimeEffective" class="settings-help" role="status" hidden></p>
    </div>
  </section>
  <div id="collectionForm">
    <section class="settings-section" data-settings-section="connection" aria-labelledby="connectionTitle">
      <h2 id="connectionTitle" tabindex="-1">Connection &amp; updates</h2>
      <section id="connectionSource" class="settings-group" aria-labelledby="connectionSourceTitle">
      <div class="settings-group-heading"><h3 id="connectionSourceTitle">Source</h3><span id="connectionStatus" class="connection-status">Checking connection</span></div>
      <div id="approvedConnection" hidden>
        <p><strong>Local Copilot chats</strong> <span id="connectionApproval" class="approved-label">Approved</span></p>
        <div class="settings-actions"><a id="viewApprovedSource" class="button-link quiet" href="#settings?section=connection&setting=source-paths" data-settings-link>View source</a><button id="pauseCollection" type="button" disabled>Pause collection</button><button id="collectNow" type="button" class="quiet" hidden disabled>Refresh</button></div>
      </div>
      <div id="unapprovedConnection" hidden>
        <p>Collect local Copilot activity, including original prompts. Review the source paths before connecting.</p>
        <button id="reviewSource" type="button" class="primary">Review source &amp; connect</button>
      </div>
      <div id="approvedSourceDetails" class="source-paths-read" hidden>
        <h4 id="approvedSourceTitle" tabindex="-1">Approved source paths</h4>
        <dl class="settings-paths"><dt>Copilot metadata database</dt><dd id="approvedDatabase"></dd><dt>Chat history folder</dt><dd id="approvedSessions"></dd></dl>
        <div class="settings-actions"><span id="sourceEditAction"><button id="editSource" type="button">Change source</button></span></div>
      </div>
      <div id="sourceEditor" class="source-editor" hidden>
        <h4 id="sourceEditorTitle">Review this source</h4>
        <p id="sourceChangeImpact" class="settings-help"></p>
        <p id="sourceSuggestion" class="settings-help" hidden></p>
        <div class="settings-field"><label for="sourceDatabase">Copilot metadata database</label><input id="sourceDatabase" type="text" autocomplete="off" spellcheck="false" aria-describedby="approvalScope settingsMessage"></div>
        <div class="settings-field"><label for="sourceSessions">Chat history folder</label><input id="sourceSessions" type="text" autocomplete="off" spellcheck="false" aria-describedby="approvalScope settingsMessage"></div>
        <p id="approvalScope"></p>
        <a href="#settings?section=connection&setting=history-window" data-settings-link class="text-link">Review history and frequency</a>
        <div class="settings-actions"><button id="connectCollection" type="button" class="primary">Approve source and start collection</button><button id="cancelSource" type="button" class="quiet">Cancel</button></div>
      </div>
      </section>
      <section id="connectionPreferences" class="settings-group" aria-labelledby="preferencesTitle">
      <h3 id="preferencesTitle" class="settings-subheading" tabindex="-1">History and frequency</h3>
      <div class="settings-preferences">
        <div class="settings-field"><label for="collectionWindow">Initial history window</label><select id="collectionWindow"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></div>
        <div class="settings-field"><label for="collectionCadence">Check frequency</label><select id="collectionCadence"><option value="5" selected>Every 5 seconds</option><option value="15">Every 15 seconds</option><option value="30">Every 30 seconds</option><option value="60">Every 60 seconds</option></select></div>
      </div>
      <div id="preferenceActions" class="settings-actions"><button id="saveCollection" type="button" class="primary" disabled>Save preferences</button><button id="cancelPreferences" type="button" class="quiet" disabled>Cancel changes</button></div>
      <p id="settingsDraftStatus" class="settings-help" role="status"></p>
      <a id="returnToSourceReview" href="#settings?section=connection&setting=source" data-settings-link class="text-link" hidden>Return to source review</a>
      </section>
    </section>
  </div>
  <section class="settings-section" data-settings-section="troubleshooting" aria-labelledby="troubleshootingTitle" hidden>
    <h2 id="troubleshootingTitle" tabindex="-1">Troubleshooting</h2>
    <section class="settings-group" aria-labelledby="historyHelpTitle">
      <div class="settings-task-row"><div class="settings-row-copy"><h3 id="historyHelpTitle">History gaps</h3></div><a class="button-link" href="#collection-status?setting=issues" data-settings-link>Review chat history</a></div>
      <div class="collection-status-actions"><a href="#collection-status?setting=collection-details" data-settings-link>Collection technical details</a><a href="#collection-status?setting=network-diagnostic" data-settings-link>Optional network diagnostic</a></div>
    </section>
    <details id="serviceProvenanceHelp" class="settings-advanced"><summary>Service details</summary><p>Services come from recorded targets, not prompts or citations. Discovery does not prove a service ran.</p><a href="#analyze?mode=calls" data-settings-link>Open Calls in Analyze</a></details>
    <details id="authorProvenanceHelp" class="settings-advanced"><summary>Prompt authors</summary><p>The prompt author comes from sender metadata, not message wording or who executed a tool.</p><a href="#analyze?mode=interactions" data-settings-link>Open interactions in Analyze</a></details>
    <details id="settingsSearchDetails" class="settings-advanced"><summary>Search troubleshooting</summary><p>For missing search model files, run <code>npm run search:model:provision</code> from the WIRE source folder. Corrupt files require repair first. Word search remains available.</p></details>
  </section>
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
    <div class="collection-status-actions"><a id="collectionSourceLink" href="#settings?section=connection&setting=source-paths" data-settings-link>Source &amp; permission</a><a href="#settings?section=connection&setting=history-window" data-settings-link>History and frequency</a><a href="#settings?section=troubleshooting" data-settings-link>Troubleshooting</a><a href="#analyze" data-settings-link>Go to Analyze</a></div>
  </div>
  <section id="collectionIssues" class="collection-issues settings-section" aria-labelledby="collectionIssuesTitle">
    <h2 id="collectionIssuesTitle" tabindex="-1">Chat history</h2>
    <p id="collectionIssueLabel"></p>
    <div id="collectionIssuesBody" class="collection-issues-body">
      <p id="collectionIssueCounts" class="muted"></p><p id="collectionIssueImpact"></p>
      <div class="scoped-search"><label for="issueSearch">Find a chat with gaps</label><div class="search-input-row"><input id="issueSearch" type="search" placeholder="Search" autocomplete="off" spellcheck="false" aria-describedby="issueSearchHelp"><button id="clearIssueSearch" type="button" class="quiet" hidden>Clear</button></div><p id="issueSearchHelp" class="settings-help">Search all affected chat names, projects, IDs and reasons. No prompts or source paths.</p><p id="issueSearchCount" class="search-count" role="status"></p></div>
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
    <p id="recorderPurpose">Test the HTTP recorder, not collection. This sends one public request to Microsoft Graph and saves its diagnostic result locally. It is not needed to collect your Copilot history.</p>
    <p id="recorderEffect" class="settings-help">GET graph.microsoft.com/v1.0/$metadata. No sign-in, credentials, response body logging or automatic retries. This cannot verify Work IQ, access to your workplace data or collection health.</p>
    <button id="recordBtn" type="button" aria-describedby="recorderPurpose recorderEffect recorderStatus" disabled>Test HTTP recorder</button>
    <p id="recorderStatus" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">Open this section to read the last saved diagnostic. No request is sent until you confirm.</p>
    <p id="recorderEvidence" class="settings-help" hidden></p>
    <p id="recorderStorageWarning" class="notice error" role="status" hidden></p>
    <a id="recorderResultLink" class="text-link" href="#home?layer=http" hidden>View HTTP recorder evidence</a>
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
export function mountCollectionSettings({ ux, write, read, invalidate, onDraftChange }) {
    const $ = id => document.getElementById(id);
    const fields = ["sourceDatabase", "sourceSessions", "collectionWindow", "collectionCadence"];
    const explanations = new Map();
    let latest, baseline, initialized = false, editing = false, busy = false, stale = false, uncertain = false, pendingAction = "", checking = false, visibleSection, visibleSetting;
    function version(status) { return status?.configVersion ?? JSON.stringify(status?.config ?? null); }
    function values() {
        return { appDbPath: $("sourceDatabase").value.trim(), sessionRoot: $("sourceSessions").value.trim(),
            windowDays: Number($("collectionWindow").value), pollSeconds: Number($("collectionCadence").value) };
    }
    function sourceValues(status) {
        const source = status?.config || status?.suggestedSource;
        return { appDbPath: source?.appDbPath || "", sessionRoot: source?.sessionRoot || "",
            windowDays: source?.windowDays ?? 30, pollSeconds: source?.pollSeconds ?? 5 };
    }
    function dirty() { return initialized && JSON.stringify(values()) !== JSON.stringify(sourceValues(baseline)); }
    function setText(id, text) { if ($(id).textContent !== text) $(id).textContent = text; }
    function message(text, error = false, origin = visibleSection) {
        if (!error && !uncertain && origin !== visibleSection) text = "";
        setText("settingsMessage", text);
        $("settingsMessage").className = "notice" + (error ? " error" : "");
        $("settingsMessage").setAttribute("role", error ? "alert" : "status");
        $("settingsMessage").hidden = !text;
    }
    function reset() {
        baseline = latest;
        const next = sourceValues(latest);
        for (const [id, key] of [["sourceDatabase", "appDbPath"], ["sourceSessions", "sessionRoot"], ["collectionWindow", "windowDays"], ["collectionCadence", "pollSeconds"]]) $(id).value = String(next[key]);
        $("sourceDatabase").classList.remove("settings-target");
        initialized = true; editing = false; stale = false;
    }
    function paint() {
        const approved = latest?.config?.approved === true, changed = dirty(), working = busy || checking;
        const inspectingSource = visibleSection === "connection" && ["source", "source-paths"].includes(visibleSetting);
        const sourceChanged = JSON.stringify([values().appDbPath, values().sessionRoot]) !== JSON.stringify([baseline?.config?.appDbPath, baseline?.config?.sessionRoot]);
        $("approvedConnection").hidden = !approved;
        $("unapprovedConnection").hidden = approved || editing;
        $("approvedSourceDetails").hidden = !approved || editing || !inspectingSource;
        $("viewApprovedSource").hidden = editing || inspectingSource;
        $("sourceEditAction").hidden = editing;
        $("sourceEditor").hidden = !editing;
        $("returnToSourceReview").hidden = !editing;
        setText("connectionStatus", !latest ? "Checking connection" : !approved ? "Not connected" : latest.error ? "Connection issue"
            : !latest.config.enabled ? "Paused" : latest.connected ? "Collection on" : "Checking connection");
        setText("approvedDatabase", latest?.config?.appDbPath || "");
        setText("approvedSessions", latest?.config?.sessionRoot || "");
        setText("sourceEditorTitle", approved ? "Change source paths" : "Review this source");
        setText("sourceChangeImpact", approved
            ? stale ? "Your draft is kept, but the approved connection changed in another panel. Cancel to load its current paths before approving."
                : uncertain ? "This draft is not confirmed. Read the current connection before trying again; no action is replayed."
                : pendingAction === "/api/collection/configure" ? "Validating and saving this draft. The source is replaced only if validation succeeds."
                : `${sourceChanged ? "Unsaved paths" : "Paths unchanged"}; your approved source stays in use until you approve a replacement. A validated replacement ${latest.config.enabled ? "starts collecting immediately" : "stays paused"}.`
            : "Review both paths and Collection preferences before granting permission.");
        setText("sourceSuggestion", !approved && latest?.suggestedSource?.error ? latest.suggestedSource.error : "Suggested local paths are not permission to read them.");
        $("sourceSuggestion").hidden = approved;
        setText("approvalScope", `Approve reading metadata and mapped logs at these paths, keeping original prompts locally, and ${approved && !latest.config.enabled ? "saving the source while collection stays paused" : "collecting while this app's runtime runs"}. Initial window: ${values().windowDays} days; event check: ${values().pollSeconds} seconds.`);
        setText("connectCollection", approved ? "Approve and switch source" : "Approve source and start collection");
        setText("pauseCollection", latest?.config?.enabled ? "Pause collection" : "Resume collection");
        for (const id of fields) $(id).disabled = working;
        for (const id of ["collectNow", "pauseCollection", "editSource"]) $(id).disabled = !approved || working || uncertain || stale || changed || editing;
        $("reviewSource").disabled = !latest || working || uncertain;
        $("connectCollection").disabled = !editing || working || uncertain || stale || !values().appDbPath || !values().sessionRoot || (approved && !sourceChanged);
        $("saveCollection").disabled = !approved || !changed || editing || working || uncertain || stale;
        $("preferenceActions").hidden = !approved || editing;
        $("cancelPreferences").disabled = (!changed && !stale) || working;
        $("cancelSource").disabled = working;
        $("reloadSettings").hidden = !uncertain;
        $("reloadSettings").disabled = working;
        const progress = checking || pendingAction === "/api/collection/now" ? "A local check is in progress; wait for it to finish."
            : pendingAction === "/api/collection/status" ? "Wait while the current connection is read."
            : "Wait while the collection settings are saved.";
        const blocked = working ? progress
            : uncertain ? "Read the current connection before trying another change."
            : stale ? "Cancel your edits to load the connection changed in another panel."
            : editing ? "Approve or cancel the source edits before using this action."
            : changed ? "Save or cancel your preference changes first."
            : "Review and approve a local source first.";
        const help = {
            editSource: "Open the source editor without changing the approved source.",
            pauseCollection: latest?.config?.enabled
                ? "Pause future local collection without removing retained evidence."
                : "Resume local collection from the previously approved source.",
            collectNow: "Refresh recorded activity without changing source approval or the pause state.",
            reviewSource: "Open the local source paths for review before granting permission.",
            connectCollection: !approved ? "Approve these local paths and start collection with the chosen preferences."
                : latest.config.enabled ? "Validate and approve these paths, then collect from the replacement source."
                : "Validate and approve these paths while keeping collection paused.",
            cancelSource: "Discard these source edits without changing the current connection.",
            saveCollection: "Save history and cadence preferences, keeping the approved source and pause state.",
            cancelPreferences: "Discard preference edits and load the current connection settings.",
            reloadSettings: "Read the current connection without replaying the previous action.",
        };
        for (const [id, consequence] of Object.entries(help)) {
            const control = $(id);
            let reason = blocked;
            if (control.disabled) {
                if (id === "reviewSource" && !latest) reason = "Wait for the current connection to load.";
                else if (id === "cancelSource") reason = progress;
                else if (id === "cancelPreferences") reason = busy ? progress : "There are no preference changes to cancel.";
                else if (!busy && !uncertain && !stale && id === "connectCollection") reason = !values().appDbPath || !values().sessionRoot
                    ? "Enter both local source paths before approving."
                    : "Change a source path before approving a replacement.";
                else if (!busy && !uncertain && !stale && id === "saveCollection" && !changed) reason = "Change a preference before saving.";
            }
            if (id !== "collectNow") {
                ux.tooltip(control, control.disabled ? reason : consequence);
                ux.explainDisabled(control, reason, { compact: true });
            }
            explanations.set(id, control.disabled ? "Unavailable: " + reason : consequence);
        }
        setText("settingsDraftStatus", stale ? "Connection settings changed in another panel. Your edits are kept. Cancel changes to load the current connection before saving."
            : working ? progress
            : editing ? "Nothing changes until you approve this source. Cancel discards these edits."
            : changed ? approved ? "Unsaved preferences. Save applies only to the approved source and keeps its active or paused state." : "Preferences are not saved until you review and approve a source."
            : approved ? "" : "Review and approve a source to use these preferences.");
        $("settingsDraftStatus").hidden = !$("settingsDraftStatus").textContent;
        ux.pending($("settingsDraftStatus"), working);
        ux.pending($("sourceChangeImpact"), busy && pendingAction === "/api/collection/configure");
        onDraftChange(changed || editing);
    }
    function receive(status) {
        latest = status;
        if (!initialized || (!dirty() && !editing && !busy && !uncertain)) reset();
        else if (version(status) !== version(baseline)) stale = true;
        paint();
    }
    function cancel() {
        if (busy) return;
        const changed = dirty(), sourceEdits = editing;
        reset();
        message(uncertain ? "Read the current connection before another write. The previous response was not confirmed."
            : !changed ? "" : sourceEdits ? "Source edits discarded. Your approved source is unchanged."
                : "Preference edits discarded. Saved collection settings are unchanged.");
        paint();
        let target = document.querySelector('[data-settings-section="connection"]:not([hidden])')
            ? $(latest?.config?.approved ? "editSource" : "reviewSource")
            : document.querySelector("[data-settings-section]:not([hidden]) h2");
        if (target === $("editSource") && !target.checkVisibility()) target = $("viewApprovedSource");
        ux.restoreFocus(target?.disabled ? target.closest(".ux-disabled-help") : target);
    }
    async function act(endpoint, input, success) {
        if (busy || uncertain || stale) return;
        const origin = visibleSection;
        busy = true; pendingAction = endpoint; message(""); invalidate(); paint();
        try {
            latest = await write(endpoint, input);
            reset();
            message(typeof success === "function" ? success(latest) : success, false, origin);
        } catch (error) {
            uncertain = true;
            message(error.message + " No success is assumed. Read the current connection before trying again.", true);
        } finally {
            busy = false; pendingAction = ""; paint();
            $("settingsMessage").focus({ preventScroll: true });
        }
    }
    function guard() {
        return latest?.configVersion !== undefined ? { expectedConfigVersion: baseline.configVersion } : {};
    }
    function configure(sourceApproval) {
        if (!initialized || busy || stale || uncertain) return;
        if (sourceApproval ? $("connectCollection").disabled : $("saveCollection").disabled) return;
        const next = values();
        if (!sourceApproval && (next.appDbPath !== baseline.config.appDbPath || next.sessionRoot !== baseline.config.sessionRoot)) {
            message("Changed source paths require fresh approval. Review the source before connecting.", true); return;
        }
        act("/api/collection/configure", { ...next, approved: true, enabled: baseline.config?.enabled ?? true, ...guard() },
            sourceApproval ? "Source approved. " + (baseline.config?.enabled === false ? "Collection remains paused." : "Collection is enabled.") : "Preferences saved. The approved source and collection state are unchanged.");
    }
    $("collectionForm").addEventListener("submit", event => event.preventDefault());
    for (const id of fields) $(id).addEventListener("input", () => { message(""); paint(); });
    for (const id of ["reviewSource", "editSource"]) $(id).addEventListener("click", () => {
        if ($(id).disabled || editing) return;
        $("approvedSourceTitle").classList.remove("settings-target");
        editing = true; message(""); paint(); $("sourceDatabase").focus();
    });
    $("cancelSource").addEventListener("click", cancel);
    $("cancelPreferences").addEventListener("click", cancel);
    $("connectCollection").addEventListener("click", () => configure(true));
    $("saveCollection").addEventListener("click", () => configure(false));
    $("pauseCollection").addEventListener("click", () => {
        if ($("pauseCollection").disabled) return;
        act("/api/collection/enabled", { enabled: !latest.config.enabled, ...guard() }, latest.config.enabled ? "Collection paused. Retained evidence is still available." : "Collection resumed for the approved source.");
    });
    $("collectNow").addEventListener("click", () => {
        if (!$("collectNow").disabled) $("checkActivity").click();
    });
    $("reloadSettings").addEventListener("click", async () => {
        if (busy) return;
        const origin = visibleSection;
        busy = true; pendingAction = "/api/collection/status"; paint();
        try {
            const status = await read();
            uncertain = false; receive(status);
            message(stale ? "Current connection read. Your earlier edits have not been reapplied. Cancel changes to review the current settings." : "Current connection read. Review your changes before trying again.", false, origin);
        } catch (error) { message("The connection could not be read. " + error.message, true); }
        finally { busy = false; pendingAction = ""; paint(); }
    });
    window.addEventListener("beforeunload", event => {
        if (!dirty() && !busy) return;
        event.preventDefault(); event.returnValue = "";
    });
    return { receive, hasDraft: () => dirty() || editing, isBusy: () => busy, explain: id => explanations.get(id) || "",
        canRefresh: () => !busy && !uncertain && !stale && !dirty() && !editing,
        setSection(section, setting) {
            if (visibleSection === section && visibleSetting === setting) return;
            const sectionChanged = visibleSection !== section;
            visibleSection = section;
            visibleSetting = setting;
            if (sectionChanged && !busy && !uncertain && !$("settingsMessage").classList.contains("error")) message("");
            paint();
        },
        setChecking(value) { if (checking !== value) { checking = value; paint(); } } };
}
