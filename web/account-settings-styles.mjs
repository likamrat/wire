export const accountSettingsStyles = `
.wire-account-slot {margin-top:auto;min-width:0}
.wire-account-entry {width:170px;max-width:100%;padding-top:20px}
.wire-account-trigger {display:grid;grid-template-columns:32px minmax(0,1fr) 16px;gap:8px;align-items:center;width:100%;min-height:44px;padding:6px 4px;text-align:left;border:0;border-radius:8px;background:transparent;box-shadow:none;color:var(--ink)}
.wire-account-trigger::before {display:none}
.wire-account-trigger:is(:hover,[aria-expanded=true]) {background:var(--hover)}
.wire-account-trigger:active {background:var(--pill-pressed)}
.wire-account-trigger:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
.wire-account-avatar {display:grid;place-items:center;flex:none;width:32px;height:32px;border:1px solid var(--control);border-radius:50%;overflow:hidden;background:var(--canvas);color:var(--muted);font-size:14px}
.wire-account-avatar img {width:100%;height:100%;object-fit:cover}
.wire-account-avatar>.wire-icon {width:20px;height:20px}
.wire-account-copy {display:flex;flex-direction:column;min-width:0;white-space:nowrap}
.wire-account-copy>span,.wire-account-copy>small {overflow:hidden;text-overflow:ellipsis}
.wire-account-copy>span {font-size:var(--type-control);line-height:1.3}
.wire-account-copy>small {font-size:var(--type-caption);line-height:1.4;color:var(--muted)}
.wire-account-trigger>svg {width:16px;height:16px;color:var(--muted)}
.wire-account-menu {--paper:var(--floating-paper);--pill-fill:var(--paper);position:fixed;inset:auto;margin:0;width:min(320px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:8px;border:1px solid var(--rule);border-radius:12px;background:var(--paper);color:var(--ink);box-shadow:var(--surface-shadow)}
.wire-account-identity {display:flex;align-items:center;gap:12px;padding:8px 12px 12px;margin-bottom:4px;border-bottom:1px solid var(--rule)}
.wire-account-identity>div {min-width:0}
.wire-account-identity p {margin:0;overflow-wrap:anywhere}
.wire-account-identity small {display:block;overflow-wrap:anywhere;font-size:var(--type-caption);color:var(--muted)}
.wire-account-menu>button {display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:10px 12px;border:0;border-radius:8px;background:none;box-shadow:none;white-space:normal;text-align:left;justify-content:flex-start;line-height:var(--leading-control)}
.wire-account-menu>button::before {display:none}
.wire-account-menu>button svg {width:1.125em;height:1.125em;flex:none}
.wire-account-menu>button:disabled {opacity:1;color:var(--muted);cursor:not-allowed}
.wire-account-menu>button:not(:disabled):hover {background:var(--hover)}
.wire-account-menu>button:not(:disabled):active {background:var(--pill-pressed)}
.wire-account-menu>button:focus-visible {outline:2px solid var(--focus);outline-offset:-2px}
.wire-account-menu:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
.wire-account-error {margin:8px 12px;font-size:var(--type-small);line-height:var(--leading-ui);color:var(--muted)}
.wire-account-profile-message,.wire-account-menu>.wire-connection-effect {margin:8px 12px;font-size:var(--type-small);line-height:var(--leading-ui);color:var(--muted);overflow-wrap:anywhere}
.wire-microsoft-connection .wire-connection-row {display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 24px;align-items:start}
.wire-connection-row h3 {margin:0}
.wire-connection-row p {margin:6px 0 0;overflow-wrap:anywhere}
.wire-connection-summary {display:flex;flex-wrap:wrap;gap:0 12px;align-items:baseline}
.wire-connection-account {color:var(--muted)}
.wire-connection-row>button {max-width:18rem;margin-top:-6px}
.wire-connection-effect {color:var(--muted)}
.wire-microsoft-enrollment {display:grid;grid-template-columns:minmax(0,1fr);gap:12px;max-width:18rem;margin:0}
.wire-microsoft-enrollment p {margin:0;overflow-wrap:anywhere}
.wire-microsoft-enrollment button {justify-self:start;max-width:100%}
.settings-view .wire-microsoft-collection.settings-group {margin-top:20px;padding:0;border:0}
.wire-microsoft-collection .settings-group-heading {margin-bottom:12px}
.wire-microsoft-collection .settings-actions:not(:has(button:not([hidden]))) {display:none}
@media(min-width:700px) {
 .app-sidebar:has(.wire-account-slot:not([hidden])) {display:flex;flex-direction:column}
 .app-sidebar:has(.wire-account-slot:not([hidden]))>.navigation-content {flex:1;min-height:0}
 :root[data-navigation=collapsed] .app-sidebar .wire-account-entry {width:44px}
 :root[data-navigation=collapsed] .app-sidebar .wire-account-trigger {grid-template-columns:32px;gap:0;justify-content:center}
 :root[data-navigation=collapsed] .app-sidebar .wire-account-copy,:root[data-navigation=collapsed] .app-sidebar .wire-account-trigger>svg {display:none}
}
@media(max-width:699px) {
 .navigation-drawer:has(.wire-account-slot:not([hidden]))[open] {display:flex;flex-direction:column}
 .navigation-drawer:has(.wire-account-slot:not([hidden])) #drawerContent {flex:1;display:flex;min-height:0}
 .navigation-drawer:has(.wire-account-slot:not([hidden])) #drawerContent>.navigation-content {flex:1;min-height:0}
 .navigation-drawer .wire-account-entry {width:100%}
 .navigation-drawer .wire-account-trigger {padding-inline:10px}
}
@container settings-pane (max-width:34rem) {
 .wire-microsoft-connection .wire-connection-row {grid-template-columns:minmax(0,1fr);gap:12px}
 .wire-connection-row>button,.wire-connection-row>.wire-microsoft-enrollment {justify-self:start;margin:0;max-width:100%}
}
@media(prefers-reduced-motion:reduce) {
 .wire-account-trigger,.wire-account-menu {animation:none!important;transition:none!important}
}
@media(forced-colors:active) {
 .wire-account-avatar,.wire-account-menu {border-color:ButtonText}
 .wire-account-trigger:focus-visible,.wire-account-menu>button:focus-visible {outline-color:Highlight}
}
`;
