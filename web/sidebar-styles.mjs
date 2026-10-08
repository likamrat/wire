export const sidebarStyles = `
.header-inner {display:flex;flex-wrap:wrap;min-height:76px;max-width:none;gap:16px;padding:12px 24px}
.header-inner .theme-control {margin-left:0}
.display-time-zone {display:flex;align-items:center;justify-content:flex-end;min-height:44px;min-width:0;max-width:min(100%,24rem);margin-left:auto;color:var(--muted);font-size:var(--type-caption);line-height:var(--leading-caption);text-align:right;overflow-wrap:anywhere;text-decoration:none}
.display-time-zone:hover {color:var(--ink)}
html {scroll-padding-top:calc(var(--app-header-height,76px) + 16px)}
.app-sidebar {position:fixed;top:var(--app-header-height,76px);bottom:0;left:0;width:max-content;min-width:208px;padding:24px 12px;background:var(--paper);border-right:1px solid var(--rule);overflow-y:auto}
.navigation-content {display:flex;flex-direction:column;gap:24px}
.navigation-collapse {display:flex;align-items:center;justify-content:center;width:44px;height:44px;min-height:44px;margin:0 0 16px;padding:10px;border:1px solid var(--rule);border-radius:6px;background:var(--paper);color:var(--ink);box-shadow:none}
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
.primary-navigation {display:flex;flex-direction:column;gap:var(--space-lg)}
.navigation-group {display:flex;flex-direction:column;gap:2px;min-width:0}
.navigation-group+.navigation-group {padding-block-start:var(--space-lg);border-block-start:1px solid var(--rule)}
.navigation-group-label {margin:0;padding:4px 10px 8px;color:var(--muted);font-size:var(--type-caption);line-height:var(--leading-caption);font-weight:var(--weight-strong)}
.primary-navigation a {position:relative;display:grid;grid-template-columns:24px max-content;gap:10px;align-items:center;min-height:44px;min-width:0;padding:8px 10px;color:var(--ink);font-size:var(--type-control);line-height:var(--leading-control);font-weight:var(--weight-regular);text-decoration:none;border-radius:6px;border:0;background:transparent;box-shadow:none}
.primary-navigation a,.navigation-group-label,.navigation-drawer .drawer-heading h2,.navigation-drawer .drawer-heading>button {white-space:nowrap;overflow-wrap:normal}
.primary-navigation a[aria-current=page] {color:var(--ink);background:var(--accent-soft)}
.primary-navigation a:hover {color:var(--ink);background:var(--hover)}
.primary-navigation a:active {color:var(--ink);background:var(--pill-pressed)}
.primary-navigation a:focus-visible {z-index:1;outline:2px solid var(--focus);outline-offset:3px}
.primary-navigation a>.fluent-icon {color:var(--muted);justify-self:center}
.primary-navigation a:is([aria-current=page],:hover,:focus-visible)>.fluent-icon {color:var(--ink)}
.primary-navigation a>.fluent-icon[data-fluent-icon$="_filled"],
.primary-navigation a[aria-current=page]>.fluent-icon[data-fluent-icon$="_regular"] {display:none}
.primary-navigation a[aria-current=page]>.fluent-icon[data-fluent-icon$="_filled"] {display:block}
body>main {width:calc(100% - var(--app-sidebar-width,208px));margin-left:var(--app-sidebar-width,208px);padding:28px 28px 64px;max-width:none}
#workspace {min-width:0}
#workspace>:not(#homeView),#homeView>.chart-actions,#homeView>.supporting {max-width:1384px}
.navigation-toggle {display:flex;align-items:center;gap:8px}
.navigation-drawer {margin:0;inset:0 auto 0 0;width:min(304px,calc(100vw - 16px));max-width:none;height:100dvh;max-height:100dvh;border:0;border-right:1px solid var(--rule);border-radius:0;padding:20px 12px;background:var(--paper);color:var(--ink)}
.navigation-drawer .drawer-heading {display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin-bottom:28px}
.navigation-drawer .drawer-heading h2 {flex:1 1 7rem;min-width:0}
.navigation-drawer .drawer-heading>button {margin-inline-start:auto}
.navigation-drawer::backdrop {background:var(--scrim)}
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
.report-toolbar {flex-wrap:wrap}
.dialog-head .report-selection-actions {justify-content:flex-end}
#savedReportCount {font-weight:var(--weight-medium)}
#formatOptions {container-type:inline-size}
.format-choices {grid-template-columns:repeat(2,minmax(0,1fr))}
@container (min-width:560px) {.format-choices {grid-template-columns:repeat(4,minmax(0,1fr))}}
@media (min-width:700px) and (max-width:999px) {.report-options {grid-template-columns:minmax(0,1fr)}}
@media (min-width:700px) and (max-width:999px) {
 .app-sidebar {width:max-content;min-width:176px;padding:24px 10px}
 body>main {width:calc(100% - var(--app-sidebar-width,176px));margin-left:var(--app-sidebar-width,176px);padding:24px 20px 48px}
 .page-heading {align-items:start;flex-direction:column}
 .page-actions {justify-content:start}
 .report-start {flex-direction:column;gap:16px}
 .report-preview-controls {align-items:flex-start}
}
@media (max-width:699px) {
 html {scroll-padding-top:calc(var(--app-header-height,148px) + 16px)}
 .header-inner {display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px;min-height:0}
 .header-inner .brand {flex:1 0 calc(100% - 96px);font-size:16px;order:-3}
 .header-inner .theme-control {margin-left:0;order:-2}
 .display-time-zone {order:-1;flex-basis:100%;max-width:100%;margin-left:0}
 .header-inner .navigation-toggle {min-height:44px;padding:8px}
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
