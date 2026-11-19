// Serialized for the inline shell as well as imported by the runtime and bundled clients.
export function createPagePaths() {
    const pages = ["analyze", "trends", "reports", "compare", "settings", "request", "collection-status"];
    const aliases = ["report", "home", "overview", "activity", "calls"];
    const fields = "layer chart bucket timelineFrom range from to source tool services includeMissingService withinServices service project result authors scope endpoint session request page expanded origin issues section setting task mode call callSort callRevision compare aFrom aTo bFrom bTo bundle inspect order nativeSource nativeRevision nativeSourceRevision nativeOrdinal nativeGroup comparisonView comparisonFocus".split(" ");
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
        for (const key of fields) if (params.has(key)) route[key] = params.get(key);
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
        const params = new URLSearchParams(), privateFields = {};
        for (const key of fields) {
            const value = route[key];
            if (value == null || value === "" || key === "compare" && page === "compare"
                || value === "all" && ["project", "service", "result"].includes(key)
                || key === "section" && page === "settings" && value === "connection" && !route.setting) continue;
            if (isPublic(key, String(value))) params.set(key, value);
            else privateFields[key] = value;
        }
        const path = page === "analyze" ? "/" : "/" + page;
        return { path, params, privateFields };
    }
    function validBookmark(value) { return typeof value === "string" && /^interaction-bookmark-v1-[0-9a-f]{32}$/.test(value); }
    return { isPagePath, legacy, parse, project, fields, validBookmark };
}
export const { isPagePath } = createPagePaths();
