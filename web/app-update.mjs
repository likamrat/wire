const day = 24 * 60 * 60 * 1000;
const receiptKey = "wire.app-update.expected";
const sha = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const asset = value => typeof value === "string" && /^\/assets\/client\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js$/.test(value);
const phases = ["current", "available", "unknown", "checking", "preparing", "restarting", "error", "manual"];
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const manualOnly = state => state && (!state.supported || state.phase === "manual");
function decode(value) {
    if (!value || typeof value.supported !== "boolean" || typeof value.automatic !== "boolean"
        || !phases.includes(value.phase) || typeof value.message !== "string"
        || ![value.installed, value.candidate, value.dismissed].every(id => id === null || sha(id))
        || value.lastChecked !== null && (!Number.isFinite(value.lastChecked) || !Number.isFinite(new Date(value.lastChecked).getTime()))
        || value.packageVersion !== undefined && typeof value.packageVersion !== "string"
        || value.clientEntry !== undefined && !asset(value.clientEntry)) throw new Error("WIRE returned an unreadable update status.");
    return value;
}

/** Page-owned controls never renew a capability or replay an update command. */
export function mountAppUpdate({ capability, blocked, loadedEntry, runtimeId, formatChecked }) {
    const $ = id => document.getElementById(id);
    const dialog = $("appUpdateFence"), notice = $("appUpdateNotice"), manual = $("appUpdateCheck"), automatic = $("appUpdateAuto");
    const entry = new URL(loadedEntry);
    const fixed = { mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store" };
    let state, busy = false, expected, checkingRestart = false, allowReload = false, storageAvailable = true;
    let scheduleTimer, recoveryTimer, pendingPreference, restoring = false, feedback = "", result = "", success = "";
    let panelVerified = false, unfinishedAtSuspension = false, restoredReceipt = false, lifetime = 0;
    function receipt(value) {
        if (value) sessionStorage.setItem(receiptKey, JSON.stringify(value));
        else sessionStorage.removeItem(receiptKey);
        expected = value;
    }
    function render() {
        const available = state?.supported && state.phase === "available" && sha(state.candidate) && state.candidate !== state.installed;
        const shown = available && state.candidate !== state.dismissed;
        notice.inert = !shown && !success && !result;
        if (!notice.inert) {
            $("appUpdateHeading").textContent = success ? "WIRE updated" : result ? "Update not installed" : "WIRE update available";
            const detail = $("appUpdateDetail");
            detail.textContent = success || result || feedback;
            detail.hidden = !detail.textContent;
            $("appUpdateApply").hidden = !shown || Boolean(result || success);
        }
        $("settingsAppUpdate").hidden = !available;
        for (const id of ["appUpdateApply", "settingsAppUpdate", "appUpdateDismiss"]) $(id).disabled = busy || Boolean(expected);
        const updating = ["preparing", "restarting", "checking"].includes(state?.phase);
        const manualMode = Boolean(manualOnly(state));
        manual.hidden = manualMode || available;
        $("appUpdateGuide").hidden = !manualMode;
        $("appUpdateAutoRow").hidden = !state?.supported || manualMode;
        manual.disabled = busy || Boolean(expected) || updating || manualMode;
        automatic.disabled = manual.disabled || !state?.supported;
        automatic.checked = !manualMode && (pendingPreference ?? state?.automatic === true);
        const status = feedback || result || (available ? "Update available." : manualMode ? "" : state?.message ?? "Reading update status…");
        const lastCheck = available || state?.lastChecked == null ? "" : `${state.phase === "error" ? "Last successful check" : "Last checked"} ${formatChecked(state.lastChecked)}.`;
        const summary = [status, lastCheck].filter(Boolean).join(" "), line = $("appUpdateStatus");
        if (line.textContent !== summary) line.textContent = summary;
        line.hidden = !summary;
        $("appUpdateVersion").textContent = state?.packageVersion ? `WIRE v${state.packageVersion}` : "WIRE";
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
        if (!state?.supported || expected || manualOnly(state)) return;
        if (["checking", "preparing", "restarting"].includes(state.phase)) scheduleTimer = setTimeout(() => void run("status"), 2500);
        else if (state.automatic) scheduleTimer = setTimeout(() => void run("auto-check"), day);
    }
    async function run(action, fields) {
        if (busy || expected || action === "auto-check" && (!state?.supported || !state.automatic || manualOnly(state))) return;
        const generation = lifetime;
        busy = true; feedback = ["check", "auto-check"].includes(action) ? "Checking for updates…" : "";
        if (action === "preferences") { pendingPreference = fields.enabled; feedback = "Saving update preferences…"; }
        clearTimeout(scheduleTimer); render();
        try {
            state = await post(action, fields);
            panelVerified = generation === lifetime;
            success = result = "";
        } catch (error) {
            // Reconcile preferences/dismissals by reading; never repeat a lost command.
            state = null;
            panelVerified = false;
            if (action !== "status") try { state = await post("status"); panelVerified = generation === lifetime; } catch { /* No usable current status. */ }
            feedback = error.refused ? error.message : "Update status could not be confirmed. Check again when WIRE is available.";
        } finally {
            pendingPreference = undefined;
            if (feedback === "Checking for updates…" || feedback === "Saving update preferences…") feedback = "";
            busy = false;
            if (restoring) { restoring = false; state = null; void run("status"); }
            else { render(); schedule(); }
        }
    }
    function fence(message, retry = false) {
        if ($("appUpdateProgress").textContent !== message) $("appUpdateProgress").textContent = message;
        $("appUpdateRecover").hidden = !retry;
        if (!dialog.open) { dialog.showModal(); $("appUpdateFenceTitle").focus(); }
    }
    function finish(message, completed = false) {
        clearTimeout(recoveryTimer); receipt(null); allowReload = false;
        if (dialog.open) dialog.close();
        if (completed) { success = message; result = feedback = ""; }
        else {
            feedback = message;
            result = state?.phase === "available" ? "" : message;
        }
        busy = false; render(); schedule();
    }
    // A replacement is verified in the fresh document, never by the old page that requested it.
    async function recover(attempt = 0, refusal = "", manualRead = false) {
        if (!expected || checkingRestart) return;
        const generation = lifetime, wanted = expected;
        checkingRestart = true; clearTimeout(recoveryTimer);
        fence(state?.phase === "preparing" ? "Preparing the selected build. Keep this panel open."
            : "Waiting for the updated WIRE build. The update will not be repeated.");
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
                    state = confirmed; panelVerified = true;
                    finish(confirmed.packageVersion ? `WIRE v${confirmed.packageVersion} is running.` : "Restart complete.", true);
                    return;
                }
                const file = await fetch(health.clientEntry, { ...fixed, signal: AbortSignal.timeout(4000) });
                if (file.ok && /(?:java|ecma)script/i.test(file.headers.get("Content-Type") || "")) {
                    receipt({ ...wanted, entry: health.clientEntry, targetRuntime: health.runtimeId });
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
            if (next.supported && wire && health.runtimeId === runtimeId && health.build === wanted.previous && next.installed === wanted.previous
                && (["error", "manual"].includes(next.phase) || (refusal || manualRead) && !["preparing", "restarting"].includes(next.phase))) {
                finish(refusal || (manualRead && next.phase === "available" ? "WIRE is not updating. The selected build was not installed." : next.message));
                return;
            }
        } catch { /* The old panel capability may be gone; use health without renewing it. */ }
        finally { checkingRestart = false; }
        if (attempt < 45) recoveryTimer = setTimeout(() => void recover(attempt + 1, refusal), Math.min(5000, (attempt + 1) * 1000));
        else fence("The restart is not confirmed. Check the original update’s status; do not run Update again.", true);
    }
    function reason() {
        try { return blocked(); }
        catch { return "WIRE could not verify that this panel is ready. Resolve unfinished work before updating."; }
    }
    async function apply() {
        if (busy || expected || !panelVerified || !state?.supported || state.phase !== "available" || !sha(state.candidate)) return;
        const candidate = state.candidate, hold = reason();
        if (hold || unfinishedAtSuspension) { feedback = hold || "This panel had unfinished work when it was suspended. Resolve it before updating manually."; render(); return; }
        if (!uuid(runtimeId) || !sha(state.installed) || entry.origin !== location.origin || !asset(entry.pathname)) {
            feedback = "This panel cannot verify its installed build. Reopen WIRE at its original address before updating."; render(); return;
        }
        busy = true; clearTimeout(scheduleTimer);
        try {
            if (!storageAvailable) throw new Error();
            restoredReceipt = false;
            receipt({ candidate, previous: state.installed, runtimeId, origin: location.origin });
        } catch {
            busy = false; feedback = "Allow session storage so WIRE can verify the restart. Nothing was started."; render(); schedule(); return;
        }
        fence("Preparing the update. Editing is paused until WIRE finishes."); render();
        // Opening a modal moves focus synchronously. Recheck after blur/change handlers have run.
        const lastMinute = reason();
        if (lastMinute) { finish(lastMinute); return; }
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
            if (expected && !dialog.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true);
    }
    window.addEventListener("beforeunload", event => { if (expected && !allowReload) { event.preventDefault(); event.returnValue = ""; } });
    // Capture before private owners withdraw and clear their in-memory state. Never
    // release an unfinished panel, a bfcache entry or a replacement runtime's grant.
    window.addEventListener("pagehide", event => {
        lifetime++;
        clearTimeout(scheduleTimer);
        const unfinished = Boolean(busy || expected || reason());
        if (event.persisted) { unfinishedAtSuspension ||= unfinished; panelVerified = false; return; }
        if (!panelVerified || !state || !uuid(runtimeId) || !storageAvailable || unfinished || unfinishedAtSuspension) return;
        // A manual installation has no updater interlock to release.
        const releasePath = state.supported ? "/api/app-update/release-panel" : "/api/session/release";
        void fetch(releasePath, {
            ...fixed, method: "POST", keepalive: true, body: "{}", headers: { "Content-Type": "application/json", "X-Board-Capability": capability },
        }).catch(() => {});
    }, true);
    window.addEventListener("pageshow", event => {
        if (event.persisted && !expected) {
            state = null; render();
            if (busy) restoring = true;
            else void run("status");
        }
    });
    $("appUpdateApply").addEventListener("click", apply);
    $("settingsAppUpdate").addEventListener("click", apply);
    $("appUpdateRecover").addEventListener("click", () => void recover(0, "", true));
    $("appUpdateDismiss").addEventListener("click", () => {
        if (success || result) { success = result = ""; render(); }
        else if (state?.candidate) void run("dismiss", { candidate: state.candidate }).then(() => {
            if (notice.inert && document.activeElement === document.body) {
                ($("settingsAppUpdate").checkVisibility() ? $("settingsAppUpdate") : $("pageTitle")).focus({ preventScroll: true });
            }
        });
    });
    manual.addEventListener("click", () => void run(state?.supported ? "check" : "status"));
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
    else void run("status").then(() => {
        if (state?.supported && state.automatic) void run("auto-check");
    });
    return {
        render,
        locked: () => Boolean(expected),
        beforeOwnerRetirement() { unfinishedAtSuspension ||= Boolean(reason()); },
    };
}
