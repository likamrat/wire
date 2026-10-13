export const sidebarStyles = `
.app-header {border-bottom-color:color-mix(in srgb,var(--rule) 75%,var(--muted))}
.app-header .header-inner {display:grid;grid-template-columns:var(--app-sidebar-width,196px) minmax(0,1fr);min-height:76px;max-width:none;gap:0;padding:0}
.app-header .brand {align-self:stretch;justify-content:center;padding:6px 12px;border-right:1px solid color-mix(in srgb,var(--rule) 75%,var(--muted));overflow:hidden}
.app-header .brand-home {position:relative;flex:none;width:148px;height:46px;max-width:none}
.app-header .brand-logo {width:148px;height:46px;max-width:none}
.app-header .brand-caption {flex:none;width:148px;font-size:.6875rem;white-space:normal}
.brand .brand-compact {display:none}
:root[data-navigation=collapsed] .app-header #shellBrand .brand-logo,:root[data-navigation=collapsed] .app-header .brand-caption {visibility:hidden}
:root[data-navigation=collapsed] .app-header .brand-home {width:44px}
:root[data-navigation=collapsed] .app-header .brand-compact {display:block;position:absolute;inset:7px 6px}
.workspace-toolbar {min-width:0}
.workspace-toolbar-inner {display:grid;grid-template-columns:minmax(0,1fr) clamp(240px,34vw,460px) minmax(0,1fr);align-items:center;gap:12px;padding:8px 24px}
.app-header .wire-search-entry {grid-column:2;min-width:0;width:100%;max-width:none}
.workspace-utilities {grid-column:3;display:flex;align-items:center;justify-content:flex-end;min-width:0}
.workspace-utilities .theme-control {flex:none}
.header-inner .theme-control {margin-left:0}
html {scroll-padding-top:calc(var(--app-header-height,76px) + 16px)}
.app-sidebar {position:fixed;z-index:2;top:var(--app-header-height,76px);bottom:0;left:0;width:max-content;min-width:196px;padding:16px 12px;background:var(--paper);border-right:1px solid color-mix(in srgb,var(--rule) 75%,var(--muted));overflow-y:auto;overscroll-behavior:contain}
.navigation-content {display:flex;flex-direction:column;gap:24px}
.navigation-collapse {display:flex;align-items:center;justify-content:center;width:44px;height:44px;min-height:44px;margin:0 0 12px;padding:10px;border:1px solid var(--control);border-radius:6px;background:var(--paper);color:var(--ink);box-shadow:none}
.navigation-collapse:hover {background:var(--hover);border-color:var(--control)}
.navigation-collapse:active {background:var(--pill-pressed);border-color:var(--control)}
.navigation-collapse:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
:root[data-navigation=collapsed] .app-sidebar {min-width:0;width:max-content}
:root[data-navigation=collapsed] .app-sidebar .primary-navigation a {gap:0;width:44px}
:root[data-navigation=collapsed] .app-sidebar .navigation-label {width:0;opacity:0}
:root[data-navigation=collapsed] .app-sidebar .navigation-group-label {width:0;height:0;padding-block:0;opacity:0}
.navigation-label,.navigation-group-label {overflow:hidden}
.app-sidebar[data-navigation-moving] {overflow-x:hidden}
:root .app-sidebar[data-navigation-moving] .primary-navigation a {width:auto}
.app-sidebar[data-navigation-moving] :is(.navigation-label,.navigation-group-label) {overflow:visible}
.primary-navigation {display:flex;flex-direction:column;gap:6px}
.navigation-group {display:flex;flex-direction:column;gap:2px;min-width:0}
.navigation-group+.navigation-group {padding-block-start:var(--space-lg);border-block-start:1px solid var(--rule)}
.navigation-group-label {margin:0;padding:4px 10px 8px;color:var(--muted);font-size:var(--type-caption);line-height:var(--leading-caption);font-weight:var(--weight-strong)}
.primary-navigation a {position:relative;display:grid;grid-template-columns:24px max-content;gap:10px;align-items:center;min-height:44px;min-width:0;padding:8px 10px;color:var(--ink);font-size:var(--type-control);line-height:var(--leading-control);font-weight:var(--weight-regular);text-decoration:none;border-radius:6px;border:0;background:transparent;box-shadow:none}
.primary-navigation a,.navigation-group-label,.navigation-drawer .drawer-heading h2,.navigation-drawer .drawer-heading>button {white-space:nowrap;overflow-wrap:normal}
.primary-navigation a[aria-current=page] {color:var(--ink);font-weight:var(--weight-strong);background:color-mix(in srgb,var(--warning) 14%,var(--paper))}
.primary-navigation a[aria-current=page]::before {content:"";position:absolute;inset:10px auto 10px 0;width:3px;border-radius:2px;background:var(--warning)}
.primary-navigation a:hover {color:var(--ink);background:var(--hover)}
.primary-navigation a:active {color:var(--ink);background:var(--pill-pressed)}
.primary-navigation a:focus-visible {z-index:1;outline:2px solid var(--focus);outline-offset:3px}
.primary-navigation a>.fluent-icon,.navigation-collapse>.fluent-icon {width:24px;height:24px}
.primary-navigation a>.fluent-icon {color:var(--muted);justify-self:center}
.primary-navigation a:is([aria-current=page],:hover,:focus-visible)>.fluent-icon {color:var(--ink)}
body>main {width:calc(100% - var(--app-sidebar-width,196px));margin-left:var(--app-sidebar-width,196px);padding:24px 24px 64px;min-width:0;max-width:none}
#workspace {min-width:0}
#workspace>:not(#homeView),#homeView>.chart-actions,#homeView>.supporting {max-width:1384px}
.navigation-toggle {display:flex;align-items:center;justify-content:center;width:44px;height:44px;flex:none;padding:10px}
.navigation-drawer {margin:0;inset:0 auto 0 0;width:min(304px,calc(100vw - 16px));max-width:none;height:100dvh;max-height:100dvh;border:0;border-right:1px solid var(--rule);border-radius:0;padding:20px 12px;background:var(--paper);color:var(--ink)}
.navigation-drawer .drawer-heading {display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--control)}
.navigation-drawer .drawer-heading h2 {flex:1 1 7rem;min-width:0}
.navigation-drawer .drawer-heading>button {margin-inline-start:auto}
.navigation-drawer .brand {margin:0 10px 20px}
.navigation-drawer .brand-logo {width:140px;height:44px}
.navigation-drawer .brand-caption {font-size:.6875rem}
.navigation-drawer::backdrop {background:var(--scrim)}
@media(prefers-reduced-motion:no-preference) {
 .navigation-drawer[open] {animation:navigation-enter 240ms cubic-bezier(.2,0,0,1)}
 .navigation-drawer[open]::backdrop {animation:navigation-scrim 180ms ease-out}
 @keyframes navigation-enter {from {transform:translateX(-100%)} to {transform:translateX(0)}}
 @keyframes navigation-scrim {from {opacity:0} to {opacity:1}}
}
.export-scope {border:0;margin:0 0 24px;padding:0}
.export-scope legend {font-size:var(--type-section);line-height:var(--leading-section);font-weight:var(--weight-strong);margin-bottom:12px}
.scope-choices {display:flex;flex-wrap:wrap;gap:10px}
.scope-choice {display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--paper);border:1px solid var(--rule);border-radius:var(--radius-small);cursor:pointer}
.scope-choice:has(:checked) {border-color:var(--accent);background:var(--accent-soft)}
.scope-choice input {min-height:0;padding:0;width:18px;height:18px;accent-color:var(--accent);flex:0 0 auto}
.scope-choice span {display:flex;flex-direction:column}
.scope-choice small {color:var(--muted)}
.scope-summary {margin:14px 0 8px;font-weight:600}
.scope-explanation {color:var(--muted);margin-top:8px;font-size:var(--type-small)}
.report-scope-details {margin-bottom:24px}
.report-selection-list {max-height:360px;overflow-y:auto}
.report-entry .actions {flex-wrap:wrap}
.report-preview-controls {display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0}
.report-start #previewSelectionSummary {font-size:var(--type-body);font-weight:var(--weight-strong);color:var(--ink);margin:0}
.report-selection-actions {display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.report-selection-actions button {min-height:44px;white-space:nowrap}
.report-selection-bar {display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin:12px 0;font-size:var(--type-small)}
.report-selection-bar>p {font-weight:var(--weight-medium)}
.report-selection-bar button {min-height:44px;padding:6px 12px;color:var(--accent)}
.dialog-head .report-selection-actions {justify-content:flex-end}
#savedReportCount {font-weight:var(--weight-medium)}
#formatOptions {container-type:inline-size}
.format-choices {grid-template-columns:repeat(2,minmax(0,1fr))}
@container (min-width:560px) {.format-choices {grid-template-columns:repeat(4,minmax(0,1fr))}}
@media (min-width:700px) and (max-width:999px) {.report-options {grid-template-columns:minmax(0,1fr)}}
@media (min-width:700px) and (max-width:999px) {
 .app-sidebar {width:max-content;min-width:176px;padding:16px 10px}
 body>main {width:calc(100% - var(--app-sidebar-width,176px));margin-left:var(--app-sidebar-width,176px);padding:24px 20px 48px}
 .page-heading {align-items:start;flex-direction:column}
 .page-actions {justify-content:start}
 .report-start {flex-direction:column;gap:16px}
 .report-preview-controls {align-items:flex-start}
}
@media (max-width:699px) {
 html {scroll-padding-top:calc(var(--app-header-height,148px) + 16px)}
 .app-header .header-inner {grid-template-columns:minmax(0,1fr);min-height:0}
 .app-header .brand {display:none}
 .workspace-toolbar-inner {grid-template-columns:44px minmax(0,1fr) 80px;gap:6px 8px;padding:6px 12px}
 .workspace-utilities {grid-column:3;grid-row:1}
 .app-header .wire-search-entry {grid-column:1/-1;grid-row:2}
 .header-inner .navigation-toggle {grid-column:1;grid-row:1;min-height:44px;padding:8px}
 .app-sidebar {display:none}
 body>main {width:100%;margin:0;padding:24px 16px 48px}
 .scope-choices {flex-direction:column}
 .scope-choice {min-height:64px}
 .report-start {align-items:start}
 .report-start .primary {white-space:nowrap}
 .report-preview-controls {align-items:flex-start;max-width:100%;flex-shrink:1}
 .dialog-head {gap:8px;padding:12px 16px}
 .dialog-head h2 {font-size:var(--type-small)}
 .dialog-head .report-selection-actions {gap:4px}
 .dialog-head .report-selection-actions button {padding:6px 10px}
}
`;
