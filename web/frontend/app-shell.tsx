import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { LuFilter, LuSearch, LuX } from "react-icons/lu";
import type { IconType } from "react-icons";
import { componentName, iconProps, iconSize, uxIconSources } from "../icon-roles.mjs";
import { mountReactActivity } from "./activity-owner.tsx";
import type { createWorkspaceState, WorkspacePresentation } from "./workspace-state.ts";

type Workspace = ReturnType<typeof createWorkspaceState>;
type Navigation = (node: HTMLAnchorElement, event: MouseEvent) => void;
type Refresh = (control: HTMLButtonElement) => void;
type Ports = {
    brand: HTMLElement; navigation: HTMLElement; sidebar: HTMLElement; toolbar: HTMLElement;
    heading: HTMLElement; home: HTMLElement; activity: HTMLElement; filters: HTMLDialogElement;
    reader: HTMLDialogElement; request: HTMLElement; emptyScope: HTMLElement;
    form: HTMLElement; appliedFilters: HTMLElement; serviceFocus: HTMLElement; pageProject: HTMLElement;
    periodCoverage: HTMLElement; sessionAnalysis: HTMLElement; actions: HTMLElement; selection: HTMLElement;
    viewSwitch: HTMLElement; brandMarkup: string;
};
const emptyPresentation: WorkspacePresentation = Object.freeze({ version: 0, active: "analyze", view: "analyze", phase: "unavailable" });
const emptySubscribe = () => () => {};
const emptySnapshot = () => emptyPresentation;

