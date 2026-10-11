export const promptAuthorStyles = `
:root {--prompt-author-user:#19676b}
@media(prefers-color-scheme:dark) {:root:not([data-evidence-theme]) {--prompt-author-user:#8bcbd0}}
:root[data-evidence-theme=dark] {--prompt-author-user:#8bcbd0}
[data-prompt-actor=user] {--prompt-author-ink:var(--prompt-author-user)}
[data-prompt-actor=agent] {--prompt-author-ink:var(--copilot-chat-title)}
[data-prompt-actor=unknown] {--prompt-author-ink:var(--muted)}
[data-prompt-actor] {color:var(--prompt-author-ink)}
.full-text-preview-label[data-prompt-actor] {border-inline-start:3px solid currentColor;padding-inline-start:6px;font-weight:var(--weight-medium,500)}
.prompt-author-filter {display:flex;flex-direction:column;gap:6px;min-width:0;flex:0 1 260px}
.prompt-author-filter>.help-heading {align-self:start}
.prompt-author-filter .local-filter-row {min-width:0}
.prompt-author-filter .select-control {flex:1;min-width:0}
.report-author-choice {display:grid;grid-template-columns:minmax(0,1fr);gap:8px;margin-top:16px;max-width:72ch}
.report-author-choice>.select-control {width:min(100%,320px)}
.report-author-choice>label {font-weight:var(--weight-medium)}
@media(max-width:600px) {.prompt-author-filter {flex:1 1 100%;width:100%}}
`;
