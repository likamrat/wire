const day = 24 * 60 * 60 * 1000;
const receiptKey = "wire.app-update.expected";
const sha = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const asset = value => typeof value === "string" && /^\/assets\/client\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js$/.test(value);
const phases = ["current", "available", "unknown", "checking", "preparing", "restarting", "error", "manual"];
function decode(value) {
    if (!value || typeof value.supported !== "boolean" || typeof value.automatic !== "boolean"
        || !phases.includes(value.phase) || typeof value.message !== "string"
        || ![value.installed, value.candidate, value.dismissed].every(id => id === null || sha(id))
        || value.lastChecked !== null && !Number.isFinite(value.lastChecked)
        || value.clientEntry !== undefined && !asset(value.clientEntry)) throw new Error("WIRE returned an unreadable update status.");
    return value;
}

/** Page-owned controls never renew a capability or replay an update command. */
export function mountAppUpdate({ capability, blocked, loadedEntry, runtimeId }) {
    const $ = id => document.getElementById(id);
    const dialog = $("appUpdateFence"), notice = $("appUpdateNotice"), manual = $("appUpdateCheck"), automatic = $("appUpdateAuto");
    const entry = new URL(loadedEntry);
    const fixed = { mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store" };
    let state, busy = false, expected, checkingRestart = false, allowReload = false, storageAvailable = true;
    let scheduleTimer, recoveryTimer, pendingPreference, restoring = false, feedback = "", result = "", success = "", managed = false;
    function receipt(value) {
        if (value) sessionStorage.setItem(receiptKey, JSON.stringify(value));
        else sessionStorage.removeItem(receiptKey);
        expected = value;
    }
    function render() {
        const available = state?.supported && state.phase === "available" && sha(state.candidate) && state.candidate !== state.installed;
        const shown = available && state.candidate !== state.dismissed;
        notice.hidden = !shown && !success && !result;
        $("appUpdateHeading").textContent = success ? "WIRE updated" : result ? "Update not installed" : "WIRE update available";
        $("appUpdateDetail").textContent = success || result || feedback || "Update and restart WIRE. Your reports and settings stay here.";
        $("appUpdateApply").hidden = !shown || Boolean(result || success);
        // Keep a dismissed build actionable in Settings without duplicating the notice's Update button.
        $("settingsAppUpdate").hidden = !available || shown && !result;
        for (const id of ["appUpdateApply", "settingsAppUpdate", "appUpdateDismiss"]) $(id).disabled = busy || Boolean(expected);
        const updating = ["preparing", "restarting", "checking"].includes(state?.phase);
        manual.disabled = busy || Boolean(expected) || updating || state?.supported === false;
        automatic.disabled = busy || Boolean(expected) || updating || !state?.supported;
        automatic.checked = pendingPreference ?? state?.automatic === true;
        $("appUpdateStatus").textContent = feedback || success || result || state?.message || "Reading update status…";
        const version = [state?.installed && `Installed ${state.installed.slice(0, 8)}`,
            state?.lastChecked != null && `Last checked ${new Date(state.lastChecked).toLocaleString()}`].filter(Boolean).join(" · ");
        $("appUpdateVersion").textContent = version;
        $("appUpdateVersion").hidden = !version;
    }
    async function post(action, fields = {}) {
        const response = await fetch("/api/app-update", { ...fixed, method: "POST",
            headers: { "Content-Type": "application/json", "X-Board-Capability": capability },
            body: JSON.stringify({ action, ...fields }), signal: AbortSignal.timeout(action === "apply" ? 20000 : 15000) });
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
        if (!state?.supported || expected) return;
        if (["checking", "preparing", "restarting"].includes(state.phase)) scheduleTimer = setTimeout(() => void run("status"), 2500);
        else if (state.automatic) scheduleTimer = setTimeout(() => void run("auto-check"), day);
    }
    async function run(action, fields) {
        if (busy || expected || action === "auto-check" && (!state?.supported || !state.automatic)) return;
        busy = true; feedback = ["check", "auto-check"].includes(action) ? "Checking for WIRE updates…" : "";
        if (action === "preferences") { pendingPreference = fields.enabled; feedback = "Saving update preferences…"; }
        clearTimeout(scheduleTimer); render();
        try {
            state = await post(action, fields);
            managed = state.supported;
            success = result = "";
        } catch (error) {
            // Reconcile preferences/dismissals by reading; never repeat a lost command.
            state = null;
            if (action !== "status") try { state = await post("status"); } catch { /* No usable current status. */ }
            feedback = error.refused ? error.message : "Update status could not be confirmed. Check again when WIRE is available.";
        } finally {
            pendingPreference = undefined;
            if (feedback === "Checking for WIRE updates…" || feedback === "Saving update preferences…") feedback = "";
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
    // Only the restarted page running the entry named by the target's health can confirm success.
    async function recover(attempt = 0, freshPage = false, refusal = "", manualRead = false) {
        if (!expected || checkingRestart) return;
        checkingRestart = true; clearTimeout(recoveryTimer);
        fence(state?.phase === "preparing" ? "Preparing the selected build. Keep this panel open."
            : "Waiting for the updated WIRE build. The update will not be repeated.");
        try {
            const response = await fetch("/health", { ...fixed, signal: AbortSignal.timeout(4000) });
            const health = response.ok && await response.json();
            if (health?.service === "workiq-evidence" && health.protocol === 1 && health.build === expected.candidate && asset(health.clientEntry)) {
                if (freshPage && entry.href === location.origin + health.clientEntry) {
                    state = null; finish(`This panel is running build ${health.build.slice(0, 8)}.`, true);
                    // Read current preferences without clearing the verified notice.
                    try { state = await post("status"); managed = state.supported; render(); schedule(); } catch { /* Build proof is independent of preferences. */ }
                    return;
                }
                const file = await fetch(health.clientEntry, { ...fixed, signal: AbortSignal.timeout(4000) });
                if (file.ok && /(?:java|ecma)script/i.test(file.headers.get("Content-Type") || "")) {
                    if (freshPage && expected.entry === health.clientEntry) {
                        fence("WIRE restarted, but this panel loaded a different browser build. Check the local build before reloading.", true); return;
                    }
                    receipt({ ...expected, entry: health.clientEntry });
                    allowReload = true; location.reload(); return;
                }
            }
            // A failed handoff can restart the previous build with new page capabilities.
            // Read the replacement's status in a fresh panel; never treat rollback as success.
            if (!freshPage && health?.service === "workiq-evidence" && health.protocol === 1 && health.build === expected.previous
                && health.runtimeId && health.runtimeId !== expected.runtimeId && asset(health.clientEntry)) {
                allowReload = true; location.reload(); return;
            }
            const next = await post("status");
            state = next;
            if ((["error", "manual"].includes(next.phase) || (refusal || manualRead) && !["preparing", "restarting"].includes(next.phase))
                && next.installed !== expected.candidate) {
                finish(refusal || (manualRead && next.phase === "available" ? "WIRE is not updating. The selected build was not installed." : next.message));
                return;
            }
        } catch { /* The old panel capability may be gone; use health without renewing it. */ }
        finally { checkingRestart = false; }
        if (attempt < 45) recoveryTimer = setTimeout(() => void recover(attempt + 1, freshPage, refusal), Math.min(5000, (attempt + 1) * 1000));
        else fence("The restart is not confirmed. Check the original update’s status; do not run Update again.", true);
    }
    function reason() {
        try { return blocked(); }
        catch { return "WIRE could not verify that this panel is ready. Resolve unfinished work before updating."; }
    }
    async function apply() {
        if (busy || expected || !state?.supported || state.phase !== "available" || !sha(state.candidate)) return;
        const candidate = state.candidate, hold = reason();
        if (hold) { feedback = hold; render(); return; }
        busy = true; clearTimeout(scheduleTimer);
        try {
            if (!storageAvailable) throw new Error();
            receipt({ candidate, previous: state.installed, runtimeId });
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
            if (error.refused) { await recover(0, false, error.message); return; }
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
        clearTimeout(scheduleTimer);
        if (!event.persisted && managed && storageAvailable && !busy && !expected && !reason()) void fetch("/api/session/release", {
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
    $("appUpdateRecover").addEventListener("click", () => void recover(0, Boolean(expected?.entry), "", true));
    $("appUpdateDismiss").addEventListener("click", () => {
        if (success || result) { success = result = ""; render(); }
        else if (state?.candidate) void run("dismiss", { candidate: state.candidate }).then(() => {
            if (notice.hidden && document.activeElement === document.body) {
                (manual.checkVisibility() ? manual : $("pageTitle")).focus({ preventScroll: true });
            }
        });
    });
    manual.addEventListener("click", () => void run(state?.supported ? "check" : "status"));
    automatic.addEventListener("change", () => void run("preferences", { enabled: automatic.checked }));
    try {
        const saved = sessionStorage.getItem(receiptKey);
        if (saved) { const data = JSON.parse(saved); if (!sha(data?.candidate)) throw new Error(); expected = data; }
    } catch { storageAvailable = false; }
    if (expected) void recover(0, true);
    else void run("status").then(() => {
        if (state?.supported && state.automatic) void run("auto-check");
    });
    return { locked: () => Boolean(expected) };
}
