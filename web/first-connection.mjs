export const firstConnectionMarkup = `
<section id="firstConnection" class="first-connection" aria-labelledby="firstConnectionTitle" hidden>
  <h2 id="firstConnectionTitle"></h2>
  <p id="firstConnectionMessage" role="status" aria-live="polite"></p>
  <div class="first-connection-actions"><button id="firstConnectionReview" type="button" class="primary">Review and connect</button><a id="firstConnectionStatus" class="text-link" href="#collection-status" data-settings-link>View collection status</a></div>
  <p id="firstConnectionStorageNotice" class="settings-help" hidden></p>
</section>
<p id="firstConnectionProgress" class="settings-help" role="status" hidden>More history is still being read. You can explore the activity already collected.</p>
<dialog id="firstConnectionWelcome" class="first-connection-welcome" aria-labelledby="firstConnectionWelcomeTitle" aria-describedby="firstConnectionWelcomeDescription">
  <div class="first-connection-heading"><h2 id="firstConnectionWelcomeTitle">Connect your Copilot history</h2><button id="closeFirstConnection" type="button" class="quiet icon-only" aria-label="Close welcome"></button></div>
  <p id="firstConnectionWelcomeDescription">WIRE needs local Copilot history to show Work IQ activity.</p>
  <div class="first-connection-actions"><button id="welcomeReviewSource" type="button" class="primary" autofocus>Review and connect</button><button id="dismissFirstConnection" type="button" class="quiet">Not now</button></div>
</dialog>`;

export const firstConnectionStyles = `
.first-connection {max-width:54rem;padding:28px 32px;background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius);margin-block:0 24px}
.first-connection h2 {display:flex;align-items:center;gap:10px;font-size:var(--type-section);line-height:var(--leading-section)}
.first-connection h2 .wire-icon {width:20px;height:20px;color:var(--muted);flex:none}
.first-connection>p {margin-top:12px}
.first-connection-actions {display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:20px}
.first-connection-actions a {display:inline-flex;align-items:center;min-height:44px}
.first-connection-welcome {width:min(560px,calc(100% - 32px));padding:24px;scroll-padding-top:24px}
.first-connection-heading {display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}
.first-connection-heading h2 {font-size:var(--type-dialog);line-height:var(--leading-dialog);padding-top:7px}
.first-connection-heading button {flex:none}
.first-connection-welcome>p {max-width:none}
#firstConnectionProgress {margin-block:0 20px}
#workspace[data-first-connection]>.page-heading {margin-bottom:24px}
#workspace[data-first-connection]>.page-heading>div:first-child {position:static!important;width:auto;height:auto;overflow:visible;clip-path:none;white-space:normal}
#workspace[data-first-connection] :is(#homeView,#activityView,#analyzeTools,#analyzeToolbar,#analyzePopulation,#appliedFilters,#filterChips,#filters,#periodResult,#periodHint,#periodCoverage,#coverage,#coverageNotice,#collectionNotice,#pagePrimaryActions,#viewingContext,#serviceEvidenceSummary,#serviceFocus,#sessionAnalysis) {display:none!important}
@media(max-width:600px) {
 .first-connection {padding:24px 20px}
 .first-connection-welcome {padding:20px}
 .first-connection-heading {gap:8px}
}
`;

