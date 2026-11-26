const captures = new WeakMap();
const object = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
const stops = new Set(["page-budget", "history-budget", "byte-budget", "record-budget", "time-budget", "membership-budget", "unreadable-history", "continuity-lost", "membership-unqualified"]);
const fail = () => { throw Object.assign(new TypeError("Invalid bounded native history progress."), { code: "NATIVE_BACKFILL_INVALID" }); };
export const NATIVE_BACKFILL_LIMIT = 10000;

export function validateNativeHistoryObservation(value) {
    if (!exact(value, ["schemaVersion", "surface", "actionId", "control", "view", "association"])
        || value.schemaVersion !== 1 || !["chat", "cowork"].includes(value.surface)
        || typeof value.actionId !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.actionId)
        || !exact(value.control, ["match", "name", "selected",
            ...(object(value.control) && Object.hasOwn(value.control, "entry") ? ["entry"] : [])])
        || !["unique", "missing", "ambiguous"].includes(value.control.match)
        || Object.hasOwn(value.control, "entry")
            && (!["chat-all", "cowork-root", "cowork-my-tasks", "unobserved"].includes(value.control.entry)
                || value.control.entry !== "unobserved" && (value.surface === "chat"
                    ? value.control.entry !== "chat-all" : !["cowork-root", "cowork-my-tasks"].includes(value.control.entry)))
        || !["history", "all-history", "all-chats", "chat", "cowork", "unobserved"].includes(value.control.name)
        || !["yes", "no", "unobserved"].includes(value.control.selected)
        || !exact(value.view, ["region", "heading", "search", "filter"])
        || !["controlled", "main", "unobserved", "ambiguous"].includes(value.view.region)
        || !["history", "all-history", "all-chats", "unobserved"].includes(value.view.heading)
        || !["empty", "nonempty", "unobserved", "ambiguous"].includes(value.view.search)
        || !["all-selected", "restricted-or-unknown", "unobserved", "ambiguous"].includes(value.view.filter)
        || !exact(value.association, ["state", "request", "response", "selectedNavigation", "frameMatched", "loaderMatched", "epochMatched", "accountMatched", "accountBinding", "requestFilterPresent",
            ...(object(value.association) && Object.hasOwn(value.association, "chatRequestBasis") ? ["chatRequestBasis"] : [])])
        || Object.hasOwn(value.association, "chatRequestBasis")
            && (!["empty-reset-shape", "continuation", "cached-seed", "ssr-initializer", "unobserved"].includes(value.association.chatRequestBasis)
                || value.surface !== "chat" && value.association.chatRequestBasis !== "unobserved")
        || !["principal-context", "request-headers", "unobserved"].includes(value.association.accountBinding)
        || value.association.accountMatched !== (value.association.accountBinding !== "unobserved")
        || !["unobserved", "ordered", "late", "unrelated", "ambiguous", "owner-lost"].includes(value.association.state)
        || ["request", "response"].some(key => value.association[key] !== null && !hash(value.association[key]))
        || ["selectedNavigation", "frameMatched", "loaderMatched", "epochMatched", "accountMatched", "requestFilterPresent"]
            .some(key => typeof value.association[key] !== "boolean")
        || value.association.state === "ordered" && (!value.association.request || !value.association.response
            || !value.association.frameMatched || !value.association.loaderMatched || !value.association.epochMatched || !value.association.accountMatched)) fail();
    return value;
}

export function createNativeHistoryObservation(surface, actionId) {
    return validateNativeHistoryObservation({ schemaVersion: 1, surface, actionId,
        control: { match: "missing", name: "unobserved", selected: "unobserved", entry: "unobserved" },
        view: { region: "unobserved", heading: "unobserved", search: "unobserved", filter: "unobserved" },
        association: { state: "unobserved", request: null, response: null, selectedNavigation: false,
            frameMatched: false, loaderMatched: false, epochMatched: false, accountMatched: false, accountBinding: "unobserved",
            requestFilterPresent: false, chatRequestBasis: "unobserved" } });
}

export function validateNativeHistoryObservations(values) {
    if (!Array.isArray(values) || !values.length || values.length > 2) fail();
    values.forEach(validateNativeHistoryObservation);
    if (new Set(values.map(value => value.surface)).size !== values.length) fail();
    return values;
}

