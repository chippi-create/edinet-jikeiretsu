// sim2.js — 財務シミュレーション（期末ベース・月次ベース・資金調達考慮後）
//
// 追加の資金調達をしない場合に、現預金と株主資本がいつマイナスになるか（資金ショート・
// 債務超過）を見る。前提は簡略化のため「利益の増減＝現金の増減」。
//   前期末（有報の実績）→ 今期末（短信の今期予想を足す）→ 来期末（今期予想と同程度と仮定）
// 月次は来期の12ヶ月に均等割りで置き、マイナスになる最初の月を出す。
// 資金調達考慮後は、MSワラントの調達額を来期に足す。
//
// 赤字の会社でだけ意味があるので、前期か今期予想の純利益が赤字のときだけページを作る。
// 前提は全部ページに書く。

import { potentialShares } from "./sim.js";

const TODO = (w) => `【${w}】`;
const num = (v) => {
  const t = String(v ?? "").replace(/,/g, "").trim();
  if (t === "") return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
};
const fmt = (v) => (v === null || v === undefined || Number.isNaN(v)) ? "—" : Math.round(v).toLocaleString("ja-JP");
const latestY = (m) => { const ys = Object.keys(m || {}).sort(); return ys.length ? ys[ys.length - 1] : null; };

/** 期末の見込みを組む。単位は百万円。 */
export function simulate(ctx) {
  const { fin = {}, ext = {} } = ctx;
  const y = latestY(fin["純利益"]) || latestY(fin["総資産"]);
  if (!y) return null;
  // 百万円未満は切り捨て（有報の表記に合わせる）。
  const get = (k) => { const v = num((fin[k] ?? ext[k])?.[y]); return v === null ? null : Math.trunc(v / 1e6); };
  const last = {
    year: Number(y),
    売上高: get("売上高"), 営業利益: get("営業利益"), 経常利益: get("経常利益"), 純利益: get("純利益"),
    現預金: get("現金及び現金同等物"),
    資本: (get("資本金") ?? 0) + (get("資本剰余金") ?? 0),
    利益剰余金: get("利益剰余金"),
    株主資本: get("株主資本"),
  };
  const t = ctx.tanshin?.forecast ? ctx.tanshin : null;
  const fcNet = t ? t.forecast.純利益 : last.純利益;
  if (fcNet === null || fcNet === undefined) return null;
  // 赤字でなければ作らない（資金ショートの話にならない）。
  if (!(fcNet < 0 || (last.純利益 !== null && last.純利益 < 0))) return null;

  const pl = (src) => src ? { 売上高: src.売上高, 営業利益: src.営業利益, 経常利益: src.経常利益, 純利益: src.純利益 } : null;
  const cur = { year: last.year + 1, basis: t ? "会社予想" : "前期実績と同程度と仮定", ...pl(t ? t.forecast : last) };
  const next = { year: last.year + 2, basis: "今期予想と同程度と仮定", ...pl(cur) };

  const step = (bs, net, add = 0) => ({
    現預金: bs.現預金 === null ? null : bs.現預金 + net + add,
    資本: bs.資本 + add,
    利益剰余金: bs.利益剰余金 === null ? null : bs.利益剰余金 + net,
    株主資本: bs.株主資本 === null ? null : bs.株主資本 + net + add,
  });
  const bs0 = { 現預金: last.現預金, 資本: last.資本, 利益剰余金: last.利益剰余金, 株主資本: last.株主資本 };
  const bs1 = step(bs0, cur.純利益);
  const bs2 = step(bs1, next.純利益);
  return { last, cur, next, bs0, bs1, bs2, tanshin: t, step };
}

const kessanMonth = (ctx) => Number(String(ctx.kessan || "").replace(/[^\d]/g, "")) || 3;
const ki = (ctx, y) => `${y}年${kessanMonth(ctx)}月期`;

