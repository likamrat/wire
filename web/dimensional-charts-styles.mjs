import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";

const faces = ["top", "mid", "base", "side", "cap", "label"];
const servicePalette = createDimensionalCharts().servicePalette;
const services = theme => Object.fromEntries(Object.values(servicePalette).map(entry => [
    entry.token, faces.map(face => entry[theme][face]),
]));
const light = {
    orange: ["#b5723a", "#95552a", "#995328", "#95552a", "#95552a", "#95552a"],
    cyan: ["#528cce", "#315fad", "#345fa4", "#315fad", "#315fad", "#315fad"],
    teal: ["#1494a6", "#086d7c", "#21687e", "#086d7c", "#086d7c", "#086d7c"],
    pink: ["#c06b24", "#a14d16", "#a34e1a", "#a14d16", "#a14d16", "#a14d16"],
    slate: ["#7a899f", "#586071", "#5c687f", "#586071", "#586071", "#586071"],
    violet: ["#9473ba", "#694b9c", "#684895", "#694b9c", "#694b9c", "#694b9c"],
    ...services("light"),
};
const dark = {
    orange: ["#e59b76", "#e59b76", "#9d6e59", "#e59b76", "#e59b76", "#e59b76"],
    cyan: ["#75a6ed", "#75a6ed", "#5475a6", "#75a6ed", "#75a6ed", "#75a6ed"],
    teal: ["#48bfd2", "#48bfd2", "#378595", "#48bfd2", "#48bfd2", "#48bfd2"],
    pink: ["#f2a262", "#f2a262", "#a2693b", "#f2a262", "#f2a262", "#f2a262"],
    slate: ["#a2a9b9", "#a2a9b9", "#717785", "#a2a9b9", "#a2a9b9", "#a2a9b9"],
    violet: ["#b69bdf", "#b69bdf", "#7e6e9d", "#b69bdf", "#b69bdf", "#b69bdf"],
    ...services("dark"),
};
const tokens = palette => Object.entries(palette).map(([tone, colors]) => colors.map((color, index) => `--chart-${tone}-${faces[index]}:${color};`).join("")).join("");
export const dimensionalColumnStyles = `
:root {${tokens(light)}}
@media(prefers-color-scheme:dark) {:root:not([data-evidence-theme]) {${tokens(dark)}}}
:root[data-evidence-theme=light] {${tokens(light)}}
:root[data-evidence-theme=dark] {${tokens(dark)}}
${Object.keys(light).map(tone => `.dimensional-tone-${tone} {${faces.map(face => `--column-${face}:var(--chart-${tone}-${face});`).join("")}--chart-mark-high:var(--column-label);--chart-mark-low:color-mix(in srgb,var(--column-label) var(--chart-fade-strength,82%),var(--paper));color:var(--column-mid)}`).join("\n")}
:is(.dimensional-tone-orange,.dimensional-tone-cyan,.dimensional-tone-teal,.dimensional-tone-pink,.dimensional-tone-slate,.dimensional-tone-violet) {--chart-mark-high:var(--column-top);--chart-mark-low:var(--column-base)}
.chart-fade-high {stop-color:var(--chart-mark-high)}
.chart-fade-low {stop-color:var(--chart-mark-low)}
`;
export const dimensionalChartStyles = `
${dimensionalColumnStyles}
.flat-comparison {display:grid;gap:12px;min-width:0;container-type:inline-size}
.flat-comparison-row {min-width:0}
.flat-comparison-action {display:grid;grid-template-columns:minmax(0,1fr) minmax(0,max-content);gap:8px 16px;align-items:center;min-height:44px;width:100%;padding:8px 0;border:0;border-radius:var(--radius-small);background:transparent;text-decoration:none;font-size:var(--type-small);color:var(--ink);text-align:start;scroll-margin-block:calc(var(--app-header-height,76px) + 16px) 16px}
.flat-comparison-action .group-name {overflow-wrap:anywhere;min-width:0;font-family:var(--font)}
.flat-comparison-action:is(a,button) {color:var(--accent);cursor:pointer}
.flat-comparison-action:is(a,button):is(:hover,:active) {background:var(--canvas);color:var(--ink);border:0}
.flat-comparison-action:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
.flat-comparison-count {font-variant-numeric:tabular-nums;font-weight:var(--weight-strong);min-width:0;overflow-wrap:anywhere}
.flat-comparison-track {display:flex;grid-column:1/-1;height:12px;min-width:0;background:var(--canvas)}
.flat-comparison-segment {display:block;height:100%;min-width:0;flex-shrink:0;background:var(--column-label);background-image:linear-gradient(90deg,var(--chart-mark-low),var(--chart-mark-high))}
@container(max-width:32rem) {.flat-comparison-action {grid-template-columns:minmax(0,1fr)}}
@media(forced-colors:active) {.flat-comparison-segment {background:CanvasText}.flat-comparison-action:focus-visible {outline-color:Highlight}}
.dimensional-scroll {overflow-x:auto;overflow-y:hidden;padding:8px 4px calc(max(16px,1rem) + 1px);scrollbar-width:thin;min-width:0;max-width:100%}
.flat-time-scroll {overflow-x:scroll}
.dimensional-count {position:absolute;bottom:calc(100% + 8px);left:var(--column-center,50%);transform:translateX(-50%);display:flex;align-items:center;justify-content:center;min-height:44px;padding:8px;color:var(--ink);font-size:1.125rem;line-height:1.2;font-weight:var(--weight-strong);font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none}
.time-column .dimensional-count {pointer-events:auto;color:var(--accent);text-decoration:none;cursor:pointer;border-radius:var(--radius-small)}
.time-column:is(:hover,:active) .dimensional-count {background:transparent;color:var(--ink)}
.time-column:focus-visible .dimensional-count {outline:2px solid var(--focus);outline-offset:2px}
#chartFooter:has(.chart-size-note) {flex-wrap:wrap}
#chartFooter>.chart-size-note {flex:1 1 28ch;min-width:0;white-space:normal}
.chart-details {margin-top:0;min-width:0}
.chart-details>summary {min-height:44px;align-content:center;color:var(--accent);font-size:var(--type-small);cursor:pointer}
#chartReadingNotes p {max-width:80ch}
#chartFooter:has(>span:only-child:empty) {display:none}
.dimensional-time-labels {display:grid;grid-auto-flow:column;grid-auto-columns:var(--scene-pitch);min-height:48px;margin:0;padding-top:24px;color:var(--muted);font-size:var(--type-small);text-align:center}
.dimensional-time-labels>span {padding-inline:8px;overflow-wrap:anywhere;min-width:0}
.flat-time-plot {position:relative;min-width:100%;--time-gutter:40px}
.flat-time-plot .time-chart {position:relative;display:grid;grid-template-columns:repeat(var(--time-bins),minmax(0,1fr));height:calc(var(--time-height) + var(--time-headroom,4rem));gap:0;margin:0 0 0 var(--time-gutter);padding:0;border:0;border-bottom:1px solid var(--control)}
.flat-time-plot .time-slot {position:relative;display:block;height:100%;min-width:0}
.flat-time-plot .time-column {position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:84px;min-width:0;min-height:0;padding:0;border:0;border-radius:0;background:transparent;pointer-events:none}
.flat-time-plot .time-stack {display:block;width:100%;height:100%;overflow:visible;border-radius:0;pointer-events:none}
.flat-time-column {display:block;max-width:none;overflow:visible;pointer-events:none}
.flat-time-segment {fill-opacity:1;stroke:none;pointer-events:visibleFill}
.flat-time-column [data-ux-tooltip]:hover {fill-opacity:1}
.flat-time-plot .time-column:hover .time-stack {filter:none;outline:0}
.flat-time-plot .time-column:focus-visible {outline:0}
.flat-time-plot .dimensional-count {font-size:1rem;min-width:44px}
.flat-time-plot .time-zero {position:absolute;bottom:0;left:50%;transform:translateX(-50%);height:0;background:none}
.flat-time-plot .dimensional-time-labels {grid-template-columns:repeat(var(--time-bins),minmax(0,1fr));grid-auto-flow:row;grid-auto-columns:auto;padding:12px 0 0;margin-left:var(--time-gutter);font-size:var(--type-small);min-height:44px}
.flat-time-axis {position:absolute;bottom:0;left:calc(-1 * var(--time-gutter));height:var(--time-height);width:calc(var(--time-gutter) - 12px);display:flex;flex-direction:column;justify-content:space-between;align-items:flex-end;color:var(--muted);font-size:var(--type-small);font-variant-numeric:tabular-nums;pointer-events:none}
.flat-time-axis>span {line-height:1}
.flat-time-axis>span:first-child {transform:translateY(-50%)}
.flat-time-axis>span:last-child {transform:translateY(50%)}
#chart:has(.flat-time-plot)+#chartFooter {justify-content:flex-start;gap:8px 24px}
#chart:has(.flat-time-plot)+#chartFooter>span {white-space:normal;min-width:0}
@media(forced-colors:active) {.flat-time-segment {fill:CanvasText;fill-opacity:1}.flat-time-plot .time-chart {border-color:CanvasText}}
@media(prefers-reduced-motion:reduce) {.flat-time-column,.flat-time-plot .time-column {animation:none;transition:none}}
`;