// Presentation only: source review, approval and collection keep their existing owners.
export function mountFirstConnection({ api, ux, reviewSource, collectionStatus }) {
    const $ = id => document.getElementById(id);
    const dialog = $("firstConnectionWelcome"), panel = $("firstConnection");
    const preferenceKey = "workiq-evidence.connection-welcome.v1";
    let dismissed = false, presented = false, storageWarning = "", canReview = false;
    let publication = null, lastTitle = "", lastMessage = "";
    $("closeFirstConnection").append(ux.icon("close"));
    function current() {
        return publication !== null && api.isCurrent(publication) === true;
    }
    function clear(element) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) walker.currentNode.data = "";
        element.replaceChildren();
    }
    try {
        const saved = localStorage.getItem(preferenceKey);
        dismissed = saved !== null;
        if (saved !== null && saved !== "dismissed") storageWarning = "The welcome preference could not be read. You can connect below.";
    } catch {
        dismissed = true;
        storageWarning = "The welcome preference could not be read. You can connect below.";
    }
    function rememberDismissal() {
        dismissed = true;
        try { localStorage.setItem(preferenceKey, "dismissed"); }
        catch { storageWarning = "This browser could not save your choice. The welcome stays closed in this tab."; }
        $("firstConnectionStorageNotice").textContent = storageWarning;
        $("firstConnectionStorageNotice").hidden = !storageWarning;
    }
    function close(restore = false) {
        if (dialog.open) dialog.close();
        if (restore && current() && !panel.hidden) ux.restoreFocus($("firstConnectionReview"));
    }
    function dismiss() {
        if (!current()) return;
        rememberDismissal();
        close(true);
    }
    function review() {
        if (!current() || !canReview) return;
        rememberDismissal();
        close();
        reviewSource();
    }
    $("closeFirstConnection").addEventListener("click", dismiss);
    $("dismissFirstConnection").addEventListener("click", dismiss);
    $("welcomeReviewSource").addEventListener("click", review);
    $("firstConnectionReview").addEventListener("click", review);
    dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    window.addEventListener("storage", event => {
        if (event.key === preferenceKey && event.newValue === "dismissed") {
            dismissed = true;
            close();
        }
    });
    function hide() {
        panel.hidden = true;
        $("firstConnectionProgress").hidden = true;
        delete $("workspace").dataset.firstConnection;
        canReview = false;
        close();
    }
    return {
        update({ status, hasActivity, hasReports, analyze, enabled, stale, busy, snapshotCurrent, paused, canConfigure, allowWelcome }) {
            publication = api.publicationToken();
            if (!current() || !enabled || !analyze || stale || !status) { hide(); return; }
            const approved = status.config?.approved === true;
            const pending = approved && !paused && !status.error
                && ["collecting", "collecting-on-interval"].includes(status.state)
                && (!status.discovery || !status.lastCheckedAt || status.historyCoverage?.pending > 0);
            if (hasActivity) {
                hide();
                $("firstConnectionProgress").hidden = !pending;
                return;
            }
            let title, message, sourceAction = false, statusAction = true;
            let statusLabel = "View collection status", statusHref = "#collection-status";
            if (!approved) {
                if (paused || hasReports) { hide(); return; }
                title = "Not connected";
                message = "Connect your Copilot history to see your Work IQ activity.";
                sourceAction = true;
                statusAction = false;
            } else if (pending) {
                title = "Reading your Copilot history";
                message = "The first read may take a few minutes. Activity will appear here as it is collected.";
            } else if (paused || status.error || ["error", "stopped", "disconnected"].includes(status.state)) {
                const view = collectionStatus.page(status);
                title = paused ? "Collection is paused" : view.label;
                message = paused ? "Automatic collection is paused. Resume it in Settings when you want new activity." : status.error || view.guidance;
                if (paused) { statusLabel = "Open Settings"; statusHref = "#settings?section=connection&setting=collection-state"; }
            } else if (!snapshotCurrent) {
                title = "Loading your activity";
                message = "Reading the activity WIRE has saved.";
            } else if (status.historyCoverage?.eligible === 0) {
                title = "No eligible local chats found";
                message = "Review the source location if you expected to find Copilot chats here.";
                statusLabel = "Review source"; statusHref = "#settings?section=connection&setting=source";
            } else if (status.historyCoverage?.affected > 0) {
                title = "History is incomplete";
                message = "No Work IQ activity has been collected. Collection status explains the history gaps.";
            } else if (status.historyCoverage?.readable > 0 && status.lastCheckedAt) {
                title = "No Work IQ activity found";
                message = "No recorded Work IQ calls were found in the selected history. You can review the source and history window in Settings.";
                statusLabel = "Review source and history window"; statusHref = "#settings?section=connection&setting=source";
            } else {
                title = "History status unavailable";
                message = "Read the current collection status before checking for activity.";
            }
            panel.hidden = false;
            $("workspace").dataset.firstConnection = approved ? "collection" : "disconnected";
            $("firstConnectionProgress").hidden = true;
            if (lastTitle !== title) {
                clear($("firstConnectionTitle"));
                $("firstConnectionTitle").replaceChildren(...(!approved ? [ux.icon("connection")] : []), document.createTextNode(title));
                lastTitle = title;
            }
            if (lastMessage !== message) {
                clear($("firstConnectionMessage"));
                $("firstConnectionMessage").textContent = message;
                lastMessage = message;
            }
            canReview = sourceAction && canConfigure && !busy;
            $("firstConnectionReview").hidden = !sourceAction;
            $("firstConnectionReview").disabled = !canReview;
            $("welcomeReviewSource").disabled = !canReview;
            ux.explainDisabled($("firstConnectionReview"), busy
                ? "Finish the current activity update or Settings review before connecting."
                : "Read the current connection in Settings before reviewing the source.", { compact: true });
            if (!current()) { hide(); return; }
            $("firstConnectionStatus").hidden = !statusAction;
            $("firstConnectionStatus").textContent = statusLabel;
            $("firstConnectionStatus").href = statusHref;
            $("firstConnectionStorageNotice").textContent = storageWarning;
            $("firstConnectionStorageNotice").hidden = !storageWarning;
            if (approved || !canReview || !allowWelcome) close();
            else if (!dismissed && !presented && !document.querySelector("dialog[open]")) {
                presented = true;
                ux.hideTooltip();
                if (current()) dialog.showModal();
            }
        },
        withdrawAccess() {
            publication = null;
            hide();
            clear($("firstConnectionTitle"));
            clear($("firstConnectionMessage"));
            lastTitle = lastMessage = "";
        },
    };
}
