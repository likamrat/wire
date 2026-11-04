// Serialized into the page; keep dependencies inside this function.
export function mountRecorderDiagnostics({ api, openDialog, el, button }) {
    if (typeof api !== "function" || typeof api.publicationToken !== "function" || typeof api.isCurrent !== "function") {
        throw new TypeError("An access-aware API with publicationToken() and isCurrent() is required.");
    }
    const $ = id => document.getElementById(id);
    const key = "workiq-evidence.recorder-attempt";
    let attemptId, attempt, busy = false, reading = false, uncertain = false, loaded = false, timer;
    let accessAvailable = true, accessEpoch = 0, confirmationBody, confirmationAction;
    const publication = () => ({ epoch: accessEpoch, token: api.publicationToken() });
    const current = access => accessAvailable && access?.epoch === accessEpoch && access.token != null
        && api.isCurrent(access.token) === true;
    function text(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
    function storage(value) {
        try {
            if (value === undefined) return sessionStorage.getItem(key);
            if (value === null) sessionStorage.removeItem(key);
            else sessionStorage.setItem(key, value);
        } catch {
            if (current(publication())) {
                $("recorderStorageWarning").hidden = false;
                $("recorderStorageWarning").textContent = "This panel cannot remember the attempt across reloads. The runtime keeps saved diagnostics; read the last result before starting another.";
            }
        }
        return null;
    }
    attemptId = storage() || undefined;
    function render(message) {
        if (!current(publication())) return;
        const pending = busy || attempt?.phase === "pending" && !uncertain;
        $("recordBtn").disabled = pending || !loaded;
        text("recordBtn", reading && (attempt?.phase !== "pending" || uncertain) ? "Reading result..."
            : pending ? "Recording diagnostic..." : uncertain ? "Check saved result" : "Test HTTP recorder");
        $("recordBtn").setAttribute("aria-busy", String(pending));
        const value = attempt;
        const phases = {
            pending: "Public request in progress. Waiting up to 30 seconds for response headers, then saving the result locally. You can leave this page; it will not repeat the request.",
            succeeded: value?.synthetic ? `Last diagnostic: synthetic HTTP ${value.status} received; test record saved. No real Graph response was observed.`
                : `Last diagnostic: HTTP ${value?.status} received; result recorded. This tested only the public endpoint and recorder, not local collection or workplace access.`,
            "http-error": `Last diagnostic: Microsoft Graph returned HTTP ${value?.status}; the failed response was recorded. Review the HTTP recorder evidence before deciding whether to run a new test.`,
            "no-response": `${value?.transportError === "TimeoutError" ? "Timed out waiting for response headers." : "No HTTP response received."} The attempt was recorded, not a successful HTTP call. Check your network before deciding whether to run a new test.`,
            "save-error": "The diagnostic could not be fully saved. Do not assume recording succeeded. Check local storage access and the saved result below before starting another test.",
            "unverified-response": "A response was recorded, but its Microsoft Graph origin could not be verified. This is not a successful Graph diagnostic.",
            interrupted: "The runtime stopped before a final result was saved. The request may have been sent. Inspect retained HTTP recorder evidence before deciding whether to start a new test; it was not replayed.",
            error: "The diagnostic could not complete. Check the local runtime and storage access. No success is claimed and no request was replayed.",
        };
        text("recorderStatus", message || phases[value?.phase] || "No saved diagnostic yet. This optional test is separate from local history collection.");
        $("recorderStatus").classList.toggle("error", Boolean(uncertain || value && !["pending", "succeeded"].includes(value.phase)));
        $("recorderEvidence").hidden = !value;
        text("recorderEvidence", value ? `Attempt ${value.attemptId}. ${value.recordSaved
            ? `Local file: http-records/${value.recordId}.json.${value.evidenceSaved ? " Also available in HTTP recorder evidence." : value.synthetic ? " Synthetic test record; excluded from activity evidence." : " Not indexed in activity evidence."}`
            : value.phase === "pending" ? "Result will appear here." : "No recorder file is confirmed by this result."}${value.cleanupFailed ? " Response stream cleanup also failed." : ""}` : "");
        $("recorderResultLink").hidden = !value?.evidenceSaved && value?.phase !== "interrupted";
    }
    function schedule() {
        clearTimeout(timer);
        const access = publication();
        if (current(access) && attempt?.phase === "pending" && !uncertain) timer = setTimeout(() => {
            if (current(access)) readResult();
        }, 750);
    }
    async function readResult() {
        const access = publication();
        if (!current(access) || busy) return;
        busy = true; reading = true;
        render(attempt?.phase === "pending" && !uncertain ? undefined : "Reading the saved diagnostic result. No network test is being started.");
        try {
            const result = await api("/api/record/status", attemptId ? { attemptId } : {});
            if (!current(access)) return;
            loaded = true;
            if (result.attempt) {
                attempt = result.attempt;
                attemptId = attempt.attemptId;
                storage(attemptId);
                uncertain = false;
            } else if (attemptId) {
                uncertain = true;
                attempt = null;
            } else { attempt = null; uncertain = false; }
            busy = false; reading = false;
            render(uncertain ? "No saved result is available for this attempt yet. It may have reached the runtime. Check the saved result again; this does not repeat the request." : undefined);
        } catch (error) {
            if (!current(access)) return;
            busy = false; reading = false; loaded = true; uncertain = true;
            render(`${error.message} Check the saved result when the runtime is available; do not repeat the request.`);
        }
        schedule();
    }
    async function start() {
        const access = publication();
        if (!current(access) || busy || uncertain || !loaded || attempt?.phase === "pending") return;
        busy = true; uncertain = false; loaded = true;
        attemptId = crypto.randomUUID();
        storage(attemptId);
        attempt = { attemptId, phase: "pending" };
        render("Starting the public request and saving its diagnostic result locally...");
        try {
            const result = await api("/api/record", { confirmed: true, attemptId });
            if (!current(access)) return;
            if (!result.attempt?.attemptId) throw new Error("The runtime did not return an attempt identity. The request may have been sent.");
            attempt = result.attempt; attemptId = attempt.attemptId; storage(attemptId);
            busy = false; render();
        } catch (error) {
            if (!current(access)) return;
            busy = false;
            if (error.code === "request_rejected") {
                attempt = null; attemptId = undefined; storage(null);
                render("The request was not started. " + error.message + " Confirm a new test only when ready.");
            } else {
                uncertain = true; attempt = { attemptId, phase: "unknown" };
                render(`${error.message} The request may still complete. Check the saved result; it will not send another request.`);
            }
        }
        schedule();
    }
    $("recordBtn").addEventListener("click", () => {
        const access = publication();
        if (!current(access) || $("recordBtn").disabled) return;
        if (uncertain) { readResult(); return; }
        const body = openDialog("Test HTTP recorder?");
        confirmationBody = body;
        body.append(el("p", "", "Send one public GET to graph.microsoft.com/v1.0/$metadata and save the result locally. No credentials or response body are logged. This does not check your Copilot collection or workplace data."));
        const action = button("Send public request", () => {
            if (!current(access) || !action.isConnected || !body.contains(action) || !$("overlay").open) return;
            $("overlay").close();
            start();
            if (current(access)) $("recorderStatus").focus({ preventScroll: true });
        }, "primary");
        confirmationAction = action; body.append(action);
    });
    $("recorderDiagnostics").addEventListener("toggle", () => {
        if (current(publication()) && $("recorderDiagnostics").open && !busy) readResult();
    });
    window.addEventListener("pagehide", () => clearTimeout(timer));
    window.addEventListener("pageshow", () => { if (current(publication()) && loaded && !busy) readResult(); });
    return {
        withdrawAccess() {
            if (!accessAvailable) return;
            accessAvailable = false; accessEpoch++;
            clearTimeout(timer); timer = undefined;
            uncertain = uncertain || Boolean(attemptId); attempt = undefined; busy = false; reading = false; loaded = false;
            if (confirmationAction && confirmationBody?.contains(confirmationAction)) confirmationBody.replaceChildren();
            confirmationBody = undefined; confirmationAction = undefined;
            for (const id of ["recorderStatus", "recorderEvidence", "recorderStorageWarning"]) text(id, "");
            $("recorderEvidence").hidden = true; $("recorderStorageWarning").hidden = true; $("recorderResultLink").hidden = true;
            $("recordBtn").disabled = true; $("recordBtn").setAttribute("aria-busy", "false");
            text("recordBtn", "Test HTTP recorder");
            $("recorderDiagnostics").open = false;
        },
        resumeAccess() {
            const access = publication();
            if (access.epoch === accessEpoch && access.token != null && api.isCurrent(access.token) === true) accessAvailable = true;
        },
    };
}
