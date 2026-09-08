import {
  allParts,
  dimensions,
  efficiency,
  references,
  checklistFor,
} from "../questions/rubric.js";

export const roundNames = {
  "one-shot": "One shot",
  "one-more-shot": "One more shot",
};
export const roundKey = (name) =>
  name === "one-shot" ? "oneShot" : "oneMoreShot";
export const round1 = (value) => Math.round((value + Number.EPSILON) * 10) / 10;
export function blankRound() {
  return {
    scores: {},
    checks: {},
    usage: { cost: null, minutes: null, tokens: null },
    plans: [
      { valid: null, value: null, cost: null },
      { valid: null, value: null, cost: null },
    ],
    notes: "",
  };
}
export function checkpointState(round, part, name = "one-shot") {
  const items = checklistFor(part, name);
  const values = items.map((c, i) => {
    const v = round?.checks?.[part.id]?.[i];
    return [0, c.max / 2, c.max].includes(v) ? v : null;
  });
  const observed = values.filter(v => v != null).length;
  const sum = round1(values.reduce((s, v) => s + (v ?? 0), 0));
  const complete = items.length > 0 && observed === items.length;
  const score = partScore(round, part, name);
  return { items, values, observed, sum, complete, score, adjusted: complete && score !== sum };
}
// 小题是唯一计分来源；拆分未完成时保留旧手评分，完成后才采用拆分合计。
export function setCheckpoint(round, part, index, value, name = "one-shot") {
  const before = checkpointState(round, part, name), item = before.items[index];
  if (!item || ![null, 0, item.max / 2, item.max].includes(value))
    throw new Error("请选择此要点的有效档位");
  round.checks ??= {};
  round.scores ??= {};
  const values = [...before.values];
  values[index] = value;
  round.checks[part.id] = values;
  const after = checkpointState(round, part, name);
  if (after.complete) round.scores[part.id] = after.sum;
  else if (before.complete) round.scores[part.id] = null;
  return checkpointState(round, part, name);
}
export function efficiencyScore(value, metric) {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  const { stops } = metric;
  for (let i = 1; i < stops.length; i++) {
    const [x0, y0] = stops[i - 1],
      [x1, y1] = stops[i];
    if (value <= x1) return round1(y0 + ((y1 - y0) * (value - x0)) / (x1 - x0));
  }
  return stops.at(-1)[1];
}
export function optimizationScore(plan, ref) {
  if (plan?.valid === false) return 0;
  if (plan?.valid !== true || plan.value == null || plan.cost == null)
    return null;
  if (plan.value < ref.value) return 0;
  if (plan.value > ref.value || plan.cost <= ref.cost * 1.05) return 15;
  if (plan.cost <= ref.cost * 1.2) return 10;
  return 5;
}
export function partScore(round, part, name = "one-shot") {
  if (!round) return null;
  const i = Number(part.id.split(".").at(-1)) - 1;
  if (part.criterion === "QD1")
    return round.plans?.[i]?.valid == null
      ? null
      : round.plans[i].valid
        ? 10
        : 0;
  if (part.criterion === "QD2")
    return optimizationScore(round.plans?.[i], references[name][i]);
  return round.scores?.[part.id] ?? (part.dimension === "B" ? 0 : null);
}
// 录分时只比较同轮同题；当前草稿替代本模型的历史记录，不要求整套题评完。
export function nearbyScores(
  runs,
  current,
  item,
  name = "one-shot",
  limit = 2,
) {
  const modelKey = (run) => run.model.trim().toLowerCase();
  const scoreOf = (run) => {
    if (name === "one-more-shot" && item.dimension === "B") return null;
    const round = run?.[roundKey(name)];
    const score = item.stops
      ? efficiencyScore(round?.usage?.[item.id], item)
      : partScore(round, item, name);
    return Number.isFinite(score) && score >= 0 && score <= item.max
      ? round1(score)
      : null;
  };
  const chosen = new Map();
  for (const run of [...runs].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )) {
    const key = modelKey(run),
      score = scoreOf(run);
    if (
      run.id === current.id ||
      key === modelKey(current) ||
      score == null ||
      chosen.has(key)
    )
      continue;
    chosen.set(key, { run, score, current: false });
  }
  const value = scoreOf(current),
    rows = [...chosen.values()];
  if (value != null) rows.push({ run: current, score: value, current: true });
  rows.sort(
    (a, b) => b.score - a.score || a.run.model.localeCompare(b.run.model),
  );
  rows.forEach(
    (row, i) =>
      (row.rank =
        i && row.score === rows[i - 1].score ? rows[i - 1].rank : i + 1),
  );
  const counts = new Map();
  rows.forEach((row) =>
    counts.set(row.score, (counts.get(row.score) || 0) + 1),
  );
  rows.forEach((row) => (row.tied = counts.get(row.score) > 1));
  const currentRow = rows.find((row) => row.current) ?? null;
  const higher =
    value == null
      ? []
      : rows.filter((row) => !row.current && row.score > value);
  const equal =
    value == null
      ? []
      : rows.filter((row) => !row.current && row.score === value);
  const lower =
    value == null
      ? []
      : rows.filter((row) => !row.current && row.score < value);
  return {
    current: currentRow,
    total: rows.length,
    higher: higher.slice(-limit),
    equal: equal.slice(0, limit),
    lower: lower.slice(0, limit),
    equalCount: equal.length,
  };
}
export function summarize(round, name = "one-shot") {
  const result = Object.fromEntries(
    dimensions.map((d) => [d.id, { known: 0, missing: 0, count: 0 }]),
  );
  for (const part of allParts) {
    if (name === "one-more-shot" && part.dimension === "B") continue;
    const value = partScore(round, part, name),
      d = result[part.dimension];
    if (value == null) {
      d.missing += part.max;
      d.count++;
    } else d.known += value;
  }
  for (const metric of efficiency) {
    const score = efficiencyScore(round?.usage?.[metric.id], metric);
    if (score == null) {
      result.C.missing += 50;
      result.C.count++;
    } else result.C.known += score;
  }
  for (const value of Object.values(result)) value.known = round1(value.known);
  const base = round1(
    ["I", "Q", "E", "C"].reduce((n, key) => n + result[key].known, 0),
  );
  const missing = ["I", "Q", "E", "C"].reduce(
    (n, key) => n + result[key].missing,
    0,
  );
  return {
    dimensions: result,
    base,
    bonus: result.B.known,
    missing,
    complete: missing === 0,
    total: round1(base + result.B.known),
  };
}
export function leaderboard(runs, mode = "one-shot") {
  const candidates = runs
    .map((run) => {
      const first = summarize(run.oneShot),
        second = summarize(run.oneMoreShot, "one-more-shot");
      return {
        run,
        first,
        second,
        complete: first.complete && (mode !== "combined" || second.complete),
        score:
          mode === "combined" ? round1(first.base + second.base) : first.total,
      };
    })
    .filter((row) => row.complete)
    .sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
  const latest = new Map();
  for (const row of candidates) {
    const key = row.run.model.trim().toLowerCase();
    if (!latest.has(key)) latest.set(key, row);
  }
  const sorted = [...latest.values()].sort(
    (a, b) => b.score - a.score || a.run.model.localeCompare(b.run.model),
  );
  for (let i = 0; i < sorted.length; i++)
    sorted[i].rank =
      i && sorted[i].score === sorted[i - 1].score ? sorted[i - 1].rank : i + 1;
  return sorted;
}

