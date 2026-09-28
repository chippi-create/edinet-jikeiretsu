// gaiyo.js — 有報の要約（読み込んだ直後に出す「この会社のこと」）
//
// 有報は読むのが大変なので、章立ての順にパートごとにまとめる。
//   第1 企業の概況   … 主要な経営指標の推移・沿革・事業の内容・従業員
//   第2 事業の状況   … 経営方針と対処すべき課題・事業等のリスク・経営者による分析
//   第3 設備の状況
//   第4 提出会社の状況 … 株式・配当政策・大株主・役員・株式の保有状況
//   第5 経理の状況   … セグメント情報
// 数字の表はここで機械的に作る。文章のパートは /api/yuho と /api/summarize の要約を画面で差し込む
// （ここでは「どのパートを取りに行くか」だけを返す）。

import { holderLabel, profile } from "./shindan.js";
import { asRatio, segUnit } from "./shikin.js";

// 有報の表は負の数を「△28,705」と書く。△・▲を負の符号として読む。
const num = (v) => {
  const t = String(v ?? "").replace(/,/g, "").replace(/^[△▲]\s*/, "-").trim();
  if (t === "") return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
};
const fmt = (v) => (v === null || v === undefined || Number.isNaN(v)) ? "—" : Math.round(v).toLocaleString("ja-JP");
const mm = (v) => (v === null ? null : Math.trunc(v / 1e6));
const pct = (v, d = 1) => (v === null || v === undefined) ? "—" : `${(v * 100).toFixed(d)}%`;
const oku = (v) => (v === null || v === undefined) ? "—" : `${(v / 1e8).toFixed(1)}億円`;

/** 年度キーを「2026/3」に。 */
const yl = (y, kessan) => { const m = Number(String(kessan || "").replace(/[^\d]/g, "")); return m ? `${y}/${m}` : y; };

/** 主要な経営指標の推移（5期）と、ひとことの読み取り。 */
export function keyTable(ctx) {
  const { fin = {}, ext = {} } = ctx;
  const get = (k, y) => num((fin[k] ?? ext[k])?.[y]);
  const years = [...new Set(["売上高", "純利益", "総資産"].flatMap((k) => Object.keys(fin[k] || {})))].sort().slice(-5);
  const row = (label, f) => [label, ...years.map(f)];
  const money = (k) => (y) => fmt(mm(get(k, y)));
  const rows = [
    row("売上高", money("売上高")),
    row("営業利益", money("営業利益")),
    row("経常利益", money("経常利益")),
    row("当期純利益", money("純利益")),
    row("純資産", money("純資産")),
    row("総資産", money("総資産")),
    row("自己資本比率", (y) => pct(asRatio(get("自己資本比率", y)))),
    row("ROE", (y) => pct(asRatio(get("ROE", y)))),
    row("営業CF", money("営業CF")),
    row("投資CF", money("投資CF")),
    row("財務CF", money("財務CF")),
    row("現金・現金同等物", money("現金及び現金同等物")),
    row("1株当たり配当（円）", (y) => { const v = get("1株当たり配当", y); return v === null ? "—" : String(v); }),
    row("従業員数（人）", (y) => fmt(get("従業員数", y))),
  ].filter((r) => r.slice(1).some((c) => c !== "—"));

  // ひとこと：売上の伸びと、利益・キャッシュの向き
  const notes = [];
  const s0 = get("売上高", years[0]), s1 = get("売上高", years[years.length - 1]);
  if (s0 > 0 && s1 > 0 && years.length >= 2) {
    const cagr = Math.pow(s1 / s0, 1 / (years.length - 1)) - 1;
    notes.push(`売上高は${years.length - 1}年で${oku(s0)}→${oku(s1)}（年率${cagr >= 0 ? "+" : "−"}${Math.abs(cagr * 100).toFixed(1)}%）。`);
  }
  const nets = years.map((y) => get("純利益", y)).filter((v) => v !== null);
  const loss = nets.filter((v) => v < 0).length;
  if (nets.length) {
    notes.push(loss === 0 ? `最終損益は${nets.length}期とも黒字。`
      : loss === nets.length ? `最終損益は${nets.length}期とも赤字。` : `最終損益は${nets.length}期のうち${loss}期が赤字。`);
  }
  const opes = years.slice(-3).map((y) => get("営業CF", y)).filter((v) => v !== null);
  if (opes.length) {
    const neg = opes.filter((v) => v < 0).length;
    if (neg === opes.length) notes.push(`営業CFは直近${opes.length}期ともマイナス。`);
  }
  return { head: ["（百万円）", ...years.map((y) => yl(y, ctx.kessan))], rows, notes };
}

