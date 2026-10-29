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
