const day = 24 * 60 * 60 * 1000;
export const receiptKey = "wire.app-update.expected";
const sha = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const asset = value => typeof value === "string" && /^\/assets\/client\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js$/.test(value);
const phases = ["current", "available", "unknown", "checking", "preparing", "restarting", "error", "manual"];
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const manualOnly = state => state && (!state.supported || state.phase === "manual");
const checkingMessage = "Checking for updates";
const updatingMessage = "WIRE is updating";
const minManualCheckMs = 3000;
const validRelease = (release, commit) => release == null || release.commit === commit && sha(commit)
    && /^v\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(release.tag) && release.url === `https://github.com/likamrat/wire/releases/tag/${release.tag}`
    && typeof release.notes === "string" && release.notes.length <= 64000;
function decode(value) {
    if (!value || typeof value.supported !== "boolean" || typeof value.automatic !== "boolean"
        || !phases.includes(value.phase) || typeof value.message !== "string"
        || ![value.installed, value.candidate, value.dismissed].every(id => id === null || sha(id))
        || value.lastChecked !== null && (!Number.isFinite(value.lastChecked) || !Number.isFinite(new Date(value.lastChecked).getTime()))
        || value.nextAutoCheckAt !== undefined && (!Number.isSafeInteger(value.nextAutoCheckAt) || value.nextAutoCheckAt < 0)
        || value.retryAt !== undefined && (!Number.isSafeInteger(value.retryAt) || !Number.isFinite(new Date(value.retryAt).getTime()))
        || value.packageVersion !== undefined && typeof value.packageVersion !== "string"
        || value.statusRevision !== undefined && (!Number.isSafeInteger(value.statusRevision) || value.statusRevision < 0)
        || !validRelease(value.availableRelease,value.candidate) || !validRelease(value.installedRelease,value.installed)
        || value.refusal !== undefined && (!uuid(value.refusal?.operation) || typeof value.refusal.message !== "string")
        || value.clientEntry !== undefined && !asset(value.clientEntry)) throw new Error("WIRE returned an unreadable update status.");
    return value;
}

