// Documentation page styles. WIRE screen tokens only; the docs area sizes its own columns with container queries.
export const documentationStyles = `
.documentation-navigation{margin:0 0 var(--space-sm);padding-bottom:var(--space-sm);border-bottom:1px solid var(--surface-divider)}
.app-sidebar .documentation-navigation a{grid-template-columns:max(24px,1.5rem) minmax(0,1fr)}
.documentation-navigation .navigation-label{text-overflow:ellipsis}
:root:has(#documentationView:not([hidden])) .page-heading{display:none}
.wire-docs{container:docs/inline-size;--docs-rule:color-mix(in srgb,var(--surface-divider) 55%,var(--paper));--docs-sticky:calc(var(--app-header-height,77px) + var(--space-md));color:var(--ink);padding-bottom:var(--space-3xl)}
.wire-docs .docs-icon{display:inline-flex;inline-size:1.1em;block-size:1.1em;flex:none;vertical-align:-.18em}
.wire-docs .docs-icon svg,.wire-docs .docs-icon .wire-icon{inline-size:100%;block-size:100%}
.wire-docs .docs-quiet{color:var(--muted)}

.docs-grid{display:grid;grid-template-columns:248px minmax(0,1fr) 236px;gap:var(--space-lg);align-items:start;max-inline-size:1560px}
.docs-center{min-width:0}
.docs-paper{min-width:0;background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius);padding:var(--space-xl) clamp(16px,4cqi,48px) var(--space-2xl)}
.docs-left,.docs-right{position:sticky;top:var(--docs-sticky);max-block-size:calc(100dvh - var(--docs-sticky) - 16px);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:2px 2px 16px}
.docs-left-toggle>summary,.docs-outline-inline{display:none}
.docs-left-toggle>summary,.docs-outline-inline>summary{align-items:center;gap:var(--pill-gap);cursor:pointer;padding:6px 12px;font-weight:var(--weight-medium);min-block-size:44px;list-style:none;border-radius:var(--radius-small)}
.docs-left-toggle>summary::-webkit-details-marker,.docs-outline-inline>summary::-webkit-details-marker{display:none}
.docs-left-toggle>summary .docs-icon:last-child,.docs-outline-inline>summary .docs-icon:last-child{margin-inline-start:auto}
.docs-left-toggle[open]>summary .docs-icon:last-child,.docs-outline-inline[open]>summary .docs-icon:last-child{transform:rotate(180deg)}
.docs-left-toggle>summary:hover,.docs-outline-inline>summary:hover{background:var(--hover)}

.docs-tree-group>h2,.docs-outline>h2{font-size:var(--type-section);line-height:var(--leading-section);font-weight:var(--weight-strong);color:var(--ink);margin:0 0 var(--space-xs);padding:0 10px}
.docs-tree-group+.docs-tree-group{margin-top:var(--space-md);padding-top:var(--space-md);border-top:1px solid var(--docs-rule)}
.docs-tree ul,.docs-outline ul{list-style:none;margin:0;padding:0}
.docs-tree a,.docs-outline a{display:flex;align-items:center;gap:8px;min-block-size:30px;padding:5px 10px;border-radius:var(--radius-small);color:var(--muted);text-decoration:none;font-size:var(--type-small);line-height:1.35}
.docs-tree a:hover,.docs-outline a:hover{color:var(--ink);background:var(--hover)}
.docs-tree a:focus-visible,.docs-outline a:focus-visible,.docs-left-toggle>summary:focus-visible,.docs-outline-inline>summary:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.docs-tree a.docs-tree-guide{color:var(--ink);font-weight:var(--weight-medium)}
.docs-tree-guide[aria-current=page]{box-shadow:inset 2px 0 0 var(--ink);border-radius:0 var(--radius-small) var(--radius-small) 0;font-weight:var(--weight-medium)}
.docs-tree-guide>span:first-child{min-width:0}
.docs-tree-sections,.docs-outline-nested{margin:2px 0 6px 14px!important;border-inline-start:1px solid var(--docs-rule)}
.docs-tree-sections>li,.docs-outline-nested>li{margin-inline-start:-1px;border-inline-start:1px solid transparent}
.docs-tree-sections>li:has(>a[aria-current=location]),.docs-outline-nested>li:has(>a[aria-current=location]){border-inline-start-color:var(--ink)}
.docs-tree-sections a,.docs-outline-nested a{border-radius:0 var(--radius-small) var(--radius-small) 0;padding-inline-start:12px}
.docs-tree a[aria-current=location],.docs-outline a[aria-current=location]{color:var(--ink);font-weight:var(--weight-medium)}
.docs-outline>.docs-outline-list>li>a[aria-current=location],.docs-outline>.docs-outline-list>li:has(a[aria-current=location])>a{color:var(--ink);box-shadow:inset 2px 0 0 var(--ink);border-radius:0 var(--radius-small) var(--radius-small) 0}
.docs-badge{flex:none;margin-inline-start:auto;font-size:11px;line-height:1;font-weight:var(--weight-medium);padding:3px 6px;border-radius:var(--radius-pill);border:1px solid currentColor;color:var(--muted)}
.docs-badge-new{color:var(--accent)}

.docs-source{display:grid;justify-items:start;gap:8px;margin:0 0 var(--space-lg);font-size:var(--type-caption);color:var(--muted);line-height:1.5}
.docs-source>p{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:0}
.docs-sep{opacity:.6}
.docs-commit{display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);font-size:.95em;border-radius:var(--radius-small);padding:1px 6px;background:color-mix(in srgb,var(--ink) 6%,transparent)}
.docs-source-warning{display:inline-flex;align-items:center;gap:6px;color:var(--ink)}
.docs-source-warning .docs-icon{color:var(--warning)}
.docs-source-local{color:var(--ink);font-weight:var(--weight-medium)}
.docs-text-button,.docs-asset-link{display:inline-flex;align-items:center;gap:var(--pill-gap)}
.docs-source-switch{display:flex;flex-wrap:wrap;gap:var(--pill-gap)}

.docs-article{font-size:var(--type-reading);line-height:var(--leading-reading);max-inline-size:76ch;overflow-wrap:anywhere}
.docs-article>:first-child{margin-top:0}
.docs-article h1{font-size:var(--type-title);line-height:var(--leading-heading);font-weight:var(--weight-strong);margin:0 0 var(--space-md)}
.docs-article :is(h2,h3,h4,h5,h6){position:relative;scroll-margin-top:8px;line-height:var(--leading-section)}
.docs-article h2{font-size:var(--type-section);font-weight:var(--weight-strong);margin:2.2em 0 .6em;padding-top:.8em;border-top:1px solid var(--docs-rule)}
.docs-article h3{font-size:1.0625em;font-weight:var(--weight-strong);margin:1.8em 0 .5em}
.docs-article :is(h4,h5,h6){font-size:1em;font-weight:var(--weight-medium);margin:1.5em 0 .4em}
.docs-article h6,.docs-article del{color:var(--muted)}
.docs-article :is(p,ul,ol,dl,blockquote,picture,.doc-table,.doc-code,.doc-alert,.doc-image-note){margin:0 0 1em}
.docs-article :is(ul,ol){padding-inline-start:1.5em}
.docs-article li+li{margin-top:.3em}
.docs-article li>:is(ul,ol){margin:.3em 0 0}
.docs-article .doc-task{list-style:none;margin-inline-start:-1.4em}
.docs-article .doc-task input{margin:0 .5em 0 0;vertical-align:-.1em}
.docs-article a{color:var(--accent);text-underline-offset:2px}
.docs-article a:hover{text-decoration-thickness:2px}
.docs-article :focus-visible:not(h1,h2,h3,h4,h5,h6){outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}
.docs-article code{font-family:var(--mono);font-size:.9em;font-weight:400;background:color-mix(in srgb,var(--ink) 7%,transparent);padding:.1em .35em;border-radius:5px}
.docs-article kbd{font-family:var(--mono);font-size:.85em;border:1px solid var(--surface-edge);border-bottom-width:2px;border-radius:5px;padding:0 .35em}
.docs-article hr{border:0;border-top:1px solid var(--docs-rule);margin:2em 0}
.docs-article img{max-inline-size:100%;block-size:auto;border-radius:var(--radius-small)}
.docs-image-frame{position:relative;display:inline-block;max-inline-size:100%;vertical-align:middle}
.docs-image-frame :is(picture,img){display:block;margin:0}
.docs-image-frame img{border:1px solid var(--docs-rule)}
.docs-image-expandable img{cursor:zoom-in}
.docs-image-frame .docs-image-open{position:absolute;inset-block-start:4px;inset-inline-end:4px;background:var(--paper);color:var(--ink);border:1px solid var(--surface-edge)}
.docs-image-frame .docs-image-open:hover{background:var(--pill-hover)}
@media(hover:hover) and (pointer:fine){.docs-image-open{opacity:0}.docs-image-frame:is(:hover,:focus-within) .docs-image-open{opacity:1}}
.docs-image-dialog:modal{display:grid;grid-template-rows:auto minmax(0,1fr);width:calc(100% - 24px);height:calc(100dvh - 24px);max-width:none;overscroll-behavior:contain;overflow:hidden}
.docs-image-dialog::backdrop{overflow:hidden;overscroll-behavior:contain}
.docs-image-dialog .dialog-head{gap:var(--space-sm);padding:var(--space-sm) var(--space-md)}
.wire-docs :is(.dialog-head .icon-only,.docs-image-open)>.docs-icon{inline-size:var(--icon-utility-size);block-size:var(--icon-utility-size)}
.docs-image-dialog h2{margin-inline-end:auto}
.docs-image-stage{display:grid;overflow:auto;overscroll-behavior:contain;padding:var(--space-sm)}
.docs-image-stage img{display:block;place-self:center;width:100%;height:100%;min-width:0;min-height:0;object-fit:contain}
.docs-image-stage[data-actual-size]{display:block}
.docs-image-stage[data-actual-size] img{width:auto;height:auto;max-width:none;max-height:none;margin:auto}
.docs-article blockquote{color:var(--muted);border-inline-start:2px solid var(--surface-divider);padding:0 0 0 1em;margin-inline:0}
.docs-article details{border:1px solid var(--docs-rule);border-radius:var(--radius-small);padding:.5em .9em;margin:0 0 1em}
.docs-article summary{cursor:pointer;font-weight:var(--weight-medium)}
.docs-article .docs-inline-contents{display:none}
:root:not([data-evidence-theme=light]) .docs-article .doc-theme-light-only,:root[data-evidence-theme=light] .docs-article .doc-theme-dark-only{display:none!important}
.docs-article .doc-external .docs-icon{inline-size:.85em;block-size:.85em;margin-inline-start:.2em;opacity:.75}
.docs-article .doc-missing-link{text-decoration:underline wavy color-mix(in srgb,var(--warning) 70%,transparent);text-underline-offset:3px;cursor:help}

.docs-article .doc-permalink{display:inline-grid;place-items:center;inline-size:1.6em;block-size:1.6em;margin-inline-start:.3em;vertical-align:middle;color:var(--muted);border-radius:6px;opacity:0;transition:opacity .15s,background-color .15s}
.docs-article .doc-permalink .docs-icon{inline-size:.8em;block-size:.8em}
.docs-article :is(h2,h3,h4,h5,h6):hover .doc-permalink,.docs-article .doc-permalink:focus-visible{opacity:1}
.docs-article .doc-permalink:hover{background:var(--hover);color:var(--ink)}
@media (hover:none){.docs-article .doc-permalink{opacity:.55}}

.docs-article .doc-table{overflow-x:auto;max-inline-size:100%;border:1px solid var(--docs-rule);border-radius:var(--radius-small)}
.docs-article .doc-table table{border-collapse:collapse;table-layout:auto;inline-size:100%;font-size:.9375em;line-height:1.5}
.docs-article .doc-table :is(th,td){text-align:start;vertical-align:top;padding:.6em .85em;border-bottom:1px solid var(--docs-rule);min-inline-size:8ch;max-inline-size:48ch;overflow-wrap:normal;word-break:normal}
.docs-article .doc-table th{font-weight:var(--weight-medium);color:var(--muted);background:color-mix(in srgb,var(--ink) 3%,var(--paper))}
.docs-article .doc-table td code{white-space:nowrap}
.docs-article .doc-table tr:last-child td{border-bottom:0}
.docs-article .doc-table [align=center]{text-align:center}
.docs-article .doc-table [align=right]{text-align:end}

.docs-article .doc-code{position:relative}
.docs-article .doc-code pre{margin:0;overflow-x:auto;padding:1em 3.2em 1em 1em;border-radius:var(--radius-small);background:color-mix(in srgb,var(--ink) 5%,var(--paper));border:1px solid var(--docs-rule);font-family:var(--mono);font-size:.875em;font-weight:400;line-height:1.55;tab-size:4}
.docs-article .doc-code pre code{background:none;padding:0;font-size:1em}
.docs-article .doc-code-label{margin:0 0 .4em;font-size:var(--type-caption);color:var(--muted)}
#documentationView button.doc-copy{position:absolute;inset:4px 4px auto auto;background:var(--paper)}
#documentationView .doc-code-drawn button.doc-copy{inset-block-start:calc(1.5em + 8px)}
#documentationView button.doc-copy:hover{color:var(--ink);background:var(--hover)}
#documentationView button.doc-copy:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
#documentationView button.doc-copy .docs-icon{inline-size:16px;block-size:16px}
@media (hover:hover) and (pointer:fine){#documentationView button.doc-copy{opacity:0;transition:opacity .12s}#documentationView .doc-code:is(:hover,:focus-within) button.doc-copy{opacity:1}}

.docs-article .doc-alert{border:1px solid var(--docs-rule);border-radius:var(--radius-small);padding:.75em 1em;background:color-mix(in srgb,var(--alert) 6%,var(--paper))}
.docs-article .doc-alert>:last-child{margin-bottom:0}
.docs-article .doc-alert-title{display:flex;align-items:center;gap:.45em;font-weight:var(--weight-medium);color:var(--alert);margin:0 0 .35em}
.doc-alert-note,.doc-alert-important{--alert:var(--accent)}
.doc-alert-tip{--alert:var(--success)}
.doc-alert-warning{--alert:var(--warning)}
.doc-alert-caution{--alert:var(--danger)}
.docs-article .doc-image-note{display:flex;gap:.6em;align-items:flex-start;padding:.75em 1em;border:1px dashed var(--docs-rule);border-radius:var(--radius-small);font-size:.9375em}
.docs-article .doc-image-note>.docs-icon{color:var(--muted);margin-top:.15em}

.docs-article .doc-footnote-ref,.docs-article .doc-footnote-back{text-decoration:none;padding:0 .15em}
.docs-article .doc-footnotes{margin-top:2.5em;padding-top:1em;border-top:1px solid var(--docs-rule);font-size:.9375em;color:var(--muted)}
.docs-article .doc-footnotes :target{background:color-mix(in srgb,var(--accent) 12%,transparent);border-radius:4px}

.docs-article-footer{max-inline-size:76ch;margin-top:var(--space-2xl);padding-top:var(--space-lg);border-top:1px solid var(--docs-rule);font-size:var(--type-small)}
.docs-article-footer>p{margin:0}
.docs-article-footer .navigation-action{display:inline-flex;align-items:center;gap:var(--pill-gap);min-height:var(--pill-height);max-width:100%;color:var(--ink);font:var(--weight-medium) var(--type-control)/var(--leading-control) var(--font);text-decoration:none;overflow-wrap:anywhere}
.docs-article-footer .navigation-action .docs-icon{inline-size:var(--icon-size-small);block-size:var(--icon-size-small)}
@media(forced-colors:active){.wire-docs .navigation-action:focus-visible::before{outline-color:Highlight}}
.docs-pager{display:flex;flex-wrap:wrap;gap:var(--pill-gap);margin-top:var(--space-sm)}
.docs-pager [rel=next]{margin-inline-start:auto}
.docs-error{max-inline-size:720px}
.docs-error h1{font-size:var(--type-title);margin-top:0}

@container docs (max-width:1260px) and (min-width:1081px){.docs-grid{grid-template-columns:220px minmax(0,1fr) 208px;gap:20px}}
@container docs (max-width:1080px){.docs-grid{grid-template-columns:220px minmax(0,1fr)}.docs-right{display:none}.docs-outline-inline{display:block;margin:0 0 var(--space-lg);border:1px solid var(--docs-rule);border-radius:var(--radius-small);padding:6px}.docs-outline-inline>summary{display:flex}.docs-outline-inline .docs-outline{padding-top:4px}}
@container docs (max-width:880px){
.docs-grid{grid-template-columns:minmax(0,1fr);gap:var(--space-md)}
.docs-left{position:static;max-block-size:none;overflow:visible;padding:0}
.docs-left-toggle{border:1px solid var(--docs-rule);border-radius:var(--radius-small);background:var(--paper);padding:6px}
.docs-left-toggle>summary{display:flex}
.docs-left-toggle .docs-tree{padding-top:6px}}
@container docs (max-width:700px){.docs-paper{padding:20px 16px 32px;border-radius:var(--radius-small)}}
@container docs (max-width:480px){.docs-paper{padding:16px 14px 28px}}
@media (pointer:coarse){.docs-tree a,.docs-outline a,.docs-left-toggle>summary,.docs-outline-inline>summary,#documentationView .docs-source-switch button{min-block-size:44px}#documentationView button.doc-copy{inline-size:44px;block-size:44px}}

@media (prefers-reduced-motion:reduce){
.docs-article .doc-permalink,#documentationView button.doc-copy{transition:none}}
`;