export function validateNativeBackfill(value) {
    if (!exact(value, ["schemaVersion", "accountRef", "privacyRevision", "windowDays", "window", "sources",
        ...(object(value) && Object.hasOwn(value, "deletionVersion") ? ["deletionVersion"] : [])])
        || value.schemaVersion !== 1 || !hash(value.accountRef) || !integer(value.windowDays) || value.windowDays < 1 || value.windowDays > 90
        || Object.hasOwn(value, "deletionVersion") && !integer(value.deletionVersion)
        || !integer(value.privacyRevision) || value.privacyRevision < 1
        || !exact(value.window, ["from", "to"]) || !date(value.window.from) || !date(value.window.to)
        || Date.parse(value.window.to) - Date.parse(value.window.from) !== value.windowDays * 86400000
        || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 2
        || value.sources.some(source => !object(source))
        || new Set(value.sources.map(row => row.surface)).size !== value.sources.length) fail();
    for (const source of value.sources) {
        if (!exact(source, ["surface", "startQualified", "controlObserved", "initial", "pages", "chain", "chainPages", "exhausted", "histories", "stops",
            ...(Object.hasOwn(source, "observation") ? ["observation"] : []),
            ...(Object.hasOwn(source, "coworkCursor") ? ["coworkCursor"] : []),
            ...(Object.hasOwn(source, "chatCursor") ? ["chatCursor"] : [])])
            || !["chat", "cowork"].includes(source.surface) || typeof source.startQualified !== "boolean"
            || typeof source.controlObserved !== "boolean" || !["unobserved", "absent", "null", "empty", "present"].includes(source.initial)
            || source.startQualified && (!source.controlObserved || source.initial === "unobserved")
            || source.chain !== null && !hash(source.chain) || !integer(source.chainPages) || source.chainPages > NATIVE_BACKFILL_LIMIT
            || (source.chain === null) !== (source.chainPages === 0)
            || typeof source.exhausted !== "boolean" || !Array.isArray(source.pages) || source.pages.length > NATIVE_BACKFILL_LIMIT
            || source.exhausted && (source.pages.length === 0 || source.chainPages === 0)
            || source.pages.some(page => !hash(page)) || new Set(source.pages).size !== source.pages.length
            || !Array.isArray(source.histories) || source.histories.length > NATIVE_BACKFILL_LIMIT
            || source.histories.some(history => !object(history))
            || new Set(source.histories.map(row => row.key)).size !== source.histories.length
            || !Array.isArray(source.stops) || source.stops.some(stop => !stops.has(stop)) || new Set(source.stops).size !== source.stops.length) fail();
        for (const history of source.histories) if (!exact(history, ["key", "activity", "handledActivity", "handledThrough", "state"])
            || !hash(history.key) || !integer(history.activity)
            || history.handledActivity !== null && !integer(history.handledActivity)
            || history.handledThrough !== null && !integer(history.handledThrough)
            || !["pending", "handled", "suppressed", "unreadable"].includes(history.state)
            || ["handled", "suppressed"].includes(history.state)
                && (history.handledActivity !== history.activity || history.handledThrough === null)) fail();
        if (Object.hasOwn(source, "observation") && validateNativeHistoryObservation(source.observation).surface !== source.surface) fail();
        if (Object.hasOwn(source, "coworkCursor") && (source.surface !== "cowork"
            || !exact(source.coworkCursor, ["parentAfter", "referenceAfter"])
            || Object.values(source.coworkCursor).some(value => value !== null && !hash(value)))) fail();
        if (Object.hasOwn(source, "chatCursor") && (source.surface !== "chat"
            || !exact(source.chatCursor, ["referenceAfter"])
            || source.chatCursor.referenceAfter !== null && !hash(source.chatCursor.referenceAfter))) fail();
    }
    if (value.sources.reduce((count, source) => count + source.histories.length, 0) > NATIVE_BACKFILL_LIMIT) fail();
    return value;
}

