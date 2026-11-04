import { searchFieldMarkup } from "./search-field.mjs";
import { sourceCollectionMarkup } from "./source-collection-settings.mjs";

export const settingsMarkup = `
<section id="settingsView" class="settings-view" aria-label="Settings" hidden>
  <p id="settingsRouteNotice" class="notice" role="status" hidden></p>
  <div class="settings-layout">
  <aside class="settings-rail" aria-label="Settings navigation">
  <div class="scoped-search settings-search">
    <label for="settingsSearch" class="visually-hidden">Search settings</label>
    ${searchFieldMarkup({ id: "settingsSearch", clearId: "clearSettingsSearch", placeholder: "Search settings" })}
    <p id="settingsSearchCount" class="search-count" role="status" hidden></p>
    <ul id="settingsSearchResults" class="settings-search-results" hidden></ul>
  </div>
  <details id="settingsCategories" class="settings-categories" open><summary id="settingsCategorySummary">Category: Connection &amp; updates</summary><nav id="settingsCategoryNav" aria-label="Settings categories"></nav></details>
  <p id="settingsStatusLink" class="settings-status-link"><a href="#collection-status" data-settings-link>Collection status</a></p>
  </aside>
  <div class="settings-content">
  <p id="settingsMessage" class="notice" role="status" tabindex="-1" hidden></p>
  <p id="settingsConnectionError" class="notice error" role="alert" hidden></p>
  <button id="reloadSettings" type="button" hidden>Read current connection</button>
  <section class="settings-section" data-settings-section="privacy" aria-labelledby="dataManagementTitle" hidden>
    <h2 id="dataManagementTitle" tabindex="-1">Privacy &amp; saved data</h2>
    <section id="assessmentSetupTitle" class="settings-reply-row" aria-label="Recorded replies" tabindex="-1">
      <h3 class="settings-reply-fallback">Save Copilot replies locally</h3>
      <div id="assessmentSetup"><p>Loading response-saving settings.</p></div>
    </section>
    <div class="settings-task-row"><div class="settings-row-copy">
    <h3>Collected activity</h3>
    <p id="deleteActivityHelp">Permanent local deletion. Copilot chats and saved reports stay.</p>
    </div>
    <button id="deleteActivity" type="button" class="danger" aria-describedby="deleteActivityHelp">Review deletion</button>
    </div>
    <div class="settings-task-row"><div class="settings-row-copy">
    <h3>Read history again</h3>
    <p id="recollectActivityHelp">Missing history, deleted replies and past annotations aren't restored.</p>
    <p id="recollectionUpdateStatus" role="status" aria-live="polite" hidden></p>
    </div><button id="recollectActivity" type="button" aria-describedby="recollectActivityHelp">Choose chats</button></div>
    <div class="settings-task-row"><div class="settings-row-copy"><h3>Saved reports</h3></div><a class="button-link" href="#reports" data-settings-link>Open saved reports</a></div>
  </section>
  <section class="settings-section" data-settings-section="display" aria-labelledby="displayTitle" hidden>
    <h2 id="displayTitle" tabindex="-1">Display</h2>
    <div class="settings-task-row settings-theme-row"><div class="settings-row-copy">
      <h3>Theme</h3>
    </div><button id="settingsThemePreference" type="button" class="theme-trigger" aria-label="Use dark theme" aria-describedby="themeStorageNotice">Change theme</button></div>
    <div class="settings-field settings-display-field display-time-field">
      <div class="settings-row-copy"><h3><label for="displayTimeZone">Time zone</label></h3></div>
      <select id="displayTimeZone" aria-describedby="displayTimeEffective displayTimeHelp timeZoneNotice"></select>
      <p id="displayTimeHelp" class="settings-help" hidden></p>
      <p id="displayTimeEffective" class="settings-help" role="status" hidden></p>
    </div>
  </section>
  <div id="collectionForm">
    <section class="settings-section" data-settings-section="connection" aria-labelledby="connectionTitle">
      <h2 id="connectionTitle" tabindex="-1">Connection &amp; updates</h2>
      <section id="connectionSource" class="settings-group" aria-labelledby="connectionSourceTitle">
      <div class="settings-group-heading"><h3 id="connectionSourceTitle">GitHub Copilot app</h3><div class="settings-source-state"><span id="connectionStatus" class="connection-status">Checking connection</span></div></div>
      <p id="connectionSourceHelp" class="settings-help" hidden></p>
      <div id="approvedConnection" hidden>
        <div class="settings-actions"><span id="sourceEditAction"><button id="editSource" type="button">Review source</button></span><button id="pauseCollection" type="button" disabled>Pause collection</button><button id="collectNow" type="button" class="quiet" hidden disabled>Refresh</button><a id="viewApprovedSource" href="#settings?section=connection&setting=source-paths" data-settings-link hidden>View source</a></div>
      </div>
      <div id="unapprovedConnection" hidden>
        <p>Collect original prompts and activity from local chats.</p>
        <button id="reviewSource" type="button" class="primary">Review source &amp; connect</button>
      </div>
      <div id="approvedSourceDetails" class="source-paths-read" hidden>
        <h4 id="approvedSourceTitle" tabindex="-1">Approved source paths</h4>
        <dl class="settings-paths"><dt>Copilot metadata database</dt><dd id="approvedDatabase"></dd><dt>Chat history folder</dt><dd id="approvedSessions"></dd></dl>
      </div>
      <div id="sourceEditor" class="source-editor" hidden>
        <h4 id="sourceEditorTitle" class="visually-hidden">Review this source</h4>
        <p id="sourceChangeImpact" class="settings-help" role="status"></p>
        <p id="sourceSuggestion" class="settings-help" hidden></p>
        <div class="settings-field"><label for="sourceDatabase">Copilot metadata database</label><input id="sourceDatabase" type="text" autocomplete="off" spellcheck="false" aria-describedby="approvalScope settingsMessage"></div>
        <div class="settings-field"><label for="sourceSessions">Chat history folder</label><input id="sourceSessions" type="text" autocomplete="off" spellcheck="false" aria-describedby="approvalScope settingsMessage"></div>
        <div id="sourcePreferenceSlot"></div>
        <p id="approvalScope"></p>
        <div id="sourceDraftStatusSlot"></div>
        <div class="settings-actions"><button id="connectCollection" type="button" class="primary">Approve source and start collection</button><button id="cancelSource" type="button" class="quiet">Cancel</button></div>
      </div>
      </section>
      <div id="microsoftConnectionHost" hidden></div>
      <section id="connectionPreferences" class="settings-group" aria-labelledby="preferencesTitle">
      <h3 id="preferencesTitle" class="settings-subheading" tabindex="-1">History and frequency</h3>
      <p id="preferencesHelp" class="settings-help" hidden></p>
      <div id="collectionPreferenceFields" class="settings-preferences">
        <div id="nativeCollectionSourceField" class="settings-field" hidden><label for="nativeCollectionSurfaces">Microsoft sources</label><select id="nativeCollectionSurfaces" disabled></select></div>
        <div class="settings-field"><label for="collectionWindow">History to include</label><select id="collectionWindow"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></div>
        <div class="settings-field"><label for="collectionCadence">Check frequency</label><select id="collectionCadence"><option value="5" selected>Every 5 seconds</option><option value="15">Every 15 seconds</option><option value="30">Every 30 seconds</option><option value="60">Every 60 seconds</option></select></div>
      </div>
      <div id="preferenceActions" class="settings-actions"><button id="saveCollection" type="button" class="primary" disabled>Save preferences</button><button id="cancelPreferences" type="button" class="quiet" disabled>Cancel changes</button></div>
      <p id="settingsDraftStatus" class="settings-help" role="status"></p>
      </section>
      ${sourceCollectionMarkup}
    </section>
  </div>
  <section class="settings-section" data-settings-section="troubleshooting" aria-labelledby="troubleshootingTitle" hidden>
    <h2 id="troubleshootingTitle" tabindex="-1">Troubleshooting</h2>
    <section class="settings-group" aria-labelledby="historyHelpTitle">
      <div class="settings-task-row"><div class="settings-row-copy"><h3 id="historyHelpTitle">Missing history</h3></div><a class="button-link" href="#collection-status" data-settings-link>Open collection status</a></div>
    </section>
    <div class="settings-task-row"><div class="settings-row-copy"><h3>HTTP recorder</h3></div><a class="button-link" href="#collection-status?setting=network-diagnostic" data-settings-link>View diagnostic</a></div>
    <details id="serviceProvenanceHelp" class="settings-advanced"><summary>How services are identified</summary><p>Services come from recorded tool targets, not prompts or citations. Finding a service does not prove it ran.</p><a href="#analyze" data-settings-link>Open Activity in Analyze</a></details>
    <details id="authorProvenanceHelp" class="settings-advanced"><summary>How prompt authors are identified</summary><p>The author comes from the recorded sender, not the message wording or who ran a tool.</p><a href="#analyze" data-settings-link>Open Activity in Analyze</a></details>
    <details id="settingsSearchDetails" class="settings-advanced"><summary>Missing search results</summary><p>Search matches text in saved activity and reports. Missing history may leave results out. Refresh the stored view, then try again.</p></details>
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
    <div class="collection-status-actions"><a id="collectionSourceLink" href="#settings?section=connection&setting=source-paths" data-settings-link>Source &amp; permission</a><a id="collectionHistoryLink" href="#settings?section=connection&setting=history-window" data-settings-link>History and frequency</a><a href="#settings?section=troubleshooting" data-settings-link>Troubleshooting</a><a href="#analyze" data-settings-link>Go to Analyze</a></div>
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
export function mountCollectionSettings({ api, ux, write, read, invalidate, onDraftChange, collectionStatus, createNativeConfigurationState, sourceCollection }) {
    if (typeof api?.publicationToken !== "function" || typeof api?.isCurrent !== "function") {
        throw new TypeError("Collection Settings requires the shared publication interface.");
    }
    const $ = id => document.getElementById(id);
    const fields = ["sourceDatabase", "sourceSessions", "collectionWindow", "collectionCadence"];
    const nativeConfiguration = typeof createNativeConfigurationState === "function" ? createNativeConfigurationState() : null;
    const nativeView = () => nativeConfiguration?.view(api.accessState?.().state);
    const sourceView = () => sourceCollection?.controlsActive ? sourceCollection.view(api.accessState()) : null;
    const legacyWindows = [...$("collectionWindow").options].map(option => option.cloneNode(true));
    let nativeWindows = false, nativeGesture = null;
    const explanations = new Map();
    let latest, baseline, initialized = false, editing = false, busy = false, stale = false, uncertain = false, readError = "", pendingAction = "", checking = false, visibleSection, visibleSetting;
    let sharedRecovery = false, recoveryHidden = true;
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
            windowDays: Number($("collectionWindow").value), pollSeconds: Number($("collectionCadence").value) };
    }
    function sourceValues(status) {
        const source = status?.config || status?.suggestedSource;
        return { appDbPath: source?.appDbPath || "", sessionRoot: source?.sessionRoot || "",
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
    function reset() {
        baseline = latest;
        if (native()) {
            nativeConfiguration?.cancel(); syncNativeValues();
            initialized = true; editing = false; stale = false;
            return;
        }
        windowOptions(false);
        const next = sourceValues(latest);
        for (const [id, key] of [["sourceDatabase", "appDbPath"], ["sourceSessions", "sessionRoot"], ["collectionWindow", "windowDays"], ["collectionCadence", "pollSeconds"]]) $(id).value = String(next[key]);
        $("sourceDatabase").classList.remove("settings-target");
        initialized = true; editing = false; stale = false;
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
        for (const id of ["unapprovedConnection", "approvedSourceDetails", "sourceEditAction", "sourceEditor",
            "connectionPreferences", "preferenceActions", "collectNow", "viewApprovedSource"]) $(id).hidden = true;
        $("approvedConnection").hidden = false;
        $("pauseCollection").hidden = false;
        for (const id of fields.concat(["collectNow", "editSource", "reviewSource", "connectCollection", "saveCollection", "cancelPreferences", "cancelSource"])) $(id).disabled = true;
        for (const id of ["approvedDatabase", "approvedSessions", "sourceChangeImpact",
            "sourceSuggestion", "approvalScope", "settingsDraftStatus"]) setText(id, "");
        setText("connectionSourceTitle", "Microsoft 365 activity");
        setText("connectionSourceHelp", "");
        $("connectionSourceHelp").hidden = true;
        setText("connectionStatus", readError ? "Last known: " + state.label : state.label);
        setText("pauseCollection", control.enabled ? "Pause Microsoft reads" : "Resume Microsoft reads");
        $("pauseCollection").disabled = working || uncertain || Boolean(readError) || !control.retained || !allowed;
        setText("settingsConnectionError", readError ? "Microsoft settings could not be read." : "");
        $("settingsConnectionError").hidden = !readError || visibleSection !== "connection";
        hideRecovery(!uncertain && (!readError || visibleSection !== "connection"));
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
        if (control) { paintNative(control); return; }
        $("nativeCollectionSourceField").hidden = true;
        $("nativeCollectionSurfaces").disabled = true;
        $("collectionCadence").closest(".settings-field").hidden = false;
        $("pauseCollection").hidden = sourceCollection?.copilotOnly && sources?.status?.global.paused === true;
        setText("preferencesTitle", sourceCollection?.active ? "GitHub history and frequency" : "History and frequency");
        setText("preferencesHelp", latest?.config?.approved && values().windowDays < baseline?.config?.windowDays ? "Saved activity is kept." : "");
        $("preferencesHelp").hidden = !$("preferencesHelp").textContent;
        setText("saveCollection", "Save preferences");
        const approved = latest?.config?.approved === true, changed = dirty(), working = busy || checking;
        setText("connectionSourceTitle", "GitHub Copilot app");
        setText("connectionSourceHelp", "");
        $("connectionSourceHelp").hidden = true;
        const inspectingSource = visibleSection === "connection" && ["source", "source-paths"].includes(visibleSetting);
        const sourceChanged = JSON.stringify([values().appDbPath, values().sessionRoot]) !== JSON.stringify([baseline?.config?.appDbPath, baseline?.config?.sessionRoot]);
        $("approvedConnection").hidden = !approved;
        $("unapprovedConnection").hidden = approved || editing;
        $("approvedSourceDetails").hidden = !approved || editing || !inspectingSource;
        $("sourceEditAction").hidden = editing;
        $("sourceEditor").hidden = !editing;
        $("connectionPreferences").hidden = editing || sourceCollection?.active && !approved;
        const preferenceHome = editing ? $("sourcePreferenceSlot") : $("connectionPreferences");
        if ($("collectionPreferenceFields").parentElement !== preferenceHome) {
            if (editing) preferenceHome.append($("collectionPreferenceFields"));
            else $("preferenceActions").before($("collectionPreferenceFields"));
        }
        const draftHome = editing ? $("sourceDraftStatusSlot") : $("connectionPreferences");
        if ($("settingsDraftStatus").parentElement !== draftHome) draftHome.append($("settingsDraftStatus"));
        const connectionState = !latest ? "Checking connection" : !approved ? "Not connected" : latest.error ? "Connection issue"
            : !latest.config.enabled || sourceCollection?.copilotOnly && sources?.status?.global.paused ? "Paused"
            : latest.connected ? "Collection on" : "Checking connection";
        setText("connectionStatus", readError ? latest ? `Last known: ${connectionState}` : "Status unavailable" : connectionState);
        setText("settingsConnectionError", readError ? "Collection settings could not be read." : "");
        $("settingsConnectionError").hidden = !readError || visibleSection !== "connection";
        setText("approvedDatabase", latest?.config?.appDbPath || "");
        setText("approvedSessions", latest?.config?.sessionRoot || "");
        setText("sourceEditorTitle", approved ? "Change source paths" : "Review this source");
        setText("sourceChangeImpact", approved
            ? stale ? "Source settings changed. Cancel edits to reload."
                : uncertain ? "Source change unconfirmed."
                : pendingAction === "/api/collection/configure" ? "Saving source..."
                : ""
            : "");
        $("sourceChangeImpact").hidden = !$("sourceChangeImpact").textContent;
        setText("sourceSuggestion", !approved && latest?.suggestedSource?.error ? latest.suggestedSource.error : "");
        $("sourceSuggestion").hidden = !$("sourceSuggestion").textContent;
        setText("approvalScope", approved && !sourceChanged ? ""
            : "Read these paths and save original prompts on this device." + (approved && !latest.config.enabled ? " Collection stays paused." : ""));
        $("approvalScope").hidden = !$("approvalScope").textContent;
        setText("connectCollection", approved ? sourceChanged ? "Approve and switch source" : "Save preferences" : "Approve source and start collection");
        $("connectCollection").dataset.intent = approved && !sourceChanged ? "save-preferences" : "approve-source";
        setText("pauseCollection", latest?.config?.enabled ? "Pause collection" : "Resume collection");
        for (const id of fields) $(id).disabled = working || !initialized;
        for (const id of ["collectNow", "pauseCollection", "editSource"]) $(id).disabled = !approved || working || uncertain || readError || stale || changed || editing;
        $("reviewSource").disabled = !latest || working || uncertain || Boolean(readError);
        $("connectCollection").disabled = !editing || working || uncertain || readError || stale || !values().appDbPath || !values().sessionRoot || (approved && !changed);
        $("saveCollection").disabled = !approved || !changed || editing || working || uncertain || readError || stale;
        if (sources) {
            for (const id of ["reviewSource", "editSource", "connectCollection", "saveCollection"]) {
                $(id).disabled ||= !sources.actions.github.includes("configure");
            }
            $("pauseCollection").disabled ||= !sources.actions.github.includes("set-interval");
            $("collectNow").disabled ||= !sources.actions.github.includes("collect-now");
        }
        $("preferenceActions").hidden = !approved || editing;
        $("cancelPreferences").disabled = (!changed && !stale) || working;
        $("cancelSource").disabled = working;
        hideRecovery(!uncertain && (!readError || visibleSection !== "connection"));
        $("reloadSettings").disabled = working;
        const progress = revokedWrite && busy ? "Earlier change pending."
            : busy && !["/api/collection/now", "/api/collection/status"].includes(pendingAction) ? "Saving..." : "Checking...";
        const blocked = working ? progress
            : uncertain || readError ? "Read current settings."
            : stale ? "Cancel edits to reload."
            : editing ? "Finish source edits first."
            : changed ? "Save or cancel your changes."
            : "Approve a source first.";
        for (const id of ["editSource", "pauseCollection", "collectNow", "reviewSource", "connectCollection",
            "cancelSource", "saveCollection", "cancelPreferences", "reloadSettings"]) {
            const control = $(id);
            let reason = blocked;
            if (control.disabled) {
                if (id === "reviewSource" && !latest) reason = "Loading settings.";
                else if (id === "cancelSource") reason = progress;
                else if (id === "cancelPreferences") reason = busy ? progress : "";
                else if (!busy && !uncertain && !readError && !stale && id === "connectCollection") reason = !values().appDbPath || !values().sessionRoot
                    ? "Enter both source paths."
                    : "";
                else if (!busy && !uncertain && !readError && !stale && id === "saveCollection" && !changed) reason = "";
            }
            if (id !== "collectNow") {
                ux.tooltip(control, control.disabled ? reason : "");
                ux.explainDisabled(control, control.disabled ? reason : "", { compact: true });
            }
            explanations.set(id, control.disabled ? reason : "");
        }
        explanations.set("sourceDatabase", working || uncertain || readError || stale ? blocked
            : "");
        setText("settingsDraftStatus", stale ? editing ? "" : "Settings changed. Cancel edits to reload."
            : busy ? editing ? "" : progress
            : checking ? ""
            : uncertain ? editing ? "" : "Change unconfirmed."
            : changed && approved ? "Unsaved changes." : "");
        $("settingsDraftStatus").hidden = !$("settingsDraftStatus").textContent;
        ux.pending($("settingsDraftStatus"), working && !checking && !editing);
        ux.pending($("sourceChangeImpact"), busy && pendingAction === "/api/collection/configure");
        onDraftChange(Boolean(safeDraft?.changed) || changed || editing);
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
            initialized = true; editing = false; stale = false;
        }
        else if (safeDraft) {
            const saved = safeDraft;
            reset();
            if (saved.changed) {
                $("collectionWindow").value = saved.window;
                $("collectionCadence").value = saved.cadence;
            }
            safeDraft = null;
        } else if (!initialized || (!dirty() && !editing && !busy && !uncertain)) reset();
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
        reset();
        message(uncertain ? "Earlier change unconfirmed. Read current connection." : "");
        paint();
        if (!current(stamp)) return;
        let target = document.querySelector('[data-settings-section="connection"]:not([hidden])')
            ? $(nativeView()?.present ? "nativeCollectionSurfaces" : latest?.config?.approved ? "editSource" : "reviewSource")
            : document.querySelector("[data-settings-section]:not([hidden]) h2");
        ux.restoreFocus(target?.disabled ? target.closest(".ux-disabled-help") : target);
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
            if (operation.dispatched) uncertain = true;
            if (!current(stamp)) { revokedWrite ||= operation.dispatched; return; }
            const detail = error.reason === "runtime_unavailable" ? "WIRE is not responding."
                : error.reason === "invalid_response" ? "The response could not be read."
                : error.reason === "wire_access_stale" ? "WIRE access changed." : error.message;
            message(detail + (operation.dispatched ? " Change unconfirmed." : " Change not started."), true);
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
    function configure(reviewingSource) {
        if (!current(capture()) || !initialized || busy || stale || uncertain) return;
        if (reviewingSource ? $("connectCollection").disabled : $("saveCollection").disabled) return;
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
        const sourceApproval = reviewingSource && (baseline?.config?.approved !== true
            || next.appDbPath !== baseline.config.appDbPath || next.sessionRoot !== baseline.config.sessionRoot);
        if (!sourceApproval && (next.appDbPath !== baseline.config.appDbPath || next.sessionRoot !== baseline.config.sessionRoot)) {
            message("Changed source paths require fresh approval. Review the source before connecting.", true); return;
        }
        act("/api/collection/configure", { ...next, approved: true, enabled: baseline.config?.enabled ?? true, ...guard() },
            sourceApproval ? "Source approved." : "Preferences saved.");
    }
    $("collectionForm").addEventListener("submit", event => event.preventDefault());
    for (const id of [...fields, "nativeCollectionSurfaces"]) $(id).addEventListener("input", () => {
        if (!current(capture())) return;
        if (native() && nativeView()?.present && ["nativeCollectionSurfaces", "collectionWindow"].includes(id)) {
            nativeConfiguration.edit({ surfaces: $("nativeCollectionSurfaces").value.split(",").filter(Boolean),
                windowDays: Number($("collectionWindow").value) });
        }
        message(""); paint();
    });
    for (const id of ["reviewSource", "editSource"]) $(id).addEventListener("click", () => {
        const stamp = capture();
        if (!current(stamp) || $(id).disabled || editing) return;
        $("approvedSourceTitle").classList.remove("settings-target");
        editing = true; message(""); paint();
        if (current(stamp)) $("sourceDatabase").focus();
    });
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
    function withdrawAccess() {
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
        sharedRecovery = false; recoveryHidden = true;
        nativeConfiguration?.withdraw();
        $("nativeCollectionSurfaces").value = "";
        // A dispatched change stays uncertain; withdrawal is not proof of cancellation.
        uncertain ||= pendingOperation?.kind === "write" && pendingOperation.dispatched;
        revokedWrite ||= uncertain;
        if (pendingOperation?.kind !== "write" || !pendingOperation.dispatched) {
            pendingOperation = null; busy = false; pendingAction = "";
        }
        latest = baseline = null; readError = ""; initialized = false; editing = false; stale = false; checking = false;
        explanations.clear();
        for (const id of ["sourceDatabase", "sourceSessions"]) {
            $(id).value = "";
            clearAttribute($(id), "value"); clearAttribute($(id), "title");
        }
        for (const id of ["approvedDatabase", "approvedSessions", "settingsMessage", "settingsConnectionError",
            "sourceChangeImpact", "sourceSuggestion", "approvalScope", "settingsDraftStatus", "connectionStatus",
            "connectionSourceTitle", "connectionSourceHelp", "pauseCollection"]) {
            clearText($(id)); $(id).replaceChildren();
        }
        for (const id of ["approvedConnection", "unapprovedConnection", "approvedSourceDetails", "sourceEditor",
            "settingsMessage", "settingsConnectionError", "sourceChangeImpact", "sourceSuggestion", "approvalScope",
            "settingsDraftStatus", "reloadSettings"]) $(id).hidden = true;
        for (const id of [...fields, "nativeCollectionSurfaces", "collectNow", "pauseCollection", "editSource", "reviewSource", "connectCollection",
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
    return { receive, withdrawAccess, resumeAccess,
        setSharedRecovery(value) {
            sharedRecovery = value;
            if (current(capture())) hideRecovery(recoveryHidden);
        },
        receiveAccess() { if (latest && current(capture())) paint(); },
        hasNativeConfiguration: () => nativeView()?.present === true,
        nativeConfigurationIntent: () => nativeView()?.intent ?? null,
        hasDraft: () => Boolean(safeDraft?.changed) || dirty() || editing || nativeView()?.stale === true, isBusy: () => busy,
        explain: id => current(capture()) ? explanations.get(id) || "" : "",
        canRefresh() {
            if (!current(capture())) return false;
            if (sourceCollection?.controlsActive && !sourceView().actions.github.includes("collect-now")) return false;
            const control = native();
            return (!control || control.enabled && control.retained && control.connected
                && collectionStatus.persistence(latest)?.actions.includes("collect-now") === true)
                && initialized && !busy && !uncertain && !readError && !stale && !dirty() && !editing
                && !nativeView()?.stale && !nativeView()?.needsRead;
        },
        unavailable(error, token) { if (!delivered(token)) return false; readError = error; paint(); return delivered(token); },
        setSection(section, setting) {
            if (visibleSection === section && visibleSetting === setting) return;
            const sectionChanged = visibleSection !== section;
            visibleSection = section;
            visibleSetting = setting;
            if (sectionChanged && !busy && !uncertain && !$("settingsMessage").classList.contains("error")) message("");
            paint();
        },
        setChecking(value, token) { if (!delivered(token)) return false; if (checking !== value) { checking = value; paint(); } return delivered(token); } };
}
