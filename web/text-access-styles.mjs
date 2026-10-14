export const textAccessStyles = `
.facts dt {min-width:0;overflow-wrap:anywhere}
.full-text {min-width:0;max-width:100%}
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
#activitySelectionContext>#pageAction {display:inline-flex;margin-top:4px}
.request-actions-heading {margin:0}
.request-support {margin-top:20px}
.request-view-context>summary {min-height:44px;cursor:pointer}
.viewing-context:has(.request-view-context) {padding:0;margin:0 0 12px;border:0}
.request-view-context[open]>div {padding:8px 0 12px}
.action-heading {display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-xs) var(--space-lg);min-width:0;font-size:var(--type-body);line-height:var(--leading-ui)}
.action-heading h3 {margin:0;font:inherit;font-weight:var(--weight-strong)}
.action-heading h3,.action-heading span {overflow-wrap:anywhere;min-width:0;max-width:100%}
.action-service-heading {display:inline-flex;align-items:center;gap:var(--space-xs)}
.action-heading .service-cue {align-items:flex-start;line-height:inherit}
.journey-item {overflow-wrap:anywhere}
.journey-item:has(>.call-heading)>.action-fields {margin-block:8px}
.journey-item:has(>.call-heading)>.call-api-summary {margin-block:8px}
.journey-item:has(>.call-heading)>.call-heading .action-heading {gap:8px 16px}
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
body:has(#requestView:not([hidden])) .breadcrumbs {display:none}
body:has(#requestView:not([hidden])) .page-heading {justify-content:flex-start;flex-direction:row;flex-wrap:wrap;gap:12px;margin-bottom:16px;max-inline-size:62rem}
body:has(#requestView:not([hidden])) .page-heading h1 {font-size:var(--type-body);font-weight:var(--weight-regular);color:var(--muted)}
body:has(#requestView:not([hidden])) .page-heading>div:first-child {position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
body:has(#requestView:not([hidden])) #pagePrimaryActions {order:-1}
.page-heading #contextBack.reader-back {display:inline-flex;align-items:center;gap:8px;border:0;background:transparent;padding-inline:0}
.page-heading #contextBack.reader-back::before {content:none}
.page-heading #contextBack.reader-back:hover {background:var(--hover)}
.reader-back .fluent-icon {flex:0 0 20px}
#requestContent .request-intro {gap:4px 20px;margin-bottom:12px}
#requestContent .request-intro:empty {display:none}
#requestContent .reader-scope {font-size:var(--type-body);line-height:var(--leading-ui)}
#requestContent .reader-scope {flex-basis:100%;margin-top:8px;color:var(--muted)}
#requestContent .request-context-timeline {margin-block:0 12px;padding:0}
#requestContent .request-context-timeline>.journey-item {padding:16px 0;margin:0;border:0;border-bottom:1px solid var(--rule)}
#requestContent .request-context-timeline>.journey-item:first-child {padding-top:0}
#requestContent .request-context-timeline>.journey-item:last-child {border-bottom:0;padding-bottom:0}
#requestContent .request-context-timeline>.journey-item[data-selected-action=true] {border-inline-start:2px solid var(--accent);padding-inline-start:16px}
#requestContent .request-context-timeline :is(.full-text-header h2,.full-text-header h3,.interaction-response>h2,.call-heading h3) {font-family:var(--font);font-size:var(--type-body);line-height:var(--leading-reading);font-weight:var(--weight-strong);margin:0}
#requestContent .request-context-timeline .context-entry-label {font-size:var(--type-body);line-height:var(--leading-ui);margin-bottom:4px;color:var(--ink)}
#requestContent .context-entry-label strong {font-weight:var(--weight-strong);color:var(--muted)}
#requestContent .request-context-timeline :is(.call-duration,.action-context,.action-fields,.reader-response-note,.reader-empty) {font-size:var(--type-body);line-height:var(--leading-reading)}
#requestContent .request-context-timeline .call-heading {gap:4px 16px}
#requestContent .full-text-complete {max-inline-size:100%}
#requestContent .full-text-header {gap:4px 16px}
#requestContent .full-text-reader-actions {gap:0 8px;margin-block:0}
#requestContent .full-text-reader-actions>button {display:inline-flex;align-items:center;justify-content:center;margin:0;font-size:var(--type-control);line-height:var(--leading-control)}
#requestContent .full-text-reader-actions>button {border:0;background:transparent;padding:8px;min-height:44px;color:var(--muted)}
#requestContent .full-text-reader-actions>button::before {content:none}
#requestContent .full-text-reader-actions>button:hover {background:var(--hover);color:var(--ink)}
#requestContent [data-text-subject=request] .full-text-content {max-inline-size:68ch;font-size:var(--type-body);font-weight:var(--weight-strong);font-style:italic}
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
#requestContent .reader-facts>dl dt {font-weight:var(--weight-strong);color:var(--muted)}
#requestContent .reader-facts>dl dd {margin:0;font-weight:var(--weight-regular);color:var(--ink);overflow-wrap:anywhere}
#requestContent :is(.facts,.action-fields) {font-size:var(--type-body);line-height:var(--leading-ui);grid-template-columns:minmax(0,10rem) minmax(0,1fr);align-items:baseline;gap:4px 12px;margin-block:8px}
#requestContent :is(.facts,.action-fields) dt {color:var(--muted);font-weight:var(--weight-strong)}
#requestContent :is(.facts,.action-fields) dd {color:var(--ink);font-weight:var(--weight-regular)}
#requestContent .reader-identifier {font-family:var(--font);font-size:inherit;user-select:text;overflow-wrap:anywhere}
#requestContent .call-duration strong {font-weight:var(--weight-strong)}
#requestContent .call-duration-label {font-weight:var(--weight-strong);color:var(--muted)}
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
@media(max-width:700px) {
 .single-interaction-measures,.single-interaction-measures tbody {display:block}
 .single-interaction-measures thead {position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}
 .single-interaction-measures tr {display:grid;grid-template-columns:minmax(0,1fr);border-bottom:1px solid var(--rule);padding-block:12px}
 .single-interaction-measures :is(th,td),.single-interaction-measures th:first-child {display:block;width:auto;padding:4px 0;border:0}
}
@container (max-width:32rem) {
 #requestContent .technical-detail .facts {grid-template-columns:minmax(0,1fr);gap:0}
 #requestContent .technical-detail .facts dd {margin-bottom:8px}
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
`;
