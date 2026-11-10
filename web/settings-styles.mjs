export const settingsStyles = `
.assessment-inline-recovery>.assessment-recovery {margin:12px 0 0}
:is(.settings-view,#workspace:has(>#settingsView:not([hidden]))) {
 --settings-title-size:1.5rem;--settings-title-leading:1.25;--settings-title-tracking:-.025em;
 --settings-field-radius:10px;--settings-nav-radius:8px;--settings-action-radius:8px;
}
#workspace:has(>#settingsView:not([hidden]))>.page-heading #pageTitle {font-size:var(--settings-title-size);line-height:var(--settings-title-leading);letter-spacing:var(--settings-title-tracking)}
.settings-view {--pill-border:var(--control);max-width:70rem;container:settings / inline-size}
.settings-status-link {margin:8px 0 0;color:var(--muted)}
.settings-status-link a {display:inline-flex;align-items:center;min-height:44px}
#workspace>#collectionStatusView {max-width:64rem}
.collection-status-view {min-width:0;container:collection-status / inline-size}
.collection-status-view,.collection-status-view p,.collection-status-view summary {font-size:var(--type-reading);line-height:var(--leading-reading)}
.collection-status-view label {font-size:var(--type-small);line-height:var(--leading-control)}
.collection-status-view :is(input,button,select,.select-trigger) {font-size:var(--type-control);line-height:var(--leading-control)}
.collection-status-view summary,.collection-status-view button,.collection-status-view .button-link {min-height:44px}
.collection-status-view p,.collection-status-view summary {overflow-wrap:anywhere}
.collection-status-view p {text-wrap:pretty}
.collection-status-view .collection-issues-body {background:none;padding:0}
.collection-status-view .history-reason {background:var(--canvas);margin-top:8px}
.collection-status-view .settings-advanced {padding:0 16px}
.collection-status-view .collection-status-details {margin:0}
.collection-health-heading {display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 24px}
.collection-health-heading h2 {min-width:0}
.collection-status-view #collectionTimes {margin-top:16px;font-size:var(--type-small)}
.collection-status-view #collectionCoverageCounts {margin-top:12px}
.collection-status-actions {display:flex;flex-wrap:wrap;align-items:center;gap:4px 24px;margin-top:12px}
.collection-status-actions a,.history-chat-link {display:inline-flex;align-items:center;min-height:44px;width:fit-content;max-width:100%;overflow-wrap:anywhere}
.collection-status-view .scoped-search {margin-block:20px 16px}
.collection-status-view .search-capsule {max-width:32rem}
.collection-status-view .scoped-search>label {margin-bottom:4px}
.collection-status-view .scoped-search p {margin-top:4px}
.collection-status-view .scoped-search .settings-help {max-width:66ch}
.collection-status-view .collection-issues>.collection-issues-body>p.settings-help {margin-top:16px}
.collection-status-view .history-issue-detail {padding-left:0}
.collection-status-view #collectionIssueLabel {font-size:var(--type-reading);font-weight:600}
.collection-status-view #collectionIssueCounts:not([hidden]) {display:flex;flex-wrap:wrap;column-gap:var(--space-lg);row-gap:var(--space-sm)}
#collectionIssueCounts>.history-status-count {min-width:0;overflow-wrap:anywhere}
#collectionIssueCounts .history-status-value {color:var(--ink);font-weight:var(--weight-strong)}
.collection-status-view .collection-issues[data-severity=error] #collectionIssueLabel {color:var(--danger)}
.collection-status-view .history-reason>summary {text-wrap:pretty}
.collection-status-view .facts {max-width:100%;grid-template-columns:minmax(0,2fr) minmax(0,1fr);font-size:1rem;line-height:1.5}
@container collection-status (max-width:36rem) {
 .collection-status-view .facts,.collection-status-view .settings-diagnostics {grid-template-columns:minmax(0,1fr);gap:4px}
 .collection-status-view .facts dd,.collection-status-view .settings-diagnostics dd {margin-bottom:12px}
}
.settings-layout {display:grid;grid-template-columns:minmax(0,14rem) minmax(0,1fr);gap:var(--space-2xl);align-items:start}
.settings-content,.settings-rail,.settings-categories,.settings-search {min-width:0}
.settings-rail {position:sticky;top:calc(var(--app-header-height,80px) + var(--space-lg));max-height:calc(100dvh - var(--app-header-height,80px) - 32px);overflow:auto;padding:8px;margin:-8px}
.settings-content {max-width:48rem;padding:24px 28px;background:var(--paper);border-radius:12px;container:settings-pane / inline-size}
.settings-categories {padding:0}
.settings-categories>summary {display:none}
.settings-categories nav {display:flex;flex-direction:column;gap:4px}
.settings-categories a {position:relative;display:flex;align-items:center;gap:var(--space-sm);min-height:44px;padding:12px;border:0;border-radius:var(--settings-nav-radius);background:transparent;color:var(--muted);font-size:var(--type-control);line-height:var(--leading-control);font-weight:var(--weight-medium);text-decoration:none;overflow-wrap:anywhere}
.settings-categories a>.wire-icon {width:20px;height:20px;margin-top:0;flex:none}
.settings-category-label {min-width:0;overflow-wrap:anywhere}
.settings-categories a:hover {background:transparent;color:var(--ink);text-decoration:underline;text-underline-offset:.25em}
.settings-categories a:active {background:transparent;color:var(--ink);text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:.25em}
.settings-categories a[aria-current=page] {background:transparent;color:var(--ink);font-weight:var(--weight-medium);box-shadow:none}
.settings-categories a[aria-current=page]::before {content:"";position:absolute;inset-inline-start:0;width:2px;height:1.25em;border-radius:2px;background:currentColor}
.settings-categories>summary {padding:10px 12px;background:var(--canvas);color:var(--ink);border:0;border-radius:var(--settings-nav-radius);cursor:pointer;min-height:44px;overflow-wrap:anywhere}
.settings-view .settings-search {width:100%;margin:0 0 var(--space-md)}
.settings-search .search-capsule {--settings-search-clear-size:max(44px,calc(1rem + 22px));isolation:isolate;max-width:32rem}
.settings-search .search-capsule::before {content:"";position:absolute;inset:6px 0;z-index:-1;pointer-events:none;border:1px solid var(--control);border-radius:var(--settings-field-radius);background:var(--paper)}
:root .settings-search .search-capsule input.search-capsule-input {min-height:44px;padding:12px var(--settings-search-clear-size) 12px calc(1rem + 18px);border:0;border-radius:var(--settings-field-radius);background:transparent;box-shadow:none;outline:none;transition:none}
.settings-search .search-capsule:has(input:hover)::before {border-color:var(--ink)}
.settings-search .search-capsule:has(input:focus-visible)::before {outline:2px solid var(--focus);outline-offset:0}
.settings-search .wire-search-icon {inset-inline-start:10px}
.settings-search .wire-search-icon .wire-icon,.settings-search .search-capsule-clear .wire-icon {width:1rem;height:1rem}
:root .settings-search .search-capsule-clear {inline-size:var(--settings-search-clear-size);margin-inline-end:0;border-radius:var(--settings-field-radius)}
.settings-rail .settings-status-link {display:flex;flex-direction:column;align-items:flex-start;padding:12px;font-size:var(--type-small);line-height:var(--leading-ui)}
.scoped-search {margin-block:16px;min-width:0}
.scoped-search>label {display:block;font-weight:600;margin-bottom:6px}
.search-input-row {display:flex;align-items:center;gap:8px}
.search-input-row input {flex:1;min-width:0;width:100%;min-height:44px}
.search-input-row button {flex:none;min-height:44px}
.scoped-search p {margin-top:6px;color:var(--muted)}
.search-count {font-size:var(--type-body)}
.settings-search-results,.settings-search-results ul {list-style:none;padding:0}
.settings-search-results {margin:16px 0 0;display:grid;gap:20px}
.settings-search-heading {display:flex;align-items:baseline;gap:8px;font-size:var(--type-control);font-weight:var(--weight-medium);line-height:var(--leading-control);color:var(--ink)}
.settings-search-heading>.wire-icon {width:1.125rem;height:1.125rem;flex:none;align-self:center;color:var(--muted)}
.settings-search-heading>span {min-width:0;overflow-wrap:anywhere}
.settings-search-results ul {margin:4px 0 0 1.125rem}
.settings-search-results a {position:relative;display:grid;align-content:center;gap:2px;min-height:44px;padding:8px 8px 8px 10px;border-radius:var(--settings-nav-radius);color:var(--muted);font-size:var(--type-control);line-height:var(--leading-control);font-weight:var(--weight-regular);overflow-wrap:anywhere}
.settings-search-results a:hover {color:var(--ink);text-decoration:underline;text-underline-offset:.25em}
.settings-search-results a:active {color:var(--ink);text-decoration-thickness:2px}
.settings-search-results a[aria-current=location] {color:var(--ink)}
.settings-search-results a[aria-current=location]::before {content:"";position:absolute;inset-inline-start:0;top:50%;transform:translateY(-50%);width:2px;height:1.25em;border-radius:2px;background:currentColor}
.settings-search-availability {font-size:var(--type-caption);color:var(--muted)}
.settings-search-results mark {color:inherit;background:var(--accent-soft);font-weight:var(--weight-medium)}
@media(forced-colors:active) {
 .settings-search .search-capsule::before {background:Canvas;border-color:CanvasText}
 .settings-search .search-capsule:has(input:focus-visible)::before {outline-color:Highlight}
 .settings-search-results a[aria-current=location]::before {background:Highlight;forced-color-adjust:none}
}
.settings-target {scroll-margin-block:20px}
.settings-target:where(:focus) {outline:2px solid var(--focus);outline-offset:4px}
@container settings (max-width:52rem) {
 .settings-layout {grid-template-columns:minmax(0,1fr);gap:20px}
 .settings-rail {position:static;max-height:none;overflow:visible;padding:0;margin:0}
 .settings-categories {padding:0;border-inline-end:0}
 .settings-categories>summary {display:list-item;list-style-position:inside}
 .settings-categories nav {margin-top:8px}
 .settings-content {max-width:none;padding:24px}
 .settings-rail .settings-status-link {padding:0;margin:0}
 .settings-section-heading {flex-wrap:wrap}
}
.settings-view,.settings-view p,.settings-view summary {font-size:var(--type-body);line-height:var(--leading-ui)}
.settings-view label {font-size:var(--type-small);line-height:var(--leading-control)}
.settings-view :is(input,select,button,.select-trigger) {font-size:var(--type-control);line-height:var(--leading-control)}
.settings-view :is(button:not(.ux-help,.ux-copy,.select-trigger),a.button-link) {--action-radius:var(--settings-action-radius)}
.settings-view :is(button,a.button-link):not(.icon-only,.select-trigger,.theme-trigger,.ux-help,.ux-copy) {--pill-inset:10px}
.settings-view :is(button,a.button-link):not(.icon-only,.select-trigger,.theme-trigger,.ux-help,.ux-copy)::before {inset-block:6px}
.settings-view :is(button,a.button-link):not(.icon-only,.select-trigger,.theme-trigger,.ux-help,.ux-copy):focus-visible {outline:none}
.settings-view :is(button,a.button-link):not(.icon-only,.select-trigger,.theme-trigger,.ux-help,.ux-copy):focus-visible::before {outline:2px solid var(--focus);outline-offset:2px}
.settings-view .ux-disabled-help:focus-visible:has(>button:not(.icon-only,.select-trigger,.theme-trigger,.ux-help,.ux-copy)) {outline:none}
.settings-view .ux-disabled-help:focus-visible>button:not(.icon-only,.select-trigger,.theme-trigger,.ux-help,.ux-copy)::before {outline:2px solid var(--focus);outline-offset:2px}
.settings-view :is(#checkActivity,#refreshBtn,#freshStoredRead) {gap:.375em}
.settings-view :is(#checkActivity,#refreshBtn,#freshStoredRead)>.wire-icon {width:1rem;height:1rem}
.settings-view #reloadSettings {margin-bottom:16px}
.settings-view :is(input[type=text],.select-trigger) {border-radius:var(--settings-field-radius)}
.settings-section {padding:24px;background:var(--paper);border-radius:var(--radius);margin-bottom:20px}
.settings-section h2 {font-size:var(--type-section);line-height:var(--leading-section)}
.settings-section h3 {font-size:var(--type-body);line-height:var(--leading-ui)}
.settings-view .settings-section {padding:0;background:transparent;border:0;border-radius:0;margin:0}
.settings-view .settings-section>h2 {margin:0}
.settings-view .settings-section>h2:has(+.settings-reply-row),.settings-view .settings-section>h2:has(+.settings-group),.settings-view .settings-section>h2:has(+.settings-theme-row) {margin-bottom:20px}
.settings-view .settings-section>h2,.settings-view .settings-section-heading h2 {font-size:1.25rem;font-weight:var(--weight-medium);line-height:var(--leading-heading);letter-spacing:-.015em}
.settings-view .settings-section>.settings-intro {margin:8px 0 24px;color:var(--muted);max-width:62ch}
.settings-section-heading {display:flex;align-items:baseline;justify-content:space-between;gap:24px;margin-bottom:24px}
.settings-section-heading p,.settings-help {color:var(--muted)}
.settings-section p {margin-top:8px;max-width:70ch}
.settings-section .settings-help {font-size:var(--type-small);line-height:var(--leading-ui)}
#sourceMicrosoftProgress {white-space:pre-line}
.settings-view .settings-section-heading p {font-size:var(--type-reading);line-height:var(--leading-reading)}
.connection-status {font-weight:var(--weight-medium);color:var(--ink);overflow-wrap:anywhere}
.settings-source-state {display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}
.settings-value-label {color:var(--muted);font-size:var(--type-small);font-weight:var(--weight-regular)}
.approved-label {color:var(--success);margin-left:12px}
.settings-actions {display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;align-items:center}
.settings-view :is(.settings-actions,.assessment-control-actions) {justify-content:flex-start}
.settings-view button,.settings-view input,.settings-view summary {min-height:44px}
.settings-view button {white-space:normal}
.settings-advanced {margin-top:16px;border-top:1px solid var(--rule)}
.settings-advanced>summary {padding-block:12px;color:var(--muted)}
.settings-paths,.settings-diagnostics {display:grid;grid-template-columns:minmax(120px,1fr) minmax(0,3fr);gap:8px 20px;margin:8px 0 16px}
.settings-view .settings-paths {grid-template-columns:minmax(0,1fr);gap:4px}
.settings-view .settings-paths dd {margin-bottom:12px;min-height:0}
.settings-paths dt,.settings-diagnostics dt {color:var(--muted)}
.settings-paths dd,.settings-diagnostics dd {margin:0;overflow-wrap:anywhere;min-width:0}
.settings-paths dd {font:var(--weight-regular) var(--type-reading)/var(--leading-reading) var(--font);white-space:break-spaces;min-height:44px}
.settings-paths dt {align-self:start;font:inherit}
.source-paths-read,.source-editor {margin-top:16px}
.settings-view :is(.source-paths-read,.source-editor) {padding-block:20px 0;border-top:1px solid var(--rule)}
.source-paths-read {scroll-margin-block:20px}
.source-paths-read h4 {width:fit-content;max-width:100%}
.source-paths-read h4,.source-editor h4 {font:var(--weight-strong) var(--type-body)/var(--leading-ui) var(--font)}
.settings-field {display:flex;flex-direction:column;gap:6px;min-width:0}
.source-editor .settings-field {margin-top:16px}
.source-editor .settings-preferences .settings-field {margin-top:0}
.source-editor .settings-field p {margin-top:0}
.source-editor input[type=text] {box-sizing:border-box;width:100%;min-height:44px;padding:8px 14px;border:1px solid var(--control);border-radius:var(--settings-field-radius,var(--radius-small));font-family:var(--font);font-size:var(--type-control);line-height:var(--leading-control)}
.source-editor input[type=text]:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
.settings-field input {width:100%}
.settings-view .select-control {max-width:100%}
.settings-preferences {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:20px}
.settings-preferences .select-control {width:100%}
.settings-view .settings-subheading {font-size:var(--type-reading)}
.settings-view p,.settings-view summary {overflow-wrap:anywhere}
.settings-view :is(.settings-display-field,.settings-task-row) {display:grid;grid-template-columns:minmax(0,1fr) fit-content(45%);align-items:baseline;gap:8px 24px;padding-block:20px;border-top:1px solid var(--rule)}
.settings-preferences .settings-field>label {padding:0;font-size:var(--type-small);font-weight:var(--weight-medium)}
.settings-display-field>.select-control {align-self:baseline;justify-self:end;max-width:100%}
.settings-display-field>:is(.settings-help,.notice) {grid-column:1/-1;margin:0}
.settings-task-row {margin-top:0}
.settings-row-copy {min-width:0}
.settings-row-copy h3,.settings-row-copy h3 label {margin:0;font-size:var(--type-reading);line-height:var(--leading-ui);font-weight:var(--weight-strong)}
.settings-row-copy p,.settings-row-copy .settings-help {color:var(--muted);margin:6px 0 0;max-width:52ch}
.settings-task-row>:is(button,.button-link,.ux-disabled-help) {justify-self:end;max-width:100%}
#approvedConnection>p {margin:0}
#approvedConnection {display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 16px}
#approvedConnection>.settings-actions {margin-top:0}
#unapprovedConnection>p {margin:0}
.settings-group {margin:0;padding-block:20px;border-top:1px solid transparent}
.settings-view .settings-group {padding-block:20px;border-top-color:var(--rule)}
.settings-group-heading {display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px;margin-bottom:12px}
.settings-view :is(.settings-group h3,.fresh-activity>h3) {font-size:var(--type-reading);font-weight:var(--weight-strong);margin:0}
.settings-view #connectionSource {padding-top:0;border-top:0}
.settings-view .fresh-activity {display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:24px;margin:0;padding-block:20px;border-top:1px solid var(--rule)}
.settings-view .fresh-activity>h3 {display:flex;align-items:center;grid-column:1;grid-row:1;min-height:44px;margin:0}
.settings-view .fresh-activity:has(#checkActivity[hidden])>h3 {min-height:0}
.settings-view .fresh-controls {display:contents}
.settings-view .fresh-controls>:is(#checkActivity,.ux-disabled-help) {grid-column:2;grid-row:1;justify-self:end;align-self:center}
.settings-view .fresh-details {display:none}
.settings-view .settings-refresh-context {grid-column:1;grid-row:2;margin:0;color:var(--muted)}
.settings-view .fresh-result {grid-column:1/-1;grid-row:3;margin-top:12px}
.fresh-result-summary {display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px}
.fresh-result-summary #freshChecked {font-size:var(--type-small);font-weight:var(--weight-regular)}
.settings-view .fresh-result-summary>p {margin:0}
.settings-view #freshCoverageAnnouncement {display:block;margin-top:4px;color:var(--muted);font-size:var(--type-small)}
.settings-view .fresh-result-meta {gap:0 16px}
.settings-group-heading .connection-status {font-size:var(--type-small)}
#approvedConnection,#unapprovedConnection {padding:0;border:0}
#connectionSource:has(#approvedConnection[hidden]) .source-editor {margin-top:0;padding-block:0;border-top:0}
#connectionPreferences .settings-preferences .settings-field {padding-block:0;border:0}
#connectionPreferences #preferenceActions {margin-top:16px;padding-top:0}
.settings-view #connectionPreferences {padding-bottom:0}
.settings-view .settings-group>.settings-task-row {padding:0;border:0;margin:0}
.settings-view .settings-group>.settings-task-row h3 {margin:0}
.settings-group>.collection-status-actions {margin-top:8px}
.settings-reply-row {padding-block:0 20px;margin:0}
.settings-reply-fallback {font-size:var(--type-reading);line-height:var(--leading-ui);font-weight:var(--weight-strong)}
.settings-reply-row:has(.settings-choice-row)>.settings-reply-fallback {display:none}
.settings-view #assessmentSetup {min-width:0}
.settings-view #assessmentSetup .settings-choice-row {display:grid;grid-template-columns:minmax(0,1fr) 44px;align-items:start;gap:8px 24px}
.settings-view #assessmentSetup .settings-row-copy h3 {display:flex;align-items:center;min-height:44px}
.settings-view #assessmentSetup .settings-row-copy h3 label {cursor:pointer}
.settings-view #assessmentSetup .settings-reply-help {margin-top:0}
.settings-view .settings-switch {position:relative;display:flex;align-items:center;justify-content:center;width:44px;height:44px;cursor:pointer}
.settings-view .settings-switch input {position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:inherit}
.settings-view .settings-switch .select-toggle {pointer-events:none}
.settings-view .settings-switch:has(input:checked) .select-toggle {border-color:var(--toggle-on);background:var(--toggle-on)}
.settings-view .settings-switch:has(input:checked) .select-toggle::after {transform:translateX(12px);background:var(--toggle-thumb)}
.settings-view .settings-switch:has(input:focus-visible) .select-toggle {outline:2px solid var(--focus);outline-offset:3px}
.settings-view .settings-switch:has(input:disabled) {cursor:not-allowed}
.settings-view .settings-switch:has(input:disabled) .select-toggle {box-shadow:none;border-color:var(--muted);border-style:dashed}
.settings-view .settings-switch:has(input:disabled:checked) .select-toggle {background:var(--muted)}
.settings-view .settings-switch:hover:has(input:enabled) .select-toggle {outline:1px solid var(--control);outline-offset:2px}
.settings-view .settings-switch:hover:has(input:focus-visible) .select-toggle {outline:2px solid var(--focus);outline-offset:3px}
.settings-view #assessmentSetup .assessment-applied {font-weight:var(--weight-regular);color:var(--muted)}
.settings-view #assessmentSetup .assessment-control-actions {justify-content:flex-start;margin:12px 0 0}
.settings-view #assessmentSetup .assessment-control-actions:not(:has(>button:not([hidden]))) {display:none}
.settings-view #assessmentSetup .assessment-capture-details {margin-block:8px;padding:12px 0;border-block:1px solid var(--rule);color:var(--muted)}
.settings-view #assessmentSetup .settings-help {margin-top:0}
.settings-view #assessmentSetup>section>p {max-width:70ch}
@media(forced-colors:active) {
 .settings-view :is(button,a.button-link):not(.icon-only,.select-trigger,.theme-trigger,.ux-help,.ux-copy):focus-visible::before,
 .settings-view .ux-disabled-help:focus-visible>button:not(.icon-only,.select-trigger,.theme-trigger,.ux-help,.ux-copy)::before {outline-color:Highlight}
 .settings-view .settings-switch .select-toggle {background:Canvas;border-color:ButtonText;box-shadow:none;forced-color-adjust:none}
 .settings-view .settings-switch .select-toggle::after {background:ButtonText}
 .settings-view .settings-switch:has(input:checked) .select-toggle {background:Highlight;border-color:Highlight}
 .settings-view .settings-switch:has(input:checked) .select-toggle::after {background:HighlightText}
 .settings-view .settings-switch:has(input:disabled) .select-toggle {border-color:GrayText}
 .settings-view .settings-switch:has(input:disabled:checked) .select-toggle {background:GrayText}
 .settings-view .settings-switch:has(input:focus-visible) .select-toggle {outline-color:Highlight}
}
.settings-view .settings-automatic-row {display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:0;margin:0;border:0}
.settings-view .settings-automatic-row>h3,.settings-view .settings-automatic-row>p {margin:0}
.settings-view .settings-automatic-actions {display:flex;flex-wrap:wrap;align-items:start;gap:8px;min-width:0}
.settings-view .settings-automatic-row[data-scoring-state=paused]>p {border-inline-start:3px solid var(--warning);padding-inline-start:12px}
.settings-view .settings-content a:not(.button-link),.settings-status-link a {text-decoration:underline;text-underline-offset:3px}
.settings-view .settings-content a:not(.button-link) {display:inline-flex;align-items:center;min-height:44px;max-width:100%;overflow-wrap:anywhere}
.settings-view .settings-advanced {margin-top:0}
.settings-view .settings-advanced>summary {padding-block:12px;cursor:pointer}
.settings-view .settings-advanced[open] {padding-bottom:12px}
.settings-view .settings-advanced>summary {color:var(--ink);font-weight:var(--weight-medium)}
.settings-view .settings-advanced>p {margin:0 0 8px;color:var(--muted)}
.settings-view [data-settings-section=troubleshooting]>.settings-group {padding-top:0;border:0}
.settings-view [data-settings-section=display]>.settings-theme-row {padding-top:0;border:0}
.settings-view .settings-theme-row {align-items:center}
.settings-view .settings-theme-row .theme-trigger {border-radius:var(--radius-pill)}
.settings-view .settings-section>:nth-last-child(1 of :not([hidden])) {padding-bottom:0}
.display-time-field p {overflow-wrap:anywhere}
.permission-boundary {margin-top:20px!important;padding-top:16px;border-top:1px solid var(--rule)}
#unapprovedConnection>.ux-disabled-help {margin-top:16px}
.collection-status-details {margin-block:16px}
.collection-notice {display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;margin-bottom:20px;color:var(--muted)}
.collection-notice p {font-size:var(--type-body)}
.collection-notice a {min-height:44px;align-content:center}
.collection-notice[data-severity=error] {color:var(--danger)}
.settings-draft-notice {display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;margin-bottom:16px}
.settings-draft-notice a {min-height:44px;align-content:center}
@container settings (max-width:52rem) {
 .settings-view .settings-section>h2,.settings-view .settings-section-heading h2 {font-size:1.375rem;line-height:var(--leading-heading)}
 .settings-paths {grid-template-columns:minmax(0,1fr);gap:4px}
 .settings-paths dd {margin-bottom:12px}
}
@container settings-pane (max-width:34rem) {
 .settings-view #assessmentSetup .settings-row-copy {display:contents}
 .settings-view #assessmentSetup .settings-row-copy h3 {grid-column:1;grid-row:1}
 .settings-view #assessmentSetup .settings-reply-help {grid-column:1/-1;grid-row:2}
 .settings-view #assessmentSetup .settings-switch {grid-column:2;grid-row:1}
 .settings-view :is(.settings-display-field,.settings-task-row) {grid-template-columns:minmax(0,1fr);gap:12px}
 .settings-view .settings-preferences {grid-template-columns:minmax(0,1fr)}
 .settings-view .settings-task-row>:is(button,.button-link,.ux-disabled-help),.settings-display-field>.select-control {justify-self:start}
 .settings-display-field>.select-control {width:100%}
 .settings-view .fresh-activity {grid-template-columns:minmax(0,1fr)}
 .settings-view .fresh-activity>h3 {min-height:0;margin-bottom:6px}
 .settings-view .settings-refresh-context {grid-column:1;grid-row:2;margin-bottom:8px}
 .settings-view .fresh-controls>:is(#checkActivity,.ux-disabled-help) {grid-column:1;grid-row:3;justify-self:start}
 .settings-view .fresh-result {grid-row:4}
 .settings-view .settings-refresh-actions {grid-column:1;grid-row:3;justify-content:flex-start}
 .settings-view :is(.settings-actions,.assessment-control-actions) {justify-content:flex-start}
}
@media(max-width:699px) {
 .settings-section {padding:20px 16px}
 #workspace:has(>#settingsView:not([hidden]))>.page-heading #pageTitle {font-size:var(--type-title);line-height:var(--leading-heading)}
 .settings-view .settings-section {padding:0}
 .settings-content {padding:20px 16px}
 .settings-section-heading {flex-direction:column;gap:8px}
 .settings-preferences {grid-template-columns:minmax(0,1fr)}
 .settings-paths,.settings-diagnostics {grid-template-columns:minmax(0,1fr);gap:4px}
 .settings-paths dd,.settings-diagnostics dd {margin-bottom:12px}
}
`;
