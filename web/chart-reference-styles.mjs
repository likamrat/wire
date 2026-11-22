export const chartReferenceStyles = `
.chart-reference {
 --chart-reference-inset:16px;--pill-hover:var(--surface-divider);
 position:fixed;inset:var(--chart-reference-inset) var(--chart-reference-inset) auto auto;margin:0;
 width:min(480px,calc(100vw - 2 * var(--chart-reference-inset)));max-width:none;
 height:calc(100dvh - 2 * var(--chart-reference-inset));max-height:none;
 padding:0;background:var(--floating-paper);color:var(--ink);
 border:1px solid var(--surface-divider);border-radius:var(--radius-dialog);box-shadow:var(--surface-shadow);
 overflow:hidden;overscroll-behavior:contain;container:chart-reference / inline-size;
 font-family:var(--font);font-size:var(--type-reading);line-height:1.5;
}
.chart-reference[open] {display:flex;flex-direction:column}
.chart-reference::backdrop {background:color-mix(in srgb,var(--scrim) 28%,transparent)}
.chart-reference-heading {display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;border-bottom:1px solid var(--surface-divider);flex:none}
.chart-reference-heading>h2 {margin:0;font-size:1.125rem;font-weight:var(--weight-medium);line-height:var(--leading-heading)}
.chart-reference #closeChartReference {width:44px;height:44px;min-width:44px;flex:none;padding:10px}
.chart-reference #closeChartReference>.wire-icon {width:20px;height:20px}
.chart-reference :is(button,input,select,summary) {min-height:44px;font-family:var(--font)}
.chart-reference button {font-size:var(--type-reading);white-space:normal}
.chart-reference :is(button,a,input,select,summary,[tabindex]):focus-visible {outline:2px solid var(--focus);outline-offset:3px}
.chart-reference-body {display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden}
.chart-reference-body>#chartReferenceNotice {flex:none;max-height:30%;overflow:auto;margin:12px 20px 0}
.chart-reference-layout {display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}
.chart-reference .chart-reference-return {display:flex;align-items:center;align-self:flex-start;gap:8px;margin:12px 20px 4px;padding:8px 4px;color:var(--muted);flex:none}
.chart-reference-return>.wire-icon {width:16px;height:16px;flex:none}
.chart-reference-explanation,.chart-reference-index,.chart-reference-exact {min-width:0;min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scroll-padding:8px;padding:20px 24px}
.chart-reference-explanation {padding-top:12px}
#meaning.chart-reference .chart-reference-index>h3 {margin:0 0 16px;font-size:1.5rem;font-weight:var(--weight-medium)}
.chart-reference-topics {min-width:0;display:flex;flex-direction:column;gap:4px}
.chart-reference .chart-reference-topic {--pill-fill:transparent;--pill-border:transparent;--pill-hover-border:transparent;--action-shadow:none;display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;text-align:left;min-height:52px;padding:12px;border:0;border-radius:8px;background:transparent;color:var(--ink);box-shadow:none}
.chart-reference-topic>.wire-icon {width:18px;height:18px;flex:none}
.chart-reference .chart-reference-topic[aria-pressed=true] {--pill-hover-border:var(--control);font-weight:var(--weight-strong)}
#meaning.chart-reference .chart-reference-explanation>h3,#meaning.chart-reference .chart-reference-exact>h3 {margin:0;font-size:1.5rem;font-weight:var(--weight-medium);line-height:var(--leading-heading)}
.chart-reference-intro {margin:12px 0 20px;color:var(--ink);max-width:62ch}
.chart-reference-group {padding-block:12px}
.chart-reference-group:first-of-type {padding-top:0}
.chart-reference-group:last-child {padding-bottom:0}
.chart-reference-group>p {margin:8px 0 0}
.chart-reference-group-heading {display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 24px}
.chart-reference-group-heading>span {font-size:var(--type-small);font-weight:var(--weight-regular)}
.chart-reference-definitions {margin:12px 0 0}
.chart-reference-definition {display:grid;grid-template-columns:minmax(0,1fr) fit-content(40%);gap:8px 16px;padding-block:14px;border-top:1px solid var(--surface-divider)}
.chart-reference-definition:first-child {border-top:0}
.chart-reference-definition>dt {grid-column:1;grid-row:1;display:flex;align-items:center;gap:8px;min-width:0;font-size:var(--type-reading);font-weight:var(--weight-medium);line-height:var(--leading-ui)}
.chart-reference-definition>dd {margin:0;font-size:var(--type-reading)}
.chart-reference-definition-copy {grid-column:1/-1;grid-row:2;color:var(--muted);overflow-wrap:anywhere}
.chart-reference-outcome {display:inline-flex;align-items:center;flex:none;color:var(--cue-color)}
.chart-reference-outcome>.wire-icon {width:18px;height:18px}
.chart-reference-definition>.chart-reference-value {grid-column:2;grid-row:1}
.chart-reference-value {text-align:right;color:var(--ink);font-variant-numeric:tabular-nums;white-space:normal;font-weight:var(--weight-medium)}
.chart-reference-value .percentage-value {font:inherit}
.chart-reference-actions {display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;flex:none;max-height:35%;overflow:auto;padding:10px 20px;border-top:1px solid var(--surface-divider)}
.chart-reference-actions>button {display:flex;align-items:center;gap:8px;margin:0}
.chart-reference-actions>button>.wire-icon {width:16px;height:16px;flex:none}
.chart-reference-help {font-size:var(--type-small);color:var(--muted)}
.chart-reference-services {margin-top:20px}
.chart-reference-service {color:var(--ink)}
.chart-reference-service+.chart-reference-service {margin-top:16px}
.chart-reference-service>div {display:flex;align-items:baseline;justify-content:space-between;gap:12px 20px;flex-wrap:wrap}
.chart-reference-service-name {display:flex;align-items:center;gap:8px}
.chart-reference-service-key {width:8px;height:8px;flex:none;border-radius:50%;background:var(--column-label)}
.chart-reference-service-track {display:block;height:4px;background:var(--surface-divider);margin-top:8px}
.chart-reference-service-track>i {display:block;height:100%;background:var(--column-label)}
.chart-reference-qualification {margin:12px 0 20px;color:var(--muted);font-size:var(--type-small);overflow-wrap:anywhere}
.chart-reference-coverage {display:block}
.chart-reference-scope+.chart-reference-coverage {margin-top:var(--space-sm)}
.chart-reference-exact>#chartReferenceBack {margin-bottom:16px}
.chart-reference-find {margin-top:20px}
.chart-reference-find>label {display:block;margin-bottom:8px}
.chart-reference-find>input {width:100%;max-width:28rem;font-size:var(--type-reading)}
.chart-reference-find>p {margin:8px 0 0}
#chartReferenceData {margin-top:20px;min-width:0}
#chartReferenceData :is(table,.percentage-table-wrap) {max-width:100%}
#chartReferenceData table {font-size:var(--type-reading);font-variant-numeric:tabular-nums}
#chartReferenceData .exact-data-table {width:100%}
#chartReferenceData .exact-data-table :is(th,td):first-child {min-width:min(12rem,calc(100cqw - 48px))}
#chartReferenceData .exact-data-table thead th {background:transparent}
#chartReferenceData .chart-data-action {font-size:var(--type-reading)}
#chartReferenceData .list-pager {display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px}
#chartReferenceData :is(th,td) {overflow-wrap:anywhere}
#chartReferenceData :is(.numeric,td:not(:first-child),th:not(:first-child)) {text-align:right}
#chartReferenceData :is(a,button) {min-height:44px}
#chartReferenceData a {display:inline-flex;align-items:center;max-width:100%;white-space:normal}
#chartReferenceData .percentage-reference-notes {margin-top:20px;border-top:1px solid var(--rule)}
#chartReferenceData .percentage-reference-notes>summary {cursor:pointer;min-height:44px;padding-block:12px}
#chartReferenceData .percentage-note {margin:8px 0;max-width:72ch}
@container chart-reference (max-width:22rem) {
 .chart-reference-definition {grid-template-columns:minmax(0,1fr)}
 .chart-reference-definition>.chart-reference-value {grid-column:1;grid-row:2;text-align:left}
 .chart-reference-definition-copy {grid-row:3}
 .chart-reference-group-heading {align-items:flex-start}
}
@media(max-width:699px) {
 .chart-reference {--chart-reference-inset:12px}
 .chart-reference-heading {padding:12px 16px;gap:12px}
 .chart-reference-explanation,.chart-reference-index,.chart-reference-exact {padding-inline:20px}
 .chart-reference-exact .percentage-table-wrap {overflow-x:auto}
}
@media(forced-colors:active) {
 .chart-reference {border-color:CanvasText;box-shadow:none}
 .chart-reference :is(.chart-reference-heading,.chart-reference-actions,.chart-reference-definition) {border-color:CanvasText}
 .chart-reference .chart-reference-topic[aria-pressed=true]:not(:focus-visible) {outline:1px solid Highlight}
 .chart-reference-service-key,.chart-reference-service-track>i {background:CanvasText}
}
/* The Analyze Guide uses the workspace, not a chart overlay. Compare keeps its period panel. */
#analyzeToolbar:has(>#analyzeReferenceEntry:not([hidden])) {flex-wrap:wrap}
#analyzeToolbar>#analyzeReferenceEntry {flex:none}
#workspace:has(>#analyzeReference #meaning[open][data-mode=analyze])>:not(#analyzeReference) {display:none!important}
#meaning[data-mode=analyze] {
 position:relative;inset:auto;width:100%;max-width:none;height:auto;max-height:none;
 background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius);
 box-shadow:none;overflow:visible;scroll-margin-top:var(--app-header-height)
}
#meaning[data-mode=analyze] .chart-reference-heading {padding:12px 24px}
#meaning[data-mode=analyze] #closeChartReference {width:auto;display:inline-flex;align-items:center;gap:8px}
#meaning[data-mode=analyze] .chart-reference-related {margin-block:14px 0;max-width:65ch}
#meaning[data-mode=analyze] .chart-reference-related summary {cursor:pointer;min-height:44px;align-content:center}
#meaning[data-mode=analyze] .chart-reference-body {display:grid;align-content:start;overflow:visible;padding:20px 24px 24px;gap:0}
#meaning[data-mode=analyze] :is(.chart-reference-explanation,.chart-reference-index,.chart-reference-exact) {overflow:visible;scrollbar-gutter:auto;padding:0}
#meaning[data-mode=analyze] :is(.chart-reference-return,#chartReferenceBack) {margin:0 0 12px}
#meaning[data-mode=analyze] .chart-reference-actions {max-height:none;overflow:visible;padding:12px 0 0;border:0}
#meaning[data-mode=analyze] .chart-reference-intro {margin:12px 0 16px}
#meaning[data-mode=analyze] .chart-reference-explanation {max-width:68ch}
#meaning[data-mode=analyze] .chart-reference-definition {grid-template-columns:minmax(8rem, .42fr) minmax(0, 1fr);gap:8px 20px;padding:10px 0}
#meaning[data-mode=analyze] .chart-reference-definition-copy {grid-column:2;grid-row:1;color:var(--ink)}
#meaning[data-mode=analyze] .chart-reference-group {padding-block:4px}
.chart-reference-example {position:static;width:auto;height:auto;padding:14px 16px;margin:18px 0 4px;background:var(--accent-soft);border-radius:var(--radius);color:var(--ink)}
.chart-reference-example h4,.chart-reference-example p {margin:0}
.chart-reference-example p {margin-top:4px}
.chart-reference-topic-group h4 {margin:0 0 4px;font-size:var(--type-small);font-weight:var(--weight-medium);color:var(--muted)}
#meaning[data-mode=analyze] .chart-reference-topics {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr));gap:20px;margin-top:20px}
#meaning .chart-reference-topic {display:flex;justify-content:flex-start;min-height:44px;padding:8px 10px;color:var(--muted);line-height:var(--leading-control);font-weight:var(--weight-regular);font-size:var(--type-control);text-decoration:none;transition:var(--control-paint-transition)}
#meaning .chart-reference-topic::before {content:none}
#meaning .chart-reference-topic[aria-current=page] {background:var(--control-sheen),var(--accent-soft);box-shadow:var(--control-sheen-edge);color:var(--ink);font-weight:var(--weight-medium)}
#meaning .chart-reference-topic:hover {background:var(--hover);color:var(--ink);text-decoration:none}
#meaning .chart-reference-topic:active {color:var(--ink);background:var(--pill-pressed)}
#meaning .chart-reference-topic:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
#meaning[data-mode=analyze] #chartReferenceNotice {margin:0 0 16px;grid-column:1/-1}
@container chart-reference (min-width:48rem) {
 #meaning[data-mode=analyze][data-reference-view=guide] .chart-reference-body {grid-template-columns:minmax(11rem,14rem) minmax(0,1fr);gap:0 clamp(24px,4vw,64px)}
 #meaning[data-mode=analyze][data-reference-view=guide] .chart-reference-topics {display:grid;grid-template-columns:1fr;margin-top:0}
 #meaning[data-mode=analyze][data-reference-view=guide] #chartReferenceIndexTitle {display:none}
}
@container chart-reference (max-width:47.99rem) {
 #meaning[data-mode=analyze][data-reference-view=guide] #chartReferenceIndex {display:none}
}
@container chart-reference (max-width:32rem) {
 #meaning[data-mode=analyze] .chart-reference-definition {display:block}
 #meaning[data-mode=analyze] .chart-reference-definition-copy {margin-top:2px}
 #meaning[data-mode=analyze] .chart-reference-body {padding:16px}
}
@media(forced-colors:active) {
 #meaning .chart-reference-topic[aria-current=page]:not(:focus-visible) {outline:1px solid CanvasText}
 #meaning .chart-reference-topic:focus-visible {outline:2px solid CanvasText;outline-offset:3px}
}
`;