export function createNativeBackfill(accountRef, windowDays, surfaces, privacyRevision, previous, now = Date.now(), deletionVersion = 0) {
    if (!hash(accountRef) || !integer(windowDays) || windowDays < 1 || windowDays > 90 || !integer(privacyRevision) || privacyRevision < 1
        || !Array.isArray(surfaces) || !surfaces.length || surfaces.length > 2
        || surfaces.some(surface => !["chat", "cowork"].includes(surface)) || new Set(surfaces).size !== surfaces.length
        || !integer(now) || !Number.isFinite(new Date(now).getTime()) || !integer(deletionVersion)) fail();
    if (previous) validateNativeBackfill(previous);
    const sameScope = previous?.accountRef === accountRef && previous.windowDays === windowDays && previous.privacyRevision === privacyRevision
        && (previous.deletionVersion ?? 0) === deletionVersion
        && JSON.stringify(previous.sources.map(row => row.surface).sort()) === JSON.stringify([...surfaces].sort());
    const previousRoundFinished = sameScope && previous.sources.every(source => source.exhausted
        && !source.stops.includes("membership-budget") && source.histories.every(row => ["handled", "suppressed"].includes(row.state)));
    if (sameScope && !previousRoundFinished) return structuredClone(previous);
    return validateNativeBackfill({
        schemaVersion: 1, accountRef, privacyRevision, windowDays, deletionVersion,
        window: { from: new Date(now - windowDays * 86400000).toISOString(), to: new Date(now).toISOString() },
        sources: [...surfaces].sort().map(surface => ({ surface, startQualified: false, controlObserved: false, initial: "unobserved",
            pages: [], chain: null, chainPages: 0, exhausted: false, histories: sameScope
                ? previous.sources.find(row => row.surface === surface).histories.filter(row => row.activity >= now - windowDays * 86400000)
                    .map(row => ({ ...row })) : [], stops: [] })),
    });
}

export function nativeBackfillSummary(value) {
    validateNativeBackfill(value);
    const sources = value.sources.map(source => {
        const count = state => source.histories.filter(row => row.state === state).length;
        return { surface: source.surface, startQualified: source.startQualified, controlObserved: source.controlObserved,
            initial: source.initial, pages: source.pages.length, chainPages: source.chainPages, exhausted: source.exhausted,
            eligible: source.histories.length, handled: count("handled"), suppressed: count("suppressed"),
            pending: count("pending"), unreadable: count("unreadable"), stops: [...source.stops] };
    });
    const complete = sources.every(source => source.exhausted && source.pending === 0 && source.unreadable === 0
        && !source.stops.includes("membership-budget"));
    return { schemaVersion: 1, window: { ...value.window },
        state: complete ? sources.every(source => source.startQualified) ? "covered" : "unqualified"
            : sources.some(source => source.pages || source.eligible) ? "progressing" : "started", sources };
}

export function validateNativeBackfillSummary(value) {
    if (!exact(value, ["schemaVersion", "window", "state", "sources"]) || value.schemaVersion !== 1
        || !exact(value.window, ["from", "to"]) || !date(value.window.from) || !date(value.window.to)
        || Date.parse(value.window.from) >= Date.parse(value.window.to)
        || !["started", "progressing", "unqualified", "covered"].includes(value.state)
        || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 2
        || value.sources.some(source => !object(source))
        || new Set(value.sources.map(row => row.surface)).size !== value.sources.length) fail();
    for (const row of value.sources) if (!exact(row, ["surface", "startQualified", "controlObserved", "initial", "pages", "chainPages",
        "exhausted", "eligible", "handled", "suppressed", "pending", "unreadable", "stops"])
        || !["chat", "cowork"].includes(row.surface) || typeof row.startQualified !== "boolean" || typeof row.controlObserved !== "boolean"
        || !["unobserved", "absent", "null", "empty", "present"].includes(row.initial) || typeof row.exhausted !== "boolean"
        || row.startQualified && (!row.controlObserved || row.initial === "unobserved")
        || row.exhausted && (row.pages === 0 || row.chainPages === 0)
        || ["pages", "chainPages", "eligible", "handled", "suppressed", "pending", "unreadable"].some(key => !integer(row[key]) || row[key] > NATIVE_BACKFILL_LIMIT)
        || row.eligible !== row.handled + row.suppressed + row.pending + row.unreadable
        || !Array.isArray(row.stops) || row.stops.some(stop => !stops.has(stop)) || new Set(row.stops).size !== row.stops.length
        || value.state === "covered" && (!row.startQualified || !row.controlObserved || !row.exhausted || row.pending || row.unreadable
            || row.initial === "unobserved" || row.stops.includes("membership-budget"))) fail();
    const exhausted = value.sources.every(row => row.exhausted && row.pending === 0 && row.unreadable === 0
        && !row.stops.includes("membership-budget"));
    const expected = exhausted ? value.sources.every(row => row.startQualified) ? "covered" : "unqualified"
        : value.sources.some(row => row.pages || row.eligible) ? "progressing" : "started";
    if (value.state !== expected) fail();
    return value;
}

export function attachNativeBackfill(envelopes, value) {
    if (!Array.isArray(envelopes) || captures.has(envelopes)) fail();
    validateNativeBackfill(value);
    captures.set(envelopes, structuredClone(value));
    return envelopes;
}

export const nativeBackfillFor = envelopes => captures.has(envelopes) ? structuredClone(captures.get(envelopes)) : null;
