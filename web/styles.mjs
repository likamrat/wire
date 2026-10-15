import { screenTokens } from "./tokens.mjs";
import { fontFaceStyles } from "../lib/typeface.mjs";
import { uxStyles } from "./ux-styles.mjs";
import { visualStyles } from "./visual-styles.mjs";
import { sidebarStyles } from "./sidebar-styles.mjs";
import { dimensionalChartStyles } from "./dimensional-charts-styles.mjs";
import { toolbarStyles } from "./toolbar-styles.mjs";
import { metadataStyles } from "./metadata-styles.mjs";
import { selectStyles } from "./select-styles.mjs";
import { reportJourneyStyles } from "./report-journey-styles.mjs";
import { settingsStyles } from "./settings-styles.mjs";
import { periodFlowStyles } from "./period-flow-styles.mjs";
import { textAccessStyles } from "./text-access-styles.mjs";
import { semanticCueStyles } from "./semantic-cue-styles.mjs";
import { percentageChartStyles } from "./percentage-charts-styles.mjs";
import { contextualActionStyles } from "./contextual-action-styles.mjs";
import { homeResultFilterStyles } from "./home-result-filter-styles.mjs";
import { promptAuthorStyles } from "./prompt-author-styles.mjs";
import { analyzeLayoutStyles } from "./analyze-layout-styles.mjs";

// These components already own their painted surface independently of their hit target.
const textAction = ":is(button,a.button-link):not(.select-trigger,.theme-trigger,.ux-help,.ux-copy,.filter-clear,.navigation-collapse,.filter-chip,.report-step,.comparison-pattern-title,.time-column,.chart-row,.chart-data-action)";