/** Page-owned controls never renew a capability or replay an update command. */
export function mountAppUpdate({ capability, blocked, loadedEntry, runtimeId, formatChecked, openNotes }) {
    const $ = id => document.getElementById(id);
    const dialog = $("appUpdateFence"), notice = $("appUpdateNotice"), manual = $("appUpdateCheck"), automatic = $("appUpdateAuto");
    const entry = new URL(loadedEntry);
    const fixed = { mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store" };
    let state, busy = false, expected, checkingRestart = false, allowReload = false, storageAvailable = true;
    let scheduleTimer, recoveryTimer, pendingPreference, restoring = false, feedback = "", result = "", success = "";
    let manualChecking = false, endCheckFeedback, openingStatusOnly = false, changingPreferences = false;
    let notesTag = null, notesText;
    let coordination = false, peerWatch, peerTimer, peerStatus;
    let panelVerified = false, unfinishedAtSuspension = false, restoredReceipt = false, lifetime = 0;
    let parked = false, presenceSequence = 0, checkingWake = false, wakeTimer;
    function receipt(value) {
        if (value) sessionStorage.setItem(receiptKey, JSON.stringify(value));
        else sessionStorage.removeItem(receiptKey);
        expected = value;
    }
    function render() {
        const available = state?.supported && state.phase === "available" && sha(state.candidate) && state.candidate !== state.installed;
        const shown = available && state.candidate !== state.dismissed;
        const offered = available ? state.availableRelease : null, installed = state?.installedRelease;
        for (const [id, release] of [["noticeReleaseNotes", shown && !success && !result && offered],["availableReleaseNotes",offered],["installedReleaseNotes",installed]]) {
            const link = $(id);
            link.hidden = !release;
            if (release) link.href = `/settings?section=release-notes&release=${release.tag}`;
            else link.removeAttribute("href");
        }
        if (notesTag !== null) {
            const record = [offered,installed].find(r=>r && r.tag===notesTag);
            $("releaseReaderVersion").textContent = record?.tag ?? "";
            $("releaseReaderStatus").textContent = record ? record === installed ? "Installed version" : "Available update"
                : !state || state.phase === "checking" ? "Reading release information…" : "These notes are not available for this installation.";
            const github = $("releaseReaderGitHub"); github.hidden = !record;
            if (record) github.href = record.url; else github.removeAttribute("href");
            const body = $("releaseNotesBody");
            if (notesText !== record?.notes) {
                body.replaceChildren(); notesText = record?.notes;
                let list;
                for (const line of (notesText ?? "").split(/\r?\n/)) {
                    if (!line.trim() || /^## What's new in v[\d.]+\s*$/i.test(line)) continue;
                    const bullet = /^[-*] (.+)/.exec(line), heading = /^#{1,6} (.+)/.exec(line);
                    if (!bullet) list = null;
                    if (bullet && !list) { list = document.createElement("ul"); body.append(list); }
                    const node = document.createElement(bullet ? "li" : heading ? "h3" : "p");
                    node.textContent = bullet?.[1] ?? heading?.[1] ?? line;
                    (list ?? body).append(node);
                }
            }
            $("releaseReaderApply").hidden = !record || record !== offered;
            $("releaseReaderApply").disabled = busy || Boolean(expected) || !panelVerified;
        }
        notice.toggleAttribute("data-install-result", Boolean(result));
        notice.inert = Boolean(expected) || !shown && !success && !result;
        if (!notice.inert) {
            notice.toggleAttribute("data-updated", Boolean(success));
            const heading = $("appUpdateHeading"), title = success || (result ? "Update not installed" : offered ? `WIRE ${offered.tag} is available` : "WIRE update available");
            if (heading.textContent !== title) heading.textContent = title;
            const detail = $("appUpdateDetail");
            const description = success ? "" : result || feedback || "Update and restart WIRE. Your saved data won’t change.";
            detail.hidden = !description;
            if (detail.textContent !== description) detail.textContent = description;
            $("appUpdateApply").hidden = !shown || Boolean(success);
        }
        $("settingsAppUpdate").hidden = !available;
        for (const id of ["appUpdateApply", "settingsAppUpdate"]) $(id).disabled = busy || Boolean(expected) || !panelVerified;
        $("appUpdateDismiss").disabled = busy || Boolean(expected);
        const updating = ["preparing", "restarting", "checking"].includes(state?.phase);
        const manualMode = Boolean(manualOnly(state));
        manual.hidden = manualMode || available;
        $("appUpdateGuide").hidden = !manualMode;
        $("appUpdateAutoRow").hidden = !state?.supported || manualMode;
        manual.disabled = busy || Boolean(expected) || updating || manualMode;
        automatic.disabled = manual.disabled || !state?.supported;
        automatic.checked = !manualMode && (pendingPreference ?? state?.automatic === true);
        const checking = feedback === checkingMessage || state?.phase === "checking";
        manual.setAttribute("aria-busy", String(manualChecking));
        manual.querySelector(".check-action-pending").hidden = !manualChecking;
        const status = feedback || (result ? `Update not installed. ${result}` : checking ? checkingMessage
            : offered ? `WIRE ${offered.tag} is available.` : available ? "Update available." : manualMode ? "" : state?.message ?? "Reading update status…");
        const lastCheck = available || checking || state?.lastChecked == null ? "" : `${state.phase === "error" ? "Last successful check" : "Last checked"} ${formatChecked(state.lastChecked)}.`;
        const retry = !feedback && state?.phase === "error" && state.retryAt ? `Earliest retry: ${formatChecked(state.retryAt, true)}.` : "";
        const summary = [status, retry, lastCheck].filter(Boolean).join(" "), line = $("appUpdateStatus");
        if (line.textContent !== summary) line.textContent = summary;
        line.hidden = !summary;
        $("appUpdateVersion").textContent = installed ? `WIRE ${installed.tag}` : state?.packageVersion ? `WIRE v${state.packageVersion}` : "WIRE";
    }
    async function post(action, fields = {}) {
        const response = await fetch("/api/app-update", { ...fixed, method: "POST",
            headers: { "Content-Type": "application/json", "X-Board-Capability": capability },
            body: JSON.stringify({ action, ...fields }), signal: AbortSignal.timeout(
                ["check", "auto-check"].includes(action) ? 100000 : action === "apply" ? 20000 : 15000) });
        const value = await response.json();
        if (!response.ok) {
            const error = new Error(typeof value.error === "string" ? value.error : value.message || "WIRE could not complete this update request.");
            error.refused = response.status >= 400 && response.status < 500;
            error.expired = response.status === 403 && value.code === "session_expired";
            throw error;
        }
        return decode(value);
    }
    function schedule() {
        clearTimeout(scheduleTimer);
        if (parked || !state?.supported || expected || manualOnly(state)) return;
        if (coordination) watchPeers();
        if (["checking", "preparing", "restarting"].includes(state.phase)) scheduleTimer = setTimeout(() => void run("status"), 2500);
        else if (state.automatic) {
            // Older launchers do not advertise a deadline and still check daily.
            const delay = state.nextAutoCheckAt === undefined ? day : Math.max(1000, Math.min(day, state.nextAutoCheckAt - Date.now()));
            scheduleTimer = setTimeout(() => void run("auto-check"), delay);
        }
    }
    async function readOpeningStatus(attempt = 0) {
        const generation = lifetime;
        await run("status", {}, true);
        if (generation !== lifetime || parked || expected) return;
        if (state?.supported && state.automatic) void run("auto-check");
        else if (!state && openingStatusOnly && attempt < 2) {
            // The host may have registered this document before its status reply was lost.
            // Retry only that read with the original capability, never an update command.
            scheduleTimer = setTimeout(() => void readOpeningStatus(attempt + 1), (attempt + 1) * 1000);
        }
    }
    function retryOpeningStatus() {
        if (openingStatusOnly && !state && !busy && !parked && !expected) void readOpeningStatus();
    }
    async function run(action, fields, opening = false) {
        if (parked || busy || expected || action === "auto-check" && (!state?.supported || !state.automatic || manualOnly(state))) return;
        const generation = lifetime;
        openingStatusOnly = opening;
        const returnFocus = action === "check" && document.activeElement === manual;
        const previousCandidate = state?.candidate;
        manualChecking = action === "check";
        changingPreferences = action === "preferences" || action === "dismiss";
        busy = true; feedback = ["check", "auto-check"].includes(action) ? checkingMessage : "";
        if (action === "preferences") { pendingPreference = fields.enabled; feedback = "Saving update preferences…"; }
        clearTimeout(scheduleTimer); render();
        const minimum = manualChecking && new Promise(resolve => {
            const timer = setTimeout(resolve, minManualCheckMs);
            endCheckFeedback = () => { clearTimeout(timer); resolve(); };
        });
        try {
            const next = await post(action, fields);
            if (minimum) await minimum;
            if (generation !== lifetime) return;
            openingStatusOnly = false;
            state = next;
            coordination ||= next.coordinated === true;
            panelVerified = true;
            success = "";
            if (!["auto-check", "status"].includes(action) || state.candidate !== previousCandidate) result = "";
        } catch (error) {
            if (minimum) await minimum;
            if (generation !== lifetime) return;
            // Navigation may cancel the opening fetch before pagehide runs. A
            // refused/unreadable response, unlike transport loss, remains unverified.
            openingStatusOnly &&= error instanceof TypeError || ["AbortError", "TimeoutError"].includes(error.name);
            // Reconcile preferences/dismissals by reading; never repeat a lost command.
            state = null;
            panelVerified = false;
            if (action !== "status") try {
                const next = await post("status");
                if (generation !== lifetime) return;
                state = next; panelVerified = true;
            } catch { /* No usable current status. */ }
            feedback = error.refused ? error.message : "Update status could not be confirmed. Check again when WIRE is available.";
        } finally {
            pendingPreference = undefined;
            endCheckFeedback = undefined; manualChecking = changingPreferences = false;
            if (feedback === checkingMessage || feedback === "Saving update preferences…") feedback = "";
            busy = false;
            if (restoring) { restoring = false; state = null; void run("status"); }
            else if (generation === lifetime) {
                showPeerStatus();
                render(); schedule();
                if (!expected && returnFocus && document.activeElement === document.body) {
                    const target = manual.hidden ? $("settingsAppUpdate") : manual;
                    if (target.checkVisibility() && !target.disabled) target.focus({ preventScroll: true });
                }
            }
        }
    }
    function fence(message, retry = false) {
        const heading = retry ? "Restart not confirmed" : message;
        const hint = retry ? message : "This tab reloads automatically.";
        if ($("appUpdateFenceTitle").textContent !== heading) $("appUpdateFenceTitle").textContent = heading;
        if ($("appUpdateHint").textContent !== hint) $("appUpdateHint").textContent = hint;
        $("appUpdateRecover").hidden = !retry;
        $("appUpdateActivity").hidden = retry;
        if (!dialog.open) dialog.showModal();
    }
    function reconnecting() {
        if (expected && dialog.open && $("appUpdateRecover").hidden) fence("Reconnecting to WIRE");
    }
    async function peerRequest(path, body, signal) {
        const response = await fetch("/api/app-update/" + path, { ...fixed, method: "POST", signal,
            headers: { "Content-Type": "application/json", "X-Board-Capability": capability }, body: JSON.stringify(body) });
        if (!response.ok) {
            const data = await response.json();
            throw Object.assign(new Error(typeof data.error === "string" ? data.error : "Update coordination is unavailable."), { status: response.status });
        }
        return response.json();
    }
    function readinessHold() {
        const hold = reason();
        if (hold) return hold.kind;
        return !storageAvailable || unfinishedAtSuspension || changingPreferences ? "operation" : "";
    }
    function showPeerStatus() {
        if (!peerStatus || busy) return;
        const next = peerStatus;
        peerStatus = undefined;
        if (!panelVerified || !state || expected || parked || next.installed !== state.installed
            || next.statusRevision <= (state.statusRevision ?? 0)) return;
        const changedPreference = next.automatic !== state.automatic;
        if (next.candidate !== state.candidate) success = result = feedback = "";
        state = next;
        render();
        if (changedPreference) schedule();
    }
    const presence = sequence => fetch("/api/app-update/presence", { ...fixed, method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json", "X-Board-Capability": capability },
        body: JSON.stringify({ runtimeId, sequence }), signal: AbortSignal.timeout(5000) });
    function onFreeze(event) {
        if (!event.isTrusted || parked || !document.hidden || !panelVerified || !coordination || busy || expected
            || !uuid(runtimeId) || !sha(state?.installed) || readinessHold()) return;
        parked = true;
        document.documentElement.inert = true;
        clearTimeout(scheduleTimer); clearTimeout(peerTimer); peerTimer = undefined;
        peerWatch?.abort();
        // The browser can suspend JS before delivery. Only receipt on the server
        // removes the blocker; on resume we rejoin even if this reply was lost.
        void presence(++presenceSequence).catch(() => { /* Delivery unknown: rejoin on wake in either case. */ });
    }
    async function onWake() {
        if (!parked || checkingWake) return;
        clearTimeout(wakeTimer); checkingWake = true;
        if (presenceSequence % 2) presenceSequence++;
        try {
            const response = await fetch("/health", { ...fixed, signal: AbortSignal.timeout(4000) });
            const health = response.ok && await response.json();
            if (health?.service !== "workiq-evidence" || health.protocol !== 1 || !uuid(health.runtimeId)
                || !sha(health.build) || !asset(health.clientEntry)) throw Error("Unverified runtime");
            if (health.updating) { fence(updatingMessage); return; }
            if (health.runtimeId !== runtimeId) {
                // This view slept through the offer. Load the current document at its
                // original address; it must not manufacture an Apply/success receipt.
                allowReload = true; location.reload(); return;
            }
            const joined = await presence(presenceSequence);
            if (joined.status === 403) { allowReload = true; location.reload(); return; }
            if (!joined.ok || (await joined.json()).state !== "ready") { fence(updatingMessage); return; }
            parked = false;
            document.documentElement.inert = false;
            if (dialog.open) dialog.close();
            await run("status");
        } catch {
            if (parked) fence("Reconnecting to WIRE");
        } finally {
            checkingWake = false;
            if (parked && !allowReload) wakeTimer = setTimeout(onWake, 1000);
        }
    }
    document.addEventListener("freeze", onFreeze, { capture: true });
    document.addEventListener("resume", onWake, { capture: true });
    document.addEventListener("resume", retryOpeningStatus);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) retryOpeningStatus(); });
    window.addEventListener("online", retryOpeningStatus);
    async function watchPeers() {
        if (parked || peerWatch || peerTimer || expected || !coordination || !panelVerified) return;
        const controller = new AbortController(), generation = lifetime;
        peerWatch = controller;
        let wait = 0;
        try {
            const statusRevision = peerStatus?.statusRevision ?? state?.statusRevision;
            const { candidate, operation, probe, status } = await peerRequest("watch",
                statusRevision === undefined ? {} : { statusRevision }, AbortSignal.any([controller.signal, AbortSignal.timeout(26000)]));
            if (status && !candidate && !probe && !expected && generation === lifetime && !controller.signal.aborted) {
                const next = decode(status);
                if (next.statusRevision > statusRevision && next.supported && next.installed === state?.installed) {
                    peerStatus = next;
                    showPeerStatus();
                }
                return;
            }
            if (uuid(probe) && !candidate && !expected && generation === lifetime && !controller.signal.aborted) {
                await peerRequest("readiness", { probe, hold: readinessHold() }, AbortSignal.timeout(5000));
                return;
            }
            if (!candidate || expected || generation !== lifetime || controller.signal.aborted) return;
            if (!sha(candidate) || !uuid(operation) || !sha(state?.installed) || !uuid(runtimeId) || entry.origin !== location.origin || !asset(entry.pathname)) return;
            let hold = readinessHold();
            if (!hold) {
                try { receipt({ candidate, previous: state.installed, runtimeId, origin: location.origin, peer: true, operation }); }
                catch { hold = "operation"; }
            }
            if (!hold) {
                clearTimeout(scheduleTimer); restoredReceipt = false;
                fence(updatingMessage); render();
                hold = readinessHold();
            }
            let acknowledgment;
            try { acknowledgment = await peerRequest("readiness", { operation, candidate, hold }, AbortSignal.timeout(5000)); }
            catch { if (expected) { await recover(); return; } throw new Error("Readiness was not confirmed."); }
            if (hold) {
                const message = typeof acknowledgment.message === "string" ? acknowledgment.message : "Finish the pending work before updating.";
                if (expected) finish(message);
                else { result = message; feedback = success = ""; render(); }
                wait = 1000; return;
            }
            await recover();
        } catch (error) {
            if (error.status === 403) coordination = false;
            wait = 1500;
        } finally {
            if (peerWatch === controller) peerWatch = null;
            if (!parked && !expected && generation === lifetime && coordination && !controller.signal.aborted) {
                peerTimer = setTimeout(() => { peerTimer = undefined; void watchPeers(); }, wait);
            }
        }
    }
    function finish(message, completed = false) {
        clearTimeout(recoveryTimer); receipt(null); allowReload = false;
        if (dialog.open) dialog.close();
        if (completed) { success = message; result = feedback = ""; }
        else { result = message; success = feedback = ""; }
        busy = false; render(); schedule();
    }
    // A replacement is verified in the fresh document, never by the old page that requested it.
    async function recover(attempt = 0, refusal = "", manualRead = false) {
        if (!expected || checkingRestart) return;
        const generation = lifetime, wanted = expected;
        checkingRestart = true; clearTimeout(recoveryTimer);
        if (restoredReceipt) fence("Checking version");
        else if (attempt === 0) fence(wanted.peer || state?.phase === "preparing" ? updatingMessage : "Checking update status");
        try {
            const response = await fetch("/health", { ...fixed, signal: AbortSignal.timeout(4000) });
            const health = response.ok && await response.json();
            const wire = health?.service === "workiq-evidence" && health.protocol === 1 && uuid(health.runtimeId)
                && sha(health.build) && asset(health.clientEntry) && wanted.origin === location.origin;
            if (wire && health.build === wanted.candidate && uuid(wanted.runtimeId) && health.runtimeId !== wanted.runtimeId) {
                if (restoredReceipt) {
                    if (runtimeId !== health.runtimeId || wanted.targetRuntime && wanted.targetRuntime !== health.runtimeId) {
                        fence("The runtime identity does not match this panel. Reopen WIRE at the same address to check the original update.", true); return;
                    }
                    if (entry.href !== location.origin + health.clientEntry || wanted.entry && wanted.entry !== health.clientEntry) {
                        fence("WIRE restarted, but this panel loaded a different browser build. Check the local build before reloading.", true); return;
                    }
                    let confirmed;
                    try { confirmed = await post("status"); }
                    catch {
                        fence("This panel could not verify the restart with its original permission. Reopen WIRE at the same address or check restart status.", true); return;
                    }
                    if (wanted !== expected || generation !== lifetime || !confirmed.supported || confirmed.installed !== wanted.candidate
                        || confirmed.clientEntry !== health.clientEntry || !["current", "available"].includes(confirmed.phase)) {
                        fence("Update status does not confirm the running build. Check restart status before continuing.", true); return;
                    }
                    state = confirmed; panelVerified = true; coordination ||= confirmed.coordinated === true;
                    finish(confirmed.installedRelease ? `WIRE updated to ${confirmed.installedRelease.tag}` : confirmed.packageVersion ? `WIRE updated to v${confirmed.packageVersion}` : "WIRE updated", true);
                    return;
                }
                const file = await fetch(health.clientEntry, { ...fixed, signal: AbortSignal.timeout(4000) });
                if (file.ok && /(?:java|ecma)script/i.test(file.headers.get("Content-Type") || "")) {
                    receipt({ ...wanted, entry: health.clientEntry, targetRuntime: health.runtimeId });
                    fence("Opening WIRE");
                    allowReload = true; location.reload(); return;
                }
            }
            // A failed handoff can restart the previous build with new page capabilities.
            // Read the replacement's status in a fresh panel; never treat rollback as success.
            if (!restoredReceipt && wire && health.build === wanted.previous && health.runtimeId !== wanted.runtimeId) {
                allowReload = true; location.reload(); return;
            }
            const next = await post("status");
            state = next;
            if (next.phase === "restarting") fence("Restarting WIRE");
            if (next.phase === "preparing") fence(updatingMessage);
            if (next.supported && wire && health.runtimeId === runtimeId && health.build === wanted.previous && next.installed === wanted.previous
                && (["error", "manual"].includes(next.phase) || (wanted.peer || refusal || manualRead) && !["preparing", "restarting"].includes(next.phase))) {
                const peerRefusal = wanted.peer && uuid(wanted.operation) && next.refusal?.operation === wanted.operation && next.refusal.message;
                finish(refusal || peerRefusal || ((manualRead || wanted.peer) && next.phase === "available" ? "WIRE is not updating. The selected build was not installed." : next.message));
                return;
            }
        } catch { reconnecting(); } // Keep checking health without renewing the old panel capability.
        finally { checkingRestart = false; }
        if (attempt < 45) recoveryTimer = setTimeout(() => void recover(attempt + 1, refusal), Math.min(5000, (attempt + 1) * 1000));
        else fence("The restart is not confirmed. Check the original update’s status; do not run Update again.", true);
    }
    function reason() {
        try { return blocked(); }
        catch { return { kind: "operation", message: "WIRE could not verify that this panel is ready. Resolve unfinished work before updating." }; }
    }
    async function apply() {
        if (busy || expected || !panelVerified || !state?.supported || state.phase !== "available" || !sha(state.candidate)) return;
        success = "";
        const candidate = state.candidate, hold = reason();
        if (hold || unfinishedAtSuspension) { result = hold?.message || "This panel had unfinished work when it was suspended. Resolve it before updating manually."; render(); return; }
        if (!uuid(runtimeId) || !sha(state.installed) || entry.origin !== location.origin || !asset(entry.pathname)) {
            result = "This panel cannot verify its installed build. Reopen WIRE at its original address before updating."; render(); return;
        }
        busy = true; feedback = result = ""; clearTimeout(scheduleTimer);
        try {
            if (!storageAvailable) throw new Error();
            restoredReceipt = false;
            receipt({ candidate, previous: state.installed, runtimeId, origin: location.origin });
        } catch {
            busy = false; result = "Allow session storage so WIRE can verify the restart. Nothing was started."; render(); schedule(); return;
        }
        fence(updatingMessage); render();
        // Opening a modal moves focus synchronously. Recheck after blur/change handlers have run.
        const lastMinute = reason();
        if (lastMinute) { finish(lastMinute.message); return; }
        try {
            state = await post("apply", { candidate });
            if (["manual", "error"].includes(state.phase) || state.phase === "available") { finish(state.message); return; }
        } catch (error) {
            if (error.expired) { state = null; finish("This panel’s update permission expired. Reopen WIRE. No update was started."); return; }
            if (error.refused) { await recover(0, error.message); return; }
        }
        await recover();
    }
    dialog.addEventListener("cancel", event => event.preventDefault());
    for (const type of ["click", "auxclick", "keydown", "pointerdown", "beforeinput", "input", "change", "paste", "drop", "submit"]) {
        window.addEventListener(type, event => {
            if (parked || expected && !dialog.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true);
    }
    window.addEventListener("beforeunload", event => { if (expected && !allowReload) { event.preventDefault(); event.returnValue = ""; } });
    // Capture before private owners withdraw and clear their in-memory state. Never
    // release an unfinished panel, a bfcache entry or a replacement runtime's grant.
    window.addEventListener("pagehide", event => {
        const opening = lifetime === 0 && openingStatusOnly && !panelVerified;
        lifetime++;
        peerStatus = undefined;
        endCheckFeedback?.();
        peerWatch?.abort(); clearTimeout(peerTimer); peerTimer = undefined;
        clearTimeout(scheduleTimer);
        const hold = reason();
        const unfinished = Boolean(changingPreferences || expected || hold);
        if (event.persisted) { unfinishedAtSuspension ||= unfinished; panelVerified = false; return; }
        if ((!opening && (!panelVerified || !state)) || !uuid(runtimeId) || !storageAvailable || unfinished || unfinishedAtSuspension) return;
        // A manual installation has no updater interlock to release.
        const releasePath = opening || state.supported ? "/api/app-update/release-panel" : "/api/session/release";
        void fetch(releasePath, {
            ...fixed, method: "POST", keepalive: true, body: JSON.stringify(opening ? { startingRuntime: runtimeId } : {}),
            headers: { "Content-Type": "application/json", "X-Board-Capability": capability },
        }).catch(() => {});
    }, true);
    window.addEventListener("pageshow", event => {
        if (event.persisted && parked) { void onWake(); return; }
        if (event.persisted && !expected) {
            state = null; render();
            if (busy) restoring = true;
            else void run("status");
        }
    });
    $("appUpdateApply").addEventListener("click", apply);
    $("settingsAppUpdate").addEventListener("click", apply);
    $("releaseReaderApply").addEventListener("click", apply);
    for (const id of ["noticeReleaseNotes","availableReleaseNotes","installedReleaseNotes"]) $(id).addEventListener("click", e => {
        if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        const record = id === "installedReleaseNotes" ? state?.installedRelease : state?.availableRelease;
        if (record && !expected) openNotes(record.tag);
    });
    $("appUpdateRecover").addEventListener("click", () => void recover(0, "", true));
    $("appUpdateDismiss").addEventListener("click", () => {
        if (success || result && state?.phase !== "available") {
            const focused = success && document.activeElement === $("appUpdateDismiss");
            success = result = ""; render();
            if (focused) {
                const target = !notice.inert ? $("appUpdateApply") : manual.checkVisibility() ? manual : $("pageTitle");
                (target.checkVisibility() ? target : $("main")).focus({ preventScroll: true });
            }
        }
        else if (state?.candidate) void run("dismiss", { candidate: state.candidate }).then(() => {
            if (notice.inert && document.activeElement === document.body) {
                ($("settingsAppUpdate").checkVisibility() ? $("settingsAppUpdate") : $("pageTitle")).focus({ preventScroll: true });
            }
        });
    });
    manual.addEventListener("click", () => {
        if (!busy && !state && openingStatusOnly) void readOpeningStatus();
        else void run(state?.supported ? "check" : "status");
    });
    automatic.addEventListener("change", () => void run("preferences", { enabled: automatic.checked }));
    try {
        const saved = sessionStorage.getItem(receiptKey);
        if (saved) {
            const data = JSON.parse(saved);
            if (!sha(data?.candidate) || !uuid(data.runtimeId) || !sha(data.previous) || data.origin !== location.origin) throw new Error();
            expected = data; restoredReceipt = true;
        }
    } catch { storageAvailable = false; }
    if (expected) void recover();
    else {
        if (dialog.open) dialog.close();
        void readOpeningStatus();
    }
    return {
        render,
        showNotes(tag) { notesTag = tag; if (tag !== null) render(); },
        reconnecting,
        locked: () => parked || Boolean(expected),
        beforeOwnerRetirement() { unfinishedAtSuspension ||= Boolean(reason()); },
    };
}
