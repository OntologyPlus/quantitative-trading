export const researchStyles = `
.qt .research-space,.qt .project-detail,.qt .research-fields{display:grid;gap:16px;min-width:0}
.qt .research-space{padding-bottom:18px}
.qt .research-space h2{font-size:20px;letter-spacing:-.5px;margin:6px 0}
.qt .health{font-size:11px;color:var(--muted);padding:10px 12px;border:1px solid var(--line);border-radius:8px}
.qt .health-dot{width:6px;height:6px;border-radius:50%;background:var(--mint)}
.qt .project-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.qt .project-tile{display:grid;gap:9px;text-align:left;padding:15px;background:var(--panel);align-content:start}
.qt .project-tile .badge{justify-self:start}
.qt .project-tile.selected{border-color:var(--mint);background:#1d302b}
.qt .project-tile strong{font-size:14px;font-weight:600}
.qt .project-tile .hint{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.qt .research-stages{display:flex;flex-wrap:wrap;gap:6px}
.qt .research-stages span{padding:7px 10px;border-radius:5px;border:1px solid var(--line);font-size:11px;color:var(--muted)}
.qt .research-stages .active{border-color:var(--mint);background:#22372e;color:var(--mint)}
.qt .research-create{border-top:2px solid var(--mint)}
.qt .research-fields{padding-top:14px}
.qt .research-fields .choice small{display:block;margin-top:4px}
.qt .condition-list{display:grid;margin:0;gap:0;font-size:12px}
.qt .condition-list>div{display:grid;grid-template-columns:minmax(100px,1fr) minmax(0,4fr);gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.qt .condition-list dt{font-weight:600}.qt .condition-list dt small{display:block;color:var(--muted);font-weight:400;margin-top:4px}
.qt .condition-list dd{margin:0;overflow-wrap:anywhere;line-height:1.7}
.qt .draft-check,.qt .research-guidance{padding:14px;border:1px solid var(--line);border-radius:8px;background:#81e5ba08;font-size:12px;line-height:1.7}
.qt .research-guidance p:last-child{margin-bottom:0}
.qt .report-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:10px}
.qt .report-checks>button{display:grid;gap:10px;text-align:left;align-content:start;white-space:normal;line-height:1.7}
.qt .research-limitations{font-size:12px;line-height:1.8;padding-left:20px;overflow-wrap:anywhere}
.qt .research-space li+li{margin-top:7px}
.qt .diagnostic-results{display:grid;gap:14px;min-width:0}.qt .diagnostic-results h3,.qt .diagnostic-results p{margin:0}
.qt .diagnostic-range{display:block;max-width:320px;white-space:normal;line-height:1.7}
.qt .research-space progress{width:100%;height:5px;accent-color:var(--mint)}
.qt .research-space .actions button[aria-pressed=true]{border-color:var(--mint);color:var(--mint)}
.qt .evidence-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;padding-top:12px}
.qt .evidence-grid button{display:grid;gap:5px;text-align:left;padding:10px}
.qt .evidence-row{display:flex;justify-content:space-between;gap:12px;text-align:left;font-size:12px}
.qt .advanced-tools{margin-top:18px;display:grid;gap:15px}
.qt .advanced-tools>summary{padding-bottom:12px}
@media(min-width:1000px){.qt .research-create .research-fields>.grid{grid-template-columns:repeat(4,minmax(0,1fr))}.qt .project-detail .stat{padding:18px}}
@media(max-width:420px){.qt .research-space>.row{align-items:flex-start}.qt .project-list{grid-template-columns:1fr}.qt .evidence-row{flex-wrap:wrap}}
`;
