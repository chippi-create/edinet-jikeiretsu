// keiei.js — 「主な経営指標の状況」1枚
//
// 5期のPL・BS・CF・1株指標を1つの表に並べ、右に売上高の内訳と有価証券の保有状況、所見を置く。
// 数字は全部有報（と短信の今期予想）から機械で出す。BSの区分は有報に当期・前期しか無いので、
// それ以前の年は空欄になる（仕様）。

import { profile } from "./shindan.js";
import { asRatio, segUnit } from "./shikin.js";

const TODO = (w) => `【${w}】`;
const num = (v) => {
  const t = String(v ?? "").replace(/,/g, "").trim();
  if (t === "") return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
};
const fmt = (v) => (v === null || v === undefined || Number.isNaN(v)) ? "—" : Math.round(v).toLocaleString("ja-JP");
const pct = (v, d = 1) => (v === null || v === undefined) ? "—" : `${(v * 100).toFixed(d)}%`;
// 百万円未満は切り捨て（有報・既存の提案書の表記に合わせる。四捨五入だと5,005が5,006になった）。
const mm = (v) => (v === null ? null : Math.trunc(v / 1e6));

export function pageKeiei(ctx) {
  const { fin = {}, ext = {}, sec = {} } = ctx;
  const get = (k, y) => num((fin[k] ?? ext[k])?.[y]);
  const years = [...new Set(["売上高", "純利益", "総資産", "営業CF"]
    .flatMap((k) => Object.keys(fin[k] || {})))].sort().slice(-5);
  const t = ctx.tanshin?.forecast ? ctx.tanshin : null;
  const kessan = Number(String(ctx.kessan || "").replace(/[^\d]/g, "")) || null;
  const head = ["（百万円）", ...years.map((y) => kessan ? `${y}/${String(kessan).padStart(2, "0")}` : y),
    ...(t ? [`${t.period.replace(/年(\d+)月期/, "/$1")}予`] : [])];

  const row = (label, f, fc) => [label, ...years.map((y) => f(y)), ...(t ? [fc ?? ""] : [])];
  const money = (k) => (y) => fmt(mm(get(k, y)));
  const debt = (y) => {
    let s = 0, got = false;
    for (const k of ["短期借入金", "コマーシャルペーパー", "1年内返済長期借入金", "長期借入金", "社債"]) {
      const v = get(k, y); if (v !== null) { s += v; got = true; }
    }
    return got ? fmt(mm(s)) : "—";
  };
  const growth = (y) => {
    const i = years.indexOf(y);
    const prevY = String(Number(y) - 1);
    const a = get("売上高", prevY), b = get("売上高", y);
    return a > 0 && b !== null ? pct(b / a - 1) : "—";
  };
  const ownEquity = (y) => {
    const a = get("総資産", y), r = asRatio(get("自己資本比率", y));
    return a !== null && r !== null ? fmt(mm(a * r)) : "—";
  };
  const fcf = (y) => {
    const o = get("営業CF", y), i = get("投資CF", y);
    return o !== null && i !== null ? fmt(mm(o + i)) : "—";
  };
  const price = (y) => {
    const p = get("株価収益率", y), e = get("EPS", y);
    return p > 0 && e > 0 ? p * e : null;
  };
  const f = t?.forecast;
  const lastSales = get("売上高", years[years.length - 1]);

  const rows = [
    ["PL", ...years.map(() => ""), ...(t ? [""] : [])],
    row("売上高", money("売上高"), f ? fmt(f.売上高) : ""),
    row("伸び率", growth, f && lastSales > 0 ? pct(f.売上高 * 1e6 / lastSales - 1) : ""),
    row("営業利益", money("営業利益"), f ? fmt(f.営業利益) : ""),
    row("経常利益", money("経常利益"), f ? fmt(f.経常利益) : ""),
    row("当期純利益", money("純利益"), f ? fmt(f.純利益) : ""),
    row("1株当たり配当", (y) => { const v = get("1株当たり配当", y); return v === null ? "—" : String(v); }),
    ["BS（資産）", ...years.map(() => ""), ...(t ? [""] : [])],
    row("流動資産", money("流動資産")),
    row("固定資産", money("固定資産")),
    row("総資産", money("総資産")),
    ["BS（負債）", ...years.map(() => ""), ...(t ? [""] : [])],
    row("流動負債", money("流動負債")),
    row("固定負債", (y) => {
      const v = get("固定負債", y);
      if (v !== null) return fmt(mm(v));
      // IFRSは非流動負債を取っていないので、負債合計−流動負債で出す。
      const l = get("負債合計", y), c = get("流動負債", y);
      return l !== null && c !== null ? fmt(mm(l - c)) : "—";
    }),
    row("有利子負債", debt),
    ["BS（純資産）", ...years.map(() => ""), ...(t ? [""] : [])],
    row("純資産", money("純資産")),
    row("資本金", money("資本金")),
    row("自己資本", ownEquity),
    row("自己資本比率", (y) => pct(asRatio(get("自己資本比率", y)))),
    ["キャッシュフロー", ...years.map(() => ""), ...(t ? [""] : [])],
    row("営業CF", money("営業CF")),
    row("投資CF", money("投資CF")),
    row("財務CF", money("財務CF")),
    row("フリーCF", fcf),
    row("現金・現金同等物", money("現金及び現金同等物")),
    ["1株指標", ...years.map(() => ""), ...(t ? [""] : [])],
    row("EPS（円）", (y) => { const v = get("EPS", y); return v === null ? "—" : v.toFixed(0); }),
    row("BPS（円）", (y) => { const v = get("BPS", y); return v === null ? "—" : v.toFixed(0); }),
    row("株価（期末・円）", (y) => { const p = price(y); return p === null ? "—" : fmt(p); }),
    row("PER（倍）", (y) => { const v = get("株価収益率", y); return v === null ? "—" : v.toFixed(1); }),
    row("PBR（倍）", (y) => { const p = price(y), b = get("BPS", y); return p && b > 0 ? (p / b).toFixed(2) : "—"; }),
  ];

  // 右側：売上高の内訳（セグメント）と有価証券の保有状況
  const seg0 = (sec.seg || []).map((s) => [String(s[0] || "").trim(), num(s[1])])
    .filter((s) => s[0] && s[1] !== null);
  // セグメントの単位（千円・百万円・円）を連結売上高との比で判定して円に直す。
  const unit = segUnit(seg0.map((x) => x[1]), get("売上高", years[years.length - 1]));
  const seg = seg0.map(([n, v]) => [n, v * unit]);
  const pf = profile(ctx);
  const h = pf.holdings;

  // 所見は、本人の指定したストーリーで組む：
  //   事業がどうか → 成長性があるのはどこか → 成長を速めるには資金が要る
  //   → 借入だと自己資本比率が下がる（試算）→ エクイティなら成長資金の確保と財務基盤の拡充を両立
  // 数字は機械で出し、「成長性があるのはどこか」だけ下書き（growthArea）を使う。
  const story = keieiStory(ctx, { years, get, seg, pf });
  const items = story.items;

  return {
    no: TODO("ページ番号"),
    title: "主な経営指標の状況",
    lead: story.lead,
    layout: "wideTable",
    tables: [
      { caption: "", head, rows, section: true },
      seg.length ? {
        caption: "売上高の内訳（百万円・直近期）",
        head: ["セグメント", "売上高"],
        rows: seg.map(([n, v]) => [n, fmt(mm(v))]),
      } : null,
      h ? {
        caption: "有価証券の保有状況（直近期末）",
        head: ["区分", "銘柄数", "金額（百万円）"],
        rows: [
          ["政策保有（上場）", h.count === null ? "—" : String(h.count), fmt(mm(h.listed ?? null))],
          ["政策保有（非上場）", "—", fmt(mm(h.unlisted ?? null))],
          ["純投資（上場）", "—", fmt(mm(h.pure ?? null))],
        ],
      } : null,
    ].filter(Boolean),
    blocks: [{ items }],
    notes: [
      "出典：有価証券報告書（EDINET）" + (t ? "、決算短信（今期予想）" : "") + "。" +
      "BSの区分（流動資産・固定資産など）は有報に当期・前期しか無いため、それ以前は空欄。" +
      "株価は期末株価（PER×EPS）。売上高の内訳は直近期のみ。",
    ],
  };
}

