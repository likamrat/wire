export const sidebarStyles = `
.app-header {border-bottom-color:transparent}
.app-header .header-inner {display:grid;grid-template-columns:var(--app-sidebar-width,196px) minmax(0,1fr);min-height:76px;max-width:none;gap:0;padding:0}
.app-header .brand {display:grid;grid-template-columns:minmax(40px,1fr) 44px;grid-template-rows:44px;column-gap:8px;align-content:center;align-self:stretch;padding:6px 12px;border-right:1px solid transparent}
.app-header .brand-home {position:relative;display:grid;align-items:center;grid-area:1/1;justify-self:start;align-self:center;flex:none;width:120px;height:44px;max-width:none}
.app-header .brand-logo {width:120px;height:auto;max-width:none}
.brand .brand-compact {display:none}
.app-header .brand-compact {display:block;position:absolute;left:6px;top:6px;width:32px;height:32px;opacity:0}
.app-header :is(.brand-logo,.brand-compact) {transform-origin:0 0;pointer-events:none}
:root[data-navigation=collapsed] .app-header #shellBrand .brand-logo {opacity:0}
:root[data-navigation=collapsed] .app-header .brand-home {justify-self:center;width:44px;height:44px}
:root[data-navigation=collapsed] .app-header .brand-compact {opacity:1}
.workspace-toolbar {min-width:0}
.workspace-toolbar-inner {display:grid;grid-template-columns:minmax(0,1fr) clamp(240px,34vw,460px) minmax(0,1fr);align-items:center;gap:12px;padding:8px 24px}
.app-header .wire-search-entry {grid-column:2;min-width:0;width:100%;max-width:none}
.workspace-utilities {grid-column:3;display:flex;align-items:center;justify-content:flex-end;min-width:0}
.workspace-utilities .theme-control {flex:none}
.header-inner .theme-control {margin-left:0}
html {scroll-padding-top:calc(var(--app-header-height,76px) + 16px);scrollbar-gutter:stable}
.app-sidebar {position:fixed;display:flex;flex-direction:column;z-index:2;top:var(--app-header-height,76px);bottom:0;left:0;width:max-content;min-width:216px;padding:12px 10px;background:var(--paper);border-right:1px solid transparent;box-shadow:var(--navigation-sidebar-shadow);overflow-y:auto;overscroll-behavior:contain}
.navigation-content {display:flex;flex:1 0 auto;flex-direction:column;gap:24px}
.navigation-content>* {flex-shrink:0}
.navigation-workspace>.navigation-group-label {display:none}
.navigation-content>.analyze-tools {margin-top:0;padding-top:0;border-top:0}
.navigation-bottom {margin-top:auto;min-width:0;container-type:inline-size}
.app-sidebar #analyzeTools .analyze-tool-action {white-space:nowrap}
.app-sidebar,.navigation-drawer {--footer-utility-width:44px}
@media (pointer:fine) and (not (any-pointer:coarse)) {
 .app-sidebar,.navigation-drawer {--footer-utility-width:32px}
}
/* Separate the targets vertically before the gliding rail loses horizontal clearance. */
.navigation-footer {--target:44px;--slots:4;--step:clamp(0px,calc((var(--slots) + 1) * var(--target) - 100cqi),var(--target));
 /* As the row becomes a stack, each utility fills the rail's 44px track again. */
 --pitch:max(var(--footer-utility-width),var(--step));position:relative;height:calc(var(--target) + (var(--slots) - 1) * var(--step))}
.navigation-footer:has(>#wireAccountEntry[hidden]) {--slots:3}
/* Preserve the account's 151px plus the rail insets and border at the default width. */
:root:not([data-navigation=collapsed]):not([data-navigation-sized]) .app-sidebar:has(#wireAccountEntry:not([hidden])) {min-width:calc(172px + 3 * var(--footer-utility-width))}
:root[data-navigation=expanded][data-navigation-sized] .app-sidebar {min-width:216px;width:min(var(--navigation-preferred-width),45vw)}
:root[data-navigation=expanded][data-navigation-sized] .app-sidebar:has(#wireAccountEntry:not([hidden])) {min-width:248px}
:root[data-navigation-sized] .app-sidebar .primary-navigation a {grid-template-columns:max(24px,1.5rem) minmax(0,1fr)}
:root[data-navigation-sized] .app-sidebar .navigation-label {text-overflow:ellipsis}
.navigation-resize {position:fixed;inset:var(--app-header-height) auto 0 calc(var(--app-sidebar-width) - 5px);width:12px;z-index:3;cursor:col-resize;touch-action:none;-webkit-user-select:none;user-select:none}
.navigation-resize::before {content:"";position:absolute;inset:50% auto auto 3px;transform:translateY(-50%);width:4px;height:44px;border-radius:2px;background:var(--focus);opacity:0;transition:opacity 120ms ease-out}
.navigation-resize:is(:hover,:focus-visible)::before,.app-sidebar[data-resizing]>.navigation-resize::before {opacity:1}
#sidebar>.navigation-resize:focus-visible {outline:none}
.app-sidebar[data-navigation-moving]>.navigation-resize,:root[data-navigation=collapsed] .navigation-resize {display:none}
@media(forced-colors:active) {.navigation-resize::before {background:Highlight;forced-color-adjust:none}}
.navigation-footer>#wireAccountEntry {position:absolute;inset:0 auto auto 0;width:max(var(--target),calc(100% - 3 * var(--pitch)));min-width:0;margin:0}
.navigation-footer .wire-account-entry {width:100%;padding-top:0}
.footer-utilities>:is(a,button) {--index:0;position:absolute;bottom:calc(var(--index) * var(--step));left:max(0px,calc(100% - (var(--index) + 1) * var(--pitch)));display:grid;place-items:center;width:var(--pitch);min-width:var(--pitch);height:var(--target);padding:0;border:0;border-radius:var(--radius-control);background:none;box-shadow:none;color:var(--muted);text-decoration:none}
.footer-utilities>#openEvidenceHelp {--index:2}
.footer-utilities>#wireFeedback {--index:1;anchor-name:--wire-feedback}
.footer-utilities .wire-icon {width:20px;height:20px}
.footer-utilities>:is(a,button),.navigation-collapse {isolation:isolate}
.footer-utilities>:is(a,button)::before,.navigation-collapse::before {content:"";position:absolute;inset:6px;z-index:-1;pointer-events:none;border-radius:var(--radius-control);background:var(--utility-cue,transparent)}
.footer-utilities>:is(a,button)::before {inset:auto;width:min(32px,calc(100% - 4px));aspect-ratio:1}
.footer-utilities>:is(a,button):is(:hover,:focus-visible),.footer-utilities:has(+ :popover-open)>#wireFeedback {color:var(--ink);background:transparent;--utility-cue:var(--hover)}
.footer-utilities>[aria-current=page] {color:var(--ink)}
.footer-utilities>[aria-current=page]::after {content:"";position:absolute;bottom:3px;width:12px;height:2px;border-radius:2px;background:currentColor}
.footer-utilities>:is(a,button):active {--utility-cue:var(--pill-pressed);background:transparent}
.footer-utilities>:focus-visible {outline:2px solid var(--focus);outline-offset:-2px}
.wire-feedback-panel {position:fixed;box-sizing:border-box;width:min(22rem,calc(100vw - 16px));max-height:calc(100dvh - 16px);overflow:auto;padding:16px;border:1px solid var(--rule);border-radius:12px;background:var(--floating-paper);color:var(--ink);box-shadow:var(--surface-shadow);font-size:var(--type-control);line-height:var(--leading-ui)}
@supports (bottom:anchor(top)) {
 .wire-feedback-panel {position-anchor:--wire-feedback;inset:auto auto calc(anchor(top) + 6px) clamp(8px,anchor(left),calc(100vw - min(22rem,100vw - 16px) - 8px));margin:0;max-height:calc(anchor(top) - 14px)}
}
.wire-feedback-panel h2 {margin:0 0 12px;font-size:var(--type-body);line-height:var(--leading-ui);font-weight:var(--weight-strong)}
.wire-feedback-panel label {display:block;margin:10px 0 4px;font-weight:var(--weight-medium)}
.wire-feedback-panel label span {font-weight:var(--weight-regular);color:var(--muted)}
.wire-feedback-panel :is(input,textarea) {box-sizing:border-box;display:block;width:100%;padding:8px 10px;font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--control);border-radius:var(--radius-control)}
.wire-feedback-panel textarea {min-height:6.5em;resize:vertical}
.wire-feedback-panel :is(input,textarea):focus {outline:2px solid var(--focus);outline-offset:-1px}
.wire-feedback-panel :is(input,textarea)::placeholder {color:var(--muted);opacity:1}
.wire-feedback-panel p {margin:10px 0;color:var(--muted)}
.wire-feedback-actions {display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.wire-feedback-actions button {min-height:36px}
@media(pointer:coarse) {.wire-feedback-actions button {min-height:44px}}
.navigation-collapse {position:relative;z-index:1;display:flex;grid-area:1/2;flex:none;align-items:center;justify-content:center;width:44px;height:44px;min-height:44px;margin:0;padding:0;border:1px solid transparent;border-radius:var(--radius-control);background:transparent;color:var(--muted);box-shadow:none}
.navigation-collapse:hover:not(:disabled) {--pill-hover-border:transparent;--utility-cue:var(--hover);background:transparent;border-color:transparent;color:var(--ink)}
.navigation-collapse:active:not(:disabled) {--utility-cue:var(--pill-pressed);background:transparent;border-color:transparent}
.navigation-collapse:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
:root[data-navigation=collapsed] .app-sidebar {min-width:0;width:max-content}
:root[data-navigation=collapsed] .app-sidebar .primary-navigation a {gap:0;width:44px;grid-template-columns:minmax(0,1fr) 0}
:root[data-navigation=collapsed] .app-sidebar .navigation-label {width:0;opacity:0}
:root[data-navigation=collapsed] .app-sidebar .navigation-group-label {width:0;height:0;padding-block:0;opacity:0}
.navigation-label,.navigation-group-label {overflow:hidden}
.app-sidebar[data-navigation-moving] {overflow-x:hidden}
:root .app-sidebar[data-navigation-moving] .primary-navigation a {width:auto}
.app-sidebar[data-navigation-moving] :is(.navigation-label,.navigation-group-label) {overflow:visible}
.primary-navigation {display:flex;flex-direction:column;gap:4px}
.navigation-group {display:flex;flex-direction:column;gap:2px;min-width:0}
.navigation-group+.navigation-group {padding-block-start:var(--space-lg);border-block-start:1px solid var(--rule)}
.navigation-group-label {margin:0;padding:4px 10px 8px;color:var(--muted);font-size:var(--type-caption);line-height:var(--leading-caption);font-weight:var(--weight-strong)}
.primary-navigation a {position:relative;display:grid;grid-template-columns:max(24px,1.5rem) max-content;gap:8px;align-items:center;min-height:44px;min-width:0;padding:8px 10px;color:var(--muted);font-size:var(--type-control);line-height:var(--leading-control);font-weight:var(--weight-regular);text-decoration:none;border-radius:8px;border:0;background:transparent;box-shadow:none;transition:var(--control-paint-transition)}
.primary-navigation a,.navigation-group-label,.navigation-drawer .drawer-heading h2,.navigation-drawer .drawer-heading>button {white-space:nowrap;overflow-wrap:normal}
.primary-navigation a[aria-current=page] {color:var(--ink);font-weight:var(--weight-medium);background:var(--control-sheen),var(--accent-soft);box-shadow:var(--control-sheen-edge)}
.primary-navigation a:hover {color:var(--ink);background:var(--hover)}
.primary-navigation a:active {color:var(--ink);background:var(--pill-pressed)}
.primary-navigation a:focus-visible {z-index:1;outline:2px solid var(--focus);outline-offset:3px}
.primary-navigation a>.wire-icon {width:var(--icon-navigation-size);height:var(--icon-navigation-size)}
.navigation-collapse>.wire-icon {width:var(--icon-size);height:var(--icon-size)}
.primary-navigation a>.wire-icon {color:var(--muted);justify-self:center}
.primary-navigation a:is([aria-current=page],:hover,:focus-visible)>.wire-icon {color:var(--ink)}
body>main {width:calc(100% - var(--app-sidebar-width,196px));margin-left:var(--app-sidebar-width,196px);padding:24px 24px 64px;min-width:0;max-width:none}
#workspace {min-width:0}
#workspace>:not(#homeView,#trendsView),#homeView>.chart-actions,#homeView>.supporting {max-width:1384px}
.navigation-toggle {display:flex;align-items:center;justify-content:center;width:44px;height:44px;flex:none;padding:10px}
.navigation-drawer {margin:0;inset:0 auto 0 0;width:min(19rem,calc(100vw - 16px));max-width:none;height:100dvh;max-height:100dvh;border:0;border-right:1px solid transparent;border-radius:0;padding:20px 12px;background:var(--paper);color:var(--ink);box-shadow:var(--navigation-sidebar-shadow)}
.navigation-drawer[open] {display:flex;flex-direction:column}
.navigation-drawer>.drawer-heading,.navigation-drawer>#drawerBrand {flex-shrink:0}
#drawerContent {display:flex;flex:1 0 auto;flex-direction:column;min-width:0}
#drawerContent>.navigation-content {min-width:0}
.navigation-drawer .drawer-heading {display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--rule)}
.navigation-drawer .drawer-heading h2 {flex:1 1 7rem;min-width:0}
.navigation-drawer .drawer-heading>button {margin-inline-start:auto}
.navigation-drawer .brand {margin:0 10px 20px}
.navigation-drawer .brand-logo {width:120px;height:auto}
.navigation-drawer .navigation-collapse {display:none}
.navigation-drawer::backdrop {background:var(--scrim)}
@media(forced-colors:active) {
 .app-sidebar,.navigation-drawer {border-right-color:CanvasText;box-shadow:none}
 .primary-navigation a[aria-current=page] {background-image:none;box-shadow:none}
}
@media(prefers-reduced-motion:reduce) {.primary-navigation a {transition:none}}
@media(prefers-reduced-motion:no-preference) {
 .navigation-drawer[open]::backdrop {animation:navigation-scrim 180ms ease-out}
 @keyframes navigation-scrim {from {opacity:0} to {opacity:1}}
}
.export-scope {border:0;margin:0 0 24px;padding:0}
.export-scope legend {font-size:var(--type-section);line-height:var(--leading-section);font-weight:var(--weight-strong);margin-bottom:12px}
.scope-choices {display:flex;flex-wrap:wrap;gap:10px}
.scope-choice {display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--paper);border:1px solid var(--rule);border-radius:var(--radius-small);cursor:pointer}
.scope-choice:has(:checked) {border-color:var(--accent);background:var(--accent-soft)}
.scope-choice input {min-height:0;padding:0;width:18px;height:18px;accent-color:var(--toggle-on);flex:0 0 auto}
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
 .app-sidebar {width:max-content;min-width:216px;padding:12px 10px}
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
 .workspace-toolbar-inner {grid-template-columns:44px minmax(0,1fr) max-content;gap:6px 8px;padding:6px 12px}
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
