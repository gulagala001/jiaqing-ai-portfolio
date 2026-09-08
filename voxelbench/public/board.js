import { indexDimensions } from "../questions/rubric.js";
import {
  chartRows,
  leaderboard,
  weightedLeaderboard,
  summarize,
  formatTokens,
  round1,
} from "./scoring.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const num = (v, digits = 1) =>
  v == null
    ? "未记录"
    : v.toLocaleString("en-US", { maximumFractionDigits: digits });
const pct = (v) => (v == null ? "未评完" : `${num(v, 3)}%`);
const date = (value) => new Date(value).toLocaleDateString("zh-CN");
const dateTime = (value) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const key = (run) => run.model.trim().toLowerCase();
const initials = (name) =>
  name
    .replace(/[^\p{L}\p{N}]/gu, "")
    .slice(0, 2)
    .toUpperCase();
const metrics = {
  cost: {
    title: "成本",
    unit: "USD",
    format: (v) => (v == null ? "未记录" : `$${num(v, 4)}`),
    axis: (v) => `$${num(v, 2)}`,
  },
  minutes: {
    title: "耗时",
    unit: "分钟",
    format: (v) => (v == null ? "未记录" : `${num(v)} 分钟`),
    axis: (v) => num(v),
  },
  tokens: {
    title: "Token",
    unit: "个",
    format: formatTokens,
    axis: formatTokens,
  },
};
const sections = [
  ["score", "模型总分"],
  ["ranking", "总排名"],
  ["profile", "四维坐标"],
  ["dimensions", "加权维度榜"],
  ["usage", "生成消耗"],
  ["tradeoff", "得分与消耗"],
  ["rounds", "双轮对照"],
  ["activity", "测试动态"],
];
const defaults = () => ({
  mode: "one-shot",
  search: "",
  models: null,
  provider: "",
  status: "all",
  limit: 0,
  sort: "default",
  labels: true,
  frontier: true,
  axis: "full",
  dimension: "I",
  usage: "cost",
  tradeoff: "cost",
  profile: "",
  compare: "",
  focus: "",
});
let state = defaults(),
  source = [],
  host,
  notify = () => {},
  previews = () => "",
  controller,
  navFrame;
const exports = new Map();

