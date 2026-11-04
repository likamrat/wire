export const sourceCollectionMarkup = `
<section id="sourceMicrosoftCollection" class="settings-group" aria-labelledby="sourceMicrosoftTitle" hidden>
  <div class="settings-group-heading"><h3 id="sourceMicrosoftTitle">Microsoft collection</h3><span id="sourceMicrosoftStatus" class="connection-status" role="status"></span></div>
  <p id="sourceMicrosoftHelp" class="settings-help" hidden></p>
  <p id="sourceMicrosoftSaved" class="settings-help" hidden></p>
  <p id="sourceMicrosoftProgress" class="settings-help" role="status" hidden></p>
  <div class="settings-preferences">
    <div class="settings-field"><label for="sourceMicrosoftSurfaces">Microsoft sources</label><select id="sourceMicrosoftSurfaces" disabled><option value="chat,cowork">Chat and Cowork</option><option value="chat">Microsoft 365 Copilot Chat</option><option value="cowork">Cowork</option></select></div>
    <div class="settings-field"><label for="sourceMicrosoftWindow">History to include</label><select id="sourceMicrosoftWindow" disabled></select></div>
  </div>
  <div class="settings-actions"><button id="saveMicrosoftCollection" class="primary" type="button" disabled>Enable Microsoft collection</button><button id="cancelMicrosoftCollection" class="quiet" type="button" disabled>Cancel changes</button></div>
  <p id="sourceMicrosoftDraft" class="settings-help" role="status" hidden></p>
  <div class="settings-actions"><button id="pauseMicrosoftCollection" type="button" disabled>Pause collection</button><button id="collectMicrosoftActivity" type="button" disabled>Collect Microsoft activity</button></div>
  <p id="sourceMicrosoftMessage" class="notice" role="status" tabindex="-1" hidden></p>
  <button id="readMicrosoftCollection" class="quiet" type="button" hidden>Read current Microsoft settings</button>
</section>
<section id="globalCollectionControls" class="settings-group" aria-labelledby="globalCollectionTitle" hidden>
  <div class="settings-group-heading"><h3 id="globalCollectionTitle">Collection across sources</h3><span id="globalCollectionStatus" class="connection-status" role="status"></span></div>
  <p id="globalCollectionHelp" class="settings-help" hidden></p>
  <div class="settings-actions"><button id="pauseGlobalCollection" type="button" disabled>Pause collection</button><button id="resumeGlobalCollection" type="button" disabled>Resume collection</button></div>
  <p id="globalCollectionMessage" class="notice" role="status" tabindex="-1" hidden></p>
  <button id="readGlobalCollection" class="quiet" type="button" hidden>Read current collection settings</button>
</section>`;