/** 判定の言葉。 */
function flags(bs) {
  const f = [];
  if (bs.現預金 !== null && bs.現預金 < 0) f.push("資金ショート");
  if (bs.株主資本 !== null && bs.株主資本 < 0) f.push("債務超過");
  return f;
}

function simTables(ctx, s, bs2, label2) {
  const head = ["（百万円）", `${ki(ctx, s.last.year)}（実績）`, `${ki(ctx, s.cur.year)}（${s.cur.basis === "会社予想" ? "会社予想" : "推定"}）`, `${ki(ctx, s.next.year)}（${label2}）`];
  return [
    {
      caption: "PL項目", head,
      rows: ["売上高", "営業利益", "経常利益", "純利益"].map((k) =>
        [k, fmt(s.last[k]), fmt(s.cur[k]), fmt(s.next[k])]),
    },
    {
      caption: "BS項目（期末）", head: ["（百万円）", head[1], head[2], head[3]],
      rows: [
        ["現預金", fmt(s.bs0.現預金), fmt(s.bs1.現預金), fmt(bs2.現預金) + (flags(bs2).includes("資金ショート") ? "（資金ショート）" : "")],
        ["資本金・資本剰余金", fmt(s.bs0.資本), fmt(s.bs1.資本), fmt(bs2.資本)],
        ["利益剰余金", fmt(s.bs0.利益剰余金), fmt(s.bs1.利益剰余金), fmt(bs2.利益剰余金)],
        ["株主資本", fmt(s.bs0.株主資本), fmt(s.bs1.株主資本), fmt(bs2.株主資本) + (flags(bs2).includes("債務超過") ? "（債務超過）" : "")],
      ],
      pick: 3,
    },
  ];
}

const premise = (s) => [
  "簡略化のため、利益の増減＝現金の増減と仮定。",
  `今期：${s.tanshin ? `${s.tanshin.announced || ""}公表の決算短信の今期予想` : "今期予想が無いため前期実績と同程度と仮定"}。`,
  "来期：PLは今期予想と同程度と仮定。",
];

/** 期末ベース（資金調達を行わない場合）。 */
export function pageSimEnd(ctx) {
  const s = simulate(ctx);
  if (!s) return null;
  const f1 = flags(s.bs1), f2 = flags(s.bs2);
  const when = f1.length ? ki(ctx, s.cur.year) + "末" : f2.length ? ki(ctx, s.next.year) + "末" : null;
  const what = [...new Set([...f1, ...f2])].join("・");
  return {
    no: TODO("ページ番号"),
    title: "財務シミュレーション（期末ベース）",
    lead: when
      ? `追加の資金調達を行わない場合、${when}時点で${what}となる可能性`
      : `追加の資金調達を行わなくても、${ki(ctx, s.next.year)}末まで現預金・株主資本はプラスを維持する見込み`,
    blocks: [
      { head: "【シミュレーション】", items: [`一定の前提を置き、今期末（${ki(ctx, s.cur.year)}）・来期末（${ki(ctx, s.next.year)}）の現預金と株主資本を推定。`] },
      { head: "【前提】", items: premise(s) },
    ],
    tables: simTables(ctx, s, s.bs2, "推定"),
    notes: ["株主資本は日本基準の株主資本（IFRSは親会社の所有者に帰属する持分）。"],
  };
}