const NO_MATERIAL = /材料が足りません|該当する記載はありません/;
const draftOf = (ctx, id) => {
  const v = ctx.drafts?.[id];
  return (typeof v === "string" && v.trim() && !NO_MATERIAL.test(v)) ? v.trim() : null;
};
const oku = (v) => (v === null || v === undefined) ? "—" : `${(v / 1e8).toFixed(1)}億円`;

/**
 * 「主な経営指標の状況」の所見。
 * 事業 → 成長性 → 資金需要 → 借入とエクイティで自己資本比率がどう変わるか → 結論。
 */
export function keieiStory(ctx, { years, get, seg, pf }) {
  const items = [];

  // 事業がどうか：売上の推移と、いちばん大きい事業
  const s0 = get("売上高", years[0]), s1 = get("売上高", years[years.length - 1]);
  const n0 = get("純利益", years[years.length - 1]);
  let biz = "";
  if (s0 > 0 && s1 > 0 && years.length >= 2) {
    const cagr = Math.pow(s1 / s0, 1 / (years.length - 1)) - 1;
    biz += `売上高は${years.length - 1}年で${oku(s0)}→${oku(s1)}（年率${cagr >= 0 ? "+" : "−"}${Math.abs(cagr * 100).toFixed(1)}%）` +
      (n0 !== null ? `、直近期の純利益は${n0 < 0 ? "△" : ""}${oku(Math.abs(n0))}。` : "。");
  }
  if (seg.length) {
    const total = seg.reduce((a, x) => a + x[1], 0);
    const top = [...seg].sort((x, y) => y[1] - x[1])[0];
    if (total > 0) biz += `売上の${Math.round(top[1] / total * 100)}%を${top[0]}が占める。`;
  }
  items.push(biz || TODO("事業の状況を1行"));

  // 成長性があるのはどこか（下書き）
  items.push(draftOf(ctx, "growthArea") || TODO("成長性のある事業・領域を1行"));

  // 成長を速めるには資金が要る。
  // 黒字なのに営業CFがマイナスの会社（不動産の仕入れ・在庫の積み上がり）は、設備投資ではなく
  // 仕入れの資金を借入で賄っている。アグレ都市デザインで「投資年1.6億円、自己資金では28.8億円不足」
  // と書いて実態を取り違えたので、書き分ける。
  const a = pf.cashAnalysis;
  const last3 = years.slice(-3);
  const sum = (k) => { let t = 0, g = false; for (const y of last3) { const v = get(k, y); if (v !== null) { t += v; g = true; } } return g ? t : null; };
  const ope3 = sum("営業CF"), fin3 = sum("財務CF"), net3 = sum("純利益");
  if (ope3 !== null && ope3 < 0 && net3 !== null && net3 > 0) {
    items.push(`利益は出ているが、営業CFは直近${last3.length}期累計で△${oku(-ope3)}（仕入れ・在庫の積み上がりなど）。` +
      (fin3 !== null && fin3 > 0 ? `成長のための資金を借入などで賄っている（財務CF累計＋${oku(fin3)}` +
        (pf.debt ? `、有利子負債${oku(pf.debt)}` : "") + "）。" : "") +
      "成長速度を高めるには、仕入れ・投資のための資金が必要。");
  } else {
    const need = [];
    if (a?.capexPerYear > 0) need.push(`直近3期の投資は年平均${oku(a.capexPerYear)}`);
    if (a?.gap > 0 && a?.opeCf >= 0) need.push(`自己資金では年${oku(a.gap)}不足`);
    items.push("成長速度を高めるには、投資のための資金が必要" + (need.length ? `（${need.join("、")}）。` : "。"));
  }

  // 借入とエクイティで自己資本比率がどう変わるか（調達額は株価を入れたときの予定額）
  const price = ctx.market?.price ?? null;
  const voting = ctx.basis?.voting;
  const raise = price && voting ? price * Math.floor(voting * (ctx.dilution || 0) / 1000) * 1000 : null;
  const assets = get("総資産", years[years.length - 1]);
  const r = pf.eqRatio;
  let lead = TODO("このページの結論を一文で");
  if (raise && assets && r !== null) {
    const e = assets * r;
    const byDebt = e / (assets + raise), byEq = (e + raise) / (assets + raise);
    items.push(`同じ${oku(raise)}を借入で賄うと自己資本比率は${pct(r)}→${pct(byDebt)}に低下、` +
      `エクイティなら${pct(byEq)}に上昇（試算）。`);
    items.push("エクイティファイナンスにより、成長資金の確保と財務基盤の拡充を同時に図れる。");
    lead = `成長投資の資金を確保しつつ、自己資本比率（${pct(r)}）の低下を避けるため、エクイティファイナンスによる財務基盤の拡充が有効`;
  } else {
    items.push(r !== null ? `自己資本比率は${pct(r)}。借入で賄うと自己資本比率は低下する。` : TODO("借入で賄った場合の財務への影響"));
    items.push("エクイティファイナンスにより、成長資金の確保と財務基盤の拡充を同時に図れる。");
  }
  return { items, lead };
}