export function formatTokens(value) {
  if (value == null) return "未记录";
  const format = (n) => n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  if (value >= 100000000) return `${format(value / 100000000)}亿`;
  if (value >= 10000) return `${format(value / 10000)}万`;
  return format(value);
}

// 小题只评分一次。先累积“十分之一分 × 整数百分比”，再统一换算，避免逐项舍入丢分。
export function weightedProfile(run, mode = "one-shot", parts = allParts) {
  const totals = Object.fromEntries(
    ["I", "Q", "E", "C"].map((id) => [
      id,
      { earned: 0, maximum: 0, missing: 0 },
    ]),
  );
  const rounds =
    mode === "combined"
      ? [
          [run?.oneShot, "one-shot"],
          [run?.oneMoreShot, "one-more-shot"],
        ]
      : [[run?.[roundKey(mode)], mode]];
  for (const [round, name] of rounds) {
    for (const part of parts) {
      if (part.dimension === "B") continue;
      const score = partScore(round, part, name);
      for (const id of ["I", "Q", "E"]) {
        const weight = part.weights[id],
          max = part.max * 10 * weight;
        totals[id].maximum += max;
        if (score == null) totals[id].missing += max;
        else totals[id].earned += Math.round(score * 10) * weight;
      }
    }
    for (const metric of efficiency) {
      const score = efficiencyScore(round?.usage?.[metric.id], metric);
      totals.C.maximum += metric.max * 1000;
      if (score == null) totals.C.missing += metric.max * 1000;
      else totals.C.earned += Math.round(score * 10) * 100;
    }
  }
  return Object.fromEntries(
    Object.entries(totals).map(([id, t]) => [
      id,
      {
        earned: t.earned / 1000,
        maximum: t.maximum / 1000,
        missing: t.missing / 1000,
        complete: t.maximum > 0 && t.missing === 0,
        rate:
          t.maximum > 0 && t.missing === 0
            ? (t.earned / t.maximum) * 100
            : null,
      },
    ]),
  );
}

