// Shared, serialized presentation contract. Local history coverage is not an action outcome.
export function createCollectionStatus() {
    const persistenceContract = "m365-native-screened-observations-v1";
    const persistencePolicy = "native-screened-source-observations-v1";
    const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    const revision = value => Number.isSafeInteger(value) && value >= 0;
    const configuredRevision = value => Number.isSafeInteger(value) && value > 0;
    const opaque = value => typeof value === "string" && value.length > 0;
    const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
    const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    function validConfiguration(config) {
        return config === null || exact(config, ["configurationRevision", "privacyRevision", "policy", "settings", "surfaces"])
            && configuredRevision(config.configurationRevision) && configuredRevision(config.privacyRevision)
            && config.policy === persistencePolicy && exact(config.settings, ["paused", "windowDays"])
            && typeof config.settings.paused === "boolean" && Number.isSafeInteger(config.settings.windowDays)
            && config.settings.windowDays > 0 && Array.isArray(config.surfaces) && config.surfaces.length > 0
            && new Set(config.surfaces).size === config.surfaces.length
            && config.surfaces.every(surface => ["chat", "cowork"].includes(surface));
    }
    function nativeUnavailable(status) {
        const value = status?.nativePersistence;
        if (value?.kind !== "native-account-unavailable") return null;
        if (!exact(value, ["schemaVersion", "kind", "reason", "generation", "authorizationRevision", "revision",
            "rawWriterAdmission", "configured", "configuration", "actions", "blockers"])
            || value.schemaVersion !== 1 || value.reason !== "microsoft-account-not-configured"
            || !revision(value.generation) || !revision(value.authorizationRevision) || !revision(value.revision)
            || value.rawWriterAdmission !== "withheld" || value.configured !== false
            || !validConfiguration(value.configuration) || !Array.isArray(value.actions) || value.actions.length
            || !Array.isArray(value.blockers) || value.blockers.length !== 1
            || value.blockers[0] !== "NATIVE_RETENTION_ACCOUNT_UNAVAILABLE") {
            throw new TypeError("Microsoft account-unavailable metadata is invalid.");
        }
        return value;
    }
    function nativeUnavailableCurrent(status, observed, previousStatus) {
        const value = nativeUnavailable(status), previous = nativeUnavailable(previousStatus);
        if (!value || value.generation !== observed?.generation || !revision(observed?.authorizationRevision)) return false;
        const sameGeneration = previous?.generation === value.generation;
        return value.authorizationRevision >= Math.max(observed.authorizationRevision, native(status)?.revision ?? 0,
            native(previousStatus)?.revision ?? 0, sameGeneration ? previous.authorizationRevision : 0)
            && (!sameGeneration || value.revision >= previous.revision);
    }
    function nativeUnavailableMatches(snapshot, status) {
        const value = nativeUnavailable(status), read = snapshot?.nativeRead;
        const nativeRow = row => typeof row?.countUnit === "string" && row.countUnit.startsWith("native-")
            || ["microsoft-365-chat", "microsoft-365-cowork"].includes(row?.sourceId);
        return Boolean(value && exact(read, ["status", "reason", "revision", "generation", "authorizationRevision"])
            && read.status === "unavailable" && read.reason === value.reason
            && typeof read.revision === "string" && /^[a-f0-9]{64}$/.test(read.revision)
            && read.generation === value.generation && read.authorizationRevision === value.authorizationRevision
            && Array.isArray(snapshot.scenarios) && !snapshot.scenarios.some(record => record?.recordKind === "native-conversation" || nativeRow(record))
            && (!snapshot.analytics?.rows || Array.isArray(snapshot.analytics.rows) && !snapshot.analytics.rows.some(nativeRow))
            && (!snapshot.requestActivity || Object.values(snapshot.requestActivity).every(rows => Array.isArray(rows) && !rows.some(nativeRow)))
            && ["nativeConversationKeys", "contextOnlyScenarioIds"].every(key => snapshot.analytics?.population?.[key] === undefined
                || Array.isArray(snapshot.analytics.population[key]) && snapshot.analytics.population[key].length === 0)
            && (!snapshot.analytics?.population?.native || Object.values(snapshot.analytics.population.native).every(count => count === 0)));
    }
    const persistenceBlockers = {
        NATIVE_RETENTION_NOT_CONFIGURED: "Microsoft activity saving is not configured.",
        NATIVE_RETENTION_PAUSED: "Microsoft collection is paused.",
        NATIVE_RETENTION_GLOBAL_PAUSED: "Collection is paused.",
        NATIVE_RETENTION_ACQUISITION_UNAVAILABLE: "The Microsoft connection is unavailable for collection.",
        NATIVE_RETENTION_RECEIPT_LIMIT: "The local collection receipt limit has been reached.",
        NATIVE_RETENTION_OPERATION_PENDING: "A Microsoft collection operation is still pending.",
        NATIVE_RETENTION_OPERATION_UNKNOWN: "The previous Microsoft collection is unconfirmed. Read its status before starting another collection.",
        NATIVE_RETENTION_AUTOMATIC_STOPPED: "Automatic Microsoft collection stopped after an error. Read the current connection before starting a new collection.",
    };
    function nativeReceipt(value) {
        if (!value || value.schemaVersion !== 1 || value.intent !== "native-collect-now"
            || !uuid(value.operationId) || !opaque(value.partition)
            || Object.hasOwn(value, "ownerHash") || Object.hasOwn(value, "fingerprint")
            || !["pending", "unknown", "committed"].includes(value.status)
            || !["configurationRevision", "privacyRevision"].every(key => configuredRevision(value[key])) || !revision(value.generation)
            || !timestamp(value.registeredAt)) throw new TypeError("Microsoft collection receipt is invalid.");
        const committedFields = ["quality", "beforeRevision", "revision", "snapshot", "changes", "committedAt"];
        if (value.status !== "committed") {
            if (committedFields.some(key => Object.hasOwn(value, key))) throw new TypeError("An unresolved Microsoft operation cannot establish saved activity.");
            return value;
        }
        if (value.quality !== "source-qualified-partial" || !revision(value.beforeRevision) || !revision(value.revision)
            || value.revision < value.beforeRevision || !opaque(value.snapshot) || !timestamp(value.committedAt)
            || !value.changes || !["addedCaptures", "addedObservations", "addedVariants", "addedProvenance",
                "reusedObservations", "suppressedObservations"].every(key => revision(value.changes[key]))) {
            throw new TypeError("The committed Microsoft collection receipt is invalid.");
        }
        return value;
    }
    function persistence(status) {
        if (status?.nativePersistence === undefined) return null;
        if (nativeUnavailable(status)) return null;
        const value = status.nativePersistence, config = value?.configuration;
        if (!value || value.schemaVersion !== 1 || value.kind !== "native-screened-retention"
            || value.contractVersion !== persistenceContract || value.rawWriterAdmission !== "withheld"
            || typeof value.configured !== "boolean" || !opaque(value.accountRef)
            || !revision(value.generation) || !revision(value.revision)
            || !Array.isArray(value.actions) || new Set(value.actions).size !== value.actions.length
            || value.actions.some(action => !["configure", "collect-now"].includes(action))
            || !Array.isArray(value.blockers) || value.blockers.some(code => !Object.hasOwn(persistenceBlockers, code))
            || value.receiptQuery !== null && !uuid(value.receiptQuery)
            || !validConfiguration(config)
            || value.configured && config === null) {
            throw new TypeError("Microsoft activity saving status is invalid.");
        }
        if (value.receipt !== null) {
            nativeReceipt(value.receipt);
            if (value.receipt.partition !== value.accountRef || value.receiptQuery !== null && value.receipt.operationId !== value.receiptQuery) {
                throw new TypeError("Microsoft receipt status does not match its requested account and operation.");
            }
        }
        if (Object.hasOwn(value, "backfill")) {
            const progress = value.backfill;
            const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object)
                && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
            const stops = ["page-budget", "history-budget", "byte-budget", "record-budget", "time-budget", "membership-budget", "unreadable-history", "continuity-lost", "membership-unqualified"];
            if (!exact(progress, ["schemaVersion", "window", "state", "sources"]) || progress.schemaVersion !== 1
                || !exact(progress.window, ["from", "to"]) || !timestamp(progress.window.from) || !timestamp(progress.window.to)
                || Date.parse(progress.window.from) >= Date.parse(progress.window.to)
                || !["started", "progressing", "unqualified", "covered"].includes(progress.state)
                || !Array.isArray(progress.sources) || !progress.sources.length || progress.sources.length > 2
                || progress.sources.some(row => !row || typeof row !== "object" || Array.isArray(row))
                || new Set(progress.sources.map(row => row.surface)).size !== progress.sources.length
                || progress.sources.some(row => !exact(row, ["surface", "startQualified", "controlObserved", "initial", "pages", "chainPages",
                    "exhausted", "eligible", "handled", "suppressed", "pending", "unreadable", "stops"])
                    || !["chat", "cowork"].includes(row.surface) || typeof row.startQualified !== "boolean"
                    || typeof row.controlObserved !== "boolean" || typeof row.exhausted !== "boolean"
                    || row.exhausted && (row.pages === 0 || row.chainPages === 0)
                    || !["unobserved", "absent", "null", "empty", "present"].includes(row.initial)
                    || row.startQualified && (!row.controlObserved || row.initial === "unobserved")
                    || ["pages", "chainPages", "eligible", "handled", "suppressed", "pending", "unreadable"].some(key => !revision(row[key]) || row[key] > 10000)
                    || row.eligible !== row.handled + row.suppressed + row.pending + row.unreadable
                    || !Array.isArray(row.stops) || row.stops.some(stop => !stops.includes(stop))
                    || new Set(row.stops).size !== row.stops.length
                    || progress.state === "covered" && (!row.startQualified || !row.controlObserved || !row.exhausted || row.pending || row.unreadable
                        || row.initial === "unobserved" || row.stops.includes("membership-budget")))) {
                throw new TypeError("Microsoft history progress is invalid.");
            }
            const exhausted = progress.sources.every(row => row.exhausted && row.pending === 0 && row.unreadable === 0
                && !row.stops.includes("membership-budget"));
            const expected = exhausted ? progress.sources.every(row => row.startQualified) ? "covered" : "unqualified"
                : progress.sources.some(row => row.pages || row.eligible) ? "progressing" : "started";
            if (progress.state !== expected) throw new TypeError("Microsoft history progress conflicts with its coverage evidence.");
        }
        if (value.actions.includes("collect-now") && (!value.configured || config.settings.paused
            || value.blockers.length && !(value.blockers.length === 1
                && ["NATIVE_RETENTION_OPERATION_UNKNOWN", "NATIVE_RETENTION_AUTOMATIC_STOPPED"].includes(value.blockers[0])))) {
            throw new TypeError("Microsoft collection actions conflict with the current status.");
        }
        return value;
    }
    function nativeReadbackCurrent(snapshot, status) {
        const current = persistence(status), readback = snapshot?.nativeRead?.readback;
        if (!current || readback?.schemaVersion !== 1 || !readback.current) return false;
        return readback.accountRef === current.accountRef
            && readback.current.generation === current.generation
            && readback.current.generation === snapshot.nativeRead.generation
            && readback.current.configurationRevision === (current.configuration?.configurationRevision ?? null)
            && readback.current.privacyRevision === (current.configuration?.privacyRevision ?? null);
    }
    function nativeReadbackMatches(receipt, snapshot, status) {
        nativeReceipt(receipt);
        const readback = snapshot?.nativeRead?.readback;
        if (receipt.status !== "committed" || !persistence(status)?.configuration
            || !nativeReadbackCurrent(snapshot, status) || !readback.committed) return false;
        return receipt.partition === readback.accountRef && receipt.snapshot === readback.snapshot
            && ["operationId", "revision", "generation", "configurationRevision", "privacyRevision"]
                .every(key => receipt[key] === readback.committed[key]);
    }
    function persistenceReason(status) {
        const value = persistence(status);
        return value?.blockers.map(code => persistenceBlockers[code]).join(" ") || "";
    }
    function native(status) {
        if (status?.nativeControl === undefined) return null;
        const control = status.nativeControl;
        const revision = control?.revision;
        if (!control || control.kind !== "native-read-only" || control.scope !== "registered-native-read"
            || control.writerAdmission !== "withheld"
            || !["enabled", "retained", "connected", "canPause", "canResume"].every(name => typeof control[name] === "boolean")
            || !Number.isSafeInteger(revision) || revision < 0) {
            throw new TypeError("Microsoft read controls are unavailable because their current status is invalid.");
        }
        return control;
    }
    function nativePage(control, saved = null, unavailable = null) {
        if (unavailable) return { label: "Microsoft account not connected",
            guidance: "Connect Microsoft 365, then enable its collection. GitHub activity is unchanged.",
            action: { label: "Connect Microsoft 365", href: "#settings?section=connection&setting=microsoft-connection" } };
        if (!control.retained) return { label: "Microsoft activity unavailable", severity: "warning",
            guidance: "Current WIRE access is required to read saved activity." };
        if (!control.enabled) return { label: "Microsoft reads paused",
            guidance: control.connected ? "New Microsoft reads are paused. Saved activity stays available."
                : "Microsoft reads are paused and the connection is unavailable. Saved activity stays available.",
            action: { label: "Open Settings", href: "#settings?section=connection&setting=collection-state" } };
        if (!control.connected) return { label: "Microsoft connection unavailable", severity: "warning",
            guidance: "New Microsoft reads are unavailable. Saved activity stays available.",
            action: { label: "View Microsoft connection", href: "#settings?section=connection&setting=microsoft-connection" } };
        if (saved) return { label: saved.actions.includes("collect-now") ? "Microsoft collection available" : "Microsoft collection unavailable",
            guidance: persistenceReason({ nativePersistence: saved })
                || "Collect screened Microsoft activity on this device. Saved results remain source-qualified and partial." };
        return { label: "Microsoft reads enabled", guidance: "Only registered Microsoft reads are enabled; native writes are unavailable." };
    }
    const dispositions = {
        eligible: "Copilot chats with a verified local history location",
        archived: "archived Copilot chats",
        "unmapped-invalid-id": "Copilot chats with an invalid identifier",
        "nonlocal-not-read": "Copilot chats hosted elsewhere",
        "ambiguous-project-mapping": "Copilot chats linked to more than one project",
        "unmapped-workspace-session": "Copilot chats without a verified workspace link",
        "unmapped-workspace-type": "Copilot chats with an unrecognized workspace type",
    };
    const reasons = {
        missing: { label: "Saved Copilot chat history file not found", explanation: "WIRE could not find this chat's saved history. It cannot collect new activity from the missing file; previously collected activity is kept.", guidance: "Refresh cannot restore a missing file. Review the source location only if you moved the Copilot history folder.", aliases: "missing absent ENOENT" },
        permission: { label: "Access denied to saved Copilot chat history", explanation: "Your computer blocked WIRE from opening this chat's history. New activity from it cannot be collected until access is restored.", guidance: "Check access to the approved history folder, then try Refresh. WIRE cannot change your computer's file permissions.", aliases: "permission unreadable EACCES EPERM" },
        read: { label: "Saved Copilot chat history file could not be read", explanation: "WIRE could not open this chat's history during the check. Activity that has not already been collected may be missing.", guidance: "Check that the history folder or drive is available, then try Refresh. Previously collected activity is kept.", aliases: "read error unreadable busy" },
        unsupported: { label: "Saved Copilot chat history could not be verified", explanation: "WIRE could not verify this file's chat identity or format, so no new activity was read from it. Previously collected activity is kept.", guidance: "There is no repair action for this format in WIRE. Technical details below can help with support; changing source paths is not a format repair.", aliases: "unsupported invalid source startup identity schema" },
        unknown: { label: "Saved Copilot chat history read failed for an unknown reason", explanation: "WIRE could not read this chat's history and could not establish why. Activity that has not already been collected may be missing.", guidance: "Technical details below can help with support. There is no known repair to recommend until the cause is established.", aliases: "unknown unreadable failed" },
        truncated: { label: "Earlier Copilot chat history may be incomplete", explanation: "WIRE first reads the last 64 MiB, then reads earlier history in small batches within the approved window. Some entries or links may still be missing.", guidance: "Automatic collection continues the remaining batches. While paused, Refresh advances one bounded cycle. Skipped entries and missing links remain disclosed.", aliases: "truncated older tail size cap backfill" },
        malformed: { label: "Some Copilot chat history entries have an invalid format", explanation: "Some prompts, actions or results may be missing because WIRE could not read their saved format. Other readable entries can still be collected.", guidance: "WIRE cannot reconstruct the skipped entries. Refreshing the same history again will not repair their format.", aliases: "malformed invalid JSON unsupported message unreadable entries decoded" },
        oversized: { label: "Some Copilot chat history entries exceed the size limit", explanation: "Entries larger than 1 MiB are not retained in full. For some larger tool results, WIRE can recover the recorded completion status; the result body and other missing details stay unavailable.", guidance: "A recovered tool status does not restore the omitted result or prove that an HTTP request succeeded.", aliases: "oversized large size cap" },
        context: { label: "Some request-to-action links may be incomplete", explanation: "An action or result may not be linked to the prompt it belongs to. WIRE could not retain enough earlier chat context to connect them; collected activity is kept.", guidance: "This does not mean the action or service failed. Inspect the chat's collected activity if a prompt, action or result looks disconnected.", aliases: "context not retained correlation evictions relationships" },
    };
    const checkSummaries = {
        missing: "The history file was not found. Checking again cannot recreate an absent file. Review the source location only if you moved the history folder.",
        permission: "The operating system denied access. Check access to the approved source before checking again.",
        read: "A local file error prevented reading. Check source access; a later check may succeed.",
        unsupported: "The opening record or chat identity could not be verified. WIRE will not guess or repair the format.",
        unknown: "The read failed for an unknown reason. Technical details may help with support; no repair is known.",
        truncated: "The initial read covers the last 64 MiB. Earlier history is read in bounded batches; finishing the byte range does not prove every entry or link was retained.",
        malformed: "Invalid or unsupported history content was skipped. Readable entries remain; missing content cannot be reconstructed.",
        oversized: "Entries over 1 MiB remain excluded in full. A bounded tool completion status may be recovered, but its omitted result and missing links remain unavailable.",
        context: "Older linking context exceeded the collector's working-memory limit. Request, action or result links may be absent; collected evidence stays.",
    };
    const reasonTitles = {
        missing: "History file not found",
        permission: "History access denied",
        read: "History file read error",
        unsupported: "History format not verified",
        unknown: "History read failed: cause unknown",
        truncated: "Older history beyond read limit",
        malformed: "Invalid history entries",
        oversized: "History entries above size limit",
        context: "Incomplete request-to-action links",
    };
    function searchTerms(row) {
        return [row.name, row.project, row.sessionId, row.unavailable ? "Unavailable history" : "Limited history",
            ...row.reasons.flatMap(reason => [reason, reasonTitles[reason], reasons[reason]?.label, reasons[reason]?.aliases])];
    }
    function impact(coverage, { pending = coverage?.pending, unfinished = 0, unchecked = 0, skipped = 0, enabled } = {}) {
        const c = coverage ?? {}, validCount = value => Number.isSafeInteger(value) && value >= 0;
        const groups = Object.entries(c.groups ?? {}).filter(([, total]) => validCount(total) && total > 0);
        const classified = validCount(c.unavailable) && validCount(c.limited) && groups.length > 0
            && Object.values(c.groups ?? {}).every(validCount)
            && groups.every(([code]) => Object.hasOwn(reasons, code))
            && groups.reduce((total, [, amount]) => total + amount, 0) === c.unavailable + c.limited;
        const progressKnown = [pending, unfinished, unchecked, skipped].every(validCount);
        const continuing = pending > 0 || unchecked > 0;
        const affected = c.unavailable > 0 || c.limited > 0 || c.affected > 0;
        const linkGaps = classified && groups.some(([code]) => code === "context");
        const onlyLinks = linkGaps && c.unavailable === 0 && groups.every(([code]) => code === "context");
        const fixedGaps = classified && progressKnown && groups.every(([code]) =>
            ["missing", "truncated", "oversized", "malformed", "context"].includes(code));
        let explanation = c.eligible > 0 && c.unavailable === c.eligible && pending === 0 && unchecked === 0
            ? "New activity from these chats couldn't be collected. WIRE couldn't read any of their history."
            : onlyLinks ? "Some prompts may not be linked to their actions or results. Collected activity is still available."
            : affected && linkGaps
                ? "Some activity or links between prompts and actions may be missing from WIRE because parts of chat history couldn't be read."
            : affected ? "Some activity may be missing from WIRE because parts of chat history couldn't be fully included."
            : continuing ? "Some activity may not appear yet: this refresh didn't finish reading all chat history."
            : unfinished > 0 ? "Recent activity may not appear yet because Copilot was still saving some history."
            : skipped > 0 ? "Activity from some chats may be missing because those chats were not checked."
            : "Some activity may be missing from WIRE. The check couldn't confirm how much history was included.";
        if (onlyLinks) {
            if (continuing) explanation += " More history remains to be read, so additional activity may not appear yet.";
            if (unfinished > 0) explanation += " Copilot was still saving some history; recent activity may not appear yet.";
            if (skipped > 0) explanation += " Some chats were not checked, so their activity may be missing.";
            if (!progressKnown) explanation += " The check couldn't confirm whether all history was read.";
        }
        const guidance = (continuing ? enabled === true
            ? "Automatic checks can continue reading the remaining history." + (affected && !linkGaps ? " Other reported gaps may remain." : "")
            : enabled === false ? "Refresh can continue reading the remaining history; automatic collection stays paused."
                : "Check collection progress before trying again; automatic collection could not be confirmed."
            : unfinished > 0 ? "Try Refresh after Copilot finishes saving. Already collected activity is kept."
            : onlyLinks ? "This does not mean an action failed. Refresh alone won't repair links between a prompt and its actions or results."
            : fixedGaps && !skipped ? "Repeating Refresh alone won't fix these gaps. Collected activity is kept."
            : "See collection details for the cause and any useful next step. Collected activity is kept.")
            + (linkGaps && (continuing || unfinished > 0)
                ? " Further reading does not guarantee that missing prompt-to-action links will be restored." : "");
        return { explanation, guidance, action: {
            label: affected ? "See currently affected chats" : continuing || unfinished > 0 ? "View collection progress" : "View collection details",
            href: affected ? "#collection-status?setting=issues" : "#collection-status",
        } };
    }
    function coverage(roster = [], cursors = [], evidenceIds = []) {
        const saved = new Map(cursors.map(row => [row.sessionId, row]));
        const retained = new Set(evidenceIds), issues = [], seen = new Set();
        const summary = { eligible: 0, readable: 0, pending: 0, unavailable: 0, limited: 0, affected: 0, groups: {}, excluded: {} };
        for (const source of roster) {
            if (seen.has(source.sessionId)) continue;
            seen.add(source.sessionId);
            if (!source.eligible) {
                const disposition = source.disposition ?? "unknown";
                summary.excluded[disposition] = (summary.excluded[disposition] ?? 0) + 1;
                continue;
            }
            summary.eligible++;
            const row = saved.get(source.sessionId), categories = [];
            if (row?.error) {
                categories.push(row.errorCode === "ENOENT" ? "missing"
                    : ["EACCES", "EPERM"].includes(row.errorCode) ? "permission"
                    : ["EIO", "EBUSY", "EMFILE", "ENFILE", "EISDIR", "ENOTDIR"].includes(row.errorCode) ? "read"
                    : ["HISTORY_STARTUP_INVALID", "HISTORY_IDENTITY_UNSUPPORTED"].includes(row.errorCode) ? "unsupported" : "unknown");
                summary.unavailable++;
            } else if (row?.scanned) summary.readable++;
            if (!row || (!row.error && (!row.scanned || row.backfillPending === true
                || (row.cursor?.backlogBytes ?? 0) > (row.cursor?.partialBytes ?? 0)))) summary.pending++;
            for (const [key, amount] of [["truncated", Math.max(row?.cursor?.droppedBytes ?? 0, row?.backfill?.omittedBytes ?? 0)],
                ["malformed", (row?.cursor?.malformedLines ?? 0) + (row?.diagnostics?.unsupportedPromptContents ?? 0) + (row?.backfill?.malformedLines ?? 0)],
                ["oversized", (row?.cursor?.oversizedLines ?? 0) + (row?.backfill?.oversizedLines ?? 0)],
                ["context", (row?.diagnostics?.contextEvictions ?? 0) + (row?.backfill?.contextEvictions ?? 0)]]) {
                if (amount > 0) categories.push(key);
            }
            if (!categories.length) continue;
            if (!row.error) summary.limited++;
            summary.groups[categories[0]] = (summary.groups[categories[0]] ?? 0) + 1;
            issues.push({
                sessionId: source.sessionId, name: source.name || "Copilot chat name not recorded",
                project: source.project || null, projectId: source.projectId || null,
                reasons: categories, unavailable: Boolean(row.error), lastAttemptAt: row.lastAttemptAt ?? null,
                hasPriorEvidence: retained.has(source.sessionId),
            });
        }
        summary.affected = issues.length;
        return { summary, issues };
    }
    function view(status) {
        const control = native(status);
        if (control) return { severity: "normal", ...nativePage(control, persistence(status), nativeUnavailable(status)) };
        const c = status.historyCoverage ?? {};
        const allUnavailable = c.eligible > 0 && c.unavailable === c.eligible && !c.pending;
        const severity = status.error || allUnavailable || status.state === "stopped" ? "error"
            : c.affected || c.unavailable || c.limited ? "warning" : "normal";
        const label = !status.config ? "Set up collection"
            : status.error ? "Collection cannot check history"
            : status.state === "stopped" ? "Collection stopped"
            : status.state === "paused" ? "Collection paused"
            : !status.discovery || !status.lastCheckedAt ? "Checking history"
            : allUnavailable ? "History unavailable"
            : c.pending ? "Importing history"
            : status.state === "collecting" ? "Checking history"
            : c.eligible === 0 ? "No local Copilot chats to collect" : "Collection active";
        return { label, severity };
    }
    function entry(status, { hasEvidence = false, unavailable = false, reason = "" } = {}) {
        const retained = hasEvidence ? " Retained evidence is still available." : "";
        if (unavailable) return { severity: "error",
            text: (reason === "runtime_unavailable" ? "Local runtime unavailable. Start WIRE if it is stopped, then retry." : "Collection status unavailable. Retry the connection.")
                + (hasEvidence ? " Showing the last accepted view." : ""),
            action: "View collection status" };
        if (!status) return null;
        const control = native(status);
        if (control) {
            const saved = persistence(status);
            const unavailable = nativeUnavailable(status);
            if (!unavailable && control.enabled && control.connected && control.retained && (!saved || saved.actions.includes("collect-now"))) return null;
            const state = nativePage(control, saved, unavailable);
            return { severity: state.severity || "normal", text: state.guidance, action: state.action?.label || "Open Settings",
                href: state.action?.href || "#settings?section=connection&setting=collection-state" };
        }
        if (!status.config?.approved) return { severity: "normal",
            text: hasEvidence ? "Collection is not connected. Retained evidence is available." : "Connect local Copilot chats to collect Work IQ activity.",
            action: "Review source in Settings" };
        const state = view(status);
        if (state.severity === "error") return { severity: "error", text: state.label + "." + retained,
            action: state.label === "History unavailable" ? "View history issues" : "View collection status", issues: state.label === "History unavailable" };
        if (status.state === "paused") return { severity: "normal", text: "Collection is paused." + retained, action: "Open Settings" };
        // Routine checks and historical gaps belong in Collection status, not the entry viewport.
        if (!hasEvidence) {
            if (!status.discovery || !status.lastCheckedAt || status.historyCoverage?.pending) return {
                severity: "normal", text: "Reading approved Copilot chat history. No activity collected yet.", action: "View collection details" };
            if (status.historyCoverage?.eligible === 0) return {
                severity: "normal", text: "No verified local Copilot chat histories were found.", action: "Review source in Settings" };
        }
        return null;
    }
    function sourceEntry(sources, current, { microsoftState: ms, unavailable = false, githubFailure = "", microsoftOperationUnconfirmed = false } = {}) {
        const saved = sources.microsoft.status, github = sources.github.status;
        const unconfirmed = saved.blockers.includes("NATIVE_RETENTION_OPERATION_UNKNOWN");
        const stopped = saved.blockers.includes("NATIVE_RETENTION_AUTOMATIC_STOPPED");
        const canCollect = current.actions.microsoft.includes("collect-now");
        const paused = sources.global.state === "committed" && sources.global.paused;
        const disconnected = ["disconnected", "reconnect-required"].includes(ms)
            || current.current && !ms && saved.kind === "native-account-unavailable";
        let text;
        if (!current.current || unavailable) text = githubFailure || "Collection status unavailable. Refresh to try again.";
        else if (paused) text = "Collection is paused.";
        else {
            const microsoft = ["signing-in", "handoff"].includes(ms) ? "Microsoft sign-in is in progress."
                : ms === "recovery-required" ? "Microsoft connection needs recovery."
                : disconnected ? "Microsoft 365 is not connected."
                : ms !== "connected" ? "Microsoft connection status is unavailable."
                : unconfirmed ? "Microsoft collection is unconfirmed. " + (microsoftOperationUnconfirmed
                    ? "Read the original result in Settings." : canCollect ? "Start a new collection in Settings." : "Check its status in Settings.")
                : stopped ? "Automatic Microsoft collection stopped after an error. " + (canCollect ? "Start a new collection in Settings." : "Check its connection in Settings.")
                : saved.configured && saved.configuration.settings.paused ? "Microsoft collection is paused."
                : !saved.configured ? "Microsoft collection is not enabled."
                : !canCollect ? "Microsoft collection is unavailable." : "";
            const githubNotice = githubFailure || (!github.config?.approved ? "GitHub collection is not set up."
                : github.state === "paused" ? "GitHub collection is paused." : "");
            text = disconnected && !github.config?.approved && !githubFailure ? "Connect a source in Settings."
                : [microsoft, githubNotice].filter(Boolean).join(" ");
        }
        return text ? { text, action: "Connection settings",
            href: "#settings?section=connection&setting=" + (unconfirmed || stopped ? "microsoft-collection" : "microsoft-connection"),
            severity: unavailable || githubFailure ? "error" : unconfirmed || stopped ? "warning" : "normal" } : null;
    }
    // Page health describes the collector; history coverage remains a separate result.
    function page(status) {
        const control = native(status);
        if (control) return nativePage(control, persistence(status), nativeUnavailable(status));
        const c = status.historyCoverage, approved = status.config?.approved;
        const sourceAction = { label: "Review source in Settings", href: "#settings?section=connection&setting=source" };
        if (!approved) return { label: "Not connected", guidance: "Collection is optional. Connect a local source to collect new evidence; retained evidence stays available.", action: sourceAction };
        if (status.error || status.state === "error") return { label: "Collection cannot check history", severity: "error",
            guidance: "Review the source and the error below. Previously collected evidence is kept.", action: sourceAction };
        if (status.state === "stopped") return { label: "Collection stopped", severity: "error",
            guidance: "Collection is not running. Start the WIRE runtime to collect new activity. Previously collected evidence is kept." };
        if (status.state === "disconnected") return { label: "Collection disconnected", severity: "error",
            guidance: "The approved source is not connected. Review the source in Settings. Previously collected evidence is kept.", action: sourceAction };
        if (status.state === "paused") return { label: "Collection paused",
            guidance: "Automatic checks are paused. Resume in Settings when you want new activity collected. Previously collected evidence is kept.",
            action: { label: "Resume in Settings", href: "#settings?section=connection&setting=collection-state" } };
        if (!status.discovery || !status.lastCheckedAt) return { label: "Checking history",
            guidance: "Waiting for the first check of approved history. No reading result is available yet." };
        if (status.state === "collecting") return { label: "Checking history",
            guidance: "Reading approved local history. You can keep browsing previously collected evidence." };
        if (c?.eligible === 0) return { label: "Collection active",
            guidance: "No eligible local chats were found. Review the approved source if you expected chats here.", action: sourceAction };
        if (c?.eligible > 0 && c.unavailable === c.eligible) return { label: "Chat history couldn't be read", severity: "error",
            guidance: "New activity from these chats cannot be collected yet. Previously collected activity is kept; see the reasons below." };
        if (c?.pending) return { label: "Collection active",
            guidance: "Some history is still being read. Automatic checks will continue; other reported gaps may remain." };
        const effect = c && (c.affected > 0 || c.unavailable > 0 || c.limited > 0) ? impact(c, { enabled: status.config.enabled }) : null;
        return { label: "Collection active", guidance: effect
            ? `${effect.explanation} ${effect.guidance}`
            : "No action is needed. Approved local history is checked automatically." };
    }
    return { reasons, reasonTitles, checkSummaries, dispositions, coverage, impact, view, entry, sourceEntry, page, searchTerms, native,
        persistence, persistenceReason, nativeReceipt, nativeReadbackCurrent, nativeReadbackMatches,
        nativeUnavailable, nativeUnavailableCurrent, nativeUnavailableMatches };
}