export function filterBoardRuns(runs, filters) {
  const query = (filters.search || "").trim().toLowerCase();
  return runs.filter(
    (run) =>
      (!filters.models || filters.models.includes(key(run))) &&
      (!query ||
        `${run.model} ${run.provider || ""}`.toLowerCase().includes(query)) &&
      (!filters.provider ||
        (run.provider || "") ===
          (filters.provider === "__empty__" ? "" : filters.provider)) &&
      (filters.status !== "complete" ||
        (summarize(run.oneShot).complete &&
          (filters.mode !== "combined" ||
            summarize(run.oneMoreShot, "one-more-shot").complete))),
  );
}
export function paretoFrontier(points) {
  return points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && !p.pending)
    .filter(
      (p, _, all) =>
        !all.some((q) => q.x <= p.x && q.y >= p.y && (q.x < p.x || q.y > p.y)),
    )
    .sort((a, b) => a.x - b.x || b.y - a.y);
}
export function comparisonRows(runs) {
  const chosen = new Map();
  for (const run of [...runs].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )) {
    const first = summarize(run.oneShot),
      second = summarize(run.oneMoreShot, "one-more-shot");
    if (first.complete && second.complete && !chosen.has(key(run)))
      chosen.set(key(run), {
        run,
        first: first.base,
        second: second.base,
        delta: round1(second.base - first.base),
      });
  }
  return [...chosen.values()].sort(
    (a, b) => b.delta - a.delta || a.run.model.localeCompare(b.run.model),
  );
}
export function csvText(headers, rows) {
  const cell = (value) => {
    let text = value == null ? "" : String(value);
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text))
      text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")
  );
}
function filtered() {
  return filterBoardRuns(source, state);
}
function colors() {
  return new Map(chartRows(source).map((row) => [key(row.run), row.color]));
}
function rows(mode = state.mode) {
  const palette = colors();
  return chartRows(filtered(), mode).map((row) => ({
    ...row,
    color: palette.get(key(row.run)),
  }));
}
function totalItems(mode = state.mode) {
  return rows(mode).map((row) => ({
    ...row,
    value: row.rated ? row.score : null,
    pending: !row.complete,
  }));
}
function dimensionItems(id = state.dimension) {
  const palette = colors();
  return weightedLeaderboard(filtered(), id, state.mode).map((row) => ({
    ...row,
    value: row.rate,
    color: palette.get(key(row.run)),
    pending: false,
  }));
}
function arranged(items, lower = false) {
  const sorted = [...items].sort((a, b) => {
    if (a.value == null || b.value == null)
      return a.value == null ? (b.value == null ? 0 : 1) : -1;
    if (state.sort === "model") return a.run.model.localeCompare(b.run.model);
    const asc = state.sort === "asc" || (state.sort === "default" && lower);
    return (
      (asc ? a.value - b.value : b.value - a.value) ||
      a.run.model.localeCompare(b.run.model)
    );
  });
  return state.limit ? sorted.slice(0, state.limit) : sorted;
}
function niceMax(value) {
  if (!(value > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(value)) / 5;
  return Math.ceil(value / step) * step;
}
function maxScore() {
  return state.mode === "combined" ? 2000 : 1050;
}
function modeLabel() {
  return state.mode === "combined" ? "两轮总榜 · 2000" : "One shot · 1000 + 50";
}
function badge(run, color) {
  return `<span class="model-badge" style="--model-color:${color}">${esc(initials(run.model))}</span>`;
}
function modelCell(run, color) {
  return `<span class="model-cell">${badge(run, color)}<span><strong>${esc(run.model)}</strong><small>${esc(run.provider || "")} ${date(run.updatedAt)}</small></span></span>`;
}
function tooltip(item, value, extra = "") {
  return `${item.run.model}\n${value}\n${item.run.provider ? item.run.provider + " · " : ""}${date(item.run.updatedAt)}${item.pending ? " · 评分中" : ""}${extra ? "\n" + extra : ""}`;
}
function markAttrs(item, text) {
  return `tabindex="0" role="button" aria-label="${esc(text)}" data-tip="${esc(text)}" data-focus-model="${esc(key(item.run))}" class="plot-mark${state.focus && state.focus !== key(item.run) ? " plot-muted" : ""}"`;
}
const svgStyle = `text{font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif}.plot-grid{stroke:#e0e3e0;stroke-dasharray:2 4}.plot-base{stroke:#c7cdc7}.plot-tick{fill:#879087;font-size:10px}.plot-name{fill:#39443b;font-size:11px}.plot-value{fill:#222d24;font-size:12px;font-weight:600}.plot-watermark{fill:#8c978a;font:italic 13px Georgia,serif}.plot-empty{fill:#8a9389;font-size:13px}.plot-mark{cursor:pointer}.plot-muted{opacity:.2}.plot-mark:focus{outline:none}.plot-mark:focus>rect:first-of-type,.plot-mark:hover>rect:first-of-type{stroke:#536851;stroke-width:2}.plot-frontier{fill:none;stroke:#738d70;stroke-width:1.5;stroke-dasharray:5 4}`;
function svgOpen(width, height, label, extra = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" class="bench-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" ${extra}><style>${svgStyle}</style>`;
}
function bars(
  items,
  {
    id,
    maximum,
    format = num,
    valueFormat = format,
    mini = false,
    unit = "分",
    empty = "暂无已记录的数据",
  } = {},
) {
  const w = mini ? 420 : Math.max(760, items.length * 66 + 110),
    h = mini ? 260 : 398,
    left = mini ? 22 : 56,
    right = w - 24,
    top = mini ? 28 : 38,
    bottom = mini ? 164 : 270;
  const ceiling =
    state.axis === "auto" || !maximum
      ? niceMax(Math.max(0, ...items.map((x) => x.value ?? 0)) * 1.08)
      : maximum;
  const slot = (right - left) / Math.max(items.length, mini ? 5 : 6),
    barW = Math.min(mini ? 43 : 60, slot * 0.67),
    start = left + (right - left - items.length * slot) / 2;
  const y = (v) => bottom - (v / ceiling) * (bottom - top);
  return `<div class="plot-scroll${mini ? " mini-plot" : ""}">${svgOpen(w, h, id, mini ? "" : `style="min-width:${items.length > 8 ? items.length * 66 + 110 : 560}px"`)}
  <defs><pattern id="hatch-${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><path d="M0 0V6" stroke="#fff" stroke-opacity=".65" stroke-width="2"/></pattern></defs>
  ${[0, 0.25, 0.5, 0.75, 1].map((r) => `<line class="plot-grid" x1="${left}" x2="${right}" y1="${y(r * ceiling)}" y2="${y(r * ceiling)}"/>${mini ? "" : `<text class="plot-tick" x="${left - 8}" y="${y(r * ceiling) + 4}" text-anchor="end">${esc(format(r * ceiling))}</text>`}`).join("")}
  <line class="plot-base" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>
  ${mini ? "" : `<text class="plot-watermark" x="${right}" y="18" text-anchor="end">▦ VoxelBench</text>`}
  ${items
    .map((item, i) => {
      const x = start + (i + 0.5) * slot,
        v = item.value,
        barH = v == null ? 0 : (v / ceiling) * (bottom - top),
        label = format(v);
      return `<g ${markAttrs(item, tooltip(item, `${valueFormat(v)}${unit === "分" && v != null ? " 分" : ""}`))}><rect x="${x - slot / 2}" y="${top}" width="${slot}" height="${bottom - top + 24}" fill="transparent"/>
    ${v == null ? "" : `<rect x="${x - barW / 2}" y="${y(v)}" width="${barW}" height="${Math.max(v === 0 ? 2 : 0, barH)}" rx="3" fill="${item.color}"/>${item.pending ? `<rect x="${x - barW / 2}" y="${y(v)}" width="${barW}" height="${barH}" fill="url(#hatch-${id})"/>` : ""}`}
    ${state.labels ? `<text class="plot-value" x="${x}" y="${v == null ? bottom - 9 : y(v) - 8}" text-anchor="middle" style="font-size:${mini ? 10 : 12}px">${v == null ? "—" : esc(label) + (item.pending ? "*" : "")}</text>` : ""}
    <rect x="${x - 8}" y="${bottom + 8}" width="16" height="16" rx="3" fill="${item.color}18"/><text x="${x}" y="${bottom + 20}" text-anchor="middle" fill="${item.color}" font-size="9" font-weight="700">${esc(initials(item.run.model))}</text>
    <text class="plot-name" transform="translate(${x + 4},${bottom + 37}) rotate(-48)" text-anchor="end" style="font-size:${mini ? 9 : 11}px">${esc(item.run.model.length > (mini ? 20 : 28) ? item.run.model.slice(0, mini ? 19 : 27) + "…" : item.run.model)}</text></g>`;
    })
    .join("")}
  ${!items.some((i) => i.value != null) ? `<text class="plot-empty" x="${w / 2}" y="${(top + bottom) / 2}" text-anchor="middle">${esc(empty)}</text>` : ""}</svg></div>`;
}
function icon(name) {
  const paths = {
    link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2",
    image: "M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M8 8h.01",
    csv: "M4 4h16v16H4z M4 10h16 M10 4v16 M4 15h16",
    expand: "M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5",
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
}
function tools(id) {
  return `<div class="chart-tools">${[
    ["link", "复制图表链接"],
    ["image", "下载图表 PNG"],
    ["csv", "下载数据 CSV"],
    ["expand", "全屏图表"],
  ]
    .map(
      ([action, title]) =>
        `<button data-export="${action}" data-chart="${id}" aria-label="${title}" title="${title}">${icon(action)}</button>`,
    )
    .join("")}</div>`;
}
function tabs(name, options, value) {
  return `<div class="bench-tabs" role="tablist" aria-label="${{ dimension: "维度榜单", usage: "消耗指标", tradeoff: "得分与消耗指标" }[name] || name}">${options.map(([v, t]) => `<button role="tab" aria-selected="${value === v}" data-view="${name}" data-value="${v}">${t}</button>`).join("")}</div>`;
}
function card(
  id,
  title,
  subtitle,
  content,
  { headers = [], data = [], footer = "", before = "", section = id } = {},
) {
  exports.set(id, { title, subtitle, headers, data, section, footer });
  return `<div class="bench-card" id="card-${id}">${before}<div class="bench-card-head"><div><h3>${title}</h3><p>${subtitle}</p></div>${tools(id)}</div>${content}<div class="bench-card-foot"><span>VOXELBENCH</span><span>${footer || `${data.length} 条记录 · ${modeLabel()}`}</span></div></div>`;
}
function section(id, title, english, content) {
  return `<section class="bench-section" id="chart-${id}"><h2><i></i>${title}<span>${english}</span></h2>${content}</section>`;
}
function barData(items) {
  return items.map((i) => [
    i.run.model,
    i.run.provider,
    i.value,
    i.pending ? "评分中" : "已完成",
    i.run.updatedAt,
  ]);
}
const barHeaders = ["模型", "厂商", "数值", "状态", "更新时间"];

function highlights() {
  const first = arranged(totalItems("one-shot")).slice(0, 5),
    combined = arranged(
      totalItems("combined").filter((row) => row.run.oneMoreShot),
    ).slice(0, 5),
    weighted = arranged(dimensionItems()).slice(0, 5);
  const d = indexDimensions.find((d) => d.id === state.dimension);
  return `<section class="highlights"><div class="overview-title"><span>评测概览 <small>Highlights</small></span><span>${new Set(source.map(key)).size} 个模型 · ${source.length} 条测试</span></div><div class="highlight-grid">
    <article class="highlight-card"><h3><i style="background:#252c26"></i><button data-overview="one-shot">One shot <span>↗</span></button></h3><p>基础 1000 + 奖励 50 · 越高越好</p>${bars(first, { id: "overview-first", maximum: 1050, mini: true, empty: "首轮尚无评分" })}</article>
    <article class="highlight-card"><h3><i style="background:#8470ad"></i><button data-overview="combined">两轮总榜 <span>↗</span></button></h3><p>One shot + One more shot · 2000 分</p>${bars(combined, { id: "overview-combined", maximum: 2000, mini: true, empty: "续轮评分完成后进入总榜" })}</article>
    <article class="highlight-card"><h3><i style="background:${d.color}"></i><span>维度指数</span><select data-setting="dimension" aria-label="概览维度">${indexDimensions.map((d) => `<option value="${d.id}" ${state.dimension === d.id ? "selected" : ""}>${d.title}</option>`).join("")}</select></h3><p>${d.title}得分率 · 越高越好</p>${bars(weighted, { id: "overview-index", maximum: 100, mini: true, format: pct, unit: "%", empty: "本维度尚无完整评分" })}</article>
    </div><p class="overview-note">斜线柱与 * 为评分中的已确认分；完整成绩参与对应排名。</p></section>`;
}
function filters() {
  const all = chartRows(source),
    providers = [...new Set(source.map((r) => r.provider || ""))];
  return `<div class="board-filterbar"><label class="board-search"><span>⌕</span><input id="board-search" aria-label="搜索模型" placeholder="搜索模型或厂商" value="${esc(state.search)}"></label>
  <details class="board-popover" data-popover="models"><summary>选择模型 <b>${state.models ? state.models.length : all.length} / ${all.length}</b>⌄</summary><div class="popover-panel"><div class="popover-actions"><button data-models="all">全选</button><button data-models="none">清空</button></div>${all.map((row) => `<label><input type="checkbox" data-model-choice="${esc(key(row.run))}" ${!state.models || state.models.includes(key(row.run)) ? "checked" : ""}>${badge(row.run, row.color)}<span>${esc(row.run.model)}</span></label>`).join("") || "<p>暂无模型</p>"}</div></details>
  <details class="board-popover" data-popover="filters"><summary>筛选${state.status !== "all" || state.provider ? " · 已启用" : ""}⌄</summary><div class="popover-panel setting-panel"><label>成绩状态<select data-setting="status" aria-label="筛选成绩状态"><option value="all" ${state.status === "all" ? "selected" : ""}>全部，含评分中</option><option value="complete" ${state.status === "complete" ? "selected" : ""}>仅完整总分</option></select></label><label>厂商<select data-setting="provider" aria-label="筛选厂商"><option value="">全部厂商</option>${providers.map((p) => `<option value="${esc(p || "__empty__")}" ${state.provider === (p || "__empty__") ? "selected" : ""}>${esc(p || "未填写厂商")}</option>`).join("")}</select></label></div></details>
  <details class="board-popover" data-popover="display"><summary>显示⌄</summary><div class="popover-panel setting-panel"><label>显示数量<select data-setting="limit" aria-label="图表显示数量">${[0, 5, 10, 20].map((n) => `<option value="${n}" ${state.limit === n ? "selected" : ""}>${n ? "前 " + n + " 个" : "全部模型"}</option>`).join("")}</select></label><label>柱形图排序<select data-setting="sort" aria-label="柱形图排序">${[
    ["default", "按指标推荐"],
    ["desc", "从高到低"],
    ["asc", "从低到高"],
    ["model", "模型名称"],
  ]
    .map(
      ([v, t]) =>
        `<option value="${v}" ${state.sort === v ? "selected" : ""}>${t}</option>`,
    )
    .join(
      "",
    )}</select></label><label>得分纵轴<select data-setting="axis" aria-label="得分纵轴"><option value="full" ${state.axis === "full" ? "selected" : ""}>固定满分</option><option value="auto" ${state.axis === "auto" ? "selected" : ""}>按当前数据适配</option></select></label><label class="inline-check"><input type="checkbox" data-setting="labels" ${state.labels ? "checked" : ""}>显示数值与散点标签</label><label class="inline-check"><input type="checkbox" data-setting="frontier" ${state.frontier ? "checked" : ""}>显示完整成绩的效率前沿</label></div></details>
  <button class="filter-reset" data-reset>重置</button></div>`;
}
function totalSection() {
  const items = arranged(totalItems());
  return section(
    "score",
    "模型总分",
    "Overall score",
    card(
      "score",
      modeLabel(),
      "完整交互世界的交付表现 · 分数越高越好",
      bars(items, { id: "score", maximum: maxScore() }),
      {
        headers: barHeaders,
        data: barData(items),
        footer: "斜线柱为评分中的已确认分 · 点击模型可高亮对照",
      },
    ),
  );
}
function rankingSection() {
  const ranked = leaderboard(filtered(), state.mode),
    palette = colors(),
    pending = rows().filter((r) => !r.complete);
  const table = `<div class="table-scroll"><table class="board-table"><thead><tr><th>排名</th><th>模型</th><th>总分 ↓</th><th>作品</th></tr></thead><tbody>${ranked.map((r) => `<tr><td class="rank">${String(r.rank).padStart(2, "0")}</td><td>${modelCell(r.run, palette.get(key(r.run)))}</td><td class="total-number">${num(r.score)}<small>/ ${maxScore()}</small></td><td>${previews(r.run, state.mode === "combined")}</td></tr>`).join("") || '<tr><td colspan="4" class="table-empty">评分完成后进入总排名</td></tr>'}</tbody></table></div>${pending.length ? `<div class="board-pending"><span>评分中</span>${pending.map((r) => `<span>${esc(r.run.model)}</span>`).join("")}</div>` : ""}`;
  return section(
    "ranking",
    "总分排名",
    "Leaderboard",
    card("ranking", "总分排名", "同模型取最近完整测试 · 同分并列", table, {
      headers: ["排名", "模型", "总分", "更新时间"],
      data: ranked.map((r) => [r.rank, r.run.model, r.score, r.run.updatedAt]),
      footer: `${ranked.length} 个完整成绩 · ${pending.length} 个模型评分中`,
    }),
  );
}
function profileSection() {
  const data = rows(),
    first =
      data.find((r) => key(r.run) === state.profile) ||
      data.find((r) => r.complete) ||
      data[0];
  const second = data.find((r) => key(r.run) === state.compare && r !== first),
    shown = [first, second].filter(Boolean);
  const cx = 255,
    cy = 175,
    radius = 112,
    point = (i, v) => [
      cx + Math.sin((i * Math.PI) / 2) * radius * v,
      cy - Math.cos((i * Math.PI) / 2) * radius * v,
    ];
  const coords = (points) => points.map((p) => p.join(",")).join(" ");
  const picker = (name, value, optional) =>
    `<select data-setting="${name}" aria-label="${optional ? "对比模型" : "主体模型"}">${optional ? '<option value="">添加对比模型</option>' : ""}${data.map((r) => `<option value="${esc(key(r.run))}" ${key(r.run) === value ? "selected" : ""}>${esc(r.run.model)}</option>`).join("") || '<option value="">暂无模型</option>'}</select>`;
  const svg =
    svgOpen(510, 355, "四维能力对比") +
    [0.25, 0.5, 0.75, 1]
      .map(
        (v) =>
          `<polygon points="${coords(indexDimensions.map((_, i) => point(i, v)))}" fill="none" stroke="#dce3dc"/><text class="plot-tick" x="${cx + 6}" y="${cy - radius * v - 3}">${v * 100}%</text>`,
      )
      .join("") +
    indexDimensions
      .map((d, i) => {
        const [x, y] = point(i, 1),
          [tx, ty] = point(i, 1.22);
        return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#e6eae5"/><text class="plot-name" x="${tx}" y="${ty + 4}" text-anchor="${i === 1 ? "start" : i === 3 ? "end" : "middle"}">${d.title}</text>`;
      })
      .join("") +
    shown
      .map((row) => {
        const complete = indexDimensions.every(
          (d) => row.profile[d.id].complete,
        );
        return `<g ${markAttrs(row, tooltip(row, "四维能力坐标"))}>${complete ? `<polygon class="radar-shape" points="${coords(indexDimensions.map((d, i) => point(i, row.profile[d.id].rate / 100)))}" fill="${row.color}16" stroke="${row.color}" stroke-width="2"/>` : ""}${indexDimensions
          .map((d, i) => {
            const v = row.profile[d.id].rate,
              [x, y] = point(i, (v ?? 0) / 100);
            return v == null
              ? ""
              : `<circle cx="${x}" cy="${y}" r="4" fill="${row.color}" data-tip="${esc(row.run.model + "\n" + d.title + " " + pct(v))}"/>`;
          })
          .join("")}</g>`;
      })
      .join("") +
    "</svg>";
  const table = `<div class="profile-comparison"><div class="profile-models">${shown.map((r) => `<span>${badge(r.run, r.color)}${esc(r.run.model)}</span>`).join("")}</div><table><thead><tr><th>维度</th>${shown.map((r, i) => `<th>${i ? "对比" : "主体"}</th>`).join("")}</tr></thead><tbody>${indexDimensions.map((d) => `<tr><td>${d.title}</td>${shown.map((r) => `<td style="color:${r.color}">${pct(r.profile[d.id].rate)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  return section(
    "profile",
    "四维能力坐标",
    "Capability profile",
    card(
      "profile",
      "能力分布与模型对比",
      "指令、质量、工程与效率 · 各轴 0–100%",
      `<div class="profile-pickers">${picker("profile", first ? key(first.run) : "", false)}${picker("compare", second ? key(second.run) : "", true)}</div><div class="radar-layout">${svg}${table}</div>`,
      {
        headers: ["模型", ...indexDimensions.map((d) => d.title + "得分率(%)")],
        data: shown.map((r) => [
          r.run.model,
          ...indexDimensions.map((d) => r.profile[d.id].rate),
        ]),
        footer: "每个模型使用同一条测试 · 未评完的维度留空",
      },
    ),
  );
}
function dimensionsSection() {
  const d = indexDimensions.find((d) => d.id === state.dimension),
    items = arranged(dimensionItems()),
    all = rows();
  const indexTable = `<div class="table-scroll"><table class="board-table"><thead><tr><th>排名</th><th>模型</th><th>得分率 ↓</th></tr></thead><tbody>${
    dimensionItems()
      .map(
        (r) =>
          `<tr><td class="rank">${String(r.rank).padStart(2, "0")}</td><td>${modelCell(r.run, r.color)}</td><td class="index-rate">${pct(r.rate)}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="3" class="table-empty">本维度尚无完整成绩</td></tr>'
  }</tbody></table></div>`;
  const main = card(
    "dimensions",
    `${d.title}榜`,
    `${d.id === "C" ? "效率" : "加权"}得分率 · 越高越好`,
    bars(items, { id: "dimensions", maximum: 100, format: pct, unit: "%" }) +
      indexTable,
    {
      before: tabs(
        "dimension",
        indexDimensions.map((d) => [d.id, d.title]),
        state.dimension,
      ),
      headers: ["排名", ...barHeaders],
      data: items.map((r) => [r.rank, ...barData([r])[0]]),
      footer: "各维度独立排名 · 同模型取本维度最近完成的测试",
    },
  );
  const matrix = card(
    "matrix",
    "四维得分率一览",
    "同一条测试的能力分布",
    `<div class="table-scroll"><table class="board-table index-matrix"><thead><tr><th>模型</th>${indexDimensions.map((d) => `<th>${d.title}</th>`).join("")}</tr></thead><tbody>${
      all
        .map(
          (r) =>
            `<tr><td>${modelCell(r.run, r.color)}</td>${indexDimensions
              .map((d) => {
                const rate = r.profile[d.id].rate;
                return `<td style="background:${rate == null ? "#f7f8f6" : `rgba(64,119,82,${0.05 + (rate / 100) * 0.32})`}">${rate == null ? '<span class="muted">未评完</span>' : pct(rate)}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("") ||
      '<tr><td colspan="5" class="table-empty">暂无匹配模型</td></tr>'
    }</tbody></table></div>`,
    {
      headers: ["模型", ...indexDimensions.map((d) => d.title + "(%)")],
      data: all.map((r) => [
        r.run.model,
        ...indexDimensions.map((d) => r.profile[d.id].rate),
      ]),
      section: "dimensions",
      footer: "颜色越深，得分率越高",
    },
  );
  return section(
    "dimensions",
    "加权维度榜",
    "Capability indices",
    main + matrix,
  );
}
function usageItems(metric) {
  return rows().map((row) => ({
    ...row,
    value: row.usage[metric].total,
    pending: false,
  }));
}
function usageSection() {
  const m = metrics[state.usage],
    items = arranged(usageItems(state.usage), true),
    all = rows();
  return section(
    "usage",
    "生成消耗",
    "Cost, time & tokens",
    card(
      "usage",
      `${m.title}对比`,
      `${m.unit} · 消耗越低越好`,
      bars(items, {
        id: "usage",
        format: m.axis,
        valueFormat: (v) =>
          v == null
            ? "未记录"
            : state.usage === "tokens"
              ? num(v, 0) + " Token"
              : m.format(v),
        unit: m.unit,
      }),
      {
        before: tabs(
          "usage",
          Object.entries(metrics).map(([k, m]) => [k, m.title]),
          state.usage,
        ),
        headers: ["模型", "厂商", m.title + " (" + m.unit + ")", "更新时间"],
        data: items.map((r) => [
          r.run.model,
          r.run.provider,
          r.value,
          r.run.updatedAt,
        ]),
        footer:
          state.mode === "combined"
            ? "同一次测试两轮消耗合计 · 缺一轮时保留未知"
            : "按本轮记录的实际消耗比较 · 未知显示 —",
      },
    ) +
      card(
        "usage-table",
        "消耗一览",
        "保留原始消耗精度",
        `<div class="table-scroll"><table class="board-table"><thead><tr><th>模型</th><th>成本 USD</th><th>耗时（分钟）</th><th>Token</th></tr></thead><tbody>${all.map((r) => `<tr><td>${modelCell(r.run, r.color)}</td><td>${metrics.cost.format(r.usage.cost.total)}</td><td>${num(r.usage.minutes.total)}</td><td>${formatTokens(r.usage.tokens.total)}</td></tr>`).join("") || '<tr><td colspan="4" class="table-empty">暂无匹配模型</td></tr>'}</tbody></table></div>`,
        {
          headers: ["模型", "成本 USD", "耗时 分钟", "Token 个", "更新时间"],
          data: all.map((r) => [
            r.run.model,
            r.usage.cost.total,
            r.usage.minutes.total,
            r.usage.tokens.total,
            r.run.updatedAt,
          ]),
          section: "usage",
          footer: "成本沿用记录中的 USD 值；套餐折算估计保留其记录口径",
        },
      ),
  );
}
function scatter(
  points,
  { id, xLabel, xFormat = num, xMax, maximum = maxScore(), dates = false } = {},
) {
  const w = 820,
    h = 390,
    left = 65,
    right = 785,
    top = 45,
    bottom = 325;
  const xMin = dates
    ? Math.min(...points.map((p) => p.x), Date.now()) - 43200000
    : 0;
  const xCeil = dates
    ? Math.max(...points.map((p) => p.x), xMin + 86400000) + 43200000
    : xMax || niceMax(Math.max(0, ...points.map((p) => p.x)) * 1.1);
  const yCeil =
    state.axis === "auto"
      ? niceMax(Math.max(0, ...points.map((p) => p.y)) * 1.08)
      : maximum;
  const x = (v) => left + ((v - xMin) / (xCeil - xMin)) * (right - left),
    y = (v) => bottom - (v / yCeil) * (bottom - top);
  const frontier = paretoFrontier(points);
  return `<div class="plot-scroll">${svgOpen(w, h, id, 'style="min-width:560px"')}
    ${[0, 0.25, 0.5, 0.75, 1].map((r) => `<line class="plot-grid" x1="${left}" x2="${right}" y1="${y(r * yCeil)}" y2="${y(r * yCeil)}"/><text class="plot-tick" x="${left - 9}" y="${y(r * yCeil) + 4}" text-anchor="end">${num(r * yCeil)}</text><text class="plot-tick" x="${left + r * (right - left)}" y="${bottom + 22}" text-anchor="middle">${esc(xFormat(xMin + r * (xCeil - xMin)))}</text>`).join("")}
    <text class="plot-name" x="${left}" y="20">总分 ↑</text><text class="plot-tick" x="${(left + right) / 2}" y="${h - 15}" text-anchor="middle">${esc(xLabel)}</text>
    ${dates ? "" : `<text class="plot-tick" x="${left + 8}" y="${top + 12}">↖ 高分 · 低消耗</text>`}
    ${!dates && state.frontier && frontier.length > 1 ? `<polyline class="plot-frontier" points="${frontier.map((p) => `${x(p.x)},${y(p.y)}`).join(" ")}"/>` : ""}
    ${points
      .map((p, i) => {
        const px = x(p.x),
          py = y(p.y),
          rightSide = px > (left + right) / 2;
        return `<g ${markAttrs(p, tooltip(p, `总分 ${num(p.y)}${p.pending ? "*" : ""}`, `${xLabel} ${xFormat(p.x)}`))}><circle cx="${px}" cy="${py}" r="14" fill="transparent"/><circle cx="${px}" cy="${py}" r="6" stroke="${p.color}" stroke-width="2" fill="${p.pending ? "white" : p.color}"/>${state.labels ? `<text class="plot-name" x="${px + (rightSide ? -11 : 11)}" y="${py + (i % 2 ? 17 : -10)}" text-anchor="${rightSide ? "end" : "start"}" style="font-size:10px">${esc(p.run.model.length > 26 ? p.run.model.slice(0, 25) + "…" : p.run.model)}${p.pending ? "*" : ""}</text>` : ""}</g>`;
      })
      .join("")}
    ${!points.length ? `<text class="plot-empty" x="${w / 2}" y="${h / 2}" text-anchor="middle">补齐对应消耗和评分后显示</text>` : ""}</svg></div>`;
}
function tradeoffSection() {
  const m = metrics[state.tradeoff],
    points = rows()
      .filter((r) => r.rated && r.usage[state.tradeoff].total != null)
      .map((r) => ({
        ...r,
        x: r.usage[state.tradeoff].total,
        y: r.score,
        pending: !r.complete,
      }));
  return section(
    "tradeoff",
    "得分与消耗",
    "Performance & efficiency",
    card(
      "tradeoff",
      `总分与${m.title}`,
      `得分越高、${m.title}越低越好`,
      scatter(points, {
        id: "tradeoff",
        xLabel: m.title + " (" + m.unit + ")",
        xFormat: m.axis,
      }),
      {
        before: tabs(
          "tradeoff",
          Object.entries(metrics).map(([id, m]) => [id, "总分 / " + m.title]),
          state.tradeoff,
        ),
        headers: [
          "模型",
          "总分",
          m.title + " (" + m.unit + ")",
          "状态",
          "更新时间",
        ],
        data: points.map((r) => [
          r.run.model,
          r.y,
          r.x,
          r.pending ? "评分中" : "已完成",
          r.run.updatedAt,
        ]),
        footer: "空心点为评分中的已确认分 · 虚线仅连接完整成绩的效率前沿",
      },
    ),
  );
}
function roundsSection() {
  const pairs = comparisonRows(
      filterBoardRuns(source, { ...state, status: "all" }),
    ),
    palette = colors(),
    w = Math.max(760, pairs.length * 130 + 100),
    h = 350,
    left = 65,
    bottom = 230,
    top = 35,
    slot = (w - left - 25) / Math.max(pairs.length, 4);
  const svg =
    svgOpen(w, h, "首轮与续轮基础分对比") +
    [0, 250, 500, 750, 1000]
      .map(
        (v) =>
          `<line class="plot-grid" x1="${left}" x2="${w - 25}" y1="${bottom - (v / 1000) * (bottom - top)}" y2="${bottom - (v / 1000) * (bottom - top)}"/><text class="plot-tick" x="${left - 10}" y="${bottom - (v / 1000) * (bottom - top) + 4}" text-anchor="end">${v}</text>`,
      )
      .join("") +
    pairs
      .map((p, i) => {
        const x = left + (i + 0.5) * slot,
          c = palette.get(key(p.run));
        return `<g ${markAttrs(p, tooltip(p, `首轮 ${p.first} / 续轮 ${p.second}\n变化 ${p.delta > 0 ? "+" : ""}${p.delta}`))}>${[p.first, p.second].map((v, j) => `<rect x="${x - 30 + j * 32}" y="${bottom - (v / 1000) * (bottom - top)}" width="27" height="${(v / 1000) * (bottom - top)}" fill="${c}" opacity="${j ? 1 : 0.4}" rx="2"/><text class="plot-value" x="${x - 16 + j * 32}" y="${bottom - (v / 1000) * (bottom - top) - 7}" text-anchor="middle">${num(v)}</text>`).join("")}<text class="plot-name" transform="translate(${x + 5},${bottom + 24}) rotate(-35)" text-anchor="end">${esc(p.run.model)}</text></g>`;
      })
      .join("") +
    (!pairs.length
      ? '<text class="plot-empty" x="380" y="130" text-anchor="middle">完成同一测试的两轮评分后，比较首轮与续轮表现</text>'
      : "") +
    "</svg>";
  const table = pairs.length
    ? `<div class="table-scroll"><table class="board-table"><thead><tr><th>模型</th><th>首轮 /1000</th><th>续轮 /1000</th><th>变化</th><th>作品</th></tr></thead><tbody>${pairs.map((p) => `<tr><td>${modelCell(p.run, palette.get(key(p.run)))}</td><td>${num(p.first)}</td><td>${num(p.second)}</td><td>${p.delta > 0 ? "+" : ""}${num(p.delta)}</td><td>${previews(p.run, true)}</td></tr>`).join("")}</tbody></table></div>`
    : "";
  return section(
    "rounds",
    "双轮成绩对照",
    "One shot & one more shot",
    card(
      "rounds",
      "两次交付的基础分",
      "首轮浅色 · 续轮深色 · 两轮各 1000 分",
      `<div class="plot-scroll">${svg}</div>` + table,
      {
        headers: ["模型", "首轮基础分", "续轮基础分", "变化", "更新时间"],
        data: pairs.map((p) => [
          p.run.model,
          p.first,
          p.second,
          p.delta,
          p.run.updatedAt,
        ]),
        footer: "只比较同一次测试的完整两轮 · 续轮为暴雨改造目标",
      },
    ),
  );
}
function activitySection() {
  const palette = colors(),
    records = filtered()
      .map((run) => {
        const first = summarize(run.oneShot),
          second = summarize(run.oneMoreShot, "one-more-shot"),
          complete =
            first.complete && (state.mode !== "combined" || second.complete),
          missing =
            first.missing + (state.mode === "combined" ? second.missing : 0);
        return {
          run,
          color: palette.get(key(run)),
          x: Date.parse(run.updatedAt),
          y:
            state.mode === "combined"
              ? round1(first.base + second.base)
              : first.total,
          pending: !complete,
          missing,
        };
      })
      .sort((a, b) => b.x - a.x);
  const points = records.filter(
    (r) => r.missing < (state.mode === "combined" ? 2000 : 1000),
  );
  return section(
    "activity",
    "测试动态",
    "Evaluation activity",
    card(
      "activity",
      "测试记录与更新时间",
      "每个点对应一条现存测试记录",
      scatter(points, {
        id: "activity",
        dates: true,
        xLabel: "记录更新时间",
        xFormat: dateTime,
      }),
      {
        headers: ["模型", "总分", "状态", "更新时间"],
        data: points.map((p) => [
          p.run.model,
          p.y,
          p.pending ? "评分中" : "已完成",
          p.run.updatedAt,
        ]),
        footer: "空心点为评分中的已确认分 · 显示每条记录当前保存的成绩",
      },
    ) +
      `<div class="activity-list">${
        records
          .slice(0, 6)
          .map(
            (r) =>
              `<div>${badge(r.run, r.color)}<span><strong>${esc(r.run.model)}</strong><small>${date(r.run.updatedAt)} · ${r.pending ? "评分中" : "本榜评分完成"}</small></span><span class="activity-score">${r.missing === (state.mode === "combined" ? 2000 : 1000) ? "未评分" : num(r.y) + (r.pending ? "*" : "")}<small>${modeLabel()}</small></span></div>`,
          )
          .join("") || '<p class="muted">暂无测试记录</p>'
      }</div>`,
  );
}
function worksSection() {
  const palette = colors(),
    works = filtered()
      .filter(
        (r) => r.artifacts?.["one-shot"] || r.artifacts?.["one-more-shot"],
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const unique = [
    ...new Map(works.map((r) => [key(r), r]).reverse()).values(),
  ].reverse();
  return section(
    "works",
    "模型作品",
    "Model deliverables",
    `<div class="home-works">${unique.map((r) => `<article>${badge(r, palette.get(key(r)))}<span class="html-label">HTML</span><h3>${esc(r.model)}</h3><p>${esc(r.title || "体素世界交付作品")}</p><div>${previews(r, true)}</div></article>`).join("") || '<div class="bench-empty">上传单 HTML 后，可以在这里预览模型作品。</div>'}</div><a class="all-works-link" href="#/works">全部作品 ↗</a>`,
  );
}
function render() {
  exports.clear();
  const latest = [...source].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    ),
    complete = leaderboard(source, state.mode).length;
  host.innerHTML = `<div class="board-hero"><div><div class="eyebrow">VOXEL WORLD / INDEPENDENT EVALUATION</div><h1>从作品要求，<br>到可观察的<span>评分。</span></h1><p>开发中平台的真实数据快照。当前 5 条记录均未完成双轮评分；<br>本页用于展示筛选与图表交互，不构成模型优劣结论。</p></div><aside><div><small>最新测试</small><strong>${esc(latest[0]?.model || "等待第一条测试")}</strong><p>${latest[0] ? date(latest[0].updatedAt) + " · 最近更新" : "从首轮题面开始一场完整委托。"}</p><button data-jump="activity">查看动态 ↗</button></div><div><small>当前榜单</small><strong>${complete} 个模型已完成评分</strong><p>${modeLabel()}</p><a href="./scoring-demo.html">体验检查点评分 ↗</a></div></aside></div>
  ${highlights()}<div class="board-mode" role="tablist" aria-label="榜单类型"><button role="tab" aria-selected="${state.mode === "one-shot"}" data-mode="one-shot">One shot <small>1000 + 50</small></button><button role="tab" aria-selected="${state.mode === "combined"}" data-mode="combined">两轮总榜 <small>One shot + One more shot · 2000</small></button></div>
  ${filters()}<div class="board-context"><span>${rows().length} 个模型${state.focus ? " · 已高亮 " + esc(source.find((r) => key(r) === state.focus)?.model || "") : ""}</span><span>图表、坐标与表格使用同一组筛选</span>${state.focus ? "<button data-clear-focus>取消高亮</button>" : ""}</div>
  <div class="home-benchmark"><aside class="home-chart-nav"><nav aria-label="图表导航">${sections.map(([id, title]) => `<button data-jump="${id}"><i></i>${title}</button>`).join("")}</nav></aside><div class="home-charts">${totalSection()}${rankingSection()}${profileSection()}${dimensionsSection()}${usageSection()}${tradeoffSection()}${roundsSection()}${activitySection()}</div></div><button class="back-top" aria-label="回到顶部" data-top>↑</button><div id="chart-tooltip" role="tooltip" hidden></div>`;
  observeSections();
}
function observeSections() {
  if (navFrame) return;
  navFrame = requestAnimationFrame(() => {
    navFrame = null;
    const visible = [...host.querySelectorAll(".bench-section")].filter(
      (el) =>
        el.getBoundingClientRect().top < (window.innerWidth <= 760 ? 100 : 190),
    );
    const active = visible.at(-1)?.id.replace("chart-", "") || "score";
    host
      .querySelectorAll("[data-jump]")
      .forEach((el) =>
        el.classList.toggle("active", el.dataset.jump === active),
      );
  });
}
function jump(section) {
  host
    .querySelector(`#chart-${section}`)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function refresh() {
  if (document.fullscreenElement) {
    const id = document.fullscreenElement.id;
    document
      .exitFullscreen()
      .then(() => {
        refresh();
        return host.querySelector(`#${id}`)?.requestFullscreen();
      })
      .catch((error) => notify(error.message, true));
    return;
  }
  const y = window.scrollY,
    open = [...host.querySelectorAll("[data-popover][open]")].map(
      (el) => el.dataset.popover,
    );
  const active = document.activeElement,
    setting = active?.dataset.setting,
    choice = active?.dataset.modelChoice,
    search = active?.id === "board-search",
    cursor = search ? active.selectionStart : null;
  render();
  open.forEach((id) => {
    const el = host.querySelector(`[data-popover="${id}"]`);
    if (el) el.open = true;
  });
  const target = setting
    ? host.querySelector(`[data-setting="${setting}"]`)
    : choice
      ? host.querySelector(`[data-model-choice="${CSS.escape(choice)}"]`)
      : search
        ? host.querySelector("#board-search")
        : null;
  target?.focus({ preventScroll: true });
  if (search) target?.setSelectionRange(cursor, cursor);
  window.scrollTo({ top: y, behavior: "instant" });
}
export function parseBoardLocation(hash) {
  const params = new URLSearchParams(hash.split("?")[1] || ""),
    result = defaults();
  const enums = {
    mode: ["one-shot", "combined"],
    status: ["all", "complete"],
    sort: ["default", "asc", "desc", "model"],
    axis: ["full", "auto"],
    dimension: ["I", "Q", "E", "C"],
    usage: ["cost", "minutes", "tokens"],
    tradeoff: ["cost", "minutes", "tokens"],
  };
  for (const [id, values] of Object.entries(enums))
    if (values.includes(params.get(id))) result[id] = params.get(id);
  for (const id of ["search", "provider", "profile", "compare"])
    result[id] = params.get(id) || "";
  if ([0, 5, 10, 20].includes(Number(params.get("limit"))))
    result.limit = Number(params.get("limit"));
  for (const id of ["labels", "frontier"])
    result[id] = params.get(id) !== "false";
  if (params.get("selection") === "custom")
    result.models = params.getAll("model");
  return {
    state: result,
    section: sections.some(([id]) => id === params.get("section"))
      ? params.get("section")
      : null,
  };
}
function chartLink(section) {
  const params = new URLSearchParams({ mode: state.mode, section });
  for (const id of [
    "search",
    "provider",
    "status",
    "limit",
    "sort",
    "labels",
    "frontier",
    "axis",
    "dimension",
    "usage",
    "tradeoff",
    "profile",
    "compare",
  ])
    if (state[id] !== defaults()[id]) params.set(id, String(state[id]));
  if (state.models) {
    params.set("selection", "custom");
    state.models.forEach((name) => params.append("model", name));
  }
  return location.origin + location.pathname + "#/leaderboard?" + params;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function downloadImage(id) {
  const entry = exports.get(id),
    cardNode = host.querySelector(`#card-${id}`),
    original = cardNode.querySelector("svg.bench-svg");
  const width = 1600,
    canvas = document.createElement("canvas"),
    context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法导出图表图片");
  let chartHeight;
  if (original) {
    const svg = original.cloneNode(true),
      box = original.viewBox.baseVal;
    chartHeight = Math.round(((width - 100) * box.height) / box.width);
    svg.removeAttribute("style");
    svg.setAttribute("width", width - 100);
    svg.setAttribute("height", chartHeight);
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(svg)], {
        type: "image/svg+xml;charset=utf-8",
      }),
    );
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      canvas.width = width;
      canvas.height = chartHeight + 170;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, canvas.height);
      context.drawImage(img, 50, 110, width - 100, chartHeight);
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    chartHeight = (entry.data.length + 1) * 42 + 25;
    canvas.width = width;
    canvas.height = chartHeight + 170;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, canvas.height);
    const columns = entry.headers.length,
      cellWidth = (width - 100) / columns;
    context.font = "17px Arial";
    [entry.headers, ...entry.data].forEach((row, i) =>
      row.forEach((v, j) => {
        context.fillStyle = i ? "#424d43" : "#171f19";
        context.fillText(
          v == null ? "—" : String(v),
          50 + j * cellWidth,
          135 + i * 42,
          cellWidth - 14,
        );
      }),
    );
  }
  context.fillStyle = "#17221a";
  context.font = "30px Arial";
  context.fillText(entry.title, 50, 50, width - 100);
  context.fillStyle = "#7b877a";
  context.font = "17px Arial";
  context.fillText(
    entry.subtitle +
      (id === "profile"
        ? " · " + entry.data.map((row) => row[0]).join(" / ")
        : ""),
    50,
    83,
    width - 100,
  );
  context.fillText(
    `VoxelBench · ${modeLabel()} · ${date(new Date())}`,
    50,
    canvas.height - 36,
  );
  context.font = "14px Arial";
  context.fillText(entry.footer || "", 50, canvas.height - 14, width - 100);
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("图表图片生成失败");
  download(blob, `VoxelBench-${id}-${state.mode}.png`);
}
function hideTooltip() {
  const tip = host?.querySelector("#chart-tooltip");
  if (tip) tip.hidden = true;
}
function showTooltip(target, x, y) {
  const tip = host.querySelector("#chart-tooltip");
  if (!tip || !target) return;
  if (document.fullscreenElement && !document.fullscreenElement.contains(tip))
    document.fullscreenElement.append(tip);
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  tip.style.left =
    Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 12, x + 16)) +
    "px";
  tip.style.top =
    Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 12, y + 16)) +
    "px";
}
export function unmountBoard() {
  controller?.abort();
  cancelAnimationFrame(navFrame);
  navFrame = null;
  document.body.classList.remove("board-page");
}
export function renderBoard(
  runs,
  { previewButtons, notify: notification } = {},
) {
  unmountBoard();
  host = document.querySelector("#app");
  source = runs;
  previews = previewButtons;
  notify = notification;
  const parsed = parseBoardLocation(location.hash);
  if (location.hash.includes("?")) state = parsed.state;
  document.body.classList.add("board-page");
  controller = new AbortController();
  const options = { signal: controller.signal };
  render();
  host.addEventListener(
    "click",
    async (event) => {
      const el = event.target.closest("button,[data-focus-model]");
      if (!el) return;
      try {
        if (el.dataset.mode) {
          state.mode = el.dataset.mode;
          refresh();
          return;
        }
        if (el.dataset.overview) {
          state.mode = el.dataset.overview;
          refresh();
          jump("score");
          return;
        }
        if (el.dataset.jump) {
          jump(el.dataset.jump);
          return;
        }
        if (el.hasAttribute("data-top")) {
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        if (el.dataset.view) {
          state[el.dataset.view] = el.dataset.value;
          refresh();
          return;
        }
        if (el.dataset.models) {
          state.models = el.dataset.models === "all" ? null : [];
          refresh();
          return;
        }
        if (el.hasAttribute("data-reset")) {
          state = { ...defaults(), mode: state.mode };
          refresh();
          return;
        }
        if (el.hasAttribute("data-clear-focus")) {
          state.focus = "";
          refresh();
          return;
        }
        if (el.dataset.focusModel) {
          state.focus =
            state.focus === el.dataset.focusModel ? "" : el.dataset.focusModel;
          refresh();
          return;
        }
        if (el.dataset.export) {
          const id = el.dataset.chart,
            entry = exports.get(id);
          if (!entry) return;
          if (el.dataset.export === "csv")
            download(
              new Blob([csvText(entry.headers, entry.data)], {
                type: "text/csv;charset=utf-8",
              }),
              `VoxelBench-${id}-${state.mode}.csv`,
            );
          if (el.dataset.export === "image") await downloadImage(id);
          if (el.dataset.export === "link") {
            await navigator.clipboard.writeText(chartLink(entry.section));
            notify("图表链接已复制，包含当前筛选与显示选项");
          }
          if (el.dataset.export === "expand") {
            const target = host.querySelector(`#card-${id}`);
            if (document.fullscreenElement) await document.exitFullscreen();
            else await target.requestFullscreen();
          }
        }
      } catch (error) {
        notify(error.message, true);
      }
    },
    options,
  );
  host.addEventListener(
    "change",
    (event) => {
      const el = event.target;
      if (el.dataset.setting) {
        state[el.dataset.setting] =
          el.type === "checkbox"
            ? el.checked
            : el.dataset.setting === "limit"
              ? Number(el.value)
              : el.value;
        refresh();
      }
      if (el.dataset.modelChoice) {
        const selection = new Set(
          state.models || chartRows(source).map((r) => key(r.run)),
        );
        if (el.checked) selection.add(el.dataset.modelChoice);
        else selection.delete(el.dataset.modelChoice);
        state.models = [...selection];
        refresh();
      }
    },
    options,
  );
  host.addEventListener(
    "input",
    (event) => {
      if (event.target.id === "board-search" && !event.isComposing) {
        state.search = event.target.value;
        refresh();
      }
    },
    options,
  );
  host.addEventListener(
    "compositionend",
    (event) => {
      if (event.target.id === "board-search") {
        state.search = event.target.value;
        refresh();
      }
    },
    options,
  );
  host.addEventListener(
    "pointermove",
    (event) => {
      const target = event.target.closest("[data-tip]");
      if (target) showTooltip(target, event.clientX, event.clientY);
      else hideTooltip();
    },
    options,
  );
  host.addEventListener("pointerleave", hideTooltip, options);
  host.addEventListener(
    "focusin",
    (event) => {
      const target = event.target.closest("[data-tip]");
      if (target) {
        const box = target.getBoundingClientRect();
        showTooltip(target, box.left + box.width / 2, box.top);
      }
    },
    options,
  );
  host.addEventListener("focusout", hideTooltip, options);
  host.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        hideTooltip();
        host
          .querySelectorAll("[data-popover]")
          .forEach((el) => (el.open = false));
      }
      const mark = event.target.closest("[data-focus-model]");
      if (mark && ["Enter", " "].includes(event.key)) {
        event.preventDefault();
        mark.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    },
    options,
  );
  window.addEventListener(
    "scroll",
    () => {
      hideTooltip();
      observeSections();
    },
    options,
  );
  window.addEventListener(
    "resize",
    () => {
      hideTooltip();
      observeSections();
    },
    options,
  );
  if (parsed.section) requestAnimationFrame(() => jump(parsed.section));
}
