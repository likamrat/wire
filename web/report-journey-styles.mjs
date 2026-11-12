export const reportJourneyStyles = `
#workspace:has(>#reportsView:not([hidden])){--report-content-width:var(--task-content-width)}
#workspace:has(>#reportsView:not([hidden]) #reportCreatePanel:not([hidden]) #reportStage3:not([hidden]) #reportReviewBody:not([hidden])),
#workspace:has(>#reportsView:not([hidden]) #comparisonWorkspace:not([hidden]) .comparison-prepared-files:not([hidden])){--report-content-width:86.5rem}
body:has(#workspace:not([hidden])>#reportsView:not([hidden])>#savedReportReader:not([hidden]))>main{display:flex;flex-direction:column;min-height:calc(100dvh - var(--app-header-height,76px));padding-block:18px 20px}
#workspace:has(>#reportsView:not([hidden]) #savedReportReader:not([hidden])){--report-content-width:none;display:flex;flex-direction:column;flex:1;min-height:0}
#workspace:has(>#reportsView:not([hidden]) #savedReportReader:not([hidden]))>#breadcrumbs{display:none}
#workspace:has(>#reportsView:not([hidden]) #savedReportReader:not([hidden]))>.page-heading{display:none}
#savedReportReader #pageTitle{font-size:1.75rem;line-height:1.2;font-weight:600;letter-spacing:-.02em;margin:0;overflow-wrap:anywhere}
#reportsView:not([hidden]):has(>#savedReportReader:not([hidden])){display:flex;flex-direction:column;flex:1;min-height:0}
#workspace:has(>#reportsView:not([hidden]))>:is(.page-heading,#reportsView,#coverage){width:100%;max-width:var(--report-content-width)}
#workspace:has(>#reportsView:not([hidden]) :is(#savedReportsPanel,#comparisonWorkspace):not([hidden]))>.page-heading{margin-bottom:16px}
#workspace:has(>#reportsView:not([hidden]) :is(#savedReportsPanel,#comparisonWorkspace):not([hidden]))>#breadcrumbs{display:none}
.report-task-nav{display:flex;flex-wrap:wrap;gap:8px;margin:0;max-width:100%}
.report-task-nav[hidden]{display:none!important}
.report-task-nav>a{min-height:44px;align-content:center;white-space:normal}
.report-task-nav>a[aria-current=page]{--pill-fill:var(--accent-soft);--pill-border:var(--accent);color:var(--accent);font-weight:var(--weight-strong)}
#reportCreatePanel[hidden],#savedReportsPanel[hidden]{display:none!important}
#reportsView #savedReportsPanel #bundles{margin-top:0;padding:20px;border:1px solid var(--surface-edge);border-radius:var(--radius);background:var(--paper)}
#savedReportReader{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;width:100%}
#savedReportReader[hidden]{display:none!important}
.saved-reader-heading{flex:none;min-width:0;padding-bottom:18px}
.saved-reader-heading>button{display:inline-flex;align-items:center;gap:8px;min-height:30px;padding:0 0 4px;font-size:var(--type-control);color:var(--muted)}
.saved-reader-identity{display:flex;align-items:start;gap:24px;margin-top:8px}
.saved-reader-title{flex:1;min-width:0}
.saved-reader-meta{margin:10px 0 0;font-size:var(--type-control);color:var(--muted)}
.saved-reader-meta>div{display:flex;flex-wrap:wrap;gap:8px}.saved-reader-meta :is(dt,dd){margin:0;font:inherit}
.saved-reader-body{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.saved-reader-actions:empty{display:none}
.saved-reader-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;min-width:0;max-width:100%;flex:none}
.saved-reader-actions button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;white-space:normal}
.saved-sharing-action{color:var(--muted);font-size:var(--type-control);text-decoration:underline;text-underline-offset:3px}
.saved-file-notice{max-width:520px;width:calc(100% - 32px)}
.saved-file-notice .dialog-head{position:static;align-items:start;border:0;padding-bottom:0}
.saved-file-notice .dialog-head h2{font-size:1.5rem;line-height:1.25;font-weight:600}
.saved-file-notice .dialog-head button{padding:0;min-width:32px;min-height:32px}
.saved-file-notice .dialog-body{font-size:var(--type-body);line-height:1.6}
.saved-sharing-lead{font-weight:var(--weight-medium)}.saved-sharing-detail{border-top:1px solid var(--rule);padding-top:16px;color:var(--muted);font-size:var(--type-control)}
.saved-reader-loading{align-self:center;margin:auto;padding:24px;color:var(--muted)}
.saved-reader-issue{flex-basis:100%;max-width:65ch;line-height:var(--leading-reading)}
.original-file-controls{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.original-file-choice{display:grid;gap:8px;min-width:0;flex-basis:100%}
.original-file-choice>label{font-weight:400}
.original-file-controls>.primary{flex:1}
.original-file-controls>button{min-height:44px;max-width:100%;white-space:normal}
.saved-inspector-facts{display:grid;gap:6px;margin:0 0 16px}
.saved-inspector-facts>div{display:grid;grid-template-columns:7rem minmax(0,1fr);gap:4px 12px}
.saved-inspector-facts :is(dt,dd){margin:0;font:inherit;overflow-wrap:anywhere}
.saved-inspector-facts dt{color:var(--muted)}
.saved-report-inspection h3{font-size:var(--type-body);font-weight:400;margin:0 0 8px}
.saved-report-inspection:has(.saved-original-notice){display:flex;flex-direction:column;min-height:100%}
.saved-report-inspection>button{display:block;margin-top:16px;white-space:normal}
.saved-inspector-title{font-size:var(--type-section);line-height:var(--leading-section);font-weight:var(--weight-regular);margin:0 0 20px}
#contextSidebar:has(.saved-report-inspection) .context-sidebar-header{justify-content:flex-end}
.saved-inspector-actions{display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:8px 12px}
.saved-inspector-actions button{min-height:44px;white-space:normal}
.saved-inspector-actions>:is(.original-file-controls,.saved-report-downloads){width:100%;margin:0;justify-content:flex-start}
.saved-inspector-actions>.saved-reader-issue{margin:0;color:var(--muted);font-size:var(--type-control);line-height:var(--leading-ui)}
.saved-original-notice{width:100%;font-size:var(--type-control);line-height:1.55;margin-top:auto;padding-top:24px}
.saved-original-notice h3{font:var(--weight-medium) var(--type-control)/1.5 var(--font);margin:0 0 8px}
.saved-original-notice p{margin:8px 0;color:var(--muted)}
@media(max-width:850px){.saved-reader-identity{flex-wrap:wrap;gap:12px}.saved-reader-title{flex-basis:100%}.saved-reader-actions{width:100%;justify-content:flex-end}.saved-reader-actions .saved-sharing-action{margin-right:auto}}
@media(max-width:700px){
 #savedReportReader #pageTitle{font-size:1.5rem}.saved-reader-heading{padding-bottom:8px}
 .saved-reader-heading>button{min-height:44px;padding-bottom:0}.saved-reader-identity{margin-top:4px;gap:8px}
 .saved-reader-meta{margin-top:6px}.saved-reader-actions button{min-height:44px}
 .saved-report-inspection:has(.saved-original-notice)>.saved-inspector-title{order:-2}
 .saved-report-inspection>.saved-original-notice{order:-1;margin-top:0;padding-top:0}
}
@container (max-width:24rem){.saved-inspector-facts>div{grid-template-columns:minmax(0,1fr)}}
.saved-reader-caption{margin:0;color:var(--muted);font-size:var(--type-body)}
.saved-library-heading{display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px;margin-bottom:12px}
.saved-library-title{flex:1 1 12rem;min-width:0}
#savedLibraryTitle{font-size:var(--type-section);margin:0;font-weight:400}
#reportsView .report-start{display:block;padding:16px 0;margin:0;border-bottom:1px solid var(--rule)}
#reportsView .report-start #reportPreviewContext{display:grid;grid-template-columns:minmax(0,1fr) auto;width:100%;align-items:center;gap:4px 16px;margin:0;text-align:left}
#reportsView #reportPreviewContext>#pageHeadingActions{grid-column:2;grid-row:1 / 3}
#reportsView #reportPreviewContext>.report-choice-summary{grid-column:1;font-size:var(--type-body);margin:0}
.report-journey{max-width:none;margin:0 0 20px;padding:20px 24px;background:var(--paper);border:1px solid transparent;border-radius:var(--radius-small);container:report-journey / inline-size}
.report-progress-label{font-weight:var(--weight-strong);font-size:var(--type-body);margin:0 0 8px;color:var(--accent)}
.report-progress ol{list-style:none;display:flex;flex-wrap:wrap;gap:8px 20px;margin:0;padding:0}
.report-progress li{min-width:0}
.report-step{display:flex;gap:var(--pill-gap);align-items:center;justify-content:flex-start;min-height:44px;border:0;border-radius:0;background:transparent;padding:8px 0;text-align:left;white-space:normal}
.report-step:disabled{background:transparent}
.report-step>span:not(.report-step-number){min-width:0;overflow-wrap:normal}
.report-step-number{font-variant-numeric:tabular-nums;color:var(--muted)}
.report-step[data-visited=true]{color:var(--accent)}
.report-step[data-visited=true] .report-step-number{color:var(--accent)}
.report-step[aria-current=step]{color:var(--ink);box-shadow:inset 0 -2px var(--ink)}
.report-step[aria-current=step] .report-step-number{color:var(--ink)}
.report-step-hint-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.report-step:not(:disabled):hover{background:var(--hover)}
.report-stage{margin-top:20px;min-width:0}
#reportStage2{container:report-journey / inline-size;margin:0}
#reportStage2 .report-options{margin:12px 0 0;padding:0;border:0;gap:20px}
#contextSidebarFooter>.report-stage-actions{margin:0;padding:0;border:0}
.report-stage>h2{font-size:var(--type-dialog);line-height:var(--leading-dialog);margin:0 0 20px;text-wrap:balance;scroll-margin-top:calc(var(--app-header-height,80px) + 16px)}
.report-entry-context,.report-scope-gap{max-width:72ch;line-height:var(--leading-reading)}
.report-choice-summary{margin:4px 0 0;color:var(--muted);font-size:1rem}
.report-entry-context{margin:12px 0 0;color:var(--muted);font-size:var(--type-body)}
.report-entry-name{display:block;color:var(--ink);margin-bottom:var(--space-xs)}
.report-metadata{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--space-xs) var(--space-lg)}
.report-metadata>span{min-width:0;max-width:100%;overflow-wrap:anywhere}
.report-stage-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:20px 0 0;border-top:1px solid var(--rule);padding-top:12px}
.report-stage-actions button,.report-downloads button{min-height:44px;max-width:100%;height:auto;white-space:normal;overflow-wrap:anywhere}
.report-stage-actions>.report-scope-gap{flex-basis:100%;max-width:none;margin:0 0 4px;color:var(--muted)}
.report-stage-actions>:last-child{margin-inline-start:auto}
.report-next-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;min-width:0;max-width:100%}
.report-stage .export-scope{margin:0;min-width:0}
.report-scope-layout{display:block;min-width:0}
.report-period-scope{min-width:0}
.report-period-ranges{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 24px}
.report-period-ranges h3{margin:0 0 4px;font:inherit;color:var(--muted)}
.report-period-ranges p{margin:0;overflow-wrap:anywhere}
.report-period-authors{margin:12px 0 4px;overflow-wrap:anywhere}
.report-period-scope>.context-help-note{margin:0 0 8px}
.report-period-scope>button{min-height:44px;max-width:100%;white-space:normal}
#reportStepTitle1{font-size:var(--type-body);line-height:var(--leading-ui);font-weight:400;margin:0 0 8px}
.report-journey .export-scope legend{font-size:var(--type-body);line-height:var(--leading-ui);margin-bottom:8px}
.report-journey .report-author-choice{margin:0;gap:8px}
.report-journey .report-author-choice>.scope-summary{margin:0;font-weight:400;max-width:38ch}
.report-journey .report-author-choice>.context-help-note{margin:0}
#reportStage1 .scope-choices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 16px;align-items:start}
#reportStage1 .scope-choice{max-width:none;min-height:44px;margin:0;padding:8px 0;border:0;background:transparent}
#reportStage1 .scope-choice:has(input:checked){background:transparent;box-shadow:none}
#reportStage1 .scope-choice :is(strong,small){font:inherit}
#reportStage1 .scope-choice:has(input:focus-visible){outline:2px solid var(--focus);outline-offset:3px}
.report-stage .scope-choice-help{max-width:65ch;margin:8px 0 0;font-size:var(--type-body);line-height:var(--leading-reading)}
.report-picker-tools{display:flex;flex-wrap:wrap;align-items:start;gap:12px 16px;margin-bottom:8px}
.report-picker-tools>.scoped-search{display:grid;gap:4px;align-content:start;flex:1 1 18rem;max-width:32rem;min-width:0;margin:0}
.report-journey .report-picker-tools>.report-author-choice{gap:4px;flex:0 1 auto;max-width:100%;min-width:0}
#reportRequests .report-picker-tools :is(.scoped-search,.report-author-choice)>label{margin:0;font-weight:400}
.report-author-control{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%}
.report-author-control>svg{width:20px;height:20px;flex:none}
.report-author-control>.select-control{min-width:0;flex:0 1 auto}
.report-picker-tools .report-author-choice>label{font-weight:400}
.report-activity-actions{position:sticky;bottom:0;z-index:2;align-items:center;background:var(--paper);margin:12px 0 0;padding:12px 0}
.report-activity-summary{flex:1 1 16rem;min-width:0;max-width:72ch}
.report-activity-summary>p{margin:0}
.report-activity-summary>.context-help-note{margin-top:4px}
.report-activity-summary>.context-help-note:empty,#reportSelectionActions:empty{display:none}
.report-activity-actions>.report-next-actions{flex:0 1 auto}
.report-activity-actions .report-next-actions button,.report-activity-actions .report-next-actions>.ux-disabled-help{flex-basis:auto}
.report-stage #promptOptions{grid-auto-rows:auto}
.report-title-field{display:grid;gap:4px;margin:0 0 16px;min-width:0}
.report-title-field>label{font-weight:400}
.report-title-field>input{width:100%;min-width:0;min-height:44px}
.report-title-field>p{margin:0}
#reportStage2 .prompt-choice{min-height:44px;padding:8px 0;border:0;background:transparent}
#reportStage2 .prompt-choice:has(input:checked){background:transparent;box-shadow:none}
#reportStage2 .prompt-choice strong{font-weight:400}
#reportStage2 .format-choices{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:0 16px}
#reportStage2 .format-choices label{justify-content:flex-start;padding:8px 0;border:0;background:transparent;font-weight:400;border-radius:0}
#reportStage2 .format-choices label:has(input:checked){color:var(--ink);background:transparent;font-weight:400}
#reportStage2 .format-choices label::before{content:none}
#reportStage2 .report-options legend{font-size:var(--type-body);font-weight:400;margin-bottom:4px}
.report-stage #promptOptions .prompt-choice:has(input:not(:checked))>span>span{display:none}
.report-stage .report-options{margin:24px 0 16px;padding-top:20px;border-top:1px solid var(--rule);gap:24px}
.report-stage .report-options>fieldset{min-width:0}
.report-stage .report-options>.report-privacy-note{grid-column:1 / -1;margin:0;max-width:65ch}
.report-journey #reportTimeContext{font-size:var(--type-body);line-height:var(--leading-ui)}
#reportsView :is(.detail-disclosure,.supporting){margin-top:12px;margin-bottom:0}
#reportsView :is(.detail-disclosure,.supporting)>summary,#reportsView:not([hidden])~#coverage>summary{font:var(--weight-medium) var(--type-body)/var(--leading-ui) var(--font);min-height:44px;padding:12px 0;overflow-wrap:anywhere}
#reportsView .report-stage>.detail-disclosure,#reportsView .report-stage>.supporting{margin-top:8px}
#reportsView #bundles,#reportsView:not([hidden])~#coverage{max-width:none;margin-top:16px}
.report-journey .report-snapshot-details{margin:0 0 12px}
.report-snapshot-details>p{margin:8px 0;font-size:var(--type-body);line-height:var(--leading-reading);font-weight:var(--weight-regular)}
.report-privacy-note{line-height:var(--leading-reading);margin:12px 0 16px}
.report-journey .report-document{padding:0;border:0;border-radius:0;background:transparent}
.report-document>h3{font-size:var(--type-section);line-height:var(--leading-section)}
.report-document>.muted{margin:4px 0 12px;font-size:var(--type-body)}
.report-journey .report-review-body,.report-journey .report-save-body{min-width:0}
.report-journey .report-frame{width:100%;min-height:0;max-height:none;border:1px solid var(--rule);border-radius:var(--radius-small);background:#fff}
.report-copy-inspection>.prompt-comparisons{margin-top:20px}
.report-journey .prompt-comparison,.report-journey .prompt-pair>*{min-width:0}
.report-journey pre,.report-journey textarea{max-width:100%;overflow-wrap:anywhere}
.report-journey .ux-code-toolbar>.ux-copy{width:44px;height:44px;min-width:44px;min-height:44px}
.report-journey .report-confirmation,.report-journey .report-time-context{overflow-wrap:anywhere}
.report-review-body>.attestation{margin:16px 0 12px;line-height:var(--leading-reading)}
.report-review-body>p[role=status]:empty{display:none}
.report-save-summary{display:grid;gap:12px;margin:0 0 16px}
.report-save-summary>div{display:grid;grid-template-columns:8rem minmax(0,1fr);gap:8px 16px}
.report-save-summary dt{color:var(--muted);font:inherit}
.report-save-summary dd{margin:0;overflow-wrap:anywhere;font-weight:400}
.report-save-boundary{margin:16px 0 8px}
.report-save-body>p[role=status]{font-size:var(--type-body);line-height:var(--leading-reading)}
.report-journey-error{scroll-margin-top:120px}
.report-save-success{font-weight:600;color:var(--success);margin-bottom:12px}
.report-saved-id,.report-saved-location{overflow-wrap:anywhere;color:var(--muted)}
#bundleList .saved-report>summary{min-height:44px}
.saved-library-context{margin:4px 0 0}
.saved-library-context>p{margin:0;color:var(--muted)}
#savedLibraryManagement{margin:0;min-width:0}
#savedLibraryManagement>summary{min-height:44px;padding:12px 0;font:var(--weight-medium) var(--type-body)/var(--leading-ui) var(--font);color:var(--muted);cursor:pointer;overflow-wrap:anywhere}
.saved-library-management-body{max-width:65ch;padding-bottom:12px;font-size:var(--type-body);line-height:var(--leading-reading);overflow-wrap:anywhere}
.saved-library-management-body>p{margin:0 0 8px}
#savedLibraryManagement{border-top:1px solid var(--rule)}
.saved-library-management-body>button{max-width:100%;white-space:normal}
.saved-library-tools{display:flex;flex:0 1 auto;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:0 0 0 auto;min-width:0;max-width:100%}
.saved-library-tools>.scoped-search{flex:0 1 18rem;width:18rem;max-width:100%;min-width:0;margin:0}
.saved-library-tools>label{display:grid;gap:4px;margin:0;min-width:0;max-width:100%}
.saved-library-tools>.select-control{align-self:center}
.saved-library-tools .select-trigger{min-height:var(--task-field-height)}
#savedReportSearchCount{margin:4px 0 0}
#savedReportSearchCount:empty{display:none}
#bundleList .list-pager{margin:8px 0;gap:8px;align-items:center}
#bundleList .list-pager:not(:has(button)){display:none}
.library-page-jump{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 0 auto;font-size:var(--type-control);line-height:var(--leading-control)}
.library-page-jump label{display:flex;align-items:center;gap:8px;margin:0;font-weight:var(--weight-regular)}
.saved-library-row{display:grid;grid-template-columns:minmax(0,1fr) 15rem 5rem;column-gap:20px;min-width:0;align-items:start;border-bottom:1px solid var(--surface-divider);padding:4px 0}
#bundleList .saved-library-row>.saved-report{min-width:0;margin:0}
#bundleList .saved-report-summary{grid-column:1 / 3;display:grid;grid-template-columns:subgrid;align-items:start;padding:12px 0;margin-inline-start:-3px;border:0;border-inline-start:3px solid transparent;text-align:left;white-space:normal;min-height:44px;height:auto;font-weight:400;border-radius:0;background:transparent;-webkit-tap-highlight-color:transparent}
.saved-report-summary::before{display:none}
#bundleList .saved-report-summary:is(:hover,:active){background:transparent}
#bundleList .saved-report-summary:active .saved-report-name{text-decoration:underline;text-underline-offset:.2em;text-decoration-thickness:2px}
#bundleList .saved-library-row[data-detail-active] .saved-report-summary{border-inline-start-color:var(--accent)}
.saved-report-summary:is(:hover,:focus-visible) .saved-report-name{text-decoration:underline;text-underline-offset:.2em;text-decoration-thickness:1px}
#bundles{container:saved-library / inline-size}
@container saved-library (max-width:40rem){
 .saved-library-row{grid-template-columns:minmax(0,1fr) auto;gap:12px}
 #bundleList .saved-report-summary{grid-column:1;grid-template-columns:minmax(0,1fr);gap:8px}
 .saved-library-row>.saved-report-no-html{max-width:7em}
}
@container saved-library (max-width:24rem){
 .saved-library-row{grid-template-columns:minmax(0,1fr);gap:0}
 .saved-library-row>button:not(.saved-report-summary){justify-self:start;margin:0 0 4px}
 .saved-library-row>.saved-report-no-html{padding:0 0 12px;max-width:none}
}
.saved-report-summary::-webkit-details-marker{display:none}
.saved-report-identity{min-width:0;overflow-wrap:anywhere}
.saved-report-name{font-size:1rem;font-weight:500;line-height:1.5}
.saved-report-formats{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}
.report-format{display:inline-block;border:1px solid var(--rule);border-radius:var(--radius-pill);padding:2px 8px;color:var(--muted);font:var(--weight-regular) var(--type-caption)/1.5 var(--font);white-space:nowrap}
.saved-file-gap{color:var(--muted);font-size:var(--type-small)}
.saved-report-manage{display:flex;align-items:center;gap:8px;padding-inline-end:3px;color:var(--accent);min-height:44px}
.saved-library-row>button:not(.saved-report-summary){min-height:44px;align-self:start;margin-block:4px}
.saved-library-row:has(>details[open])>button{align-self:start}
.saved-report-management{padding:12px 0;overflow-wrap:anywhere}
.saved-report-management>p{margin:8px 0}
.saved-report-downloads{display:flex;flex-wrap:wrap;align-items:end;gap:8px;max-width:100%}
.report-downloads.saved-report-downloads{align-items:end}
.saved-file-choice{display:grid;gap:4px;flex:0 1 auto;min-width:0;max-width:100%;margin:0}
.saved-file-choice select{width:100%;min-width:0;min-height:44px}
.saved-report-downloads>button{min-height:44px;max-width:100%;white-space:normal}
.saved-report-no-html{align-self:start;padding-top:12px;color:var(--muted);overflow-wrap:anywhere}
@media(max-width:850px){
 #bundleList .saved-report>summary{grid-template-columns:minmax(0,1fr) auto;gap:4px 12px}
 .saved-report-identity{grid-column:1}
 .saved-report-manage{grid-column:2;grid-row:1 / 3}
}
@media(max-width:500px){
 .saved-library-tools{margin-inline-start:0;width:100%}
 #bundleList .saved-report>summary{grid-template-columns:minmax(0,1fr)}
 .saved-report-manage{grid-column:1;grid-row:auto}
 .library-page-jump{margin-inline-start:0}
}
.report-downloads{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0 28px}
.report-journey [hidden]{display:none!important}
#reportCreatePanel .report-step{border-radius:0}
#reportsView .report-stage-actions .report-start,#reportsView .report-stage-actions #reportPreviewContext{display:contents}
.report-content-context{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--space-sm) var(--space-lg);margin:0 0 16px;color:var(--muted);font-size:var(--type-body)}
.report-content-context>span{min-width:0;max-width:100%;overflow-wrap:anywhere}
.report-content-context #previewSelectionSummary{margin:0;font-weight:400}
.report-content-scope{color:var(--ink)}
#reportCreatePanel .report-request-page{max-height:none;overflow:visible}
.report-entry .request-link::before{background:transparent!important;border:0!important}
.report-saved-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px;margin:16px 0}
.report-downloads{align-items:center;gap:8px;margin:12px 0 20px}
.report-download-label{font-size:var(--type-body);font-weight:600;color:var(--muted);margin-right:4px}
.report-inspection-tabs{position:sticky;top:var(--app-header-height,80px);z-index:2;display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;padding:8px 0;background:var(--paper)}
.report-inspection-choices{display:flex;flex-wrap:wrap;gap:8px 16px}
.report-inspection-tabs button{min-height:44px;white-space:normal;border:0;border-radius:0;padding:8px 4px;background:transparent}
.report-inspection-tabs [aria-selected=true]{box-shadow:inset 0 -2px var(--ink);color:var(--ink);font-weight:400}
.report-inspection-tabs [role=tab]::before{content:none}
body:has(#reportsView.report-file-stage:not([hidden]))>main{display:flex;flex-direction:column;height:calc(100dvh - var(--app-header-height,76px));padding-block:18px 20px;min-height:0}
#workspace:has(>#reportsView.report-file-stage:not([hidden])){display:flex;flex-direction:column;flex:1;min-height:0}
#workspace:has(>#reportsView.report-file-stage:not([hidden]))>#breadcrumbs{display:none}
#workspace:has(>#reportsView.report-file-stage:not([hidden])) #pageTitle{font-size:1.75rem;line-height:1.2;font-weight:600}
#reportsView.report-file-stage:not([hidden]),#reportsView.report-file-stage :is(#reportCreatePanel,#reportStage3,#reportReviewBody,#comparisonWorkspace,.comparison-review,.comparison-prepared-files):not([hidden]){display:flex;flex-direction:column;flex:1;min-height:0}
#reportsView.report-file-stage #reportFileInspection{flex:1;min-height:0}
#reportsView.report-file-stage :is(#reportCreatePanel,#comparisonWorkspace){padding:0;margin:0;border:0;background:transparent}
#reportsView.report-file-stage #reportStage3{margin-top:0}
#reportsView.report-file-stage :is(.report-progress,.report-entry-context,#reportStepTitle3,#reportDecision,.report-approval,.comparison-disclosure){display:none}
#reportsView.report-file-stage .report-inspection-tabs{position:static;flex:none;background:transparent;margin:0 0 12px;border-bottom:1px solid var(--surface-divider)}
#reportsView.report-file-stage .prepared-file-reader{flex:1;height:auto;min-height:200px}
#reportsView.report-file-stage .report-review-body>h3{display:none}
#reportsView.report-file-stage #comparisonWorkspace .prepared-file-preview>.report-frame{height:100%;min-height:0;border:0;border-radius:0}
.report-approval{margin-top:20px;padding-top:16px;border-top:1px solid var(--rule);scroll-margin-top:calc(var(--app-header-height,80px) + 140px)}
.report-approval .attestation{margin:0;max-width:72ch;line-height:var(--leading-reading)}
.report-approval>p{margin:8px 0;font-size:var(--type-body)}
.report-scope-details{border-top:0;margin-top:20px;padding-top:0}
.report-scope-details>.scoped-search{max-width:32rem}
#reportList .report-entry{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:0;border:0;border-top:1px solid var(--rule);padding:0}
#reportList .report-entry:has(>.report-selection-toggle){grid-template-columns:44px minmax(0,1fr)}
.report-selection-toggle{display:grid;place-items:start center;align-self:start;padding-top:1px;flex:none;width:44px;min-height:44px;cursor:pointer}
.report-selection-toggle>input{width:18px;height:18px;margin:0}
#reportList .report-selection-toggle{padding-top:24px}
#reportList .report-entry .request-card-open{min-width:0}
#reportList .report-entry .request-card-prompt{color:var(--ink)}
.report-entry>div{min-width:0;flex:1}
#reportList .full-text{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px}
.report-prompt-heading{display:flex;flex-wrap:wrap;align-items:center;gap:0 12px;min-height:0;grid-column:1;grid-row:1}
.report-prompt-heading .full-text-provenance{flex:1 1 12rem;min-width:0}
#reportList .full-text-actions{grid-column:2;grid-row:1 / span 2;align-self:start;display:flex;align-items:start;gap:4px;margin:0;max-width:100%}
.report-prompt-heading .full-text-preview-label[data-prompt-actor]{border:0;padding:0;color:var(--prompt-author-ink,var(--muted));font:inherit}
#reportList .full-text>:is(.full-text-preview,.full-text-body){order:1;grid-column:1;grid-row:2;min-width:0;max-width:none;margin:0;padding:2px 0 2px 12px;border-inline-start:2px solid var(--control);border-radius:0;background:var(--paper);color:var(--ink);font:var(--weight-regular) var(--type-body)/var(--leading-reading) var(--font);font-style:normal}
#reportList .full-text:has([data-prompt-actor=user])>:is(.full-text-preview,.full-text-body){border-inline-start-color:var(--screen-prompt-user)}
#reportList .full-text:has([data-prompt-actor=agent])>:is(.full-text-preview,.full-text-body){border-inline-start-color:var(--prompt-author-agent)}
#reportList .full-text>:is(.full-text-preview-state,.full-text-availability){order:2;grid-column:1;margin:0}
#reportList .full-text-body .ux-code-block{margin:0;border:0;border-radius:0;background:transparent}
#reportList .full-text-body .ux-code-toolbar{padding:0 0 8px;background:transparent}
#reportList .full-text-body .ux-code-block>pre{margin:0;padding:0;background:transparent;font:inherit}
.report-entry-meta{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:var(--type-body);line-height:var(--leading-ui);margin:8px 0 0;color:var(--muted)}
.report-entry-meta>div{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 6px;min-width:0;max-width:100%}
.report-entry-meta dt{font:inherit}
.report-entry-meta dd{margin:0;min-width:0;color:var(--ink);font:inherit;overflow-wrap:anywhere}
#reportList .interaction-summary{font-size:var(--type-body)}
.report-file-inspection,.report-copy-inspection{min-width:0}
.report-journey .prompt-comparison{border:0;padding:0;background:transparent}
.report-journey .prompt-comparison>h4{font-size:var(--type-body);margin:16px 0 8px}
.report-journey .prompt-pair{display:block;max-width:80ch}
.report-copy-versions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.report-copy-versions button[aria-pressed=true]{background:var(--hover);box-shadow:inset 0 -2px var(--ink)}
.report-journey .prompt-pair>[hidden],.report-read-copy[hidden]{display:none}
.report-copy-controls textarea{min-height:18rem;max-height:60dvh;line-height:var(--leading-reading)}
.report-read-copy{min-width:0;margin:12px 0}
.report-copy-label{margin:0 0 4px;font:inherit;color:var(--muted)}
.report-read-copy>pre{padding:0 0 0 12px;margin:0;border-inline-start:2px solid var(--rule);border-radius:0;background:transparent;font:var(--weight-regular) var(--type-body)/var(--leading-reading) var(--font);white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px}
.report-exact-text{max-height:360px;overflow:auto}
.report-read-copy>pre:focus-visible,.report-exact-text:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.report-copy-controls{min-width:0;margin:0;padding:0;border:0}
#reportsView:is([data-report-phase=saved],[data-report-phase=unavailable]) #reportStage3>.report-stage-actions{display:none}
#reportsView #comparisonWorkspace{max-width:none;min-width:0;margin:0 0 20px;padding:20px;border:1px solid var(--surface-edge);border-radius:var(--radius);background:var(--paper);container:comparison-task / inline-size}
#comparisonWorkspace [hidden]{display:none!important}
#comparisonWorkspace>.comparison-task-heading{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap}
#comparisonWorkspace>.comparison-task-heading h2{margin:0;font-size:var(--type-dialog);font-weight:400;scroll-margin-top:calc(var(--app-header-height,80px) + 16px)}
#comparisonWorkspace>.comparison-task-intro{max-width:65ch;margin:0 0 16px;color:var(--muted)}
#comparisonWorkspace .comparison-selectors{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px;margin:0}
#comparisonWorkspace .comparison-report-choice{display:grid;align-content:start;gap:4px;min-width:0}
#comparisonWorkspace .comparison-report-choice>.select-field{width:100%;max-width:100%;min-width:0}
#comparisonWorkspace .comparison-report-choice label{font-weight:400;padding-inline:0}
#comparisonWorkspace .comparison-report-choice .select-control{width:100%}
#comparisonWorkspace .comparison-report-choice .select-trigger{min-height:var(--task-field-height);border-radius:var(--radius-field)}
#comparisonWorkspace button.comparison-report-identity{justify-self:start;min-height:44px;margin:0;max-width:100%;white-space:normal;font-size:var(--type-control)}
#comparisonWorkspace>.assessment-control-actions{justify-content:space-between;align-items:center;gap:8px 16px;margin:16px 0 0}
#comparisonWorkspace>.assessment-control-actions>.primary{margin-inline-start:auto}
#comparisonWorkspace>p[role]:not([hidden]){margin-top:12px}
#comparisonWorkspace .comparison-review{margin-top:16px;min-width:0}
#comparisonWorkspace:has(.comparison-prepared-files:not([hidden])) .comparison-review{margin-top:0}
#comparisonWorkspace .comparison-copy-options{margin-top:16px;padding-top:16px;border-top:1px solid var(--rule)}
#comparisonWorkspace .comparison-copy-options>button{display:block;margin-inline-start:auto}
#comparisonWorkspace .comparison-copy-options>h3{font-size:var(--type-section);font-weight:400;margin:0 0 16px}
#comparisonWorkspace .comparison-copy-options>fieldset{display:block;padding:0;margin:0 0 12px}
#comparisonWorkspace .comparison-copy-options legend{font:inherit;margin:0 0 4px}
#comparisonWorkspace .comparison-format-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;max-width:36rem}
#comparisonWorkspace .comparison-format-choices label{min-width:0;min-height:44px;margin:0;background:transparent;font-weight:400}
#comparisonWorkspace .comparison-prepared-files{min-width:0;margin-top:0}
#comparisonWorkspace .comparison-prepared-files .report-frame{display:block;width:100%;height:75dvh;min-height:320px;margin:0;border:1px solid var(--rule);border-radius:var(--radius-small);background:#fff}
#comparisonWorkspace .report-inspection-tabs{margin-bottom:16px}
#comparisonWorkspace .comparison-inspection-actions{display:flex;flex-wrap:wrap;gap:8px 12px;min-width:0;max-width:100%}
#comparisonWorkspace .report-inspection-tabs [aria-selected=true]{font-weight:400}
#comparisonWorkspace .comparison-exact-file{border-top:1px solid var(--rule);margin:0;padding:0}
#comparisonWorkspace .comparison-exact-file>summary{min-height:44px;padding:12px 0;font:inherit;overflow-wrap:anywhere}
#comparisonWorkspace .comparison-exact-file>pre{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}
#comparisonWorkspace .comparison-disclosure{margin-top:20px;padding-top:16px;border-top:1px solid var(--rule)}
#comparisonWorkspace .comparison-disclosure>label{align-items:flex-start;min-height:44px;max-width:72ch;line-height:var(--leading-reading);padding:8px 0}
#comparisonWorkspace .comparison-disclosure>label>input{margin-top:4px;flex:none}
#comparisonWorkspace .comparison-decision-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px 12px;margin-top:8px}
#comparisonWorkspace :is(.comparison-decision-actions,.comparison-task-heading,.comparison-copy-options)>button{min-height:44px;max-width:100%;white-space:normal}
@container comparison-task (max-width:40rem){#comparisonWorkspace .comparison-selectors{grid-template-columns:minmax(0,1fr)}}
@container comparison-task (max-width:24rem){#comparisonWorkspace .comparison-format-choices{grid-template-columns:minmax(0,1fr)}}
@container report-journey (max-width:46rem){
 .report-activity-actions{position:static}
 #reportsView .report-start #reportPreviewContext{grid-template-columns:minmax(0,1fr)}
 #reportsView #reportPreviewContext>#pageHeadingActions{grid-column:1;grid-row:auto}
 .report-options{grid-template-columns:minmax(0,1fr)}
}
@container report-journey (max-width:36rem){#reportStage1 .scope-choices{grid-template-columns:minmax(0,1fr)}}
@container report-journey (max-width:32rem){.report-period-ranges{grid-template-columns:minmax(0,1fr);gap:12px}}
@container report-journey (max-width:22rem){#reportStage2 .format-choices{grid-template-columns:minmax(0,1fr)}}
@container report-journey (max-width:32rem){
 .report-progress ol{grid-template-columns:minmax(0,1fr)}
 .format-choices{grid-template-columns:minmax(0,1fr)}
 #reportList .report-entry:has(>.report-selection-toggle){grid-template-columns:44px minmax(0,1fr)}
 #reportList .report-selection-toggle{padding-top:20px}
 #reportList .full-text{display:flex;flex-direction:column}
 #reportList .full-text-provenance{flex-basis:100%;display:flex;align-items:center;min-height:44px}
 #reportList .report-entry:has(>.report-selection-toggle) .full-text-provenance{padding-inline-start:56px}
 #reportList .full-text-actions{order:3;flex-wrap:wrap;margin-inline-start:auto}
}
@container report-journey (max-width:18rem){
 .report-save-summary>div{grid-template-columns:minmax(0,1fr);gap:4px}
}
@media(max-width:700px){
 #reportsView #comparisonWorkspace{padding:16px}
 .report-journey{padding:16px}
 .report-stage>h2{font-size:var(--type-dialog)}
 .report-inspection-tabs{gap:4px}
 .report-journey .prompt-pair{grid-template-columns:minmax(0,1fr)}
 .report-stage-actions{align-items:stretch}
 .report-stage-actions>.ux-disabled-help,.report-stage-actions>button,.report-next-actions{flex:1 1 max(160px,10rem)}
 .report-stage-actions>.ux-disabled-help>button,.report-next-actions>.ux-disabled-help,.report-next-actions button{flex:1}
}
@media(max-width:700px),(max-height:600px){.report-activity-actions{position:static}}
@media(prefers-reduced-motion:reduce){.report-step{transition:none}}
.report-first{background:transparent;border:0;padding:0;max-width:none}
#reportsView #reportCreatePanel.report-first{box-shadow:none}
.report-first .report-progress[hidden],.report-first #reportStepTitle1[hidden]{display:none}
.report-first .report-stage{margin-top:0}
.report-gallery{max-width:none}
.report-gallery-heading{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-bottom:12px}
.report-gallery-heading>h2{font-size:1.2rem;font-weight:500;line-height:1.4;margin:0}
.report-gallery>h2{font-size:1.2rem;font-weight:500;margin:24px 0 16px}
.report-period-choices{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.report-period-choices>span{margin-right:8px}
.report-period-choices button{min-height:44px;white-space:normal}
.report-period-choices button[aria-pressed=true]{background:var(--accent-soft);border-color:var(--ink)}
.report-period-caption{font-size:var(--type-control);color:var(--muted);margin:10px 0 18px;line-height:1.5}
.report-tiles{display:grid;grid-template-columns:minmax(0,1fr);grid-auto-rows:1fr;gap:0}
.report-tile{position:relative;min-width:0;border:0;border-bottom:1px solid var(--surface-divider);border-radius:0;background:transparent;--tile-ink:var(--ink)}
.report-tile[data-preset=all]{--tile-ink:var(--search-context)}
.report-tile[data-preset=errors]{--tile-ink:var(--danger)}
.report-tile[data-preset=completed]{--tile-ink:var(--chart-success)}
.report-tile[data-preset=mine]{--tile-ink:var(--screen-prompt-user)}
.report-tile[data-preset=agent]{--tile-ink:var(--screen-prompt-agent)}
.report-tile-open{display:grid;grid-template-columns:20px 11rem minmax(0,1fr) 44px 16px;gap:12px;align-items:center;width:100%;height:100%;min-height:58px;padding:10px 12px;text-align:left;border:0;border-radius:0;background:transparent;white-space:normal}
.report-tile-open>svg{grid-column:1;grid-row:1;width:20px;height:20px;color:var(--tile-ink)}
.report-tile-open>strong{grid-column:2;grid-row:1;font-size:var(--type-reading);line-height:1.5;font-weight:500;color:var(--tile-ink)}
.report-tile-open>span{grid-column:3;grid-row:1;color:var(--muted);font-size:var(--type-control);line-height:1.5}
.report-tile-open>.report-tile-next{grid-column:5;width:16px;height:16px;color:var(--muted)}
.report-help{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:10px;border-color:transparent;background:transparent}
.report-help>svg{width:16px;height:16px}
.report-tile>.report-help{position:absolute;right:32px;top:50%;transform:translateY(-50%);color:var(--muted);opacity:0}
.report-tile:is(:hover,:focus-within)>.report-help{opacity:1}
.report-gallery-note{font-size:var(--type-control);color:var(--muted);margin:18px 0}
.report-explicit-selection{margin-top:16px;max-width:62rem}
.report-explicit-selection>summary{min-height:44px;align-content:center;cursor:pointer;color:var(--muted)}
.report-explicit-selection[open]>.report-scope-layout{margin-top:16px}
.report-first .report-activity-actions{position:static;background:transparent}
.report-first #reportStage2{display:none!important}
.report-edit-toolbar{margin-bottom:20px}
.report-name-row{display:flex;align-items:center;gap:24px}
.report-name-row>.report-title-field{flex:1;margin:0}
.report-first .report-title-field{gap:12px}
.report-first .report-title-field>input{min-height:48px;font-size:1.1875rem}
.report-first .report-title-field>p{display:none}
.report-save-slot{align-self:end}
.report-save-slot button{min-height:48px}
.report-toolbar-choices{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:18px}
.report-toolbar-group{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0}
.report-toolbar-group>.report-toolbar-choice{flex:1;min-width:0;text-align:left}
.report-toolbar-choice{display:inline-flex;align-items:center;gap:10px;min-height:44px;white-space:normal}
.report-toolbar-choice:last-child{margin-left:auto}
.report-options-popover{width:min(28rem,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow:auto;padding:24px;border:1px solid var(--rule);border-radius:12px;background:var(--floating-paper);color:var(--ink);box-shadow:var(--surface-shadow)}
.report-options-popover h2{font-size:1.3125rem;font-weight:500;line-height:1.35;margin:0 0 20px}
.report-options-popover :is(fieldset,.report-author-choice){margin:0 0 20px;border:0;padding:0;min-width:0}
.report-options-popover .prompt-choice{min-height:44px;padding:8px 0;background:transparent;border:0;align-items:start}
.report-options-popover .prompt-choice strong{font-weight:500}
.report-options-popover :is(.report-field,.report-author-choice){display:grid;gap:12px;margin:18px 0}
.report-options-popover :is(input:not([type=checkbox]):not([type=radio]),select,textarea){width:100%;min-width:0;min-height:44px}
.report-options-popover .prompt-choice:has(input:checked){box-shadow:none;background:var(--accent-soft)}
.report-options-popover .format-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.report-options-popover .format-choices label{padding:10px 0;border:0;background:transparent;justify-content:start;font-weight:400}
.report-options-popover .format-choices label::before{content:none}
.report-options-popover #additionalMasking{margin-top:18px}
.report-options-popover #additionalMasking>label{margin:16px 0 12px}
.report-popover-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.report-popover-actions button{min-height:44px}
.report-date-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.report-date-fields .report-field{margin:0}
.report-calendar-header{display:flex;align-items:center;justify-content:space-between;margin:18px 0 8px}
.report-calendar-header h3{margin:0;font:inherit}
.report-calendar-header button{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:8px;border:0}
.report-calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}
.report-calendar-grid>span{text-align:center;font-size:.75rem;color:var(--muted);padding-block:8px}
.report-calendar-day{min-height:44px;min-width:0;border:0;border-radius:4px;padding:8px 0}
.report-calendar-day.in-range{background:var(--accent-soft)}
.report-calendar-day[aria-pressed=true]{background:var(--accent-fill);color:var(--on-accent)}
.report-first .report-document{border:1px solid color-mix(in srgb,var(--focus) 45%,var(--rule));border-radius:8px;overflow:hidden;background:var(--paper)}
.report-first .report-frame{border:0;border-radius:0;margin:0;display:block;width:100%;min-height:0}
.report-first #reportDecision{border:0;margin:0;padding:0}
.report-first .report-optional-copies,.report-first .report-optional-files{margin-top:16px}
.report-first :is(.report-optional-copies,.report-optional-files)>summary{min-height:44px;align-content:center;cursor:pointer}
.report-first .report-approval:has(>[role=status]:empty){display:none}
.report-save-warning{width:min(32rem,calc(100vw - 32px));padding:26px;border:1px solid color-mix(in srgb,var(--danger) 45%,var(--rule));border-radius:12px;background:var(--floating-paper);color:var(--ink)}
.report-save-warning h2{display:flex;align-items:flex-start;gap:10px;font-size:1.3125rem;line-height:1.35;margin:0 0 20px}
.report-save-warning h2>span{display:inline-flex;align-items:center;height:1.35em;flex:none}
.report-save-warning h2 svg{width:22px;height:22px;color:var(--danger)}
.report-save-warning p{line-height:1.6;margin:12px 0}
.report-warning-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:24px}
.report-warning-actions button{min-height:44px;height:auto;white-space:normal;line-height:1.5;padding:10px}
.chat-details-kept{--pill-border:var(--danger);--pill-hover-border:var(--danger);color:var(--danger);border-color:var(--danger)}
.report-warning-back{grid-column:1 / -1;justify-self:start;display:inline-flex;align-items:center;gap:8px;border-color:transparent}
.report-warning-back svg{width:16px;height:16px}
.saved-report-purpose{display:block;color:var(--muted);font-size:var(--type-control);font-weight:400;margin-top:8px;line-height:1.5}
.saved-report-table{container:saved-library / inline-size;display:grid;grid-template-columns:minmax(0,1fr) fit-content(18rem) max-content;column-gap:20px}
#reportsView.report-workspace-landing .report-first{margin-bottom:30px}
#reportsView #savedReportsPanel #bundles{padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}
.saved-report-rows{display:grid;grid-template-columns:subgrid;grid-column:1 / -1}
#reportsView .saved-library-row,.saved-library-columns{display:grid;grid-template-columns:subgrid;grid-column:1 / -1;align-items:center}
.saved-library-columns{min-height:36px;font-size:var(--type-caption);color:var(--muted)}
.saved-library-columns>:first-child{padding-left:8px}
#reportsView .saved-library-row{padding:6px 0;min-height:56px}
.saved-report-identity{display:flex;align-items:center;gap:8px;min-width:0}
.saved-report-title{display:flex;align-items:start;gap:12px;min-width:0;min-height:44px;padding:4px 8px;border:0;border-radius:var(--radius-small);background:transparent;text-align:left;white-space:normal;font-weight:500}
.saved-report-caption{display:flex;flex-direction:column;gap:2px;min-width:0}
.saved-report-prepared,.saved-report-period{display:block;color:var(--muted);font-size:var(--type-control);font-weight:400;line-height:1.5;overflow-wrap:anywhere}
.saved-period-availability{color:var(--muted);font-size:var(--type-control);line-height:1.5;margin:0 0 12px}
.saved-report-title>.wire-icon{flex:none;width:1.125rem;height:1.125rem;margin-top:.1875rem;color:var(--muted)}
.saved-report-title:is(:hover,:focus-visible):not(:disabled){background:var(--hover);color:var(--ink);text-decoration:none}
.saved-report-title:active:not(:disabled){background:var(--control)}
.saved-report-privacy{display:flex;align-items:start;gap:8px;min-width:0;color:var(--muted);font-size:var(--type-control);font-weight:400;line-height:1.5}
.saved-report-privacy>.wire-icon{flex:none;width:1rem;height:1rem;margin-top:.15em}
.saved-report-files{display:inline-flex;align-items:center;justify-content:center;gap:8px}
.saved-report-files>.wire-icon{width:18px;height:18px;flex:none}
#reportsView .saved-library-row>button{margin:0;align-self:center}
.saved-report-actions{display:flex;flex-wrap:wrap;gap:4px;min-width:0;justify-content:flex-end}
.saved-report-actions>button{white-space:nowrap}
.saved-report-actions>.danger{--pill-border:transparent;--pill-hover-border:transparent;--pill-fill:transparent}
.saved-report-menu{position:fixed;inset:auto;margin:0;min-width:180px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;padding:6px;border:1px solid var(--rule);border-radius:8px;background:var(--floating-paper);color:var(--ink);box-shadow:var(--surface-shadow)}
#reportsView .saved-report-menu>button{display:block;width:100%;min-height:44px;padding:10px 12px;border:0;background:transparent;text-align:left;white-space:normal}
#reportsView .saved-report-menu>button::before{display:none}
#reportsView .saved-report-menu>button:hover{background:var(--hover)}
#reportActivityOptions{width:min(60rem,calc(100vw - 32px))}
.report-reading-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 16px;border:1px solid var(--rule);border-bottom:0;border-radius:8px 8px 0 0;background:var(--paper)}
.report-reading-toolbar>label{display:flex;align-items:center;gap:8px;margin:0}
#reportsView .report-reading-toolbar>.select-field{flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px}
#reportsView .report-reading-toolbar>.select-field>label{padding:0}
.report-reading-toolbar .select-control{min-width:9rem}
.report-copy-inspection.document-reading-pane{padding:16px 24px;overflow:auto;overscroll-behavior:contain}
.report-copy-inspection[hidden]{display:none}
.report-copy-inspection .report-read-copy>pre{max-height:none}
.report-document:has(.report-reading-toolbar)>.report-frame{border-radius:0 0 8px 8px}
.prepared-file-reader.prepared-file-reader-single{grid-template-columns:minmax(0,1fr)}
#reportActivityOptions .scope-choices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
#reportActivityOptions .report-activity-actions{position:static;background:transparent}
#reportActivityOptions .report-scope-layout{margin-bottom:16px}
@media(hover:none){.report-tile>.report-help{opacity:1}}
@container saved-library (max-width:52rem){
 .saved-report-table{grid-template-columns:minmax(0,1fr)}
 .saved-library-columns{display:none}
 #reportsView .saved-library-row{grid-template-columns:minmax(0,1fr);gap:8px;padding-block:12px}
 .saved-report-identity{grid-column:1;grid-row:1}
 .saved-report-privacy{grid-column:1;grid-row:2;padding-left:8px}
 .saved-report-actions{grid-column:1;grid-row:3;justify-content:flex-start}
}
@media(max-width:900px){.report-tile-open{grid-template-columns:20px 9rem minmax(0,1fr) 44px 16px}.saved-library-tools{width:100%;margin-left:0}}
@media(max-width:700px){
 .report-first{padding:0}.report-name-row{flex-wrap:wrap;gap:16px}.report-name-row>.report-title-field{flex-basis:100%}.report-save-slot{margin-left:auto}.report-toolbar-choice:last-child{margin-left:0}.report-options-popover{padding:20px}.report-save-warning{padding:20px}
 .report-tile-open{grid-template-columns:20px minmax(0,1fr) 44px 16px;grid-template-rows:auto auto;gap:2px 12px;padding:12px 6px}
 .report-tile-open>span{grid-column:2;grid-row:2}.report-tile-open>.report-tile-next{grid-column:4;grid-row:1 / 3}
 .report-tile>.report-help{right:22px}
 #reportActivityOptions .scope-choices{grid-template-columns:1fr;gap:8px}
}
`;
