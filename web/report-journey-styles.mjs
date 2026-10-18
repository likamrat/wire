export const reportJourneyStyles = `
#workspace:has(>#reportsView:not([hidden])){--report-content-width:74rem}
#workspace:has(>#reportsView:not([hidden]) #reportCreatePanel:not([hidden]) #reportStage3:not([hidden]) #reportReviewBody:not([hidden])),
#workspace:has(>#reportsView:not([hidden]) #comparisonWorkspace:not([hidden]) .comparison-prepared-files:not([hidden])),
#workspace:has(>#reportsView:not([hidden]) #savedReportReader:not([hidden]) :is(.report-frame,.saved-reader-text)){--report-content-width:86.5rem}
#workspace:has(>#reportsView:not([hidden]))>:is(.page-heading,#reportsView,#coverage){width:100%;max-width:var(--report-content-width)}
.report-task-nav{display:flex;flex-wrap:wrap;gap:8px;margin:0;max-width:100%}
.report-task-nav[hidden]{display:none!important}
.report-task-nav>a{min-height:44px;align-content:center;white-space:normal}
.report-task-nav>a[aria-current=page]{--pill-fill:var(--accent-soft);--pill-border:var(--accent);color:var(--accent);font-weight:var(--weight-strong)}
#reportCreatePanel[hidden],#savedReportsPanel[hidden]{display:none!important}
#reportsView #savedReportsPanel #bundles{margin-top:0;padding:20px 24px;border:1px solid transparent;border-radius:var(--radius-small);background:var(--paper)}
#savedReportReader{display:flex;flex-wrap:wrap;align-items:end;gap:12px 24px;min-width:0;width:100%;padding-bottom:16px}
#savedReportReader[hidden]{display:none!important}
.saved-reader-heading{display:flex;flex:1 1 16rem;flex-wrap:wrap;align-items:center;gap:8px 16px;min-width:0}
.saved-reader-heading>button{display:inline-flex;align-items:center;gap:8px}
.saved-reader-heading h2{margin:0;font-size:var(--type-dialog);font-weight:400;min-width:0;text-wrap:balance}
.saved-reader-body{flex-basis:100%;min-width:0}
.saved-reader-body>.report-frame{display:block;width:100%;height:75dvh;min-height:320px;margin:12px 0 0;border:0;border-radius:var(--radius-small);background:#fff}
.saved-reader-text{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;margin:16px 0}
.saved-reader-actions:empty{display:none}
.saved-reader-actions{min-width:0;max-width:100%}
.saved-reader-issue{flex-basis:100%;max-width:65ch;line-height:var(--leading-reading)}
.original-file-controls{display:flex;flex-wrap:wrap;align-items:end;gap:12px;margin:12px 0 16px}
.original-file-choice{display:grid;gap:4px;min-width:0}
.original-file-choice>label{font-weight:400}
.original-file-controls>button{min-height:44px;max-width:100%;white-space:normal}
.saved-inspector-facts{display:grid;gap:6px;margin:0 0 16px}
.saved-inspector-facts>div{display:grid;grid-template-columns:7rem minmax(0,1fr);gap:4px 12px}
.saved-inspector-facts :is(dt,dd){margin:0;font:inherit;overflow-wrap:anywhere}
.saved-inspector-facts dt{color:var(--muted)}
.saved-report-inspection h3{font-size:var(--type-body);font-weight:400;margin:0 0 8px}
.saved-report-inspection>button{display:block;margin-top:16px;white-space:normal}
.saved-inspector-files{margin:24px 0}
.saved-inspector-title{font-size:var(--type-section);line-height:var(--leading-section);font-weight:var(--weight-regular);margin:0 0 20px}
#contextSidebar:has(.saved-report-inspection) .context-sidebar-header{justify-content:flex-end}
.saved-inspector-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px 12px}
.saved-inspector-actions button{min-height:44px;white-space:normal}
@container (max-width:24rem){.saved-inspector-facts>div{grid-template-columns:minmax(0,1fr)}}
.saved-reader-caption{margin:0;color:var(--muted);font-size:var(--type-body)}
.saved-library-heading{display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px;margin-bottom:8px}
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
#savedReportSearchCount{margin:4px 0 0}
#savedReportSearchCount:empty{display:none}
#bundleList .list-pager{margin:8px 0;gap:8px;align-items:center}
#bundleList .list-pager:not(:has(button)){display:none}
.library-page-jump{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 0 auto}
.library-page-jump label{display:flex;align-items:center;gap:8px;margin:0;font-weight:var(--weight-regular)}
.library-page-jump input{width:5.5rem;min-height:44px;min-width:0;padding:8px}
.saved-library-row{display:grid;grid-template-columns:minmax(0,1fr) 16rem 6rem;column-gap:20px;min-width:0;align-items:start;border-bottom:1px solid var(--surface-divider);padding:4px 0}
#bundleList .saved-library-row>.saved-report{min-width:0;margin:0}
#bundleList .saved-report-summary{grid-column:1 / 3;display:grid;grid-template-columns:subgrid;align-items:start;padding:12px 0 12px 12px;border:0;border-inline-start:3px solid transparent;text-align:left;white-space:normal;min-height:44px;height:auto;font-weight:400;border-radius:0;background:transparent;-webkit-tap-highlight-color:transparent}
.saved-report-summary::before{display:none}
#bundleList .saved-report-summary:hover{background:var(--hover)}
#bundleList .saved-report-summary:active{background:var(--pill-pressed)}
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
 .saved-library-row>button:not(.saved-report-summary){justify-self:start;margin:0 0 4px 15px}
 .saved-library-row>.saved-report-no-html{padding:0 0 12px 15px;max-width:none}
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
.report-content-context{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;margin:0 0 16px;color:var(--muted);font-size:var(--type-body)}
.report-content-context #previewSelectionSummary{margin:0;font-weight:400}
.report-content-scope::after{content:" ·"}
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
.report-approval{margin-top:20px;padding-top:16px;border-top:1px solid var(--rule);scroll-margin-top:calc(var(--app-header-height,80px) + 140px)}
.report-approval .attestation{margin:0;max-width:72ch;line-height:var(--leading-reading)}
.report-approval>p{margin:8px 0;font-size:var(--type-body)}
.report-scope-details{border-top:0;margin-top:20px;padding-top:0}
.report-scope-details>.scoped-search{max-width:32rem}
#reportList .report-entry{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:8px 12px;border:0;border-top:1px solid var(--rule);padding:12px 0}
#reportList .report-entry:has(>.report-selection-toggle){grid-template-columns:44px minmax(0,1fr)}
.report-selection-toggle{display:grid;place-items:start center;align-self:start;padding-top:1px;flex:none;width:44px;min-height:44px;cursor:pointer}
.report-selection-toggle>input{width:18px;height:18px;margin:0}
.report-entry>div{min-width:0;flex:1}
#reportList .full-text{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px}
.report-prompt-heading{display:flex;flex-wrap:wrap;align-items:center;gap:0 12px;min-height:0;grid-column:1;grid-row:1}
.report-prompt-heading .full-text-provenance{flex:1 1 12rem;min-width:0}
#reportList .full-text-actions{grid-column:2;grid-row:1 / span 2;align-self:start;display:flex;align-items:start;gap:4px;margin:0;max-width:100%}
.report-prompt-heading .full-text-preview-label[data-prompt-actor]{border:0;padding:0;color:var(--prompt-author-ink,var(--muted));font:inherit}
#reportList .full-text>:is(.full-text-preview,.full-text-body){order:1;grid-column:1;grid-row:2;min-width:0;max-width:none;margin:0;padding:2px 0 2px 12px;border-inline-start:2px solid var(--control);border-radius:0;background:var(--paper);color:var(--ink);font:var(--weight-regular) var(--type-body)/var(--leading-reading) var(--font);font-style:normal}
#reportList .full-text:has([data-prompt-actor=user])>:is(.full-text-preview,.full-text-body){border-inline-start-color:var(--screen-prompt-user)}
#reportList .full-text:has([data-prompt-actor=agent])>:is(.full-text-preview,.full-text-body){border-inline-start-color:var(--copilot-chat-title)}
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
.report-read-copy{min-width:0;margin:12px 0}
.report-copy-label{margin:0 0 4px;font:inherit;color:var(--muted)}
.report-read-copy>pre{padding:0 0 0 12px;margin:0;border-inline-start:2px solid var(--rule);border-radius:0;background:transparent;font:var(--weight-regular) var(--type-body)/var(--leading-reading) var(--font);white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px}
.report-exact-text{max-height:360px;overflow:auto}
.report-read-copy>pre:focus-visible,.report-exact-text:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.report-copy-controls{min-width:0;margin:0;padding:0;border:0}
#reportsView:is([data-report-phase=saved],[data-report-phase=unavailable]) #reportStage3>.report-stage-actions{display:none}
#reportsView #comparisonWorkspace{max-width:none;min-width:0;margin:0 0 20px;padding:20px 24px;border:0;border-radius:var(--radius-small);background:var(--paper);container:comparison-task / inline-size}
#comparisonWorkspace [hidden]{display:none!important}
#comparisonWorkspace>.comparison-task-heading{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap}
#comparisonWorkspace>.comparison-task-heading h2{margin:0;font-size:var(--type-dialog);font-weight:400;scroll-margin-top:calc(var(--app-header-height,80px) + 16px)}
#comparisonWorkspace>.comparison-task-intro{max-width:65ch;margin:8px 0 16px;color:var(--muted)}
#comparisonWorkspace .comparison-selectors{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px;margin:16px 0}
#comparisonWorkspace .comparison-report-choice{display:grid;align-content:start;justify-items:start;gap:4px;min-width:0}
#comparisonWorkspace .comparison-report-choice>.select-field{max-width:100%;min-width:0}
#comparisonWorkspace .comparison-report-choice label{font-weight:400}
#comparisonWorkspace button.comparison-report-identity{min-height:44px;margin:0;max-width:100%;white-space:normal;font-size:var(--type-control)}
#comparisonWorkspace .comparison-review{margin-top:16px;min-width:0}
#comparisonWorkspace:has(.comparison-prepared-files:not([hidden])) .comparison-review{margin-top:0}
#comparisonWorkspace .comparison-copy-options{margin-top:16px;padding-top:16px;border-top:1px solid var(--rule)}
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
#comparisonWorkspace .comparison-decision-actions{display:flex;flex-wrap:wrap;gap:8px 12px;margin-top:8px}
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
 #reportList .report-entry:has(>.report-selection-toggle){position:relative;grid-template-columns:minmax(0,1fr)}
 #reportList .report-selection-toggle{position:absolute;inset-block-start:12px;inset-inline-start:0}
 #reportList .report-selection-toggle{place-items:center;padding-top:0}
 #reportList .full-text{display:flex;flex-direction:column}
 #reportList .full-text-provenance{flex-basis:100%;display:flex;align-items:center;min-height:44px}
 #reportList .report-entry:has(>.report-selection-toggle) .full-text-provenance{padding-inline-start:56px}
 #reportList .full-text-actions{order:3;flex-wrap:wrap;margin-inline-start:auto}
}
@container report-journey (max-width:18rem){
 .report-save-summary>div{grid-template-columns:minmax(0,1fr);gap:4px}
}
@media(max-width:700px){
 #reportsView #savedReportsPanel #bundles,#reportsView #comparisonWorkspace{padding:16px}
 .report-journey{padding:16px}
 .report-stage>h2{font-size:var(--type-dialog)}
 .report-inspection-tabs{gap:4px}
 .report-journey .prompt-pair{grid-template-columns:minmax(0,1fr)}
 .report-stage-actions{align-items:stretch}
 .report-stage-actions>.ux-disabled-help,.report-stage-actions>button,.report-next-actions{flex:1 1 160px}
 .report-stage-actions>.ux-disabled-help>button,.report-next-actions>.ux-disabled-help,.report-next-actions button{flex:1}
}
@media(max-width:700px),(max-height:600px){.report-activity-actions{position:static}}
@media(prefers-reduced-motion:reduce){.report-step{transition:none}}
`;