export const styles = `
/* Shared screen presentation; saved output uses its own tokens. */
${screenTokens}
${fontFaceStyles}
* {box-sizing:border-box}
html,body {margin:0;min-width:0}
html {background:var(--page);font-family:var(--font);scroll-padding-top:100px}
body {background:var(--page);color:var(--ink);font:var(--type-body)/var(--leading-ui) var(--font);font-variant-numeric:tabular-nums;color-scheme:inherit}
button,input,select,.button-link {font:var(--type-control)/var(--leading-control) var(--font);letter-spacing:var(--tracking-ui);color:inherit}
button,select,input:not([type=checkbox]),.button-link {min-height:var(--pill-height);border:1px solid var(--control);border-radius:var(--radius-small);padding:8px 14px;background:var(--paper);max-width:100%;min-width:0}
button,.button-link {border-radius:var(--action-radius,var(--radius-control))}
input:not([type=checkbox]):not([type=radio]),select {border-radius:var(--radius-field)}
button,.button-link {background:var(--pill-fill);color:var(--pill-ink);border-color:var(--pill-border);font-weight:var(--pill-weight);padding-inline:var(--pill-inset)}
select {padding-right:8px;cursor:pointer}
input::placeholder {color:var(--muted);opacity:1}
option {background:var(--paper);color:var(--ink)}
button,.button-link {cursor:pointer;touch-action:manipulation}
button:disabled {cursor:not-allowed;background:var(--canvas);border-color:var(--rule);color:var(--muted)}
button:hover:not(:disabled),.button-link:hover {border-color:var(--pill-border);background:var(--pill-hover);color:var(--pill-ink)}
button:active:not(:disabled),.button-link:active {background:var(--pill-pressed);color:var(--pill-ink)}
a {color:var(--accent);text-decoration:none}
a:is(:hover,:active) {color:var(--ink)}
:is(button,a,input,select,summary):focus-visible {outline:2px solid var(--focus);outline-offset:3px}
:is(h1,h2,h3,h4,h5,h6)[tabindex="-1"] {position:relative;outline:none;border-radius:0}
:is(h1,h2,h3,h4,h5,h6)[tabindex="-1"]:focus-visible::before {content:"";position:absolute;inset-block:.125em;inset-inline-start:-8px;width:3px;background:var(--focus)}
@media(forced-colors:active) {
 :is(h1,h2,h3,h4,h5,h6)[tabindex="-1"]:focus-visible::before {background:Highlight;forced-color-adjust:none}
}
input[type=checkbox] {width:18px;height:18px;accent-color:var(--accent);flex:0 0 auto}
h1,h2,h3,p {margin:0;min-width:0;overflow-wrap:anywhere}
h1 {font-size:var(--type-title);font-weight:var(--weight-strong);line-height:var(--leading-heading);letter-spacing:var(--tracking-heading);text-wrap:balance}
h2 {font-size:var(--type-section);font-weight:var(--weight-strong);line-height:var(--leading-section)}
h3 {font-size:var(--type-body);font-weight:var(--weight-strong);line-height:var(--leading-ui)}
:is(b,strong,h4,h5,h6) {font-weight:var(--weight-strong)}
.chart-heading h2,.percentage-card h3 {text-transform:uppercase;letter-spacing:.025em}
p {max-width:72ch}
.muted {color:var(--muted);font-size:var(--type-caption)}
.collector-panel {margin-bottom:20px;padding:12px 16px;border-radius:var(--radius);background:var(--paper)}
.collector-heading {display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.collector-heading>p {font-weight:600}
.collector-state {min-width:0}
.collector-heading .page-actions button {min-height:44px}
#collectionStatus {font-weight:600}
#collectionStatus[data-severity=error] {color:var(--danger)}
#collectionTimes {display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:2px;font-size:var(--type-caption)}
.collector-panel>.detail-disclosure {margin-top:0}
.collector-panel>.detail-disclosure>summary {min-height:44px;align-content:center;color:var(--muted)}
.collection-issues {margin-top:4px}
.collection-issues>summary {display:flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;list-style:none;color:var(--warning);border-radius:var(--radius-small)}
.collection-issues>summary::-webkit-details-marker {display:none}
.collection-issues>summary:hover {background:var(--canvas)}
.collection-issues[data-severity=error]>summary {color:var(--danger)}
#collectionIssueIcon {display:flex;flex:none}
#collectionIssueLabel {flex:1;min-width:0;overflow-wrap:anywhere}
.collection-issue-action {color:var(--accent);flex:none}
.collection-issues-body {padding:16px;background:var(--canvas);border-radius:var(--radius-small)}
.collection-issues-body>p {margin-top:8px}
.history-reason {margin-top:12px;background:var(--paper);border-radius:var(--radius-small);padding:0 12px}
.history-reason>summary,.history-issue>summary {cursor:pointer;min-height:44px;padding:10px 0}
.history-reason-body>p {margin-top:8px}
.history-issue {border-top:1px solid var(--rule)}
.history-issue-identity {display:inline-flex;vertical-align:top;flex-direction:column;max-width:calc(100% - 24px);gap:2px;overflow-wrap:anywhere}
.history-issue-name {font-weight:600}
.history-issue-detail {padding:0 0 12px 18px;display:grid;gap:8px}
.collection-issues .history-issue-detail>p {margin:0}
.collection-issues .history-reason-body>p {margin:8px 0 0}
.history-issue-detail .detail-disclosure {margin-top:0}
.history-issue-detail .detail-disclosure>summary {min-height:44px;align-content:center}
@media(max-width:600px) {
 .collector-heading {gap:8px}
 .collector-heading .page-actions {justify-content:start;flex-shrink:1}
 .collection-issues>summary {flex-wrap:wrap;padding:6px 0}
 #collectionIssueLabel {flex-basis:calc(100% - 36px)}
 .collection-issue-action {margin-left:28px}
 .collection-issues-body {padding:12px}
}
.collector-form {display:grid;gap:8px;margin:16px 0;max-width:780px}
.collector-form>input {width:100%}
.collector-form fieldset {display:flex;flex-wrap:wrap;gap:12px;border:0;padding:8px 0}
.collector-form fieldset label,.collector-approval {display:flex;align-items:center;gap:8px;min-height:44px}
.collector-form>button {justify-self:start;min-height:44px}
.collector-panel .detail-disclosure>p {margin-top:12px}
.collector-panel .mono {overflow-wrap:anywhere}
.mono {font-family:var(--mono);overflow-wrap:anywhere}
.quiet {border-color:transparent;background:transparent;color:var(--muted);font-weight:var(--weight-regular)}
.quiet:hover:not(:disabled),.quiet:active:not(:disabled) {background:var(--hover);color:var(--ink)}
.primary {--action-radius:var(--radius-primary);font-weight:var(--weight-strong)}
.primary:not(:disabled),.primary:hover:not(:disabled),.primary:active:not(:disabled) {background:var(--accent-soft);border-color:var(--accent);color:var(--accent);font-weight:600}
.primary:hover:not(:disabled) {background:var(--accent-hover)}
.primary:active:not(:disabled) {background:var(--accent-pressed)}
button.danger {white-space:normal;overflow-wrap:anywhere}
button.danger:not(:disabled) {background:var(--paper);color:var(--danger);border-color:var(--danger)}
button.danger:hover:not(:disabled) {background:color-mix(in srgb,var(--danger) 6%,var(--paper))}
button.danger:active:not(:disabled) {background:color-mix(in srgb,var(--danger) 10%,var(--paper));box-shadow:inset 0 0 0 1px var(--danger)}
.text-link {font-weight:var(--weight-medium);text-decoration:none}
.button-link {display:inline-flex;align-items:center;justify-content:center;gap:var(--pill-gap);min-height:var(--pill-height);white-space:normal;overflow-wrap:anywhere}
:is(a.button-link,a.result-link,.primary-navigation a,.app-header nav a):any-link {text-decoration:none}
[hidden] {display:none!important}
.app-header {position:sticky;top:0;z-index:3;background:var(--paper);border-bottom:1px solid var(--rule)}
.header-inner {max-width:1248px;margin:auto;display:flex;gap:var(--space-lg);align-items:center;padding:12px var(--space-xl);min-height:76px}
.brand {font-size:16px;font-weight:var(--weight-strong);white-space:nowrap;color:var(--ink);text-decoration:none}
.app-header nav {display:flex;gap:4px;align-items:center}
.app-header nav a {display:flex;align-items:center;justify-content:center;color:var(--muted);text-decoration:none;border:1px solid transparent;border-radius:var(--radius-pill);padding:8px 14px;min-height:40px}
.app-header nav a:hover {background:var(--hover);color:var(--ink)}
.app-header nav a[aria-current=page] {color:var(--accent);background:var(--accent-soft);font-weight:600;border-color:var(--accent)}
.theme-control {display:flex;align-items:center;gap:8px;margin-left:auto;color:var(--muted)}
.visually-hidden {position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
main {max-width:1200px;margin:0 auto;padding:var(--space-2xl) var(--space-xl) var(--space-3xl)}
.page-heading {display:flex;justify-content:space-between;align-items:center;gap:var(--space-xl);margin-bottom:var(--space-xl)}
.page-heading p {color:var(--muted);margin-top:8px}
.page-actions {display:flex;flex-wrap:wrap;align-items:center;justify-content:end;gap:8px;flex-shrink:0}
#pageHeadingActions:not(:has(> :not([hidden]))) {display:none}
.reset-view {color:var(--accent);white-space:nowrap}
/* The native 24px reset glyph extends into existing padding without growing the 44px target. */
.reset-view>.wire-icon {margin-block:-2px}
.breadcrumbs {display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-height:24px;margin-bottom:16px}
.breadcrumbs:empty {display:none}
.breadcrumbs a {text-decoration:none}
.breadcrumbs span {color:var(--muted)}
.filters {display:flex;flex-wrap:wrap;gap:var(--space-md);align-items:end;padding:var(--space-lg);border:1px solid var(--rule);border-radius:var(--radius);background:var(--paper)}
.filters label,.collection-tools label {display:flex;flex-direction:column;gap:4px;color:var(--muted);flex:1 1 130px;min-width:0}
.filters select {color:var(--ink);width:100%}
.date-fields {width:100%;display:flex;gap:12px;align-items:end;flex-wrap:wrap}
.filter-chips {display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px;min-height:12px}
.filter-chips:empty {margin:0}
.filter-chips:not(:empty) {margin-bottom:16px}
.filter-chip {min-height:32px;padding:4px 12px;background:var(--accent-soft);border-color:var(--control)}
.insight-header {display:flex;justify-content:space-between;align-items:end;gap:var(--space-xl);padding:var(--space-2xl) 0 var(--space-xl)}
.eyebrow {color:var(--muted);margin-bottom:4px}
.activity-total {display:flex;flex-wrap:wrap;align-items:baseline;gap:10px}
#activityCount {font-size:36px;line-height:1.2;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.04em}
#activityUnit {font-size:var(--type-reading);color:var(--muted)}
#takeaway {margin-top:8px;max-width:60ch}
.view-switch {display:flex;flex-shrink:0;padding:4px;border:1px solid var(--rule);border-radius:var(--radius-pill);background:var(--canvas);gap:2px}
.view-switch button {min-height:34px;padding:6px 10px;border-color:transparent;background:transparent;white-space:nowrap}
.view-switch button[aria-pressed=true] {background:var(--paper);border-color:var(--accent);font-weight:600;color:var(--accent)}
.chart-panel {background:var(--paper);border:1px solid var(--rule);border-radius:var(--radius);padding:var(--space-xl);min-width:0;box-shadow:var(--shadow)}
.chart-heading {display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:var(--space-xl)}
.bucket-control {display:flex;align-items:center;gap:8px;font-size:var(--type-caption);color:var(--muted)}
.bucket-control select {min-height:34px;background:var(--paper)}
.time-chart {display:grid;align-items:end;gap:4px;height:220px;min-width:0;border-bottom:1px solid var(--control)}
.time-slot {position:relative;height:100%;min-width:0;display:flex;align-items:end;justify-content:center}
.time-column {display:block;width:min(100%,36px);min-width:0;min-height:0;border:0;padding:0;background:transparent;border-radius:3px 3px 0 0}
.time-column:hover:not(:disabled),.time-column:active:not(:disabled) {background:transparent}
.time-column:hover .time-stack {filter:brightness(1.12);outline:2px solid var(--accent);outline-offset:2px}
.time-stack {width:100%;height:100%;display:flex;flex-direction:column-reverse;border-radius:3px 3px 0 0;overflow:clip}
.time-zero {display:block;width:min(100%,36px);height:2px;background:var(--control)}
.time-zero:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
.chart-data-action {min-height:32px;padding:4px 8px;color:var(--accent)}
.time-segment {display:block;flex:0 0 auto;min-height:0;background:var(--chart-teal-label)}
.time-segment.failure {background:var(--chart-pink-label)}
.time-segment.transport {background:var(--chart-cyan-label)}
.time-segment.unknown {background:var(--chart-slate-label)}
.time-segment.other {background:var(--chart-violet-label)}
.time-segment.partial {background:var(--chart-orange-label)}
.time-axis {display:flex;justify-content:space-between;font-size:12px;color:var(--muted);padding-top:10px;gap:12px}
.chart-row {display:grid;grid-template-columns:minmax(130px,25%) minmax(0,1fr) 44px;align-items:center;gap:16px;padding:12px 10px;width:100%;border:1px solid transparent;border-bottom-color:var(--rule);border-radius:var(--radius-small);background:transparent;text-align:left;white-space:normal}
.group-name {overflow-wrap:anywhere;font-size:13px}
.row-bar {display:flex;height:18px;border-radius:6px;overflow:clip;background:var(--canvas)}
.bar-part {background:var(--chart-teal-label);height:100%;flex:0 0 auto}
.bar-part.failure {background:var(--chart-pink-label)}
.bar-part.transport {background:var(--chart-cyan-label)}
.bar-part.unknown {background:var(--chart-slate-label)}
.bar-part.other {background:var(--chart-violet-label)}
.bar-part.partial {background:var(--chart-orange-label)}
.row-total {font-variant-numeric:tabular-nums;text-align:right;font-weight:600}
.chart-footer {display:flex;justify-content:space-between;gap:16px;align-items:center;margin-top:12px;font-size:12px;color:var(--muted)}
.chart-footer:empty {display:none}
.chart-footer>span:nth-child(2) {white-space:nowrap}
.chart-footer button {min-height:32px}
.result-summary {display:flex;gap:var(--space-sm);flex-wrap:wrap;align-items:center;padding:var(--space-lg) 0}
.result-summary button {display:flex;gap:8px;align-items:center;border:1px solid var(--control);background:var(--paper);padding:6px 12px;min-height:36px}
.result-count {font-weight:600;font-variant-numeric:tabular-nums}
.swatch {width:9px;height:9px;border-radius:3px;background:var(--chart-teal-label);flex-shrink:0}
.swatch.failure {background:var(--chart-pink-label)}
.swatch.transport {background:var(--chart-cyan-label)}
.swatch.unknown {background:var(--chart-slate-label)}
.swatch.other {background:var(--chart-violet-label)}
.swatch.partial {background:var(--chart-orange-label)}
.chart-actions {display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;align-items:start}
details {min-width:0}
summary {cursor:pointer;min-height:40px;padding:8px 0;overflow-wrap:anywhere}
details p {margin:8px 0;color:var(--muted)}
.supporting {margin-top:var(--space-sm);border-top:1px solid var(--rule);color:var(--muted)}
.collection-tools {display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:16px 0}
.collection-tools label {max-width:240px}
.section-heading {display:flex;gap:16px;justify-content:space-between;align-items:end;margin:var(--space-xl) 0}
.search-label {display:flex;flex-direction:column;gap:4px;color:var(--muted)}
.search-label input {width:240px}
.request-row {display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:start;gap:12px;padding:16px;border:1px solid var(--rule);border-radius:var(--radius-small);background:var(--paper);margin-top:8px}
.request-row input {margin-top:4px}
.request-link {color:var(--ink);text-decoration:none;display:block;overflow-wrap:anywhere}
.request-meta {display:flex;gap:8px;flex-wrap:wrap;color:var(--muted);margin-top:6px}
.status {font-weight:var(--weight-medium);border-radius:var(--radius-pill);padding:3px 9px;background:var(--canvas);display:inline-block}
.status.failure {color:var(--danger)}
.status.unknown {color:var(--muted)}
.status.success {color:var(--success)}
.pager {display:flex;flex-wrap:wrap;justify-content:end;align-items:center;gap:12px;margin-top:20px;font-size:12px;color:var(--muted)}
.pager:empty {display:none}
.request-intro {border:1px solid var(--rule);border-radius:var(--radius);background:var(--paper);padding:24px}
.request-intro p {max-width:76ch}
.request-intro .muted {margin-bottom:8px}
.request-actions {display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:20px 0}
.journey {margin:24px 0;padding:0;list-style:none}
.journey-item {border-left:2px solid var(--rule);padding:0 0 24px 20px;margin-left:6px}
.journey-item:last-child {padding-bottom:0}
.journey-item h3 {margin-bottom:4px}
.journey-item p {color:var(--muted)}
.journey-result {margin-top:8px}
.detail-disclosure {border-top:1px solid var(--rule);margin-top:12px}
.journey-item>.detail-disclosure {border-top:0;margin-top:4px}
.journey-item>.detail-disclosure>summary {min-height:44px}
.journey-item:not(:last-child)>.detail-disclosure {border-bottom:1px solid var(--rule)}
.facts {display:grid;grid-template-columns:minmax(100px,25%) minmax(0,1fr);gap:8px 16px;margin:12px 0;font-size:12px}
.facts dt {color:var(--muted)}
.facts dd {margin:0;overflow-wrap:anywhere}
pre {white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:12px/1.65 var(--mono);background:var(--canvas);padding:16px;border-radius:var(--radius-small);max-height:360px;overflow:auto}
.original-prompt pre {font:14px/1.7 var(--font)}
.report-start {display:flex;align-items:start;justify-content:space-between;gap:24px;padding:24px;border:1px solid var(--rule);border-radius:var(--radius);background:var(--paper)}
.report-start>button {flex-shrink:0}
.report-start p {color:var(--muted);margin-top:6px}
.report-entry {display:flex;align-items:start;gap:16px;justify-content:space-between;padding:20px 0;border-bottom:1px solid var(--rule)}
.report-entry>div:first-child {min-width:0;flex:1}
.report-entry .actions {display:flex;flex-wrap:wrap;gap:8px;justify-content:end}
.report-entry p {color:var(--muted);margin-top:4px}
.report-document {padding:20px;border:1px solid var(--rule);border-radius:var(--radius-small);background:var(--paper)}
.report-document p {margin:8px 0}
.report-document h3 {margin-top:16px}
.report-document ul {padding-left:20px}
.notice {padding:12px 16px;border:1px solid var(--control);border-radius:var(--radius-small);background:var(--canvas);margin-bottom:20px}
.notice.error {border-color:var(--danger)}
.notice.stale {border-color:var(--warning)}
.notice button {margin-top:8px}
.empty-state {padding:36px 20px;text-align:center;background:var(--canvas);border-radius:var(--radius)}
.empty-state p {margin:8px auto 16px;color:var(--muted);max-width:54ch}
.loading-state p {color:var(--muted);margin-top:16px}
.skeleton {border-radius:var(--radius-small);background:var(--canvas)}
.skeleton.heading {height:30px;width:55%;margin-bottom:16px}
.skeleton.summary {height:18px;width:70%;margin-bottom:36px}
.chart-placeholder {height:300px}
table {width:100%;table-layout:fixed;border-collapse:collapse;color:var(--ink);font-size:12px}
td,th {padding:10px 8px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top;overflow-wrap:anywhere}
th {font-weight:var(--weight-medium);color:var(--muted)}
.numeric {text-align:right;font-variant-numeric:tabular-nums}
td a {text-decoration:none}
dialog {padding:0;width:min(820px,calc(100% - 24px));max-height:calc(100dvh - 24px);overflow:auto;border:1px solid var(--control);border-radius:var(--radius-dialog);background:var(--canvas);color:var(--ink);box-shadow:var(--shadow);scroll-padding-top:88px}
dialog::backdrop {background:var(--scrim)}
.dialog-head {position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px 24px;border-bottom:1px solid var(--rule);background:var(--paper);z-index:1}
.dialog-body {padding:24px}
.dialog-body>*+* {margin-top:20px}
.privacy-steps {display:flex;flex-wrap:wrap;gap:8px 20px;margin:0;padding:0;list-style-position:inside;font-size:12px;color:var(--muted)}
.privacy-steps li {white-space:nowrap}
.privacy-steps .current {font-weight:600;color:var(--ink)}
.attestation {display:flex;align-items:start;gap:12px;padding:16px;border:1px solid var(--control);border-radius:var(--radius-small);font-size:13px;background:var(--paper)}
.attestation input {margin:2px 0 0}
.dialog-actions {display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.skip-link {position:fixed;left:12px;top:-100px;z-index:5;background:var(--paper);padding:8px}
.skip-link:focus {top:8px}
@media(max-width:900px) {
 .header-inner {gap:12px}
 .insight-header {align-items:start;flex-direction:column}
 .view-switch {align-self:start}
 .filters label {flex-basis:120px}
}
@media(max-width:760px) {
 html {scroll-padding-top:144px}
 .header-inner {display:grid;grid-template-columns:minmax(0,1fr) auto;padding:12px 16px;gap:8px 12px;min-height:0}
 .brand {font-size:15px}
 .theme-control {grid-column:2;grid-row:1;margin-left:0}
 .header-inner>button {grid-column:2;grid-row:2;justify-self:end}
 .app-header nav {grid-column:1;grid-row:2;gap:4px;min-height:44px}
 .app-header nav a {min-height:44px;flex:1;padding:8px;font-size:13px}
}
@media(max-width:600px) {
 main {padding:24px 16px 32px}
 .page-heading {align-items:start;flex-direction:column;gap:12px}
 .page-heading>.button-link {display:none}
 .filters {gap:8px;padding:12px}
 .filters label {flex:1 1 130px}
 button,input,select,.button-link {min-height:44px}
 .insight-header {padding-top:24px}
 #activityCount {font-size:32px}
 .chart-panel {padding:16px}
 .chart-heading {flex-wrap:wrap}
 .time-chart {height:190px;gap:2px}
 .view-switch {width:100%}
 .view-switch button {flex:1;padding:6px;min-height:40px}
 .filter-chip,.result-summary button {min-height:44px}
 .chart-row {grid-template-columns:minmax(0,1fr) 40px;gap:8px}
 .row-bar {grid-column:1/-1;grid-row:2}
 .row-total {grid-column:2;grid-row:1}
 .result-summary {gap:8px}
 .section-heading {align-items:start;flex-direction:column}
 .search-label,.search-label input {width:100%}
 .request-row {grid-template-columns:24px minmax(0,1fr)}
 .request-row>.status {grid-column:2}
 .report-start,.report-entry {align-items:start;flex-direction:column}
 .report-entry .actions {justify-content:start}
 .dialog-head {padding:12px 16px}
 .dialog-body {padding:16px}
 .facts {grid-template-columns:100px minmax(0,1fr)}
 .chart-actions {flex-direction:column}
 .privacy-steps {gap:8px 16px}
 .report-document table,.report-document tbody,.report-document tr {display:block;width:100%}
 .report-document thead {display:none}
 .report-document tr {border-bottom:1px solid var(--rule);padding:8px 0}
 .report-document td {display:grid;grid-template-columns:minmax(0,40%) minmax(0,1fr);gap:12px;border:0;padding:4px 0}
 .report-document td::before {content:attr(data-label);color:var(--muted)}
}
@media(prefers-reduced-motion:no-preference) {
 button,select,input,.button-link,.app-header nav a {transition:border-color .12s ease,box-shadow .12s ease}
}
@media(prefers-reduced-motion:reduce) {*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
.report-options {display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:24px;margin:24px 0}
.report-options fieldset {min-width:0;margin:0;padding:20px;border:1px solid var(--rule);border-radius:var(--radius);background:var(--paper)}
.report-options legend {font-size:16px;font-weight:600;padding:0 8px}
.prompt-choice {display:flex;align-items:start;gap:12px;padding:14px 12px;margin:8px 0;border:1px solid var(--control);border-radius:var(--radius-small);cursor:pointer}
.prompt-choice:has(input:checked) {background:var(--accent-soft);border-color:var(--accent)}
.prompt-choice input {flex:0 0 auto;width:18px;height:18px;margin:4px 0;accent-color:var(--accent)}
.prompt-choice>span {min-width:0}
.prompt-choice strong {display:block;font-weight:600}
.prompt-choice span span {display:block;color:var(--muted);font-size:14px;margin-top:4px}
.prompt-choice small {font-size:12px;color:var(--accent);margin-left:8px}
.format-choices {display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.format-choices label {display:inline-flex;align-items:center;gap:8px;padding:10px 12px;min-height:44px;border:1px solid var(--control);border-radius:var(--radius-pill);cursor:pointer}
.format-choices label:has(input:checked) {background:var(--accent-soft);border-color:var(--accent)}
.report-field {display:block;margin:8px 0}
textarea {width:100%;min-width:0;max-width:100%;padding:12px;border:1px solid var(--control);border-radius:var(--radius-small);font:var(--type-reading)/var(--leading-reading) var(--font);color:var(--ink);background:var(--paper);resize:vertical}
textarea:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
.prompt-comparison {border-top:1px solid var(--rule);margin-top:16px}
.prompt-comparison>summary {font-weight:600;padding:16px 0}
.prompt-pair {display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px}
.prompt-pair>div {min-width:0}
.prompt-pair h4 {font-size:14px;margin:0 0 8px}
.prompt-pair mark {background:var(--accent-soft);color:var(--ink);border-bottom:2px solid var(--accent);border-radius:3px}
.prompt-pair mark.mandatory {border-bottom-color:var(--danger)}
.report-frame {display:block;width:100%;height:540px;border:1px solid var(--control);border-radius:var(--radius-small);margin:16px 0;background:var(--paper)}
.report-confirmation {font-weight:600}
@media(max-width:760px) {.report-options,.prompt-pair{grid-template-columns:minmax(0,1fr)}.report-options{gap:16px}.report-options fieldset{padding:16px}.report-frame{height:440px}}
${uxStyles}
${visualStyles}
${dimensionalChartStyles}
${semanticCueStyles}
${sidebarStyles}
${toolbarStyles}
.reading-section {color:var(--ink);font-size:var(--type-reading);line-height:1.6}
.reading-section>summary {font-size:var(--type-section);line-height:1.4;font-weight:var(--weight-strong);min-height:48px;padding:12px 0}
.supporting>summary,#meaning>summary {font-size:var(--type-reading);line-height:1.5;font-weight:var(--weight-strong);color:var(--ink);min-height:44px;padding:var(--space-sm) 0;align-content:center}
.reading-section p {font-size:var(--type-reading);line-height:1.6;color:var(--ink);max-width:65ch;margin:12px 0}
.chart-actions {display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.chart-actions>#exploreLink {justify-self:start;font-size:var(--type-small);padding:8px 0}
#meaning {max-width:72rem}
#meaning section+section {margin-top:16px}
#meaning h3 {font-size:var(--type-section);margin:0 0 8px}
#meaning .scope-facts {display:grid;grid-template-columns:minmax(0,max-content) minmax(0,48ch);gap:8px 24px;width:fit-content;max-width:100%;margin:8px 0}
#meaning .scope-facts dt {font-size:var(--type-small);color:var(--muted)}
#meaning .scope-facts dd {margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
#meaning .result-definitions {grid-template-columns:repeat(2,minmax(0,36ch));gap:8px 24px;width:fit-content;max-width:100%;margin:12px 0}
#meaning .result-definitions>div {display:grid;grid-template-columns:20px minmax(0,1fr);column-gap:8px;align-content:start}
#meaning .result-definitions dt {grid-column:1/-1}
#meaning .result-definitions dd {grid-column:2;margin:2px 0 0}
#meaning .reading-notes dl {margin:8px 0;font-size:var(--type-reading);line-height:var(--leading-reading);color:var(--ink)}
#meaning .reading-notes dt {font-weight:var(--weight-strong);margin-top:12px}
#meaning .reading-notes dd {margin:2px 0 0;max-width:65ch}
.result-definitions {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:16px 32px;margin:16px 0}
.result-definitions dt,.service-glossary dt {font-weight:var(--weight-strong)}
.result-definitions dd {margin:6px 0 0;max-width:40ch}
@media(max-width:700px) {#meaning .scope-facts,#meaning .result-definitions {grid-template-columns:minmax(0,1fr)}}
.service-definitions .service-glossary {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 40px;margin:8px 0 0}
.glossary-entry {display:flex;flex-wrap:wrap;align-content:start;gap:4px 16px;padding:16px 0;border-bottom:1px solid var(--rule)}
.glossary-entry>dt {flex:1 1 9rem}
.glossary-entry>dd {flex:2 1 16rem;min-width:0}
.service-definitions .service-glossary dd {margin:0;color:var(--ink);font-size:var(--type-reading);line-height:1.6;max-width:48ch}
.service-glossary dt {font-size:var(--type-reading);line-height:1.6;overflow-wrap:anywhere}
.service-evidence-summary {margin-block:16px 24px;max-width:72ch;overflow-wrap:anywhere}
.service-evidence-summary h2 {font-size:var(--type-section)}
.service-evidence-summary p,.service-evidence-summary dl {margin:8px 0;font-size:var(--type-small)}
.service-evidence-summary dl>div {margin-top:12px}
.service-evidence-summary dt {font-weight:var(--weight-strong)}
.service-evidence-summary dd {margin:4px 0 0}
#coverage p {font-size:var(--type-reading);line-height:1.6;max-width:80ch;margin-block:12px;overflow-wrap:anywhere}
#coverage .coverage-destination {margin-block:16px}
#collectionEvidenceDetails p,#collectionEvidenceDetails .evidence-notes {max-width:80ch;overflow-wrap:anywhere}
#collectionEvidenceDetails .evidence-notes {grid-template-columns:minmax(0,1fr)}
#countTable {container-type:inline-size;max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;padding-bottom:4px}
#countTable:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
#countTable>.list-pager {min-height:0;margin:0 0 6px}
#countTable>p {font-size:var(--type-small);margin:8px 0 0}
.exact-data-table {width:auto;table-layout:auto;font-size:var(--type-small);line-height:1.5}
.exact-data-table .chart-label-column {width:13rem}
.exact-data-table .chart-number-column {width:7.5rem}
.exact-data-table caption {position:sticky;left:0;width:min(80ch,100cqw);max-width:100cqw;text-align:left;color:var(--muted);font-size:var(--type-small);line-height:1.6;padding:0 0 8px}
.exact-data-table :is(td,th) {vertical-align:middle;padding:6px 12px}
.exact-data-table :is(td,th):first-child {min-width:10rem;text-align:left}
.exact-data-table tbody td:first-child {padding:2px 0}
.exact-data-table .numeric {white-space:nowrap;text-align:center;font-variant-numeric:tabular-nums;min-width:6rem}
.exact-data-table thead th {color:var(--ink);font-weight:var(--weight-strong);background:var(--canvas)}
.exact-data-table tfoot {font-weight:var(--weight-strong)}
.exact-data-table tfoot th {color:var(--ink);font-weight:inherit}
.exact-data-table .chart-data-action {width:100%;max-width:20rem;font-size:var(--type-small);min-height:44px;text-align:left;padding:8px 12px;white-space:normal;overflow-wrap:anywhere}
.exact-data-table .chart-data-label {display:block;max-width:20rem;padding:8px 12px;overflow-wrap:anywhere}
.evidence-notes {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 48px;padding-left:20px;margin:16px 0 24px;font-size:var(--type-reading);line-height:1.6}
.evidence-notes li {padding-left:4px;max-width:65ch;overflow-wrap:anywhere}
#coverage .collection-tools {padding-top:16px;border-top:1px solid var(--rule);gap:16px}
#coverage .collection-tools :is(label,button,select) {font-size:var(--type-small)}
#coverage .collection-tools .filter-field {flex:1 1 15rem;max-width:18rem}
.scope-choice-help {display:block;font-size:var(--type-small);line-height:1.6;font-weight:var(--weight-regular);color:var(--muted);margin-top:8px}
.context-help-note {font-size:var(--type-small);line-height:1.6;color:var(--muted);max-width:65ch;margin:12px 0}
.section-heading>.filter-field {display:flex;flex-direction:column;gap:4px;min-width:0;max-width:100%}
.section-heading>.filter-field input {width:15rem;max-width:100%;font-size:var(--type-small);line-height:1.5}
@media(max-width:1100px) {
 .glossary-entry>dt,.glossary-entry>dd {flex-basis:100%}
}
@media(max-width:700px) {
 .service-definitions .service-glossary,.evidence-notes {grid-template-columns:minmax(0,1fr)}
}
${metadataStyles}
${selectStyles}
.viewing-context {padding:12px 0 16px;margin-bottom:12px;border-bottom:1px solid var(--rule);font-size:var(--type-reading);color:var(--muted)}
.viewing-context .inline-metadata {font-size:inherit;line-height:1.6}
.viewing-context .metadata-item:first-child {color:var(--ink);font-weight:600}
.viewing-context .context-source {margin:6px 0 0;overflow-wrap:anywhere}
.context-return {margin-top:8px}
.recorded-results {display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin-top:8px;font-size:var(--type-small);line-height:var(--leading-ui);color:var(--ink)}
.recorded-results .result-unit {font-weight:var(--weight-medium);font-variant-numeric:tabular-nums}
.recorded-result {display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:3px 8px;border-radius:var(--radius-pill);background:color-mix(in srgb,var(--cue-color,var(--muted)) 8%,var(--paper));font-size:var(--type-caption);line-height:var(--leading-caption);font-variant-numeric:tabular-nums}
.recorded-result:not(.result-link) {box-shadow:inset 0 0 0 1px var(--cue-color,var(--control))}
.recorded-result-label {min-width:0;overflow-wrap:anywhere;text-transform:uppercase;font-weight:var(--weight-strong);letter-spacing:.02em}
.result-unavailable {color:var(--muted)}
.recorded-result .wire-icon {width:16px;height:16px;flex:0 0 16px}
.recorded-result .wire-icon[data-lucide-icon=info] {width:16px;height:16px;flex-basis:16px}
.result-with-heading {align-items:start;gap:6px 16px}
.result-description {min-width:0;flex:0 1 22rem}
.result-heading {display:block;font-weight:var(--weight-strong)}
.result-with-heading .result-unit {display:block;font-size:var(--type-small);font-weight:var(--weight-regular);color:var(--muted)}
.result-values {display:flex;flex-wrap:wrap;align-items:start;gap:6px;min-width:0;max-width:100%;flex:1 1 10rem}
.result-evidence-note,.result-missing-api {font-size:var(--type-small);color:var(--muted);line-height:var(--leading-ui)}
.action-fields {display:grid;grid-template-columns:fit-content(8rem) minmax(0,1fr);align-items:baseline;gap:8px 16px;margin:12px 0 0;font-size:var(--type-reading);line-height:var(--leading-ui);font-weight:var(--weight-regular);min-width:0;max-width:100%}
.action-fields dt,.action-field-label {font-size:var(--type-small);color:var(--muted);font-weight:var(--weight-regular);overflow-wrap:anywhere}
.action-fields dd {margin:0;min-width:0;overflow-wrap:anywhere}
.action-tool-heading {display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.action-fields .path-attribution {font-size:var(--type-small);color:var(--muted)}
.api-result-entry+.api-result-entry {border-top:1px solid var(--rule);padding-top:12px;margin-top:12px}
.request-outcome .returned-api-details {margin-top:12px}
@media(max-width:600px) {
 .result-description {flex-basis:100%}
 .action-fields {grid-template-columns:minmax(0,1fr);gap:2px}
 .action-fields dd+dt {margin-top:6px}
}
.request-row {grid-template-columns:24px minmax(0,1fr)}
.request-row .request-link,.report-entry .request-link,.context-return .request-link {white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.full-request-results {border-top:1px solid var(--rule);margin-top:16px;padding-top:16px}
.full-request-results h3 {font-size:var(--type-reading)}
.full-request-results .context-help-note {font-size:var(--type-small)}
.journey-item .action-context {font-size:var(--type-small);margin:8px 0;color:var(--muted)}
.report-matching-context {border-top:1px solid var(--rule);padding-top:8px;margin-top:12px}
.report-entry>div:first-child {max-width:100%;align-self:stretch}
.list-summary {font-size:var(--type-small);color:var(--muted);max-width:80ch}
.session-label {font-size:var(--type-small);font-weight:400;color:var(--muted)}
.copilot-chat-name {color:var(--copilot-chat-title);overflow-wrap:anywhere}
.result-unit {min-width:0;overflow-wrap:anywhere}
.session-id {font-size:var(--type-small);color:var(--muted);overflow-wrap:anywhere}
.page-heading #pageIdentity {margin:0 0 4px}
#pageProject {display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px}
#pageProject p {margin:8px 0 0}
.source-reference {font-size:var(--type-caption);color:var(--muted);overflow-wrap:anywhere}
#pageProject .source-header-details {margin:0;border:0;min-width:0}
#pageProject .source-header-details>summary {min-height:44px;color:var(--muted);font-size:var(--type-caption)}
#pageProject .source-header-details[open] {flex-basis:100%}
#pageProject .source-header-details .facts {max-width:72ch;margin-top:0}
@media(max-width:600px) {
 #pageProject .source-header-details .facts {grid-template-columns:minmax(0,1fr);gap:4px}
 #pageProject .source-header-details .facts dd {margin-bottom:12px}
}
.session-analysis {padding:0 0 20px;margin-bottom:12px;border-bottom:1px solid var(--rule)}
.session-analysis .recorded-results {margin-top:16px}
.session-scope,.session-coverage {font-size:var(--type-small);line-height:1.6;margin:12px 0;color:var(--muted)}
.result-link {position:relative;isolation:isolate;min-height:max(44px,calc(1lh + 24px));padding:12px 8px;gap:4px;border-radius:var(--radius-pill);background:transparent;text-decoration:none;touch-action:manipulation}
.result-link::before {content:"";position:absolute;inset:10px 0;z-index:-1;border:1px solid var(--cue-color,var(--control));border-radius:inherit;background:color-mix(in srgb,var(--cue-color,var(--muted)) 8%,var(--paper))}
.result-link:is(:hover,:focus-visible,:active) {background:transparent;text-decoration:none}
.result-link:is(:hover,:focus-visible)::before {background:color-mix(in srgb,var(--cue-color,var(--muted)) 10%,var(--paper))}
.result-link:active::before {background:color-mix(in srgb,var(--cue-color,var(--muted)) 10%,var(--paper));box-shadow:inset 0 0 0 1px var(--cue-color,var(--control))}
.matched-action {display:grid;gap:8px;padding:16px 0;border-top:1px solid var(--rule);font-size:var(--type-reading);overflow-wrap:anywhere}
.matched-action h3 {margin:0}
.matched-action>:is(p,.action-fields) {margin:0}
.call-heading {display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;min-width:0}
.call-heading>:is(.recorded-results,.call-duration,.action-heading),.call-heading h3 {margin:0}
.call-heading>.call-duration {min-width:0;overflow-wrap:anywhere}
.call-heading .result-inline {display:inline-flex;flex:0 1 auto}
.call-heading .recorded-result-label {text-transform:none;letter-spacing:0}
.call-api-summary {align-items:center}
.matched-action .full-text-actions {margin-top:0}
.matched-action .action-purpose {margin:8px 0}
.matched-action .action-error {color:var(--danger)}
.matched-action>.text-link,.session-analysis>.text-link {display:inline-flex;align-items:center;min-height:44px}
.call-sort-controls {display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;margin-block:8px;min-width:0}
.call-sort-controls>.context-help-note {margin:0}
.call-sort-controls .select-control {max-width:100%}
.call-duration {font-variant-numeric:tabular-nums}
${reportJourneyStyles}
${settingsStyles}
${periodFlowStyles}
${textAccessStyles}
${percentageChartStyles}
${contextualActionStyles}
${homeResultFilterStyles}
${promptAuthorStyles}
.button-link,.full-text-toggle,.view-switch button,
.result-summary .result-with-help>button:not(.ux-help),.filter-chip,.format-choices label,
.report-step,.request-actions button:not(.ux-help,.ux-copy),.contextual-actions button:not(.ux-help,.ux-copy),
.report-stage-actions button:not(.ux-help,.ux-copy),.report-entry .actions button:not(.ux-help,.ux-copy),
.report-review-body .dialog-actions button:not(.ux-help,.ux-copy),.report-save-body button:not(.ux-help,.ux-copy),
.settings-actions button:not(.ux-help,.ux-copy),.search-input-row button,#checkActivity,#clearActivitySearch {
 border-radius:var(--action-radius,var(--radius-control));overflow-wrap:anywhere;
}
.request-actions button:not(.ux-help,.ux-copy),.report-review-body .dialog-actions button:not(.ux-help,.ux-copy),
.report-save-body button:not(.ux-help,.ux-copy),#clearActivitySearch {min-height:var(--pill-height)}
#activityPager,.list-pager {justify-content:start;margin:12px 0;min-height:44px}
.list-pager>span {margin-right:auto}
.list-pager button {min-height:44px}
.report-selection-list {max-height:none;overflow:visible}
.report-request-page {max-height:360px;overflow-y:auto;overscroll-behavior-y:contain}
.report-request-page:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
.report-selection-list .report-entry {padding:16px 0}
.journey-pages>.pager {margin-bottom:20px}
.journey-pages .journey {margin-top:0}
${textAction},${textAction}:is(:hover,:active,:disabled,[aria-pressed]) {
 position:relative;isolation:isolate;min-height:max(44px,calc(1lh + 24px));
 padding:12px calc(var(--pill-inset) + var(--action-progress-inset,0px));border:0;background:transparent;box-shadow:none;
}
${textAction}::before {
 content:"";position:absolute;inset:4px 0;z-index:-1;pointer-events:none;
 border:1px solid var(--pill-border);border-radius:inherit;background:var(--pill-fill);
}
${textAction}:hover:not(:disabled)::before {background:var(--pill-hover)}
${textAction}:active:not(:disabled)::before {background:var(--pill-pressed)}
${textAction}[aria-pressed=true]::before {background:var(--pill-hover);box-shadow:inset 0 0 0 1px var(--pill-border)}
${textAction}:disabled::before {background:var(--canvas);border-color:var(--rule)}
${textAction}.quiet:not([aria-pressed])::before {background:transparent;border-color:transparent}
${textAction}.quiet:not([aria-pressed]):hover:not(:disabled)::before {background:var(--hover)}
${textAction}.quiet:not([aria-pressed]):active:not(:disabled)::before {background:var(--pill-pressed)}
${textAction}.primary:not(:disabled)::before {background:var(--accent-soft);border-color:var(--accent)}
${textAction}.primary:hover:not(:disabled)::before {background:var(--accent-hover)}
${textAction}.primary:active:not(:disabled)::before {background:var(--accent-pressed)}
${textAction}.danger:not(:disabled)::before {background:var(--paper);border-color:var(--danger)}
${textAction}.danger:hover:not(:disabled)::before {background:color-mix(in srgb,var(--danger) 6%,var(--paper))}
${textAction}.danger:active:not(:disabled)::before {background:color-mix(in srgb,var(--danger) 10%,var(--paper));box-shadow:inset 0 0 0 1px var(--danger)}
@media(max-width:500px) {
 .recorded-results {gap:6px 14px}
 .recorded-results .result-unit {flex-basis:100%}
}
#resultsLink {display:inline-flex;align-items:center;min-height:44px;padding:8px}
#analyzeModes {flex-wrap:wrap;align-self:center;width:auto}
#analyzeModes a {min-height:44px}
#analyzeModes a[aria-current=true]::before {background:var(--accent-soft);border-color:var(--accent)}
#activityView>.section-heading {justify-content:start}
#activityView>.section-heading>.filter-field {margin-inline-start:auto}
.analyze-result-actions {display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;margin-block:12px}
.analyze-result-actions .report-selection-bar {margin:0}
#activityList>.activity-card {container-type:inline-size;padding:16px 8px;border:0;border-bottom:1px solid transparent;border-radius:var(--radius-small);background:var(--paper);margin-top:8px}
#activityList>.request-row {display:block;padding:0}
.request-card-open {display:block;min-height:44px;padding:16px 12px;color:var(--ink);border-inline-start:3px solid transparent;border-radius:inherit}
.request-card-open:hover {background:var(--hover)}
.request-row[data-detail-active]>.request-card-open {border-inline-start-color:var(--control);background:var(--canvas)}
.request-card-prompt {font:var(--type-body)/var(--leading-reading) var(--font);max-width:68ch}
.request-card-summary {display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;font-size:var(--type-small);color:var(--muted)}
.request-card-outcome[data-outcome=failure],.request-card-outcome[data-outcome=transport] {color:var(--danger)}
#activityList>.request-row .interaction-body {display:grid;gap:12px;min-width:0}
#activityList>.matched-action {gap:12px}
#activityList>.activity-card .full-text-preview,#activityList>.activity-card .full-text-body pre {font-family:var(--font);line-height:var(--leading-reading);padding-inline:2px;overflow:visible;max-height:none}
#activityList>.activity-card .full-text-preview {font-weight:var(--weight-regular);font-style:normal}
#activityList>.activity-card .full-text-body .ux-code-block {max-inline-size:76ch;font-size:var(--type-reading)}
#activityList>.activity-card .full-text-body pre {font-weight:var(--weight-regular);font-style:normal;padding-inline:var(--space-lg)}
#activityList>.activity-card .full-text-preview-label {--metadata-target:max(44px,1.5rem);line-height:var(--leading-ui)}
#activityList>.activity-card .request-meta .metadata-item {--metadata-target:max(44px,1.5rem);line-height:var(--leading-ui)}
#activityList>.activity-card .full-text-preview {margin-block:4px 0}
#activityList>.activity-card .full-text-passage {max-width:68ch;min-width:0;margin-top:4px;font-size:var(--type-body);line-height:var(--leading-reading);overflow-wrap:anywhere}
#activityList>.activity-card .full-text-passage>.full-text-preview {display:inline;margin:0;color:var(--ink);font-size:inherit;max-width:68ch}
#activityList>.activity-card .full-text-passage>.full-text-preview[hidden] {display:none}
#activityList>.activity-card .full-text-passage>.full-text-toggle {display:inline-flex;vertical-align:middle;min-height:44px;min-width:44px;margin:0;padding:10px;border:0;border-radius:2px;background:transparent;color:var(--ink);font:inherit;font-style:normal;font-weight:var(--weight-regular)}
#activityList>.activity-card .full-text-passage>.full-text-toggle::before {content:none}
#activityList>.activity-card .full-text-passage>.full-text-toggle:hover {background:var(--hover)}
#activityList>.activity-card .full-text-passage>.full-text-toggle:active {background:var(--pill-pressed)}
#activityList>.activity-card .full-text-availability {margin:4px 0 0}
#activityList>.activity-card .card-details {display:grid;gap:12px 32px;min-width:0}
#activityList>.activity-card .card-activity {display:grid;align-content:start;gap:8px;min-width:0}
#activityList>.activity-card .activity-card-facts {display:grid;align-content:start;gap:4px;margin:0;min-width:0;font-size:var(--type-small);line-height:var(--leading-ui)}
#requestContent .interaction-model-fact {display:grid;gap:6px;margin:4px 0 0;min-width:0;font-size:var(--type-small);line-height:var(--leading-ui)}
#activityList>.activity-card .activity-card-facts>div,#requestContent .interaction-model-fact>div {display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;min-width:0}
#activityList>.activity-card .activity-card-facts dt {font:inherit;color:var(--muted);overflow-wrap:anywhere;max-width:100%}
#requestContent .interaction-model-fact dt {font:inherit;overflow-wrap:anywhere;max-width:100%}
#activityList>.activity-card .activity-card-facts dd,#requestContent .interaction-model-fact dd {font:inherit;margin:0;min-width:0;max-width:100%;overflow-wrap:anywhere}
#activityList>.activity-card .activity-card-facts dd {color:var(--ink)}
#activityList>.activity-card .activity-card-facts :is(.request-meta,.semantic-cue>span,.card-chat>.text-link,.source-reference,.service-context-label) {color:var(--ink)}
#activityList>.activity-card .activity-card-facts dd .semantic-cue {font-weight:var(--weight-regular)}
#activityList>.activity-card :is(.project-context,.request-meta,.recorded-results,.call-duration) {font-size:inherit;line-height:inherit;margin:0}
#activityList>.activity-card .card-chat {display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;min-width:0}
#activityList>.activity-card .card-chat>.text-link {display:inline-flex;align-items:baseline;min-height:24px;min-width:24px;max-width:100%;overflow-wrap:anywhere;font-weight:var(--weight-regular)}
#activityList>.activity-card .interaction-tools {display:grid;gap:4px;margin:0;padding:0;list-style:none;color:var(--ink);font:inherit}
#activityList>.activity-card .interaction-tools>li {display:flex;flex-wrap:wrap;align-items:baseline;gap:0 6px;min-width:0}
#activityList>.activity-card .card-tool-name {font:inherit;overflow-wrap:anywhere;min-width:0}
#activityList>.activity-card .card-tool-count {color:var(--ink)}
#activityList>.activity-card .recorded-results {align-items:center;gap:4px 12px}
#activityList>.activity-card .result-unit {font-weight:var(--weight-regular)}
#activityList>.activity-card .recorded-result-label {text-transform:none;letter-spacing:0;font-weight:var(--weight-regular)}
#activityList>.activity-card .card-outcomes {font-size:var(--type-small)}
#activityList>.activity-card .card-result-scope {flex-basis:100%;color:var(--muted)}
#activityList>.activity-card .card-result-note {margin:0;font-size:var(--type-small);line-height:var(--leading-ui);overflow-wrap:anywhere}
#activityList>.activity-card .context-help-note {margin:4px 0 0;line-height:var(--leading-ui)}
@container(min-width:50rem) {
 #activityList>.activity-card .card-details {grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
}
#activityList>.activity-card .interaction-details {grid-template-columns:minmax(0,1fr);gap:8px}
#activityList>.activity-card .interaction-details .activity-card-facts {display:flex;flex-wrap:wrap;align-items:center;gap:4px 24px}
#activityList>.activity-card .interaction-details .card-operation>dt {position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
#activityList>.activity-card .interaction-details .card-operation>dd {display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px}
#activityList>.activity-card .interaction-details .card-tools {flex-basis:100%}
#activityList>.activity-card .interaction-details .interaction-tools {display:flex;flex-wrap:wrap;gap:4px 16px}
#activityList>.activity-card .interaction-details .card-context {column-gap:20px}
@media(min-width:700px) {
 #activityList>.activity-card .full-text {display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:16px}
 #activityList>.activity-card .full-text>:not(.full-text-actions,.full-text-body) {grid-column:1}
 #activityList>.activity-card .full-text>.full-text-actions {grid-column:2;grid-row:1/span 2;align-self:start;justify-content:flex-end;margin:0}
 #activityList>.activity-card .full-text>.full-text-body {grid-column:1/-1}
}
.interaction-select {display:grid;place-items:center;min-width:44px;min-height:44px;cursor:pointer;border-radius:var(--radius-small)}
.interaction-select:focus-within {outline:2px solid var(--focus);outline-offset:2px}
.interaction-select input {margin:0}
@media(max-width:699px) {
 #activityView>.section-heading {align-items:stretch}
 #analyzeModes {align-self:start}
 #activityView>.section-heading>.filter-field {margin-inline-start:0;width:100%}
 #activityView>.section-heading>.filter-field input {width:100%}
}
${analyzeLayoutStyles}
/* Screen-only semantic aliases follow shared chart CSS; saved output keeps its own palette. */
:root[data-evidence-theme],:root:not([data-evidence-theme]) {
 --chart-pink-top:var(--screen-failure-high);--chart-pink-mid:var(--chart-failure);
 --chart-pink-base:var(--screen-failure-low);--chart-pink-side:var(--chart-failure);
 --chart-pink-cap:var(--chart-failure);--chart-pink-label:var(--chart-failure);
 --prompt-author-user:var(--screen-prompt-user);
}
.settings-search-results mark,body .comparison-reading summary {font-weight:var(--weight-medium)}
.result-tone-failure,.recorded-result.result-tone-failure:is(:hover,:active) {color:var(--chart-failure)}
.percentage-card[data-breakdown=outcomes] [data-category=failure] .percentage-label,
.select-option[data-value=failure] .result-option-label,
.select-trigger:has(.result-tone-failure) .result-option-label {color:var(--chart-failure)}
/* The shared frozen-comparison renderer historically uses pink for transport, too. */
.comparison-outcome-transport {
 --column-top:var(--chart-cyan-top);--column-mid:var(--chart-cyan-mid);--column-base:var(--chart-cyan-base);
 --column-side:var(--chart-cyan-side);--column-cap:var(--chart-cyan-cap);--column-label:var(--chart-cyan-label);
}
@media(forced-colors:active) {
 :is(.primary-navigation,.settings-categories) a[aria-current=page] {background:Highlight;color:HighlightText;forced-color-adjust:none}
 .primary-navigation a[aria-current=page]>.wire-icon {color:HighlightText}
 .result-tone-failure,.recorded-result.result-tone-failure:is(:hover,:active),
 .percentage-card[data-breakdown=outcomes] [data-category=failure] .percentage-label,
 .select-option[data-value=failure] .result-option-label,
 .select-trigger:has(.result-tone-failure) .result-option-label {color:CanvasText}
}
`;
