export const textAccessStyles = `
.facts dt {min-width:0;overflow-wrap:anywhere}
.full-text {min-width:0;max-width:100%}
.text-preview-identifier {margin-inline-start:.25em}
.full-text>.full-text-preview {max-width:68ch;margin:4px 0 0;color:var(--ink);font-size:var(--type-body);line-height:1.6;overflow-wrap:anywhere;white-space:normal;overflow:visible;text-overflow:clip}
.full-text-preview-label {display:block;color:var(--muted);font-size:var(--type-caption)}
.full-text-provenance {min-width:0}
.full-text-provenance .full-text-preview-label {min-width:0;overflow-wrap:anywhere}
.full-text-preview-state {margin:4px 0 0;color:var(--muted);font-size:var(--type-caption);line-height:var(--leading-caption);overflow-wrap:anywhere}
.full-text-actions {display:flex;flex-wrap:wrap;align-items:center;gap:0 var(--space-sm);margin-top:4px;min-width:0}
.full-text-actions .request-link {display:inline-flex;align-items:center;min-height:44px;max-width:100%;padding:8px var(--pill-inset);font-size:var(--type-control);line-height:var(--leading-control);color:var(--accent)}
.full-text-actions .full-text-toggle {margin-top:0}
.full-text-toggle {min-height:44px;color:var(--accent);white-space:normal;overflow-wrap:anywhere;margin-top:4px}
.full-text-availability {font-size:var(--type-small);color:var(--muted);margin:8px 0;line-height:1.6}
.full-text-body {min-width:0;max-width:100%}
.request-row .request-link,.report-entry .request-link,.context-return .request-link {white-space:normal;overflow:visible;text-overflow:clip}
.full-text-body .ux-code-block>pre {max-height:none;overflow:visible;scrollbar-gutter:auto}
.full-text-body .ux-code-block {overflow:visible}
.request-original {margin:0 0 16px;min-width:0}
.full-text-header {display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.full-text-header :is(h2,h3) {margin:0;min-width:0;overflow-wrap:anywhere}
.full-text-header h3 {font-size:var(--type-body);color:var(--muted)}
.full-text-qualifiers {display:flex;flex-wrap:wrap;flex-basis:100%;align-items:baseline;gap:4px 12px}
.full-text-qualifiers:empty {display:none}
.full-text-qualifiers>p {margin:0}
.full-text-reader-actions {display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:4px 8px;margin-inline-start:auto;min-width:0;max-width:100%}
.full-text-reader-actions:has(.ux-copy-status.error) {flex-basis:100%}
.full-text-header .full-text-toggle {margin:0;font-size:var(--type-body)}
.full-text-header .ux-copy {width:44px;height:44px;min-width:44px;min-height:44px}
.full-text-privacy {margin:4px 0 12px;color:var(--muted);font-size:var(--type-caption);line-height:var(--leading-ui);overflow-wrap:anywhere}
.full-text-content {margin:0;padding:0;max-width:72ch;font-family:var(--font);font-size:var(--type-reading);line-height:var(--leading-reading);white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;max-height:none;overflow:visible;background:none;border:0;border-radius:0}
.full-text-content:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
.full-text-complete>.full-text-body {margin-top:16px}
.full-text-content-first>.full-text-body {margin-top:8px}
.full-text-content-first>.full-text-reader-actions {justify-content:flex-start;margin:8px 0 0}
.full-text-content-first>.full-text-reader-actions .reader-copy-scope,
.full-text-content-first>.full-text-reader-actions .ux-copy-status:not(.error) {text-align:start}
.reader-state {font-size:var(--type-caption);line-height:var(--leading-caption);color:var(--muted)}
.reader-state-partial {color:var(--warning);font-weight:var(--weight-medium)}
.reader-copy-scope {flex-basis:100%;font-size:var(--type-caption);line-height:var(--leading-caption);color:var(--muted);text-align:end;overflow-wrap:anywhere}
.reader-details {margin-top:12px;border-top:1px solid var(--rule)}
.reader-details>summary {min-height:44px;font-size:var(--type-caption);line-height:var(--leading-ui);color:var(--muted)}
.reader-details>p {font-size:var(--type-small);line-height:var(--leading-reading);margin:4px 0 12px}
.reader-empty,.full-text-unavailable {margin:12px 0;color:var(--muted);font-size:var(--type-body);line-height:var(--leading-reading)}
.full-text-reader-actions .ux-copy-labeled,.full-text-reader-actions .ux-copy-labeled:is(:hover,:active) {
 position:relative;isolation:isolate;width:auto;height:auto;min-height:max(44px,calc(1lh + 24px));
 padding:12px var(--pill-inset);gap:8px;border:0;background:transparent;border-radius:var(--radius-control);
 font-size:var(--type-control);line-height:var(--leading-control);white-space:normal;
}
.full-text-reader-actions .ux-copy-labeled::before {content:"";position:absolute;inset:4px 0;z-index:-1;pointer-events:none;border:1px solid var(--pill-border);border-radius:inherit;background:var(--pill-fill)}
.full-text-reader-actions .ux-copy-labeled:hover::before {background:var(--pill-hover)}
.full-text-reader-actions .ux-copy-labeled:active::before {background:var(--pill-pressed)}
.full-text-reader-actions .ux-copy-labeled[data-copy-state=error]::before {border-color:var(--danger)}
.full-text-reader-actions .ux-copy-status.pending {color:var(--muted)!important}
.full-text-reader-actions .ux-copy-status:not(.error) {text-align:end}
.request-original,.interaction-response {padding:20px;border:1px solid var(--rule);border-radius:var(--radius-small);background:var(--paper)}
.interaction-response {margin-bottom:24px}
.interaction-response .error {color:var(--danger)}
.interaction-response>.reader-details {margin-top:8px}
.interaction-response .full-text-complete {margin-top:16px}
.interaction-insights {margin-block:24px}
.request-recorded {margin-top:24px;padding-top:24px;border-top:1px solid var(--rule)}
.request-recorded>.request-actions-heading {margin-bottom:12px}
.request-outcome {padding:12px 16px;background:var(--paper);border-inline-start:3px solid var(--control);border-radius:var(--radius-small);overflow-wrap:anywhere}
.request-outcome .full-request-results {border:0;margin:0;padding:0}
.request-outcome h2 {margin:0}
.request-outcome p {margin:8px 0 0}
.request-outcome .action-error,.journey-item .action-error {color:var(--danger);white-space:pre-wrap;overflow-wrap:anywhere}
.request-outcome-action {font-weight:var(--weight-medium)}
.request-matching {margin-top:12px;border-top:1px solid var(--rule);padding-top:4px}
.request-intro {display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px;padding:0;margin-bottom:12px;background:none;border:0;border-radius:0}
.request-intro p,.request-intro>.project-context {margin:0 0 4px;overflow-wrap:anywhere}
.request-actions {margin:20px 0;padding:16px 0;border-block-start:1px solid var(--rule);min-width:0}
.request-actions h2 {margin:0;font-size:var(--type-section)}
.request-actions p {margin:4px 0 0;overflow-wrap:anywhere}
.request-actions>div {flex:1 1 12rem;min-width:0}
#activitySelectionContext>#reportContextAction {display:inline-flex;margin-top:4px}
.request-actions-heading {margin:0}
.request-support {margin-top:20px}
.request-view-context>summary {min-height:44px;cursor:pointer}
.viewing-context:has(.request-view-context) {padding:0;margin:0 0 12px;border:0}
.request-view-context[open]>div {padding:8px 0 12px}
.action-heading {display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-xs) var(--space-lg);min-width:0;font-size:var(--type-body);line-height:var(--leading-ui)}
.action-heading h3 {margin:0;font:inherit;font-weight:var(--weight-strong)}
.action-heading h3,.action-heading span {overflow-wrap:anywhere;min-width:0;max-width:100%}
.action-service-heading {display:inline-flex;align-items:center;gap:var(--space-xs)}
.call-heading .action-service-heading {max-width:100%;min-width:0}
.action-heading .service-cue {align-items:flex-start;line-height:inherit}
.journey-item {overflow-wrap:anywhere}
.journey-item:has(>.call-heading)>.action-fields {margin-block:8px}
.journey-item:has(>.call-heading)>.call-api-summary {margin-block:8px}
.journey-item:has(>.call-heading)>.call-heading .action-heading {display:grid;gap:var(--space-xs)}
.journey-item .ux-inline-code {margin-block:4px}
.journey-pages>.list-pager:not(:has(button)) {min-height:0;margin:8px 0 12px}
.request-context-note {flex-basis:100%;font-size:var(--type-caption);line-height:var(--leading-caption);color:var(--muted)}
.request-context-timeline {margin-block:16px}
.request-context-timeline>.journey-item {min-width:0;padding-block:8px 20px}
.request-context-timeline>.journey-item[aria-current=true] {border-inline-start-color:var(--accent)}
.request-context-timeline .context-entry-label {font-size:var(--type-caption);line-height:var(--leading-caption);margin:0 0 12px}
.request-context-timeline .full-text-header .context-entry-label {margin:0}
.request-context-timeline .context-selected-label {color:var(--accent);font-weight:var(--weight-strong)}
.request-context-timeline>.journey-item[data-selected-action=true] {border-inline-start-color:var(--accent)}
#selectedCall,#unavailableCall {scroll-margin-block-start:160px;outline-offset:4px}
.selected-api-result {min-width:0;margin-block:16px}
.selected-api-result>.api-result-entry {border-inline-start:2px solid var(--accent);padding-inline-start:12px}
.request-context-timeline :is(.request-original,.request-context-prompt,.interaction-response) {padding:0;margin:0;border:0;border-radius:0;background:none;min-width:0}
.request-context-timeline .reader-state-partial {color:var(--warning)}
.request-context-summaries>summary {min-height:44px;font-size:var(--type-body)}
.request-summary-content>.request-recorded {margin-top:16px;padding-top:16px}
.request-context-summaries .interaction-insights {margin-block:16px}
.request-link-details {margin-top:16px;padding-top:16px;border-top:1px solid var(--rule);font-size:var(--type-caption)}
#requestContent {max-inline-size:62rem}
#requestView>#reportSelectionBar {max-inline-size:62rem;margin-top:8px}
.page-heading #contextBack.reader-back {display:inline-flex;align-items:center;gap:8px;border:0;background:transparent;padding-inline:0}
.page-heading #contextBack.reader-back::before {content:none}
.page-heading #contextBack.reader-back:hover {background:var(--hover)}
.reader-back .wire-icon {flex:0 0 20px}
#requestContent .request-intro {gap:4px 20px;margin-bottom:12px}
#requestContent .request-intro:empty {display:none}
#requestContent .reader-scope {font-size:var(--type-body);line-height:var(--leading-ui)}
#requestContent .reader-scope {flex-basis:100%;margin-top:8px;color:var(--muted)}
#requestContent :is(.request-context-timeline,.reader-context-list) {margin-block:0 12px;padding:0}
#requestContent :is(.request-context-timeline,.reader-context-list)>.journey-item {padding:16px 0;margin:0;border:0;border-bottom:1px solid var(--rule)}
#requestContent :is(.request-context-timeline,.reader-context-list)>.journey-item:first-child {padding-top:0}
#requestContent :is(.request-context-timeline,.reader-context-list)>.journey-item:last-child {border-bottom:0;padding-bottom:0}
#requestContent .request-context-timeline>.journey-item[data-selected-action=true] {border-inline-start:2px solid var(--accent);padding-inline-start:16px}
#requestContent .request-context-timeline :is(.full-text-header h2,.full-text-header h3,.interaction-response>h2,.call-heading h3) {font-family:var(--font);font-size:var(--type-body);line-height:var(--leading-reading);font-weight:var(--weight-strong);margin:0}
#requestContent .request-context-timeline .context-entry-label {font-size:var(--type-body);line-height:var(--leading-ui);margin-bottom:4px;color:var(--ink)}
#requestContent .context-entry-label strong {font:inherit;color:var(--muted)}
#requestContent .request-context-timeline :is(.call-duration,.action-context,.action-fields,.reader-response-note,.reader-empty) {font-size:var(--type-body);line-height:var(--leading-reading)}
#requestContent :is(.request-context-timeline,.reader-context-list) .call-heading {display:block;line-height:1.5}
#requestContent :is(.request-context-timeline,.reader-context-list) .call-heading h3 {font:inherit}
#requestContent .request-context-timeline .call-heading .call-duration {line-height:inherit}
#requestContent .full-text-complete {max-inline-size:100%}
#requestContent .full-text-header {gap:4px 16px}
#requestContent .full-text-reader-actions {gap:0 8px;margin-block:0}
#requestContent .full-text-reader-actions>button {display:inline-flex;align-items:center;justify-content:center;margin:0;font-size:var(--type-control);line-height:var(--leading-control)}
#requestContent .full-text-reader-actions>button {border:0;background:transparent;padding:8px;min-height:44px;color:var(--muted)}
#requestContent .full-text-reader-actions>button::before {content:none}
#requestContent .full-text-reader-actions>button:hover {background:var(--hover);color:var(--ink)}
#requestContent [data-text-subject=request] .full-text-content {max-inline-size:68ch;font-size:var(--type-body);font-weight:var(--weight-regular);font-style:normal}
#requestContent [data-text-subject=request]>.full-text-body {padding:12px 16px;background:var(--paper);border-inline-start:3px solid var(--control)}
#requestContent [data-text-subject=request]:has([data-prompt-actor=user])>.full-text-body {border-inline-start-color:var(--screen-prompt-user)}
#requestContent .full-text-content-first>.full-text-body {margin-top:4px}
#requestContent .reader-copy-scope {font-size:var(--type-caption);line-height:var(--leading-ui);text-align:start;margin:16px 0 8px}
#requestContent .request-context-timeline .reader-state {font-size:var(--type-body);line-height:var(--leading-ui)}
#requestContent .request-context-timeline .interaction-response {margin-top:8px;padding:0}
#requestContent .interaction-response:has(>.reader-empty) {display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px}
#requestContent .interaction-response:has(>.reader-empty)>h2 {position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
#requestContent .interaction-response>.reader-empty {margin:0;color:var(--muted)}
#requestContent .interaction-response>.reader-empty.error {color:var(--danger)}
#requestContent .interaction-response>.reader-response-note {flex-basis:100%}
#requestContent .request-context-timeline [data-context-kind=response]>.interaction-response {margin-top:0}
#requestContent .reader-response-note {margin-block:4px 12px;color:var(--muted)}
#requestContent .reader-facts {display:flex;flex-wrap:wrap;gap:4px 20px;margin-block:12px 0;font-size:var(--type-body);line-height:var(--leading-ui)}
#requestContent .reader-facts>dl {margin:0;padding:0}
#requestContent .reader-facts .reader-source {display:flex;flex-wrap:wrap;gap:4px 20px;flex-basis:100%}
#requestContent .reader-source .card-chat {display:flex;flex-wrap:wrap;gap:4px 8px}
#requestContent .reader-source .text-link {min-height:24px}
#requestContent .reader-facts>dl>div {display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px}
#requestContent .reader-facts>dl dt {font:inherit;color:var(--muted)}
#requestContent .reader-facts>dl dd {margin:0;font-weight:var(--weight-regular);color:var(--ink);overflow-wrap:anywhere}
#requestContent :is(.facts,.action-fields) {font-size:var(--type-body);line-height:var(--leading-ui);grid-template-columns:minmax(0,10rem) minmax(0,1fr);align-items:baseline;gap:4px 12px;margin-block:8px}
#requestContent :is(.facts,.action-fields) dt {color:var(--muted);font:inherit}
#requestContent :is(.facts,.action-fields) dd {color:var(--ink);font-weight:var(--weight-regular)}
#requestContent .reader-identifier {font-family:var(--font);font-size:inherit;user-select:text;overflow-wrap:anywhere}
#requestContent .call-duration strong {font-weight:var(--weight-regular)}
#requestContent .call-duration-label {font-weight:var(--weight-regular);color:var(--muted)}
#requestContent .call-duration data {color:var(--ink);font-variant-numeric:tabular-nums}
#requestContent .operation-icon {display:inline-flex;align-self:center;flex:0 0 24px;color:var(--ink)}
#requestContent .request-context-timeline .context-entry-label.call-started {font-size:var(--type-caption);color:var(--muted);margin:4px 0}
#requestContent .journey-item>.detail-disclosure {border-bottom:0;margin-top:4px}
#requestContent .journey-item>.detail-disclosure>summary {font-size:var(--type-small);color:var(--muted)}
#requestContent .technical-detail>p {font-size:var(--type-body);line-height:var(--leading-reading);margin-block:8px}
#requestContent .technical-detail .ux-code-block {margin-bottom:0}
#requestContent .recorded-arguments>pre {white-space:pre-wrap;overflow-wrap:anywhere}
#requestContent .reader-footer {border-top:1px solid var(--rule);padding-top:12px}
#requestContent .request-context-summaries {border:0;margin:0}
#requestContent .request-context-summaries>h2 {margin:0;font-size:var(--type-body);line-height:var(--leading-ui)}
#requestContent .request-actions {display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:4px 12px;margin:0 0 8px;padding:0;border:0}
#requestContent .request-actions>div {flex:0 1 auto}
#requestContent .request-actions p {margin:0}
#requestContent .request-recorded {padding-top:0;margin-top:8px;border:0}
#requestContent .request-support {margin-top:8px}
#requestContent .request-context-summaries .interaction-insights {margin-block:8px}
#requestContent .request-context-summaries .assessment-findings {font-size:var(--type-body);margin-block:8px}
#requestContent .request-context-summaries .assessment-saved-details {margin-block:4px}
#requestContent .request-context-summaries .assessment-saved-details>summary {font-size:var(--type-body)}
#requestContent .reader-evidence-scope {margin-block:12px 0;font-size:var(--type-small);color:var(--muted)}
#requestContent .reader-evidence-scope a {display:inline-flex;align-items:center;min-height:24px}
.single-interaction-measures {width:100%;table-layout:fixed;font-size:var(--type-body);line-height:var(--leading-ui)}
.single-interaction-measures :is(th,td) {vertical-align:top;overflow-wrap:anywhere;white-space:normal}
.single-interaction-measures th {font-weight:var(--weight-strong);color:var(--muted)}
.single-interaction-measures td,.single-interaction-measures td :is(p,code,.single-measure-value) {font-weight:var(--weight-regular)}
.single-interaction-measures th:first-child {width:24%}
.single-interaction-measures :is(p,code) {margin:4px 0;font-size:inherit;overflow-wrap:anywhere}
.single-interaction-measures ul {list-style:none;margin:4px 0;padding:0}
.single-interaction-measures li {margin:4px 0}
.single-interaction-measures .single-measure-coverage,.single-interaction-measures .single-measure-reason {color:var(--muted)}
.single-interaction-measures .positive {color:var(--success)}
.single-interaction-measures :is(.negative,.error) {color:var(--danger)}
@container (max-width:44rem) {
 .single-interaction-measures,.single-interaction-measures tbody {display:block}
 .single-interaction-measures thead {position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}
 .single-interaction-measures tr {display:grid;grid-template-columns:minmax(0,1fr);border-bottom:1px solid var(--rule);padding-block:12px}
 .single-interaction-measures :is(th,td),.single-interaction-measures th:first-child {display:block;width:auto;padding:4px 0;border:0}
}
@container (max-width:32rem) {
 #requestContent .technical-detail .facts {grid-template-columns:minmax(0,1fr);gap:0}
 #requestContent .technical-detail .facts dd {margin-bottom:8px}
}
body {--context-sidebar-width:min(42vw,34rem);min-height:var(--context-anchor-height,0px)}
body[data-context-docked]>main {width:calc(100% - var(--app-sidebar-width,196px) - var(--context-sidebar-width))}
body[data-reader-expanded]>main {visibility:hidden}
#contextSidebar {position:fixed;inset:var(--app-header-height,76px) 0 0 auto;margin:0;padding:0;width:var(--context-sidebar-width);max-width:100%;height:calc(100dvh - var(--app-header-height,76px));max-height:none;border:0;border-inline-start:1px solid transparent;border-radius:0;background:var(--paper);color:var(--ink);box-shadow:var(--context-sidebar-shadow);overflow:hidden;z-index:2}
#contextSidebar[open] {display:grid;grid-template-rows:auto auto minmax(0,1fr) auto}
#contextSidebar[data-mode=overlay] {inset:0 0 0 auto;width:min(100%,40rem);height:100dvh}
#contextSidebar::backdrop {background:var(--scrim)}
.context-sidebar-header {grid-row:1;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 20px;border-bottom:1px solid transparent;min-width:0}
.context-sidebar-header>h2 {font-size:var(--type-body);font-weight:var(--weight-regular)}
.context-sidebar-header .icon-only>.wire-icon {width:var(--icon-utility-size);height:var(--icon-utility-size)}
.context-sidebar-controls,#readerWidthControls {display:flex;align-items:center;flex:none}
.context-sidebar-controls button {display:grid;place-items:center;flex:none;width:44px;height:44px;min-height:44px;padding:10px}
.context-sidebar-controls button[aria-disabled=true] {color:var(--muted);cursor:default}
#readerResize {position:absolute;inset:0 auto 0 0;width:12px;cursor:ew-resize;touch-action:none;z-index:3;outline-offset:-3px}
#readerResize::after {content:"";position:absolute;inset:calc(50% - 24px) auto auto 3px;width:3px;height:48px;border-radius:2px;background:var(--muted);opacity:.5}
#readerResize:is(:hover,:focus-visible)::after,#contextSidebar[data-resizing] #readerResize::after {background:var(--ink);opacity:1}
#contextSidebar[data-resizing] {user-select:none;cursor:ew-resize}
#contextSidebar[data-mode=expanded] #requestView {max-width:72ch;margin-inline:auto}
#contextSidebarBody {grid-row:3;min-height:0;overflow-y:auto;overscroll-behavior:contain;scroll-padding:16px;padding:20px;container-type:inline-size}
#contextSidebarFooter {grid-row:4;padding:8px 20px max(8px,env(safe-area-inset-bottom));border-top:1px solid transparent;background:var(--paper);min-width:0}
#contextSidebarFooter:empty {display:none}
#contextSidebarFooter .request-actions {display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:flex-end;margin:0;padding:0;border:0}
#contextSidebarFooter #requestReportTitle {flex-basis:100%;font-size:var(--type-small)}
#contextSidebarGuard {grid-row:2;padding:12px 20px;border-bottom:1px solid var(--rule)}
#contextSidebarGuard>p {margin-bottom:8px}
#contextSidebarGuard>button {margin-inline-end:8px}
#contextSidebar :is(.request-original,.interaction-response) {min-width:0}
#contextSidebar :is(.full-text-content,pre) {max-width:100%;overflow-wrap:anywhere;white-space:pre-wrap}
#contextSidebar .assessment-inline {margin-top:12px;padding-top:12px;border-top:1px solid var(--rule);min-width:0}
#contextSidebar .assessment-inline>.assessment-dialog-body {padding:0;max-height:none;overflow:visible}
#contextSidebar .assessment-inline>.dialog-head {position:static;padding:0;display:flex;flex-wrap:wrap;gap:8px}
#contextSidebar .assessment-inline>.dialog-head h2 {font-size:var(--type-body)}
@media(forced-colors:active) {
 #contextSidebar {border-inline-start-color:CanvasText;box-shadow:none}
 .context-sidebar-header {border-bottom-color:CanvasText}
 #contextSidebarFooter {border-top-color:CanvasText}
}
@container(max-width:32rem) {
 #contextSidebar :is(.facts,.action-fields) {grid-template-columns:minmax(0,1fr)}
 #contextSidebar .automatic-score-limits {grid-template-columns:minmax(0,1fr)}
}
@media(max-width:600px) {
 .request-original,.interaction-response {padding:16px}
 .full-text-reader-actions {flex-basis:100%;margin-inline-start:0;justify-content:flex-start}
 .reader-copy-scope,.full-text-reader-actions .ux-copy-status:not(.error) {text-align:start}
 .request-support .facts,.journey-item>details .facts {grid-template-columns:minmax(0,1fr);gap:4px}
 .request-support .facts dd,.journey-item>details .facts dd {margin-bottom:12px}
 #requestContent :is(.facts,.action-fields) {grid-template-columns:minmax(0,1fr);gap:0}
 #requestContent :is(.facts,.action-fields) dd {margin-bottom:8px}
 #requestContent .reader-facts {gap:4px 16px}
 #requestContent .full-text-reader-actions {flex-basis:auto;margin-inline-start:auto;gap:0}
 #requestContent .reader-facts .reader-source {gap:4px 16px}
}
#requestContent .reader-section {min-width:0}
#requestContent .reader-section~.reader-section {margin-top:20px;padding-top:12px;border-top:1px solid var(--rule)}
#requestContent .reader-section-heading {display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin:0 0 6px;font-size:var(--type-reading);font-weight:var(--weight-medium);line-height:1.4}
#requestContent .reader-section-toggle {display:inline-flex;flex:1 1 0;align-items:center;gap:8px;min-width:0;min-height:44px;max-width:100%;padding:0;border:0;border-radius:2px;background:transparent;font:inherit;text-align:start;white-space:normal}
#requestContent .reader-section-toggle>span {min-width:0;overflow-wrap:anywhere}
#requestContent .reader-section-toggle::before {content:none}
#requestContent .reader-section-toggle:hover,#requestContent .reader-section-toggle[aria-expanded=false] {background:transparent}
#requestContent .reader-section-toggle>.wire-icon {width:16px;height:16px;flex:none;color:var(--muted)}
#requestContent .reader-section-toggle[aria-expanded=true]>.wire-icon {transform:rotate(90deg)}
#requestContent .reader-section-context {margin-inline-start:auto;min-width:0;color:var(--muted);font:inherit;overflow-wrap:anywhere}
#requestContent .reader-section-actions {display:flex;align-items:center;gap:2px;min-width:0}
#requestContent .reader-section-actions:empty {display:none}
#requestContent .reader-section[data-open=false]>.reader-section-heading>.reader-section-actions {visibility:hidden;pointer-events:none}
#requestContent .reader-section-clip,#requestContent .reader-section-content {min-width:0}
#requestContent .reader-section-content {padding-bottom:4px}
#requestContent .reader-section-notice {margin:0 0 12px;color:var(--ink)}
#requestContent .reader-input>.ux-copy {border:0;background:transparent;color:var(--muted)}
#requestContent .reader-input>.ux-copy::before {content:none}
#requestContent .reader-input>.ux-copy:hover {background:var(--hover);color:var(--ink)}
#requestContent :is(.reader-prompt-list,.reader-response-list) {list-style:none;margin:0;padding:0;min-width:0}
#requestContent :is(.reader-prompt-list,.reader-response-list)>.journey-item {margin:0;padding:0;border:0;min-width:0}
#requestContent .reader-section :is(.request-original,.interaction-response) {padding:0;margin:0;border:0;background:none}
#requestContent .reader-owned-text>.full-text-header {margin-bottom:8px;min-height:0}
#requestContent .reader-owned-text[data-text-subject=request]>.full-text-header>h2 {display:inline-block;width:fit-content;margin:0;padding:0;background:none;border-radius:0;font:inherit;color:var(--prompt-author-ink)}
#requestContent .reader-owned-text:has(.reader-prompt-role-label)>.full-text-header {margin-bottom:0}
#requestContent .reader-owned-text:has(.reader-prompt-role-label) .full-text-qualifiers:not(:empty) {margin-bottom:6px}
#requestContent .reader-owned-text:has([data-prompt-actor=agent])>.full-text-body {border-inline-start-color:var(--prompt-author-agent)}
#requestContent .reader-section-actions>.full-text-reader-actions {display:flex;align-items:center;gap:2px;margin:0}
#requestContent .full-text-content.prompt-preview-clamped {display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:clip}
#requestContent .prompt-preview-toggle {min-height:44px;max-width:100%;margin:4px 0 0;padding:8px 0;border:0;background:transparent;color:var(--accent);font:inherit;text-align:start;text-decoration:underline;text-underline-offset:3px;white-space:normal;overflow-wrap:anywhere}
#requestContent .prompt-preview-toggle::before {content:none}
#requestContent .prompt-preview-toggle:hover {color:var(--ink)}
#requestContent .reader-section .reader-facts {display:grid;gap:12px;margin:12px 0 0}
#requestContent .reader-section .reader-facts>.reader-fields {display:grid;gap:12px;margin:0}
#requestContent .reader-section .reader-facts>.reader-fields>div {display:flex;flex-wrap:wrap;gap:2px 8px}
#requestContent .reader-section .reader-facts>.reader-fields dd {flex:1 1 14ch;margin:0}
#requestContent .reader-section .reader-facts>.reader-fields .model-recording-note {flex-basis:100%;font-size:var(--type-small);color:var(--muted)}
#requestContent .reader-recorded-at {margin:12px 0 0;color:var(--muted);font:inherit;line-height:1.5;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
#requestContent .reader-interaction-time {font-size:var(--type-caption)}
#requestContent .reader-prompt-timing {margin-top:12px}
#requestContent .reader-prompt-timing>.reader-recorded-at {margin:0}
#requestContent .reader-prompt-timing>.reader-response-timing {margin-top:8px}
#requestContent .reader-section .reader-prompt-timing>.reader-response-timing>div {display:flex;flex-wrap:wrap;gap:2px 8px}
#requestContent .reader-section .reader-response-timing dd {margin:0}
#requestContent .reader-fields {display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin:0;min-width:0;font-size:var(--type-body);line-height:1.5}
#requestContent .reader-section .reader-fields>div {display:block;min-width:0}
#requestContent .reader-fields dt {margin:0;color:var(--muted);font:inherit;overflow-wrap:anywhere}
#requestContent .reader-fields dd {margin:2px 0 0;min-width:0;color:var(--ink);font:inherit;overflow-wrap:anywhere}
#requestContent .reader-fields dd>h3 {margin:0;font:inherit}
#requestContent .reader-check-counts {grid-template-columns:repeat(3,minmax(0,1fr))}
#requestContent .reader-check-counts dd.negative {color:var(--danger)}
#requestContent .reader-fields+.reader-fields,#requestContent .reader-source-record>.reader-fields+.reader-fields {margin-top:12px}
#requestContent .reader-identifiers-toggle {margin-top:8px;color:var(--muted)}
#requestContent .reader-identifiers:not([hidden]) {margin-top:8px}
#requestContent .reader-time-offset {white-space:nowrap}
#requestContent .reader-local-timing:not(:empty) {margin-top:16px}
#requestContent .reader-section .reader-identifier,#requestContent .reader-section .api-path {display:block;min-width:0;font:inherit;background:none;padding:0;border:0;border-radius:0;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
#requestContent .reader-call-summary {display:flex;flex-wrap:wrap;align-items:center;gap:6px 24px;margin:8px 0 0;min-width:0;font-size:var(--type-body);line-height:1.5}
#requestContent .reader-call-summary .recorded-results {margin:0;font:inherit}
#requestContent .reader-call-summary .recorded-result {padding:0;border:0;border-radius:0;background:none;box-shadow:none;font:var(--weight-regular) var(--type-reading)/1.5 var(--font)}
#requestContent .reader-call-summary .recorded-result-label {white-space:normal}
#requestContent .reader-call-summary .result-story {display:grid;justify-items:start;gap:6px;color:var(--ink)}
#requestContent .reader-call-summary .result-cause {color:var(--ink);font:var(--weight-regular) var(--type-reading)/1.5 var(--font)}
#requestContent .reader-call-row>.returned-api-entries,#requestContent .reader-call-row>.selected-api-result {margin-inline-start:20px;min-width:0}
#requestContent .api-result-entry .recorded-result {padding:0;border:0;border-radius:0;background:none;box-shadow:none;font:var(--weight-regular) var(--type-reading)/1.5 var(--font)}
#requestContent .api-result-entry .reader-error-message {font:var(--weight-regular) var(--type-reading)/1.5 var(--font)}
#requestContent .api-result-entry>.reader-error-details {margin:6px 0}
#requestContent .reader-call-summary .recorded-result::before {content:none}
#requestContent .reader-call-duration {display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:4px 6px;min-width:0;font:inherit;font-variant-numeric:tabular-nums}
#requestContent .reader-duration-label {color:var(--muted)}
#requestContent .reader-call-duration .call-duration {font:inherit}
#requestContent .reader-call-duration data {color:var(--ink)}
#requestContent .reader-tool-name {font-weight:var(--weight-medium)}
#requestContent :is(.request-context-timeline,.reader-context-list) .reader-call-identity .context-entry-label {display:inline;margin:0;font:inherit;color:var(--muted)}
#requestContent .request-context-timeline .reader-call-identity .context-selected-label {color:var(--accent)}
#requestContent .reader-entry-label {color:var(--ink);margin:0 0 12px}
#requestContent .recorded-result:is(.result-tone-success,.result-tone-failure) .reader-entry-label {color:inherit}
#requestContent .request-context-timeline>.journey-item[data-context-kind=action] {padding-block:20px}
#requestContent .request-context-timeline>.journey-item[data-context-kind=action]:first-child {padding-top:0}
#requestContent .request-context-timeline>.journey-item[data-context-kind=action]:last-child {padding-bottom:0}
#requestContent .reader-call-summary+.reader-fields {margin-top:12px}
#requestContent .reader-values {display:grid;gap:6px;list-style:none;margin:0;padding:0;min-width:0}
#requestContent .reader-values>li {margin:0;padding:0;min-width:0;overflow-wrap:anywhere}
#requestContent .reader-values .semantic-cue {font:inherit;line-height:1.5}
#requestContent .reader-values .service-cue {--cue-icon-size:20px}
#requestContent .reader-input {display:grid;grid-template-columns:minmax(0,1fr);gap:6px 8px;align-items:start;margin-top:16px;min-width:0;line-height:1.5}
#requestContent .reader-input-copy {grid-template-columns:minmax(0,1fr) 44px}
#requestContent .reader-input-heading {grid-column:1;grid-row:1;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;min-width:0}
#requestContent .reader-input-label {min-width:0;color:var(--muted);font:inherit;line-height:1.5}
#requestContent .reader-input>.ux-copy {grid-column:2;grid-row:1/span 2;align-self:start;align-items:flex-start;padding-block-start:max(0px,calc((1.5em - 20px)/2))}
#requestContent .reader-input-value {grid-column:1;grid-row:2;min-width:0}
#requestContent .reader-input-value>.reader-request-paths {margin:0}
#requestContent .reader-input-value>ol.reader-request-paths {padding-inline-start:1.4em;list-style:decimal}
#requestContent .reader-response-availability {margin:20px 0 0;padding:12px 0 0;border:0;border-top:1px solid var(--rule);border-radius:0;background:none;min-width:0}
#requestContent .reader-response-availability:has(>.reader-empty) {display:block}
#requestContent .reader-response-availability[hidden] {display:none}
#requestContent .reader-response-availability.interaction-response>h2 {position:static;inline-size:auto;block-size:auto;overflow:visible;clip-path:none;white-space:normal;font:inherit;margin:0 0 8px}
#requestContent .reader-linked-context>summary {min-height:44px;font:inherit}
#requestContent .reader-linked-context .reader-context-heading {font:inherit;margin:0 0 6px}
#requestContent .reader-linked-context .full-text-body {border:0;padding:0;background:none}
#requestContent .reader-input>.reader-fields {grid-column:1/-1;margin-top:12px}
#requestContent .reader-input>.ux-copy-status.error {grid-column:1/-1}
#requestContent .reader-request-text {margin:0;padding:8px 12px;border-inline-start:2px solid var(--rule);background:none;font:inherit;font-weight:var(--weight-regular);white-space:pre-wrap;overflow-wrap:anywhere}
#requestContent .reader-section .technical-detail>.facts:empty {display:none}
#requestContent .reader-section .technical-detail {margin-top:16px;min-width:0}
#requestContent .reader-section .technical-detail>:first-child {margin-top:0}
#requestContent .reader-section :is(.facts,.action-fields) {grid-template-columns:minmax(0,1fr);gap:0;line-height:1.5}
#requestContent .reader-section :is(.facts,.action-fields) dd {margin:2px 0 12px}
#requestContent .reader-section :is(.facts,.action-fields) dd:last-child {margin-bottom:0}
#requestContent .reader-source-record+.reader-source-record {margin-top:20px}
#requestContent .reader-source-heading {font:inherit;margin-bottom:12px}
#requestContent .reader-record-limits {display:grid;gap:10px;margin-top:16px;color:var(--muted)}
#requestContent .reader-record-limits>p {margin:0;font:inherit;line-height:1.5}
#requestContent .reader-error-details {display:grid;gap:8px;margin:12px 0;min-width:0}
#requestContent .reader-error-message {margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;color:var(--ink)}
#requestContent .reader-section-title {font-weight:var(--weight-medium)}
#requestContent .request-context-timeline {gap:0}
#requestContent .request-context-timeline>.reader-call-row[data-context-kind=action] {padding-block:16px;border-block-start:0}
#requestContent .reader-call-row:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
#requestContent .reader-native-message {min-width:0;margin-block:0 16px}
#requestContent .reader-native-message>.reader-context-heading {font:inherit;margin:0 0 6px}
#requestContent .native-source-fact {min-width:0;margin-block:0 20px;overflow-wrap:anywhere}
#requestContent .native-source-fact>.reader-context-heading {font:var(--weight-medium) var(--type-small)/var(--leading-ui) var(--font);margin:0 0 6px}
#requestContent .native-source-fact:focus-visible {outline:2px solid var(--focus);outline-offset:4px}
#requestContent .native-source-fact p {margin-block:4px}
#requestContent .native-update-list {padding-inline-start:20px;margin-block:8px}
#requestContent .native-update-list>li+li {margin-block-start:8px}
#requestContent .reader-message-text {font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
#requestContent .reader-call-row .call-heading {display:block}
#requestContent .reader-call-row .reader-call-identity {font:400 var(--type-small)/var(--leading-ui) var(--font);margin:0}
#requestContent .reader-call-row .reader-call-summary {display:block;margin:0;font:inherit}
#requestContent .reader-call-secondary {display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 20px;margin-top:12px}
#requestContent .reader-call-secondary:empty {display:none}
#requestContent .reader-call-services {margin:0;font-size:var(--type-small)}
#requestContent .reader-attribution-context {margin:12px 0 0;color:var(--muted);font:var(--weight-regular) var(--type-small)/1.5 var(--font);max-width:none}
#requestContent .reader-operation-context {margin:0 0 16px;color:var(--muted);font:var(--weight-regular) var(--type-small)/1.5 var(--font);max-width:none}
#requestContent .reader-call-toggle {display:flex;flex-direction:column;align-items:stretch;gap:6px;width:100%;font:inherit;min-height:44px;padding:0;border:0;background:transparent;text-align:start;color:var(--ink);user-select:text}
#requestContent .reader-call-identity-line {display:flex;flex-wrap:wrap;align-items:baseline;gap:0 var(--space-md);min-width:0}
#requestContent .reader-call-identity-line>.reader-call-disclosure {margin-inline-start:auto;align-self:center;flex:none;width:16px;height:16px;color:var(--muted)}
#requestContent .reader-call-toggle[aria-expanded=true] .reader-call-disclosure {transform:rotate(90deg)}
#requestContent .reader-call-toggle::before {content:none}
#requestContent .reader-call-toggle:hover {background:transparent;text-decoration:none}
#requestContent .reader-call-toggle:hover .reader-call-identity-line {text-decoration:underline;text-underline-offset:3px}
#requestContent .technical-detail[hidden] {display:none}
#requestContent .reader-call-row .reader-call-duration {font-size:var(--type-small);color:var(--muted)}
#requestContent .reader-call-row .reader-call-duration data {color:var(--muted)}
#requestContent.tool-activity-log [data-reader-section=activity]>.reader-section-heading {position:sticky;top:calc(-1 * var(--reader-timing-padding,20px));z-index:1;background:var(--paper)}
#requestContent.tool-activity-log [data-reader-section=activity] :is(.reader-call-row,.reader-call-row .call-heading,.reader-call-toggle) {scroll-margin-block-start:var(--reader-timing-inset,16px)}
#requestContent .reader-response-availability:has(>.reader-empty) {display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;margin-top:24px;padding-top:20px}
#requestContent .reader-response-availability:has(>.reader-empty)>h2 {margin:0;font-weight:var(--weight-medium)}
#requestContent .reader-response-availability:has(>.reader-empty)>h2::after {content:":"}
#requestContent .reader-response-availability>.reader-response-note {flex-basis:100%}
@container(max-width:28rem) {
 #requestContent .reader-check-counts {grid-template-columns:minmax(0,1fr)}
 #requestContent .reader-call-secondary {gap:8px 16px}
}
`;
