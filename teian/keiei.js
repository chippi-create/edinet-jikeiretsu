// keiei.js — 「主な経営指標の状況」1枚
//
// 5期のPL・BS・CF・1株指標を1つの表に並べ、右に売上高の内訳と有価証券の保有状況、所見を置く。
// 数字は全部有報（と短信の今期予想）から機械で出す。BSの区分は有報に当期・前期しか無いので、
// それ以前の年は空欄になる（仕様）。

import { profile } from "./shindan.js";
import { asRatio } from "./shikin.js";

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
  const seg = (sec.seg || []).map((s) => [String(s[0] || "").trim(), num(s[1])])
    .filter((s) => s[0] && s[1] !== null);
  const pf = profile(ctx);
  const h = pf.holdings;

  // 所見は数字から言える事実だけ。評価や方向性は【　】で空ける。
  const net = years.map((y) => get("純利益", y)).filter((v) => v !== null);
  const lossYears = net.filter((v) => v < 0).length;
  const items = [
    net.length
      ? (lossYears === 0 ? `直近${net.length}期は最終黒字を継続。`
        : lossYears === net.length ? `直近${net.length}期は最終赤字が継続。`
        : `直近${net.length}期のうち${lossYears}期が最終赤字。`) +
        (pf.cash !== null ? `現預金は${(pf.cash / 1e8).toFixed(1)}億円` : "") +
        (h && (h.sellable || h.total) ? `、保有する有価証券（上場）は${((h.sellable || 0) / 1e8).toFixed(1)}億円。` : "。")
      : null,
    pf.eqRatio !== null ? `自己資本比率は${pct(pf.eqRatio)}。` : null,
    TODO("中期経営計画の進捗と、今期以降の見通しを1〜2行"),
    TODO("今後の投資と財務基盤の課題を1行"),
  ].filter(Boolean);

  return {
    no: TODO("ページ番号"),
    title: "主な経営指標の状況",
    lead: TODO("このページの結論を一文で"),
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
