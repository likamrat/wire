import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";

export const resultCueColors = Object.freeze(Object.fromEntries(
    Object.entries(createDimensionalCharts().outcomeTones).map(([key, tone]) => [key, `var(--chart-${tone}-label)`]),
));

export const semanticCueStyles = `
${Object.entries(resultCueColors).map(([key, color]) => `.result-tone-${key} {--cue-color:${color}}`).join("\n")}
.service-cue {--cue-color:var(--column-label)}
.semantic-cue {display:inline-flex;align-items:flex-start;gap:8px;max-width:100%;vertical-align:baseline;font-weight:600;line-height:1.6}
.semantic-cue,.recorded-result,.result-legend-icon {color:var(--cue-color)}
.semantic-cue>span {min-width:0;overflow-wrap:anywhere}
.semantic-cue .fluent-icon {display:block;width:20px;height:20px;flex:0 0 20px;margin-top:calc((1lh - 20px) / 2)}
.semantic-cue .fluent-icon[data-fluent-icon=info_16_regular] {width:16px;height:16px;flex-basis:16px;margin-inline:2px;margin-top:calc((1lh - 16px) / 2)}
.result-legend-icon {display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:0 0 20px}
.result-legend-icon .fluent-icon {width:20px;height:20px}
.result-legend-icon .fluent-icon[data-fluent-icon=info_16_regular] {width:16px;height:16px}
@media(forced-colors:active) {
 .semantic-cue,.recorded-result,.result-legend-icon {color:CanvasText}
 .result-link {color:LinkText}
}
@media print {
 .semantic-cue,.recorded-result,.result-legend-icon {color:#172333}
}
`;
