// Serialized for the inline shell as well as imported by the runtime and bundled clients.
export function createPagePaths() {
    const pages = ["analyze", "trends", "reports", "compare", "settings", "request", "collection-status", "help", "documentation"];
    const helpTopics = ["reports", "history", "counts", "results", "updates"];
    const aliases = ["report", "home", "overview", "activity", "calls"];
    const fields = "layer chart bucket timelineFrom range from to source tool services includeMissingService withinServices service project result authors scope endpoint session request page expanded origin issues section setting task mode call callSort callRevision completedCalls failedCalls compare aFrom aTo bFrom bTo bundle inspect order nativeSource nativeRevision nativeSourceRevision nativeOrdinal nativeCompletedRef nativeGroup comparisonView comparisonFocus widget guideTopic".split(" ");
    const trendMeasures = ["rhythm", "problems", "tools", "services", "timing", "authors", "models", "usage"];
    const trendPeriods = ["7", "14", "30", "custom"];
    const trendSections = ["overview", "charts", "guide"];
    const trendFields = { measure: "trendMeasure", period: "trendPeriod", from: "trendFrom", to: "trendTo", section: "trendSection" };
    const scopeKeys = new Set("layer chart bucket timelineFrom range from to source tool services includeMissingService withinServices service project result authors scope endpoint session aFrom aTo bFrom bTo comparisonFocus comparisonView nativeGroup trendMeasure trendPeriod trendFrom trendTo page expanded order".split(" "));
    const trendSection = route => route.trendSection ?? (route.trendMeasure || route.trendPeriod || route.trendEntry ? "charts" : "overview");
    const isPagePath = path => path === "/" || pages.some(page => path === "/" + page || path === "/" + page + "/");
    const legacy = hash => hash.startsWith("#") && [...pages, ...aliases].includes(hash.slice(1).split("?")[0]);
    function parse(address) {
        const [path, query = ""] = address.split(/\?(.*)/s);
        const fragment = path.startsWith("#");
        if (!(fragment ? legacy(address) : isPagePath(path))) return null;
        const raw = fragment ? path.slice(1) : path.replaceAll("/", "") || "analyze";
        const view = raw === "report" ? "reports" : raw === "compare" ? "analyze" : raw;
        const params = new URLSearchParams(query);
        const route = { view };
        if (view === "settings" && params.get("section") === "release-notes") {
            const release = params.get("release");
            return { view, section:"release-notes", ...(/^v\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(release ?? "") && { release }) };
        }
        if (view === "documentation") {
            // A guide slug, never a path. Heading fragments stay in the address hash, not the route.
            const guide = params.get("guide");
            return { view, guide: typeof guide === "string" && /^[a-z0-9._-]{1,80}$/.test(guide) ? guide : "" };
        }
        if (view === "help") {
            const topic = params.get("topic");
            return { view, section: helpTopics.includes(topic) ? topic : "reports" };
        }
        if (view === "trends") {
            // These are display selections, not Analyze/snapshot filters.
            for (const key of params.keys()) {
                if (params.getAll(key).length !== 1 || !Object.hasOwn(trendFields, key) && key !== "privateView")
                    return { view, trendUnavailable: true };
                if (key !== "privateView") route[trendFields[key]] = params.get(key);
            }
            if (route.trendMeasure !== undefined && !trendMeasures.includes(route.trendMeasure)
                || route.trendSection !== undefined && !trendSections.includes(route.trendSection)
                || route.trendPeriod !== undefined && !trendPeriods.includes(route.trendPeriod)
                || (route.trendPeriod === "custom" ? !route.trendFrom || !route.trendTo : route.trendFrom !== undefined || route.trendTo !== undefined))
                return { view, trendUnavailable: true };
            route.trendSection = trendSection(route);
            return route;
        }
        for (const key of fields) if (params.has(key)) route[key] = params.get(key);
        if (view === "analyze" && raw !== "compare" && route.section === "guide") {
            route.analyzeSection = "guide"; delete route.section;
        }
        if (!fragment && view === "request" && params.has("record")) {
            // Ambiguous and malformed locators share the missing-record presentation.
            const refs = params.getAll("record");
            route.bookmark = refs.length === 1 && validBookmark(refs[0]) && !params.has("request") ? refs[0] : "unavailable";
            delete route.request;
        }
        if (raw === "compare") route.compare = "periods";
        if (raw === "activity" && route.session && route.result && !route.mode) route.mode = "calls";
        if (view === "reports" && !params.has("task") && (raw === "report" || route.request)) route.task = "create";
        return route;
    }
    // Unknown or record-derived values must never become HTTP request targets.
    // "privateView=required" is a constant warning, not a lookup key or a capability.
    function project(route, isPublic) {
        const page = route.view === "analyze" && route.compare === "periods" ? "compare" : route.view;
        if (!pages.includes(page)) throw new TypeError("Unknown WIRE page.");
        const params = new URLSearchParams(), privateFields = {}, viewScope = {};
        const projected = { path: page === "analyze" ? "/" : "/" + page, params, privateFields, viewScope };
        if (page === "settings" && route.section === "release-notes") {
            params.set("section","release-notes");
            if (/^v\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(route.release ?? "")) params.set("release",route.release);
            return projected;
        }
        if (page === "analyze" && route.analyzeSection === "guide") params.set("section", "guide");
        if (page === "documentation") {
            if (typeof route.guide === "string" && /^[a-z0-9._-]{1,80}$/.test(route.guide)) params.set("guide", route.guide);
            return projected;
        }
        if (page === "help") {
            if (helpTopics.includes(route.section) && route.section !== "reports") params.set("topic", route.section);
            return projected;
        }
        if (page === "trends") {
            const section = trendSection(route);
            if (section !== "overview" && trendSections.includes(section)) params.set("section", section);
            if (trendMeasures.includes(route.trendMeasure)) viewScope.trendMeasure = route.trendMeasure;
            if (trendPeriods.includes(route.trendPeriod)) viewScope.trendPeriod = route.trendPeriod;
            if (route.trendPeriod === "custom") for (const key of ["from", "to"]) {
                const value = route[trendFields[key]];
                if (/^\d{4}-\d\d-\d\d$/.test(value)) viewScope[trendFields[key]] = value;
            }
            if (route.trendEntry) privateFields.trendEntry = route.trendEntry;
            if (route.trendUnavailable) privateFields.trendUnavailable = true;
            return projected;
        }
        for (const key of fields) {
            const value = route[key];
            if (value == null || value === "" || key === "compare" && page === "compare"
                || page === "settings" && key === "section" && value === "general" && !route.setting
                || value === "all" && ["project", "service", "result"].includes(key)) continue;
            if (!isPublic(key, String(value))) privateFields[key] = value;
            else if (scopeKeys.has(key)) viewScope[key] = typeof value === "number" ? String(value) : value;
            else params.set(key, value);
        }
        return projected;
    }
    function validBookmark(value) { return typeof value === "string" && /^interaction-bookmark-v1-[0-9a-f]{32}$/.test(value); }
    return { isPagePath, legacy, parse, project, isScope: key => scopeKeys.has(key), fields, validBookmark, trendMeasures, trendPeriods, trendSection };
}
export const { isPagePath } = createPagePaths();