/** 月次ベース。今期末の推定を起点に、来期の12ヶ月を均等割りで置く。 */
export function pageSimMonthly(ctx) {
  const s = simulate(ctx);
  if (!s || s.bs1.現預金 === null) return null;
  const m0 = kessanMonth(ctx);
  const perMonth = s.next.純利益 / 12;
  const cols = [], cash = [], eq = [], ni = [];
  let c = s.bs1.現預金, e = s.bs1.株主資本;
  let firstShort = null, firstNeg = null;
  for (let i = 1; i <= 12; i++) {
    const month = ((m0 + i - 1) % 12) + 1;
    const year = s.cur.year + (m0 + i > 12 ? 1 : 0);
    c += perMonth; if (e !== null) e += perMonth;
    cols.push(`${String(year).slice(2)}/${month}`);
    ni.push(fmt(perMonth)); cash.push(fmt(c)); eq.push(e === null ? "—" : fmt(e));
    if (firstShort === null && c < 0) firstShort = `${year}年${month}月`;
    if (firstNeg === null && e !== null && e < 0) firstNeg = `${year}年${month}月`;
  }
  const parts = [];
  if (firstShort) parts.push(`${firstShort}に資金ショート`);
  if (firstNeg) parts.push(`${firstNeg}に債務超過`);
  return {
    no: TODO("ページ番号"),
    title: "財務シミュレーション（月次ベース）",
    // 13列あるので、右半分では数字が折れる。上に文章、下に全幅の表。
    layout: "stack",
    lead: parts.length
      ? `追加の資金調達を行わない場合、${parts.join("、")}となる可能性`
      : `来期中は現預金・株主資本ともプラスを維持する見込み`,
    blocks: [
      { head: "【シミュレーション】", items: [`一定の前提を置き、${ki(ctx, s.next.year)}の各月末の現預金と株主資本を推定。`] },
      { head: "【前提】", items: [
        "簡略化のため、利益の増減＝現金の増減と仮定。",
        `起点は前ページの${ki(ctx, s.cur.year)}末の推定。来期の純利益（${fmt(s.next.純利益)}百万円）を12ヶ月に均等割り。`,
      ] },
    ],
    tables: [{
      caption: "月次の推移（百万円）",
      head: ["", ...cols],
      rows: [["純利益", ...ni], ["株主資本", ...eq], ["現預金", ...cash]],
    }],
    notes: [],
  };
}

/** 資金調達考慮後。MSワラントの調達額を来期に足す。 */
export function pageSimAfter(ctx) {
  const s = simulate(ctx);
  if (!s) return null;
  const price = ctx.market?.price ?? null;
  const shares = ctx.basis?.voting ? potentialShares(ctx.basis.voting, ctx.dilution) : null;
  const ratio = ctx.terms?.exerciseRatio ?? 1;
  const raise = price && shares ? price * shares * ratio / 1e6 : null;
  if (raise === null) {
    return {
      no: TODO("ページ番号"),
      title: "【資金調達考慮後】財務シミュレーション（期末ベース）",
      lead: TODO("このページの結論を一文で"),
      blocks: [{ items: [TODO("調達額（株価の入力で算出）")] }],
      notes: [],
    };
  }
  const bs2 = s.step(s.bs1, s.next.純利益, raise);
  const before = flags(s.bs2), after = flags(bs2);
  return {
    no: TODO("ページ番号"),
    title: "【資金調達考慮後】財務シミュレーション（期末ベース）",
    lead: before.length && !after.length
      ? `追加の資金調達を行うことで、${ki(ctx, s.next.year)}末時点の${before.join("・")}は回避できる見込み`
      : after.length
        ? `調達後も${ki(ctx, s.next.year)}末時点で${after.join("・")}の可能性。調達額の積み増しか費用の見直しが必要`
        : `調達により、${ki(ctx, s.next.year)}末の現預金は${fmt(bs2.現預金)}百万円の見込み`,
    blocks: [
      { head: "【シミュレーション】", items: [`MSワラントで${fmt(raise)}百万円を調達する前提で、来期末の現預金と株主資本を推定。`] },
      { head: "【前提】", items: [
        ...premise(s),
        `調達額＝基準株価${fmt(price)}円×発行予定株数${fmt(shares)}株` +
        (ratio !== 1 ? `×${Math.round(ratio * 100)}%（行使価額の修正を考慮）` : "") + "。来期中に全額行使と仮定。",
      ] },
    ],
    tables: simTables(ctx, s, bs2, "調達後"),
    notes: ["株主資本は日本基準の株主資本（IFRSは親会社の所有者に帰属する持分）。"],
  };
}