// Separate controls share the same publication and composite authority, never inferred permissions.
export function mountSourceCollectionSettings({ api, ux, sourceCollection, createNativeConfigurationState,
    collectionStatus, write, read, collect, onDraftChange, needsStoredRead = () => false }) {
    const $ = id => document.getElementById(id);
    $("microsoftConnectionHost").after($("sourceMicrosoftCollection"));
    const configuration = createNativeConfigurationState();
    const groups = ["sourceMicrosoftCollection", "globalCollectionControls"];
    const controlIds = ["sourceMicrosoftSurfaces", "sourceMicrosoftWindow", "saveMicrosoftCollection",
        "cancelMicrosoftCollection", "pauseMicrosoftCollection", "collectMicrosoftActivity",
        "pauseGlobalCollection", "resumeGlobalCollection", "readMicrosoftCollection", "readGlobalCollection"];
    let withdrawn = true, epoch = 0, operation = null, checking = false, readError = "", latest = null, gesture = null;
    let sharedRecovery = false, integrated = false;
    const uncertain = new Set();
    const held = new Map();
    const stamp = () => ({ token: api.publicationToken(), epoch });
    const current = value => !withdrawn && value.epoch === epoch && value.token && api.isCurrent(value.token);
    const sources = () => sourceCollection.view(api.accessState());
    const draft = () => configuration.view(api.accessState().state);
    const dirty = () => draft().dirty || draft().stale;
    const working = () => Boolean(operation || checking);
    function text(id, value) {
        const node = $(id);
        if (node.textContent === value) return;
        for (const child of node.childNodes) if (child.nodeType === Node.TEXT_NODE) child.data = "";
        node.textContent = value;
    }
    function message(group, value, error = false) {
        const id = group === "global" ? "globalCollectionMessage" : "sourceMicrosoftMessage";
        text(id, value); $(id).hidden = !value;
        $(id).className = "notice" + (error ? " error" : "");
        $(id).setAttribute("role", error ? "alert" : "status");
    }
    function sync() {
        const model = draft();
        $("sourceMicrosoftSurfaces").value = model.values?.surfaces.join(",") ?? "";
        $("sourceMicrosoftWindow").value = model.values ? String(model.values.windowDays) : "";
    }
    function syncRecovery(authority, model) {
        if (!current(stamp())) return;
        authority ??= sources();
        model ??= draft();
        const initialRead = !latest && !readError && !uncertain.size;
        for (const [id, group] of [["readMicrosoftCollection", "microsoft"], ["readGlobalCollection", "global"]]) {
            $(id).hidden = initialRead || sharedRecovery && !uncertain.has(group)
                || !readError && authority.current && !uncertain.has(group) && (group !== "microsoft" || !model.needsRead);
            $(id).disabled = working();
        }
    }
    function historyProgress(saved) {
        if (!saved?.configured) return "";
        return saved.configuration.surfaces.map(surface => {
            const name = surface === "chat" ? "Chat history" : "Cowork history";
            const source = saved.backfill?.sources.find(row => row.surface === surface);
            if (!source) return `${name}: Coverage not verified.`;
            const stops = new Set(source.stops);
            const unqualified = stops.has("membership-unqualified");
            const finished = source.exhausted && !source.pending && !source.unreadable
                && !stops.has("membership-budget") && !unqualified;
            const checked = finished && source.startQualified;
            const state = unqualified ? "Full history hasn't been confirmed."
                : finished ? checked ? "Window checked." : "Coverage not verified."
                : source.pages || source.eligible ? "Partly checked." : "Not checked yet.";
            const labels = { handled: "read", suppressed: "kept deleted", pending: "pending", unreadable: "unreadable" };
            const counts = Object.entries(labels).flatMap(([key, label]) => source[key] ? [`${source[key].toLocaleString()} ${label}`] : []);
            const observed = counts.length ? counts.join(", ") + "." : checked ? "No histories in this window." : "";
            const remaining = stops.has("membership-budget") ? "More histories uncounted."
                : unqualified && ["page-budget", "history-budget", "byte-budget", "record-budget", "time-budget"].some(stop => stops.has(stop))
                    ? "Collection limit reached."
                : !unqualified && !finished && source.pages && !source.pending && !source.exhausted ? "More history to check." : "";
            const limit = stops.has("continuity-lost")
                ? remaining ? `Interrupted; ${remaining[0].toLowerCase()}${remaining.slice(1)}` : "Continuation interrupted."
                : remaining;
            return [`${name}: ${state}`, observed, limit].filter(Boolean).join(" ");
        }).join("\n");
    }
    function paint() {
        if (!sourceCollection.controlsActive || !current(stamp())) return;
        if (sourceCollection.copilotOnly) {
            $("sourceMicrosoftCollection").hidden = true;
            const authority = sources(), global = latest?.global;
            $("globalCollectionControls").hidden = global?.paused !== true
                && operation?.group !== "global" && !uncertain.has("global");
            text("globalCollectionTitle", "Collection pause");
            text("globalCollectionStatus", operation ? "Updating..." : !authority.current ? "Status unavailable"
                : global?.paused ? "Paused" : "Source settings apply");
            text("globalCollectionHelp", global?.paused ? "Automatic collection is paused. Check local history still works." : "");
            $("globalCollectionHelp").hidden = !global?.paused;
            for (const [id, action] of [["pauseGlobalCollection", "pause"], ["resumeGlobalCollection", "resume"]]) {
                $(id).hidden = action === "resume" ? global?.paused !== true : global?.paused === true;
                $(id).disabled = working() || !authority.current || Boolean(readError) || uncertain.size > 0
                    || !authority.actions.global.includes(action);
            }
            syncRecovery(authority);
            if (uncertain.has("global") && !operation && !$("globalCollectionMessage").textContent) {
                message("global", "Change unconfirmed. Read current settings.", true);
            }
            return;
        }
        for (const id of groups) $(id).hidden = false;
        $("sourceMicrosoftStatus").hidden = $("globalCollectionStatus").hidden = false;
        const authority = sources(), model = draft(), saved = latest?.microsoft.status, global = latest?.global;
        const initialRead = !latest && !readError && !uncertain.size;
        $("sourceMicrosoftCollection").hidden = integrated && !saved?.configured && !readError && !uncertain.size
            && (initialRead || model.blockers.some(code => ["NATIVE_CONFIGURATION_ACCOUNT_REQUIRED", "NATIVE_CONFIGURATION_IDENTITY_REQUIRED"].includes(code)));
        const unavailable = !authority.current || readError || uncertain.size > 0;
        const blocked = initialRead ? "Loading settings."
            : working() ? "Update in progress."
            : unavailable ? "Read current settings."
            : model.stale ? "Settings changed. Cancel edits to reload."
            : model.needsRead ? "Read current settings."
            : model.blockers.includes("NATIVE_CONFIGURATION_ACCOUNT_REQUIRED") ? "Connect Microsoft 365 first."
            : model.blockers.includes("NATIVE_CONFIGURATION_IDENTITY_REQUIRED") ? "Connect Microsoft 365 first."
            : model.blockers.length ? "Microsoft access is required."
            : model.validation;
        text("sourceMicrosoftStatus", operation?.group === "microsoft" ? operation.kind === "read" ? "Checking..." : "Saving..."
            : initialRead ? "Checking settings..." : !authority.current ? "Status unavailable" : !saved?.configured ? "Not enabled"
            : saved.configuration.settings.paused ? "Paused"
            : global.state === "committed" && global.paused ? "Paused across sources"
            : saved.blockers.includes("NATIVE_RETENTION_AUTOMATIC_STOPPED") ? "Automatic collection stopped"
            : saved.blockers.includes("NATIVE_RETENTION_OPERATION_UNKNOWN") ? "Collection outcome unconfirmed"
            : !authority.actions.microsoft.includes("collect-now") ? "Unavailable" : "Enabled");
        const detailBlockers = saved?.blockers.filter(code => code !== "NATIVE_RETENTION_PAUSED"
            && !((global?.paused || saved.configuration?.settings.paused) && code === "NATIVE_RETENTION_ACQUISITION_UNAVAILABLE")) ?? [];
        const help = saved?.configured && detailBlockers.length
            ? collectionStatus.persistenceReason({ nativePersistence: { ...saved, blockers: detailBlockers } })
            : model.intent === "enable" && model.canEdit
                ? "Save prompts, replies and tool activity locally. Microsoft may cache activity during sign-in." : "";
        text("sourceMicrosoftHelp", help.trim()); $("sourceMicrosoftHelp").hidden = !help.trim();
        const progress = historyProgress(unavailable || dirty() ? null : saved);
        text("sourceMicrosoftProgress", progress); $("sourceMicrosoftProgress").hidden = !progress;
        text("sourceMicrosoftTitle", integrated ? "Activity to save" : "Microsoft collection");
        text("saveMicrosoftCollection", model.intent === "enable" ? integrated ? "Enable collection" : "Enable Microsoft collection"
            : integrated ? "Save preferences" : "Save Microsoft preferences");
        for (const id of ["sourceMicrosoftSurfaces", "sourceMicrosoftWindow"]) {
            if (model.values) $(id).removeAttribute("data-select-state");
            else $(id).dataset.selectState = initialRead ? "loading" : "stale";
        }
        $("sourceMicrosoftSurfaces").disabled = $("sourceMicrosoftWindow").disabled = working() || unavailable || !model.canEdit;
        $("saveMicrosoftCollection").disabled = working() || unavailable || !model.canSubmit
            || !authority.actions.microsoft.includes("configure");
        $("cancelMicrosoftCollection").disabled = working() || !dirty();
        $("cancelMicrosoftCollection").hidden = integrated && !dirty();
        const pauseAction = authority.actions.microsoft.includes("pause") ? "pause"
            : authority.actions.microsoft.includes("resume") ? "resume" : null;
        text("pauseMicrosoftCollection", pauseAction === "resume" ? "Resume collection" : "Pause collection");
        $("pauseMicrosoftCollection").hidden = model.intent === "enable";
        $("pauseMicrosoftCollection").disabled = working() || unavailable || dirty() || !pauseAction;
        const recovery = needsStoredRead();
        text("collectMicrosoftActivity", recovery ? "Read stored activity" : "Collect Microsoft activity");
        $("collectMicrosoftActivity").disabled = working() || uncertain.size > 0 || dirty()
            || !recovery && (unavailable || !authority.actions.microsoft.includes("collect-now"));
        $("collectMicrosoftActivity").hidden = integrated && model.intent === "enable" && !recovery;
        text("sourceMicrosoftDraft", model.stale ? "Settings changed. Cancel edits to reload."
            : model.validation || (model.dirty ? "Unsaved changes." : ""));
        $("sourceMicrosoftDraft").hidden = !$("sourceMicrosoftDraft").textContent;
        text("globalCollectionStatus", operation?.group === "global" ? operation.kind === "read" ? "Checking..." : "Saving..."
            : initialRead ? "Checking settings..." : !authority.current ? "Status unavailable"
            : global.paused ? "Paused" : "Source settings apply");
        text("globalCollectionHelp", global?.paused ? "Refresh can still check GitHub history." : "");
        $("globalCollectionHelp").hidden = !global?.paused;
        for (const [id, action] of [["pauseGlobalCollection", "pause"], ["resumeGlobalCollection", "resume"]]) {
            $(id).hidden = action === "resume" ? global?.paused !== true : global?.paused === true;
            $(id).disabled = working() || unavailable || dirty() || !authority.actions.global.includes(action);
        }
        syncRecovery(authority, model);
        for (const id of ["saveMicrosoftCollection", "pauseMicrosoftCollection", "collectMicrosoftActivity",
            "pauseGlobalCollection", "resumeGlobalCollection"]) {
            const reason = $(id).disabled ? blocked || (dirty() ? "Save or cancel your changes first." : "") : "";
            ux.tooltip($(id), reason);
            if (!current(stamp())) return;
            ux.explainDisabled($(id), reason, { compact: true });
        }
        for (const group of uncertain) {
            const target = $(group === "global" ? "globalCollectionMessage" : "sourceMicrosoftMessage");
            if (!operation && !target.textContent) message(group, "Change unconfirmed. Read current settings.", true);
        }
        onDraftChange(dirty());
    }
    async function act(group, endpoint, input, confirm) {
        const owner = stamp();
        if (!current(owner) || working() || uncertain.size) return;
        const pending = { group, kind: "write", dispatched: false };
        operation = pending;
        try {
            message(group, ""); paint();
            if (!current(owner)) return;
            sourceCollection.authorize(endpoint, input, api.accessState());
            pending.dispatched = true;
            const result = await write(endpoint, input);
            if (!current(owner)) { uncertain.add(group); return; }
            confirm(result);
            if (group === "microsoft") { configuration.cancel(); sync(); }
            message(group, "");
        } catch (error) {
            if (pending.dispatched) uncertain.add(group);
            if (current(owner)) message(group, pending.dispatched ? "Change unconfirmed. Read current settings." : "The change did not start.", true);
        } finally {
            if (operation === pending) {
                operation = null;
                if (current(stamp())) paint();
            }
        }
    }
    async function recover(group) {
        const owner = stamp();
        if (!current(owner) || working()) return;
        const pending = { group, kind: "read", dispatched: false }, wasUncertain = uncertain.has(group);
        operation = pending;
        try {
            paint(); await read();
            if (!current(owner)) return;
            if (!sources().current) throw new Error("Current source status is unavailable.");
            uncertain.delete(group); readError = "";
            message(group, wasUncertain ? "Current settings shown; earlier change unconfirmed." : "");
        } catch (error) {
            if (current(owner)) { readError = error.message; message(group, "Current settings could not be read.", true); }
        } finally {
            if (operation === pending) operation = null;
            if (current(owner)) paint();
        }
    }
    for (let days = 1; days <= 90; days++) {
        const option = document.createElement("option");
        option.value = String(days); option.textContent = `${days} ${days === 1 ? "day" : "days"}`;
        $("sourceMicrosoftWindow").append(option);
    }
    for (const id of ["sourceMicrosoftSurfaces", "sourceMicrosoftWindow"]) $(id).addEventListener("input", () => {
        if (!current(stamp()) || $(id).disabled) return;
        configuration.edit({ surfaces: $("sourceMicrosoftSurfaces").value.split(",").filter(Boolean),
            windowDays: Number($("sourceMicrosoftWindow").value) });
        message("microsoft", ""); paint();
    });
    $("cancelMicrosoftCollection").addEventListener("click", () => {
        if (!current(stamp()) || $("cancelMicrosoftCollection").disabled) return;
        configuration.cancel(); sync(); paint();
    });
    const captureGesture = () => {
        const owner = stamp();
        gesture = { owner, command: current(owner) && draft().canSubmit ? configuration.command(api.accessState().state) : null };
    };
    $("saveMicrosoftCollection").addEventListener("pointerdown", event => { if (event.button === 0) captureGesture(); });
    $("saveMicrosoftCollection").addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key) && !event.repeat) captureGesture();
    });
    $("saveMicrosoftCollection").addEventListener("click", () => {
        if (!current(stamp()) || $("saveMicrosoftCollection").disabled || !draft().canSubmit) return;
        const command = configuration.command(api.accessState().state), original = gesture;
        gesture = null;
        if (original && (!current(original.owner) || JSON.stringify(original.command) !== JSON.stringify(command))) {
            message("microsoft", "Settings changed. Try again.", true); return;
        }
        const paused = latest.microsoft.status.configuration?.settings.paused, globalRevision = latest.global.revision;
        void act("microsoft", "/api/collection/microsoft/configure", command, result => {
            const saved = collectionStatus.persistence(result), configured = saved?.configuration;
            if (!saved?.configured || configured.settings.windowDays !== command.windowDays
                || JSON.stringify([...configured.surfaces].sort()) !== JSON.stringify([...command.surfaces].sort())
                || command.intent === "save" && configured.settings.paused !== paused
                || !sources().current || sources().status.global.revision !== globalRevision) {
                throw new Error("The Microsoft settings change was not confirmed.");
            }
            return !sources().actions.microsoft.includes("collect-now")
                ? "Microsoft preferences saved. Collection remains unavailable; no history was collected."
                : command.intent === "enable" ? "Microsoft collection enabled. Global policy is unchanged."
                : "Microsoft preferences saved. Pause and global policy are unchanged.";
        });
    });
    function hold(id, build) {
        const capture = () => held.set(id, { owner: stamp(), command: current(stamp()) && sources().current ? build() : null });
        $(id).addEventListener("pointerdown", event => { if (event.button === 0) capture(); });
        $(id).addEventListener("keydown", event => { if (["Enter", " "].includes(event.key) && !event.repeat) capture(); });
    }
    function admitGesture(id, command, group) {
        const original = held.get(id);
        held.delete(id);
        if (!original || current(original.owner) && JSON.stringify(original.command) === JSON.stringify(command)) return true;
        message(group, "Settings changed. Try again.", true);
        return false;
    }
    const nativePauseCommand = () => ({ enabled: sources().actions.microsoft.includes("resume"),
        expectedNativeRevision: sources().status.authorizationRevision });
    hold("pauseMicrosoftCollection", nativePauseCommand);
    $("pauseMicrosoftCollection").addEventListener("click", () => {
        if (!current(stamp()) || $("pauseMicrosoftCollection").disabled) return;
        if (!sources().current) { paint(); return; }
        const command = nativePauseCommand();
        if (!admitGesture("pauseMicrosoftCollection", command, "microsoft")) return;
        void act("microsoft", "/api/collection/microsoft/enabled", command, result => {
                if (collectionStatus.native(result)?.enabled !== command.enabled) throw new Error("The Microsoft read change was not confirmed.");
                return command.enabled ? "Microsoft reads resumed. Global policy is unchanged." : "Microsoft reads paused. Saved activity stays available.";
            });
    });
    $("collectMicrosoftActivity").addEventListener("click", event => {
        if (current(stamp()) && !$("collectMicrosoftActivity").disabled) void collect(event);
    });
    for (const [id, enabled] of [["pauseGlobalCollection", false], ["resumeGlobalCollection", true]]) {
        const build = () => {
            const value = sources().status;
            return { schemaVersion: 1, enabled, generation: value.generation,
                authorizationRevision: value.authorizationRevision, expectedRevision: value.global.revision };
        };
        hold(id, build);
        $(id).addEventListener("click", () => {
            if (!current(stamp()) || $(id).disabled) return;
            if (!sources().current) { paint(); return; }
            const command = build();
            if (!admitGesture(id, command, "global")) return;
            void act("global", "/api/collection/global/enabled", command, result => {
                const decoded = sourceCollection.decode(result);
                if (decoded.global.state !== "committed" || decoded.global.paused !== !enabled) {
                    throw new Error("The global collection change was not confirmed.");
                }
                return enabled ? "Global collection allowed. Each source keeps its own preferences."
                    : "Global collection paused. Saved activity and manual GitHub Refresh remain available.";
            });
        });
    }
    $("readMicrosoftCollection").addEventListener("click", () => void recover("microsoft"));
    $("readGlobalCollection").addEventListener("click", () => void recover("global"));
    return {
        placeInConnection(container) {
            const root = $("sourceMicrosoftCollection"), parent = root.parentElement, next = root.nextSibling;
            if (!(container instanceof HTMLElement)) throw new TypeError("Microsoft collection requires its existing connection container.");
            integrated = true; root.classList.add("wire-microsoft-collection"); container.append(root); paint();
            return () => {
                integrated = false; root.classList.remove("wire-microsoft-collection");
                parent.insertBefore(root, next?.parentElement === parent ? next : null); paint();
            };
        },
        receive(value, token) {
            if (!sourceCollection.controlsActive || !token || !api.isCurrent(token) || withdrawn) return false;
            if (!sourceCollection.copilotOnly) configuration.receive(value.microsoft.configurationOffer);
            latest = value; readError = ""; sync(); paint(); return true;
        },
        receiveSavedActivity(textValue, token) {
            if (!sourceCollection.active || !token || !api.isCurrent(token) || withdrawn) return;
            text("sourceMicrosoftSaved", textValue);
            $("sourceMicrosoftSaved").hidden = !textValue;
        },
        hasDraft: dirty, isBusy: working,
        canCollect: () => current(stamp()) && !working() && !dirty() && !uncertain.size
            && (needsStoredRead() || !readError && sources().actions.microsoft.includes("collect-now")),
        setChecking(value) { checking = value; paint(); },
        setSharedRecovery(value) { sharedRecovery = value; syncRecovery(); },
        unavailable(error) { configuration.receive(undefined); readError = error; paint(); },
        receiveAccess: paint,
        resumeAccess() { withdrawn = !api.publicationToken(); return !withdrawn; },
        withdrawAccess() {
            withdrawn = true; epoch++; latest = null; gesture = null; readError = ""; checking = false; sharedRecovery = false;
            held.clear();
            if (operation?.dispatched) uncertain.add(operation.group);
            configuration.withdraw();
            for (const id of groups) {
                $(id).hidden = true;
            }
            for (const id of ["sourceMicrosoftStatus", "sourceMicrosoftDraft", "sourceMicrosoftMessage", "sourceMicrosoftSaved", "sourceMicrosoftProgress",
                "globalCollectionStatus", "globalCollectionMessage"]) { text(id, ""); $(id).hidden = true; }
            $("sourceMicrosoftSurfaces").value = $("sourceMicrosoftWindow").value = "";
            $("sourceMicrosoftSurfaces").dataset.selectState = $("sourceMicrosoftWindow").dataset.selectState = "stale";
            for (const id of controlIds) $(id).disabled = true;
        },
    };
}