function NativeHost({ node, id, className }: { node: HTMLElement; id?: string; className?: string }) {
    const host = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        host.current?.append(node);
        return () => { node.remove(); };
    }, [node]);
    return <div id={id} className={className ?? (id ? undefined : "frontend-native-host")} ref={host} />;
}
const shellGlyphs: Readonly<Record<string, IconType>> = { LuFilter, LuSearch, LuX };
function Icon({ name }: { name: "search" | "filter" | "close" }) {
    const asset = uxIconSources[name], Glyph = shellGlyphs[componentName(asset)];
    if (!Glyph) throw new TypeError(`Unregistered shell icon: ${name}`);
    return <Glyph {...iconProps(name, asset, iconSize(name))} />;
}
function Search() {
    return <div id="wireSearchHome" className="wire-search-entry">
        <label htmlFor="wireSearch" className="visually-hidden">Search</label>
        <div className="search-capsule">
            <span className="wire-search-icon"><Icon name="search" /></span>
            <input id="wireSearch" className="search-capsule-input" type="search" placeholder="Search"
                autoComplete="off" spellCheck={false} aria-controls="wireSearchPanel" aria-expanded="false" />
            <button id="wireSearchClear" type="button" className="quiet search-capsule-clear" hidden>Clear search</button>
        </div>
        <section id="wireSearchPanel" className="wire-search-panel" aria-labelledby="wireSearchTitle" hidden>
            <h2 id="wireSearchTitle" className="visually-hidden">Search results</h2>
            <div className="wire-search-filters" role="group" aria-label="Search filters">
                <label htmlFor="wireSearchScope" className="visually-hidden">Search scope</label>
                <select id="wireSearchScope" data-select-presentation="filter" defaultValue="everywhere">
                    <option value="everywhere">Everywhere</option><option value="analysis">Current Analyze scope</option>
                </select>
                <label htmlFor="wireSearchType" className="visually-hidden">Result type</label>
                <select id="wireSearchType" data-select-presentation="filter" defaultValue="">
                    {Object.entries({ "": "All types", interaction: "Interactions", context: "Conversation context",
                        reply: "Retained replies", action: "Recorded actions", tool: "Tools", service: "Services",
                        report: "Saved reports", comparison: "Saved comparisons", view: "Views", setting: "Settings",
                    }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
            </div>
            <p id="wireSearchScopeNote" hidden>Search your saved activity and reports. This does not collect new data.</p>
            <p id="wireSearchStatus" role="status" aria-live="polite" />
            <button id="wireSearchRetry" type="button" className="quiet" hidden>Reconnect search</button>
            <section id="wireSearchMatches" className="wire-search-set" aria-labelledby="wireSearchMatchesTitle" hidden>
                <h3 id="wireSearchMatchesTitle"><span id="wireSearchCount" /> <span id="wireSearchCoverage" /></h3>
                <ol id="wireSearchResults" className="wire-search-results" aria-label="Search results" />
                <div id="wireSearchPaging" className="wire-search-paging" />
            </section>
        </section>
    </div>;
}
function Analyze() {
    return <div className="analyze-dashboard">
        <div className="analyze-chart-grid">
            <section className="analyze-chart-main" aria-labelledby="chartTitle">
                <div className="chart-panel">
                    <div className="chart-heading"><h2 id="chartTitle" /></div>
                    <div id="chart" /><div id="chartFooter" className="chart-footer" />
                </div>
            </section>
            <section className="analyze-outcome-summary" aria-label="Recorded outcomes"><div id="outcomeChart" /></section>
        </div>
    </div>;
}
function Activity() {
    return <>
        <h2 id="activityTitle" className="visually-hidden" tabIndex={-1}>Activity</h2>
        <div id="activityListContext" className="section-heading activity-list-context">
            <p id="activityListSummary" className="list-summary" role="status" tabIndex={-1} aria-describedby="analyzeScopeCaption" />
            <p id="activityListScope" className="activity-list-scope" hidden />
            <label className="search-label" hidden>Legacy private search
                <input id="activitySearch" type="search" placeholder="Search" autoComplete="off" />
            </label>
            <button id="clearActivitySearch" type="button" className="quiet" hidden>Clear legacy search</button>
        </div>
        <div id="coverageNotice" className="activity-evidence-context" hidden><span id="activityCoverageGap" />{" "}
            <a href="/collection-status?setting=collection-details" data-settings-link="">Collection status</a>
        </div>
        <div id="activityList" /><div id="analyzeResultActions" className="analyze-result-actions" />
        <div id="activityPager" className="pager" />
    </>;
}
function Reader({ request, close }: { request: HTMLElement; close: () => void }) {
    return <>
        <header className="context-sidebar-header">
            <h2 id="contextSidebarTitle" tabIndex={-1} />
            <div className="context-sidebar-controls">
                <div id="readerWidthControls" hidden>
                    <button id="narrowInteraction" type="button" className="quiet" aria-label="Narrow interaction" />
                    <button id="widenInteraction" type="button" className="quiet" aria-label="Widen interaction" />
                </div>
                <button id="expandInteraction" type="button" className="quiet" hidden />
                <button id="closeContextSidebar" type="button" className="quiet" aria-label="Close interaction" onClick={close} />
            </div>
        </header>
        <div id="readerResize" role="separator" aria-label="Interaction width" aria-orientation="vertical"
            aria-controls="contextSidebarBody" tabIndex={0} hidden />
        <NativeHost id="contextSidebarBody" node={request} />
        <footer id="contextSidebarFooter" />
    </>;
}
function Filters({ ports }: { ports: Ports }) {
    return <div id="analyzeFilterPanel" className="analyze-filter-panel">
        <div className="analyze-filter-heading">
            <div id="analyzeFilterHeading"><h2 id="filterHeading" className="filter-heading"><Icon name="filter" />Filters</h2></div>
            <button id="closeAnalyzeFilters" type="button" className="quiet icon-only" aria-label="Close filters and view"><Icon name="close" /></button>
        </div>
        <NativeHost id="analyzeFilterFields" node={ports.form} />
        <div id="analyzeAppliedFilters">
            <NativeHost node={ports.appliedFilters} /><NativeHost node={ports.serviceFocus} />
        </div>
        <fieldset id="analyzeViewControls" className="analyze-view-controls">
            <legend>View</legend><NativeHost node={ports.viewSwitch} />
        </fieldset>
        <div id="analyzeSourceContext">
            <NativeHost node={ports.pageProject} /><NativeHost node={ports.periodCoverage} /><NativeHost node={ports.sessionAnalysis} />
        </div>
    </div>;
}
function AppShell({ ports, workspace, navigate, refresh, closeReader, activity }: {
    ports: Ports; workspace?: Workspace; navigate: Navigation; refresh: Refresh;
    closeReader: () => void; activity: ReactNode;
}) {
    const state = useSyncExternalStore(workspace?.subscribe ?? emptySubscribe, workspace?.getSnapshot ?? emptySnapshot);
    const nav = (name: string, label: string, id?: string) => <a id={id} key={name}
        href={name === "analyze" ? "/" : "/" + name} data-nav={name}
        aria-current={state.active === name ? "page" : undefined}
        onClick={event => navigate(event.currentTarget, event.nativeEvent)}><span className="navigation-label">{label}</span></a>;
    return <>
        <header className="app-header" data-workspace-phase={state.phase}>
            <div className="header-inner">
                <NativeHost node={ports.brand} />
                <div className="workspace-toolbar"><div className="workspace-toolbar-inner">
                    <button id="navigationToggle" className="navigation-toggle quiet" type="button"
                        aria-label="Open navigation" aria-expanded="false" aria-controls="navigationDrawer" hidden />
                    <Search />
                    <div className="workspace-utilities"><div className="theme-control">
                        <button type="button" id="themePreference" className="theme-trigger" role="switch" aria-label="Dark theme" aria-checked="false" />
                    </div></div>
                </div></div>
            </div>
        </header>
        {createPortal(<>
            <a className="brand-home" href="/" data-nav="analyze" aria-label="WIRE - Work IQ Request Explorer"
                onClick={event => navigate(event.currentTarget, event.nativeEvent)}
                dangerouslySetInnerHTML={{ __html: ports.brandMarkup }} />
            <button id="navigationCollapse" className="navigation-collapse" type="button"
                aria-label="Collapse navigation" aria-expanded="true" aria-controls="navigationContent" />
        </>, ports.brand)}
        {createPortal(<NativeHost node={ports.navigation} />, ports.sidebar)}
        {createPortal(<>
            <section className="navigation-workspace" aria-labelledby="workspaceNavigationTitle">
                <h2 id="workspaceNavigationTitle" className="navigation-group-label">Workspace</h2>
                <nav className="primary-navigation" aria-label="Main navigation">
                    {nav("analyze", "Analyze")}{nav("trends", "Trends")}{nav("reports", "Reports")}{nav("compare", "Compare", "comparePeriods")}
                </nav>
            </section>
            <section id="analyzeTools" className="analyze-tools" aria-label="Analyze tools" hidden>
                <h2 className="navigation-group-label">Analyze tools</h2><div id="analyzeReturnActions" /><div id="analyzeToolActions" />
            </section>
            <div className="navigation-bottom"><div id="navigationFooter" className="navigation-footer">
                <div id="wireAccountEntry" hidden />
                <nav className="footer-utilities" aria-label="Utility navigation">
                    <a id="openEvidenceHelp" href="/help" aria-label="Help" />
                    <button type="button" id="wireFeedback" className="icon-only" aria-label="Feedback" aria-haspopup="dialog" popoverTarget="wireFeedbackPanel" />
                    <a href="/settings" data-nav="settings" aria-label="Settings" aria-current={state.active === "settings" ? "page" : undefined}
                        onClick={event => navigate(event.currentTarget, event.nativeEvent)} />
                </nav>
            </div></div>
        </>, ports.navigation)}
        {createPortal(<>
            <div className="frontend-heading-copy"><p id="pageIdentity" className="session-label" hidden /><h1 id="pageTitle" tabIndex={-1} /><p id="pageIntro" /></div>
            <NativeHost node={ports.actions} /><NativeHost node={ports.selection} />
        </>, ports.heading)}
        {createPortal(<>
            <button id="analyzeRefresh" className="quiet" type="button" aria-label="Refresh" onClick={event => refresh(event.currentTarget)}><span id="analyzeRefreshLabel">Refresh</span></button>
            <button id="openAnalyzeFilters" className="quiet filter-entry" type="button" aria-label="Filters and view"
                aria-haspopup="dialog" aria-expanded="false" aria-controls="analyzeFilterDialog">
                <Icon name="filter" /><span className="analyze-entry-label filter-entry-label">Filters</span>
            </button>
            <span id="analyzeRefreshStatus" className="visually-hidden" role="status" aria-live="polite" />
        </>, ports.toolbar)}
        {createPortal(<>
            <NativeHost node={ports.emptyScope} /><Analyze />
            <div className="chart-actions"><a id="exploreLink" className="text-link" href="/" hidden>Explore the requests behind this chart</a></div>
        </>, ports.home)}
        {createPortal(<Activity />, ports.activity)}
        {createPortal(<Filters ports={ports} />, ports.filters)}
        {createPortal(<Reader request={ports.request} close={closeReader} />, ports.reader)}
        {activity}
    </>;
}

export function mountReactShell() {
    function element(id: string) {
        const node = document.getElementById(id);
        if (!(node instanceof HTMLElement)) throw new Error(`WIRE shell is missing ${id}. Reload this panel.`);
        return node;
    }
    function dialog(id: string) {
        const node = element(id);
        if (!(node instanceof HTMLDialogElement)) throw new TypeError(`WIRE shell requires the ${id} dialog.`);
        return node;
    }
    const heading = document.querySelector("#workspace > .page-heading"), viewSwitch = document.querySelector(".view-switch");
    if (!(heading instanceof HTMLElement) || !(viewSwitch instanceof HTMLElement)) throw new Error("WIRE workspace structure is incomplete.");
    const brand = element("shellBrand"), brandHome = brand.querySelector(".brand-home");
    if (!(brandHome instanceof HTMLAnchorElement)) throw new Error("WIRE shell requires its brand navigation link.");
    const ports: Ports = {
        brand, navigation: element("navigationContent"), sidebar: element("sidebar"),
        toolbar: element("analyzeToolbar"), heading, viewSwitch, home: element("homeView"), activity: element("activityView"),
        filters: dialog("analyzeFilterDialog"), reader: dialog("contextSidebar"), request: element("requestView"),
        emptyScope: element("analyzeEmptyScope"), form: element("filters"),
        appliedFilters: element("appliedFilters"), serviceFocus: element("serviceFocus"), pageProject: element("pageProject"),
        periodCoverage: element("periodCoverage"), sessionAnalysis: element("sessionAnalysis"),
        actions: element("pagePrimaryActions"), selection: element("reportSelectionBar"),
        brandMarkup: brandHome.innerHTML,
    };
    for (const node of [ports.brand, ports.navigation, ports.request, ports.emptyScope,
        ports.form, ports.appliedFilters, ports.serviceFocus, ports.pageProject, ports.periodCoverage,
        ports.sessionAnalysis, ports.actions, ports.selection, ports.viewSwitch]) node.remove();
    document.querySelector(".app-header")?.remove();
    element("filterHeading").remove();
    for (const host of [ports.brand, ports.navigation, ports.sidebar, ports.toolbar, ports.heading, ports.home, ports.activity, ports.filters, ports.reader]) host.replaceChildren();
    const host = document.createElement("div");
    host.id = "wireReactShell";
    const skip = document.querySelector(".skip-link");
    if (!skip) throw new Error("WIRE shell requires its keyboard entry link.");
    skip.after(host);
    const root = createRoot(host);
    let workspace: Workspace | undefined, activity: ReactNode = null;
    let navigate: Navigation = () => { throw new Error("WIRE navigation is not ready."); };
    let refresh: Refresh = () => { throw new Error("WIRE refresh is not ready."); };
    let closeReader: () => void = () => { throw new Error("WIRE reader is not ready."); };
    function render() {
        flushSync(() => root.render(<AppShell ports={ports} workspace={workspace} activity={activity}
            navigate={(node, event) => navigate(node, event)} refresh={control => refresh(control)} closeReader={() => closeReader()} />));
    }
    render();
    return {
        connectWorkspace(value: Workspace) { workspace = value; render(); },
        bindNavigation(value: Navigation) { navigate = value; },
        bindRefresh(value: Refresh) { refresh = value; },
        bindReaderClose(value: () => void) { closeReader = value; },
        mountActivityList(options: Parameters<typeof mountReactActivity>[0]) {
            return mountReactActivity({ ...options, render: content => {
                activity = createPortal(content, options.root); render();
            } });
        },
    };
}