/** 沿革。設立・上場・商号変更などの節目に印を付ける。 */
export function historyRows(hist) {
  return (hist || []).map(([ym, what]) => ({
    ym, what,
    mark: /設立|創業/.test(what) ? "設立" : /上場|市場第|市場へ|市場に/.test(what) ? "上場"
      : /商号|社名/.test(what) ? "商号変更" : /持株会社|合併|買収|子会社化|譲受/.test(what) ? "再編・M&A" : "",
  }));
}

/** セグメント情報（直近期）。単位は連結売上高との比で判定する。 */
export function segmentRows(ctx) {
  const seg = (ctx.sec?.seg || []).map((s) => ({ name: String(s[0] || "").trim(), sales: num(s[1]), profit: num(s[2]) }))
    .filter((s) => s.name && s.sales !== null);
  if (!seg.length) return [];
  const ys = Object.keys(ctx.fin?.["売上高"] || {}).sort();
  const unit = segUnit(seg.map((s) => s.sales), num(ctx.fin?.["売上高"]?.[ys[ys.length - 1]]));
  const total = seg.reduce((a, s) => a + (s.sales > 0 ? s.sales : 0), 0);
  return seg.map((s) => ({
    name: s.name,
    sales: s.sales * unit, profit: s.profit === null ? null : s.profit * unit,
    share: total > 0 ? s.sales / total : null,
    margin: s.profit !== null && s.sales > 0 ? s.profit / s.sales : null,
  }));
}

/** 株式・株主・役員の要点。 */
export function stockFacts(ctx) {
  const pf = profile(ctx);
  const x = ctx.ext || {};
  const last = (k) => { const m = x[k]; if (!m) return null; const ys = Object.keys(m).sort(); return num(m[ys[ys.length - 1]]); };
  const own = ctx.sec?.own || [];
  const total = own.find((r) => /^計$/.test(String(r[0] || "").trim()));
  const officers = (ctx.sec?.of || []).map((r) => ({ role: String(r[0] || "").replace(/\s+/g, " ").trim(), name: String(r[1] || "").replace(/\s*注\s*\d+/g, "").trim() }));
  const reps = officers.filter((o) => /代表/.test(o.role));
  return {
    issued: last("発行済株式数") ?? last("発行済株式総数_期末"),
    treasury: last("自己株式数"),
    unit: last("単元株式数"),
    holdersCount: total ? num(total[1]) : null,
    reps: reps.map((o) => `${o.role} ${holderLabel(o.name, "個人")}`),
    officerCount: officers.length,
    top: pf.holders.slice(0, 10).map((h) => ({ label: h.label, kind: h.kind, ratio: h.ratio, shares: h.shares })),
    own: pf.own,
    holdings: pf.holdings,
  };
}

/** 要約を取りに行く文章パート（有報の章の名前と、/api/yuho のパート名）。 */
export const TEXT_PARTS = [
  { chapter: 2, part: "policy", title: "経営方針、経営環境及び対処すべき課題等" },
  { chapter: 2, part: "risk", title: "事業等のリスク" },
  { chapter: 2, part: "mdna", title: "経営者による財政状態、経営成績及びキャッシュ・フローの状況の分析" },
  { chapter: 3, part: "facilities", title: "設備の状況" },
  { chapter: 4, part: "dividend", title: "配当政策" },
];