export function weightedLeaderboard(runs, dimension, mode = "one-shot") {
  const latest = new Map();
  for (const run of [...runs].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )) {
    const key = run.model.trim().toLowerCase(),
      profile = weightedProfile(run, mode);
    if (profile[dimension].complete && !latest.has(key))
      latest.set(key, { run, profile, rate: profile[dimension].rate });
  }
  const rows = [...latest.values()].sort(
    (a, b) => b.rate - a.rate || a.run.model.localeCompare(b.run.model),
  );
  rows.forEach(
    (row, i) =>
      (row.rank =
        i && row.rate === rows[i - 1].rate ? rows[i - 1].rank : i + 1),
  );
  return rows;
}

// 与正式榜单使用同一条记录；暂无完整成绩的模型可展示已确认分，仍不参与排名。
export function chartRows(runs, mode = "one-shot") {
  const chosen = new Map();
  for (const run of [...runs].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )) {
    const key = run.model.trim().toLowerCase();
    if (!chosen.has(key)) chosen.set(key, run);
  }
  for (const row of leaderboard(runs, mode))
    chosen.set(row.run.model.trim().toLowerCase(), row.run);
  const colors = [
    "#242424",
    "#be826c",
    "#4488db",
    "#699f65",
    "#7d6ac4",
    "#e38b43",
    "#c86082",
    "#49959b",
  ];
  return [...chosen.values()]
    .sort((a, b) => a.model.localeCompare(b.model))
    .map((run, index) => {
      const first = summarize(run.oneShot),
        second = summarize(run.oneMoreShot, "one-more-shot");
      const summaries = mode === "combined" ? [first, second] : [first];
      const rounds =
        mode === "combined" ? [run.oneShot, run.oneMoreShot] : [run.oneShot];
      const dims = Object.fromEntries(
        dimensions
          .filter((d) => mode !== "combined" || d.id !== "B")
          .map((d) => [
            d.id,
            {
              known: round1(
                summaries.reduce((n, s) => n + s.dimensions[d.id].known, 0),
              ),
              missing: summaries.reduce(
                (n, s) => n + s.dimensions[d.id].missing,
                0,
              ),
              max: d.max * summaries.length,
            },
          ]),
      );
      const usage = Object.fromEntries(
        efficiency.map((m) => {
          const values = rounds.map((r) => r?.usage?.[m.id] ?? null);
          return [
            m.id,
            {
              values,
              total: values.some((v) => v == null)
                ? null
                : values.reduce((a, b) => a + b, 0),
            },
          ];
        }),
      );
      const missing = summaries.reduce((n, s) => n + s.missing, 0);
      return {
        run,
        first,
        second,
        dims,
        usage,
        profile: weightedProfile(run, mode),
        missing,
        color: colors[index % colors.length],
        complete: missing === 0,
        rated: missing < 1000 * summaries.length,
        score:
          mode === "combined" ? round1(first.base + second.base) : first.total,
        capability: round1(
          ["I", "Q", "E"].reduce((n, id) => n + dims[id].known, 0),
        ),
        capabilityMissing: ["I", "Q", "E"].reduce(
          (n, id) => n + dims[id].missing,
          0,
        ),
      };
    });
}
