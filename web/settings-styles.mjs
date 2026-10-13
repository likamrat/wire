export const settingsStyles = `
:is(.settings-view,#workspace:has(>#settingsView:not([hidden]))) {
 --settings-title-size:2rem;--settings-title-leading:1.25;--settings-title-tracking:-.025em;
 --settings-field-radius:4px;--settings-nav-radius:6px;--settings-action-radius:8px;
}
#workspace:has(>#settingsView:not([hidden]))>.page-heading #pageTitle {font-size:var(--settings-title-size);line-height:var(--settings-title-leading);letter-spacing:var(--settings-title-tracking)}
.settings-view {max-width:1384px;container:settings / inline-size}
.settings-status-link {margin:8px 0 0;color:var(--muted)}
.settings-status-link a,#activityCollectionLink a {display:inline-flex;align-items:center;min-height:44px}
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
.collection-status-view .search-input-row {max-width:32rem}
.collection-status-view .scoped-search>label {margin-bottom:4px}
.collection-status-view .scoped-search p {margin-top:4px}
.collection-status-view .scoped-search .settings-help {max-width:66ch}
.collection-status-view .collection-issues>.collection-issues-body>p.settings-help {margin-top:16px}
.collection-status-view .history-issue-detail {padding-left:0}
.collection-status-view #collectionIssueLabel {font-size:var(--type-reading);font-weight:600}
.collection-status-view .collection-issues[data-severity=error] #collectionIssueLabel {color:var(--danger)}
.collection-status-view .history-reason>summary {text-wrap:pretty}
.collection-status-view .facts {max-width:100%;grid-template-columns:minmax(0,2fr) minmax(0,1fr);font-size:1rem;line-height:1.5}
@container collection-status (max-width:36rem) {
 .collection-status-view .facts,.collection-status-view .settings-diagnostics {grid-template-columns:minmax(0,1fr);gap:4px}
 .collection-status-view .facts dd,.collection-status-view .settings-diagnostics dd {margin-bottom:12px}
}
#activityCollectionLink {display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin-bottom:16px}
.settings-layout {display:grid;grid-template-columns:minmax(0,15rem) minmax(0,1fr);gap:var(--space-3xl);align-items:start}
.settings-content,.settings-rail,.settings-categories,.settings-search {min-width:0}
.settings-rail {position:sticky;top:calc(var(--app-header-height,80px) + var(--space-lg));max-height:calc(100dvh - var(--app-header-height,80px) - 32px);overflow:auto;padding:8px;margin:-8px}
.settings-content {max-width:52rem;container:settings-pane / inline-size}
.settings-categories {padding:4px var(--space-lg) 4px 0;border-inline-end:1px solid var(--rule)}
.settings-categories>summary {display:none}
.settings-categories nav {display:flex;flex-direction:column;gap:4px}
.settings-categories a {position:relative;display:flex;align-items:flex-start;gap:var(--space-sm);min-height:44px;padding:8px 10px;border:0;border-radius:var(--settings-nav-radius);background:transparent;color:var(--muted);font-size:var(--type-control);line-height:var(--leading-control);font-weight:var(--weight-medium);text-decoration:none;overflow-wrap:anywhere}
.settings-categories a>.fluent-icon {margin-top:calc((1lh - 24px)/2)}
.settings-category-label {min-width:0;overflow-wrap:anywhere}
.settings-categories a:hover {background:var(--hover);color:var(--ink);text-decoration:none}
.settings-categories a:active {background:var(--pill-pressed);color:var(--ink)}
.settings-categories a[aria-current=page] {background:var(--paper);color:var(--ink);font-weight:var(--weight-strong)}
.settings-categories a[aria-current=page]::before {content:"";position:absolute;inset-inline-start:0;inset-block:12px;width:3px;border-radius:3px;background:var(--accent)}
.settings-categories a[aria-current=page]:hover {background:var(--hover)}
.settings-categories a[aria-current=page]:active {background:var(--pill-pressed)}
.settings-categories>summary {padding:10px 12px;background:var(--canvas);color:var(--ink);border:0;border-radius:var(--settings-nav-radius);cursor:pointer;min-height:44px;overflow-wrap:anywhere}
.settings-view .settings-search {width:100%;margin:0 0 var(--space-md)}
.settings-search .search-input-row {gap:var(--space-sm);min-height:44px;padding-inline:10px;border:1px solid var(--control);border-radius:var(--settings-action-radius);background:var(--paper)}
.settings-search .search-input-row:has(input:focus-visible) {outline:2px solid var(--focus);outline-offset:3px}
.settings-search .settings-search-icon {color:var(--muted);flex:none}
.settings-search .search-input-row input {border:0;border-radius:0;background:transparent;padding:8px 0;min-height:44px}
.settings-search .search-input-row input:focus-visible {outline:none}
.settings-search .search-input-row button {padding:8px var(--pill-inset);border:0;background:transparent;min-width:44px}
.settings-search .search-input-row button:focus-visible {outline-offset:0}
.settings-rail .settings-status-link {display:flex;flex-direction:column;align-items:flex-start;font-size:var(--type-caption);line-height:var(--leading-caption)}
.scoped-search {margin-block:16px;min-width:0}
.scoped-search>label {display:block;font-weight:600;margin-bottom:6px}
.search-input-row {display:flex;align-items:center;gap:8px}
.search-input-row input {flex:1;min-width:0;width:100%;min-height:44px}
.search-input-row button {flex:none;min-height:44px}
.scoped-search p {margin-top:6px;color:var(--muted)}
.search-count {font-size:var(--type-body)}
.settings-search-results {list-style:none;padding:0;margin:12px 0 0;display:grid;gap:4px}
.settings-search-results a {display:grid;gap:2px;padding:12px 16px;background:var(--paper);border-radius:var(--radius-small);text-decoration:none!important;min-height:44px}
.settings-search-results a:hover {background:var(--hover)}
.settings-search-results .search-category,.settings-search-results .search-context {color:var(--muted);font-weight:400}
.settings-search-results .search-category {font-size:.875rem}
.settings-search-results mark {color:inherit;background:var(--accent-soft);font-weight:700}
.settings-target {scroll-margin-block:20px}
.settings-target:where(:focus) {outline:2px solid var(--focus);outline-offset:4px}
@container settings (max-width:52rem) {
 .settings-layout {grid-template-columns:minmax(0,1fr);gap:16px}
 .settings-rail {position:static;max-height:none;overflow:visible;padding:0;margin:0}
 .settings-categories {padding:0;border-inline-end:0}
 .settings-categories>summary {display:list-item;list-style-position:inside}
 .settings-categories nav {margin-top:8px}
 .settings-content {max-width:none}
 .settings-section-heading {flex-wrap:wrap}
}
.settings-view,.settings-view p,.settings-view summary {font-size:var(--type-body);line-height:var(--leading-ui)}
.settings-view label {font-size:var(--type-small);line-height:var(--leading-control)}
.settings-view :is(input,select,button,.select-trigger) {font-size:var(--type-control);line-height:var(--leading-control)}
.settings-view :is(button:not(.ux-help,.ux-copy,.select-trigger),a.button-link) {--action-radius:var(--settings-action-radius)}
.settings-view :is(input[type=text],.select-trigger) {border-radius:var(--settings-field-radius)}
.settings-section {padding:24px;background:var(--paper);border-radius:var(--radius);margin-bottom:20px}
.settings-section h2 {font-size:var(--type-section);line-height:var(--leading-section)}
.settings-section h3 {font-size:var(--type-body);line-height:var(--leading-ui)}
.settings-view .settings-section {padding:0;background:transparent;border:0;border-radius:0;margin:0}
.settings-view .settings-section>h2 {margin-bottom:16px}
.settings-view .settings-section>h2,.settings-view .settings-section-heading h2 {font-size:var(--settings-title-size);line-height:var(--settings-title-leading);letter-spacing:var(--settings-title-tracking)}
.settings-section-heading {display:flex;align-items:baseline;justify-content:space-between;gap:24px;margin-bottom:24px}
.settings-section-heading p,.settings-help {color:var(--muted)}
.settings-section p {margin-top:8px;max-width:70ch}
.settings-section .settings-help {font-size:var(--type-small);line-height:var(--leading-ui)}
.settings-view .settings-section-heading p {font-size:var(--type-reading);line-height:var(--leading-reading)}
.connection-status {flex:none;font-weight:600;color:var(--accent)}
.approved-label {color:var(--success);margin-left:12px}
.settings-actions {display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;align-items:center}
.settings-view :is(.settings-actions,.assessment-control-actions) {justify-content:flex-start}
.settings-view button,.settings-view input,.settings-view summary {min-height:44px}
.settings-view button {white-space:normal}
.settings-advanced {margin-top:16px;border-top:1px solid var(--rule)}
.settings-advanced>summary {padding-block:12px;color:var(--muted)}
.settings-paths,.settings-diagnostics {display:grid;grid-template-columns:minmax(120px,1fr) minmax(0,3fr);gap:8px 20px;margin:8px 0 16px}
.settings-paths dt,.settings-diagnostics dt {color:var(--muted)}
.settings-paths dd,.settings-diagnostics dd {margin:0;overflow-wrap:anywhere;min-width:0}
.settings-paths dd {font:var(--weight-regular) var(--type-reading)/var(--leading-reading) var(--font);white-space:break-spaces;min-height:44px}
.settings-paths dt {align-self:start;font-weight:var(--weight-medium)}
.source-paths-read,.source-editor {margin-top:16px}
.settings-view :is(.source-paths-read,.source-editor) {padding-block:16px 0;border-top:1px solid var(--rule)}
.source-paths-read {scroll-margin-block:20px}
.source-paths-read h4 {width:fit-content;max-width:100%}
.source-paths-read h4,.source-editor h4 {font:var(--weight-strong) var(--type-body)/var(--leading-ui) var(--font)}
.settings-field {display:flex;flex-direction:column;gap:6px;min-width:0}
.source-editor .settings-field {margin-top:16px}
.source-editor .settings-field p {margin-top:0}
.source-editor input[type=text] {box-sizing:border-box;width:100%;min-height:44px;padding:8px 14px;border:1px solid var(--control);border-radius:var(--settings-field-radius,var(--radius-small));font-family:var(--font);font-size:var(--type-control);line-height:var(--leading-control)}
.source-editor input[type=text]:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
.settings-field input {width:100%}
.display-time-field {margin-top:0}
.display-time-field>.select-control,.settings-preferences .select-control {align-self:flex-start;width:max-content;max-width:min(100%,36rem)}
.display-time-field .select-trigger,.settings-preferences .select-trigger {font-size:var(--type-control);line-height:var(--leading-control);min-height:max(44px,calc(1lh + 16px))}
.settings-preferences {display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin-top:12px}
.settings-view .settings-subheading {font-size:var(--type-reading);margin-top:var(--space-xl)}
.settings-view .settings-subheading+.settings-preferences {margin-top:var(--space-md)}
.settings-view p,.settings-view summary {overflow-wrap:anywhere}
.settings-view :is(.settings-preferences .settings-field,.display-time-field,.settings-task-row) {display:grid;grid-template-columns:minmax(0,18rem) minmax(0,1fr);align-items:start;gap:4px var(--space-lg);padding-block:16px;border-top:1px solid var(--rule)}
.settings-preferences .settings-field>label {grid-column:1;grid-row:1;padding:0;font-size:var(--type-reading);font-weight:var(--weight-strong)}
.display-time-field>h3 {grid-column:1;grid-row:1;margin:0}
.display-time-field>h3>label {padding:0;font-size:var(--type-reading);font-weight:var(--weight-strong)}
.settings-preferences .settings-field>.select-control,.display-time-field>.select-control {grid-column:2;grid-row:1;justify-self:start;align-self:start;width:fit-content;max-width:100%}
.display-time-field>.settings-help {grid-column:2;margin:0}
.settings-task-row {margin-top:0}
.settings-row-copy {display:contents}
.settings-row-copy h3 {grid-column:1;grid-row:1;align-self:center;font-size:var(--type-reading);line-height:var(--leading-ui)}
.settings-row-copy p {grid-column:1/-1;grid-row:2;color:var(--muted);margin:0}
.settings-task-row>:is(button,.button-link) {grid-column:2;grid-row:1;justify-self:start;max-width:100%}
#approvedConnection>p {margin:0}
#approvedConnection>.settings-actions {margin-top:8px}
#unapprovedConnection>p {margin:0}
.settings-group,.settings-view .fresh-activity {margin:0;padding-block:16px;border-top:1px solid var(--rule)}
.settings-group-heading {display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px}
.settings-view :is(.settings-group h3,.fresh-activity>h3) {font-size:var(--type-reading);font-weight:var(--weight-strong);margin:0 0 12px}
.settings-view #connectionSource {display:grid;grid-template-columns:minmax(0,18rem) minmax(0,1fr);gap:0 var(--space-lg)}
.settings-view #connectionSource>.settings-group-heading {align-content:start;align-items:baseline;gap:4px 12px}
.settings-view #connectionSource>.settings-group-heading h3 {margin:0}
.settings-view #connectionSource>:is(.source-editor,.source-paths-read) {grid-column:1/-1}
.settings-view .fresh-activity {display:grid;grid-template-columns:minmax(0,18rem) minmax(0,1fr);gap:8px var(--space-lg)}
.settings-view .fresh-activity>h3 {margin:0}
.settings-view .fresh-controls {min-width:0;grid-template-columns:auto minmax(0,1fr);gap:8px 12px}
.settings-view .fresh-details {grid-column:2;grid-row:1}
.settings-view .fresh-controls:has(#freshHelp[open]) {grid-template-columns:minmax(0,1fr)}
.settings-view .fresh-controls:has(#freshHelp[open]) .fresh-details {grid-column:1;grid-row:auto}
.settings-group-heading .connection-status {font-size:var(--type-small)}
#approvedConnection,#unapprovedConnection {padding:0;border:0}
#connectionSource:has(#approvedConnection[hidden]) .source-editor {margin-top:0;padding-block:0;border-top:0}
#connectionPreferences .settings-preferences .settings-field {padding-block:0;border:0}
#connectionPreferences #preferenceActions {margin-top:16px;padding-top:12px;border-top:1px solid var(--rule)}
.settings-view .settings-group>.settings-task-row {padding:0;border:0;margin:0}
.settings-view .settings-group>.settings-task-row h3 {margin:0}
.settings-group>.collection-status-actions {margin-top:8px}
.settings-reply-row {display:grid;grid-template-columns:minmax(0,18rem) minmax(0,1fr);gap:8px var(--space-lg);padding-block:16px;margin-top:0;border-top:1px solid var(--rule)}
.settings-reply-row>h3 {font-size:var(--type-reading);line-height:var(--leading-ui);font-weight:var(--weight-strong)}
.settings-view #assessmentSetup {min-width:0}
.settings-view #assessmentSetup .settings-choice-row {display:flex;align-items:center;gap:var(--space-sm);width:fit-content;max-width:100%;min-height:44px;margin-top:0;cursor:pointer}
.settings-view #assessmentSetup .settings-choice-row>input {margin:0;min-height:0}
.settings-view #assessmentSetup .assessment-control-actions {justify-content:flex-start}
.settings-view #assessmentSetup .assessment-control-actions:not(:has(>button:not([hidden]))) {display:none}
.settings-view #assessmentSetup .assessment-capture-details {margin-block:8px;color:var(--muted)}
.settings-view #assessmentSetup>section>p {max-width:70ch}
.settings-view .settings-automatic-row {display:grid;grid-template-columns:minmax(0,18rem) minmax(0,1fr);align-items:start;gap:4px var(--space-lg);padding-block:16px;margin-top:0}
.settings-view .settings-automatic-row>h3 {grid-column:1;grid-row:1;align-self:center;min-width:0}
.settings-view .settings-automatic-row>p {grid-column:1/-1;grid-row:2;margin:0}
.settings-view .settings-automatic-actions {grid-column:2;grid-row:1;display:flex;flex-wrap:wrap;align-items:start;gap:8px;min-width:0}
.settings-view .settings-content a:not(.button-link),.settings-status-link a {text-decoration:underline;text-underline-offset:3px}
.settings-view .settings-content a:not(.button-link) {display:inline-flex;align-items:center;min-height:44px;max-width:100%;overflow-wrap:anywhere}
.settings-view .settings-advanced {margin-top:0}
.settings-view .settings-advanced>summary {padding-block:12px;cursor:pointer}
.settings-view .settings-advanced[open] {padding-bottom:12px}
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
 .settings-view .settings-section>h2,.settings-view .settings-section-heading h2 {font-size:var(--type-title);line-height:var(--leading-heading)}
 .settings-paths {grid-template-columns:minmax(0,1fr);gap:4px}
 .settings-paths dd {margin-bottom:12px}
}
@container settings-pane (max-width:36rem) {
 .settings-view :is(.settings-preferences .settings-field,.display-time-field,.settings-task-row) {grid-template-columns:minmax(0,1fr);gap:8px}
 .settings-preferences .settings-field>label,.settings-preferences .settings-field>.settings-help,.settings-preferences .settings-field>.select-control,
 .display-time-field>h3,.display-time-field>.select-control,.display-time-field>.settings-help {grid-column:1;grid-row:auto}
 .settings-preferences .settings-field>.select-control,.display-time-field>.select-control {justify-self:start;width:max-content;max-width:100%}
 .settings-task-row>:is(button,.button-link),#unapprovedConnection>button {justify-self:start}
 .settings-task-row>.settings-row-copy>:is(h3,p),.settings-task-row>:is(button,.button-link) {grid-column:1;grid-row:auto}
 .settings-view .settings-automatic-row {grid-template-columns:minmax(0,1fr)}
 .settings-view .settings-automatic-row>:is(h3,p,.settings-automatic-actions) {grid-column:1;grid-row:auto}
 .settings-view #connectionSource,.settings-view .fresh-activity,.settings-reply-row {grid-template-columns:minmax(0,1fr);gap:8px}
 .settings-view :is(.settings-actions,.assessment-control-actions) {justify-content:flex-start}
}
@media(max-width:699px) {
 .settings-section {padding:20px 16px}
 #workspace:has(>#settingsView:not([hidden]))>.page-heading #pageTitle {font-size:var(--type-title);line-height:var(--leading-heading)}
 .settings-view .settings-section {padding:0}
 .settings-section-heading {flex-direction:column;gap:8px}
 .settings-preferences {grid-template-columns:minmax(0,1fr)}
 .settings-paths,.settings-diagnostics {grid-template-columns:minmax(0,1fr);gap:4px}
 .settings-paths dd,.settings-diagnostics dd {margin-bottom:12px}
}
`;
