export type WorkspaceRoute = { view: string; [key: string]: unknown };
export type AcceptedWorkspace<E, S, A> = { evidence: E; scope: S; analytics: A; route: WorkspaceRoute };
export type WorkspaceIntent = Readonly<{ authority: object; navigation: number; reading: number }>;
export type WorkspacePresentation = Readonly<{
    version: number; active: string; view: string;
    phase: "unavailable" | "pending" | "ready" | "stale";
}>;

export function createWorkspaceState<E extends object = object, S extends object = object, A extends object = object>(
    { isCurrent, releaseReading }: {
        isCurrent: (authority: object) => boolean;
        releaseReading?: (reading: Record<string, unknown>) => void;
    },
) {
    let evidence: E | undefined, scope: S | undefined, analytics: A | undefined;
    let route: WorkspaceRoute = { view: "analyze" }, acceptedRoute: WorkspaceRoute | undefined;
    let readGeneration = 0, loading = false, stale = false;
    let navigationGeneration = 0, readingIntent = 0;
    let dateDraft: Record<string, unknown> | null = null;
    const positions = new Map<string, Record<string, unknown>>();
    const listeners = new Set<() => void>();
    let active = "analyze", view = "analyze";
    let presentation: WorkspacePresentation = Object.freeze({ version: 0, active, view, phase: "unavailable" });
    function publish() {
        const phase = loading ? "pending" : !evidence ? "unavailable" : stale ? "stale" : "ready";
        if (phase === presentation.phase && active === presentation.active && view === presentation.view) return;
        presentation = Object.freeze({ version: presentation.version + 1, active, view, phase });
        const errors: unknown[] = [];
        for (const listener of listeners) {
            try { listener(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, "Workspace presentation could not update safely.");
    }
    function readCurrent(request: number, authority: object) {
        return request === readGeneration && isCurrent(authority) === true && request === readGeneration;
    }
    function retire() {
        readGeneration++; navigationGeneration++; readingIntent++;
    }
    function clear() {
        evidence = scope = analytics = acceptedRoute = undefined;
        route = { view: "analyze" };
        dateDraft = null;
        loading = false; stale = true;
        const errors: unknown[] = [];
        for (const saved of positions.values()) {
            try { releaseReading?.(saved); } catch (error) { errors.push(error); }
        }
        positions.clear();
        try { publish(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "Workspace reading positions could not be retired.");
    }
    return {
        positions,
        getSnapshot: () => presentation,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        present(next: { active: string; view: string }) {
            const destinations = ["analyze", "trends", "reports", "compare", "settings", "request", "collection-status"];
            if (!destinations.includes(next.active) || !destinations.includes(next.view)) {
                throw new TypeError("Workspace presentation requires a supported public destination.");
            }
            ({ active, view } = next);
            publish();
        },
        get evidence() { return evidence; },
        set evidence(value: E | undefined) { evidence = value; },
        get scope() { return scope; },
        get analytics() { return analytics; },
        set analytics(value: A | undefined) { analytics = value; },
        get route() { return route; },
        set route(value: WorkspaceRoute) { route = value; },
        get acceptedRoute() { return acceptedRoute; },
        set acceptedRoute(value: WorkspaceRoute | undefined) { acceptedRoute = value; },
        get loading() { return loading; },
        set loading(value: boolean) { loading = value; publish(); },
        get stale() { return stale; },
        set stale(value: boolean) { stale = value; publish(); },
        get dateDraft() { return dateDraft; },
        set dateDraft(value: Record<string, unknown> | null) { dateDraft = value; },
        get readGeneration() { return readGeneration; },
        get navigationGeneration() { return navigationGeneration; },
        get readingIntent() { return readingIntent; },
        beginNavigation() { return ++navigationGeneration; },
        noteReading() { return ++readingIntent; },
        invalidateRead() { return ++readGeneration; },
        captureIntent(authority: object): WorkspaceIntent {
            return Object.freeze({ authority, navigation: navigationGeneration, reading: readingIntent });
        },
        intentCurrent(intent: WorkspaceIntent) {
            const matches = () => intent.navigation === navigationGeneration && intent.reading === readingIntent;
            return matches() && isCurrent(intent.authority) === true && matches();
        },
        beginRead(authority: object) {
            const generation = readGeneration;
            if (isCurrent(authority) !== true || generation !== readGeneration) return null;
            loading = true; stale = Boolean(analytics);
            const request = ++readGeneration;
            publish();
            return request;
        },
        readCurrent,
        acceptRead(request: number, authority: object, accepted: AcceptedWorkspace<E, S, A>) {
            if (!readCurrent(request, authority)) return false;
            ({ evidence, scope, analytics, route } = accepted);
            acceptedRoute = { ...route };
            loading = stale = false;
            publish();
            return true;
        },
        failRead(request: number, authority: object) {
            if (!readCurrent(request, authority)) return false;
            loading = false; stale = Boolean(analytics);
            publish();
            return true;
        },
        retire,
        clear,
        withdrawAccess() { retire(); clear(); },
    };
}
