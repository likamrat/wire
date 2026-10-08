export const metadataStyles = `
.inline-metadata {display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--space-xs);min-width:0}
.metadata-item {
 --metadata-target:var(--help-target);
 display:inline-flex;align-items:baseline;gap:var(--space-xs);min-width:0;max-width:100%;
 line-height:max(var(--metadata-target),1.5em);vertical-align:baseline;
}
.metadata-label {min-width:0;overflow-wrap:anywhere}
.metadata-separator {flex:none;color:var(--muted);user-select:none}
.metadata-tail {display:inline-block;max-width:100%;vertical-align:top;overflow-wrap:anywhere}
.metadata-tail-end {display:inline-flex;align-items:center;vertical-align:baseline;white-space:nowrap}
.metadata-item .metadata-help {
 flex:none;width:var(--metadata-target);min-width:var(--metadata-target);
 height:1lh;min-height:var(--metadata-target);margin:0;margin-inline-start:var(--help-gap);padding:0;font:inherit;
 display:inline-flex;align-items:center;justify-content:flex-start;vertical-align:baseline;
}
.metadata-item .metadata-help svg {width:var(--help-icon);height:var(--help-icon);margin:0}
.request-meta .metadata-help-with-label {
 width:max-content;max-width:100%;height:auto;margin:0;gap:var(--space-sm);align-items:baseline;
 color:inherit;text-align:start;white-space:normal;
}
.request-meta .metadata-help-with-label .metadata-tail-end {gap:var(--help-gap)}
.request-meta .metadata-help-with-label:is(:hover,:active) {color:inherit}
.request-meta .metadata-help-with-label:is(:hover,:active) .metadata-tail-end>svg {color:var(--ink)}
.request-meta .service-cue {flex:none;align-self:flex-start;font:inherit;margin-top:calc((1lh - max(20px,1em)) / 2)}
.request-meta .service-cue .fluent-icon {width:max(20px,1em);height:max(20px,1em);flex-basis:max(20px,1em);margin:0}
`;
