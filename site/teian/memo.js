// memo.js — 考え方のメモ（提案書には入れない）
//
// 提案の筋道を、材料つきの箇条書きで並べる。画面にだけ出し、PPTXには入れない。
//   ① なぜ資金調達が必要か：業績 → 株価 → 事業の拡大 → 資金需要 → だから資金調達
//   ② どう調達するか：借入ではなくエクイティ → 公募増資ではなくMSワラント → 実施時期 → 発行概要
//   ③ 本人から続きを聞いてから足す
// 数字は機械で出す。判断が要るところは【　】。手法の違いは仕組み（準備期間・資金が入る時期・
// 調達額の確定・希薄化の制御）で書き、信用や審査の話にはしない。

import { profile, diagnose } from "./shindan.js";
import { progress } from "./genjo.js";
import { potentialShares, maxDilutionFor } from "./sim.js";
import { simulate } from "./sim2.js";

const TODO = (w) => `【${w}】`;
const NO_MATERIAL = /材料が足りません|該当する記載はありません/;
const num = (v) => {
  const t = String(v ?? "").replace(/,/g, "").trim();
  if (t === "") return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
};
const fmt = (v) => (v === null || v === undefined || Number.isNaN(v)) ? "—" : Math.round(v).toLocaleString("ja-JP");
const pct = (v, d = 1) => (v === null || v === undefined) ? "—" : `${(v * 100).toFixed(d)}%`;
const oku = (v) => (v === null || v === undefined) ? "—" : `${(v / 1e8).toFixed(1)}億円`;
const draft = (ctx, id) => {
  const v = ctx.drafts?.[id];
  return (typeof v === "string" && v.trim() && !NO_MATERIAL.test(v)) ? v.trim() : null;
};
const firstLine = (v) => v ? v.split(/\r?\n/).map((x) => x.replace(/^[・\-\s]+/, "").trim()).filter(Boolean)[0] : null;

export function buildMemo(ctx) {
  const fin = ctx.fin || {}, ext = ctx.ext || {};
  const pf = profile(ctx);
  const a = pf.cashAnalysis;
  const ys = Object.keys(fin["売上高"] || fin["純利益"] || {}).sort();
  const get = (k, y) => num((fin[k] ?? ext[k])?.[y]);
  const t = ctx.tanshin?.forecast || ctx.tanshin?.actual ? ctx.tanshin : null;

  // ---- ① なぜ資金調達が必要か ----
  const perf = [];
  if (ys.length >= 2) {
    const s0 = get("売上高", ys[0]), s1 = get("売上高", ys[ys.length - 1]);
    const n1 = get("純利益", ys[ys.length - 1]);
    if (s0 > 0 && s1 > 0) perf.push(`売上高 ${oku(s0)}（${ys[0]}）→${oku(s1)}（${ys[ys.length - 1]}）`);
    if (n1 !== null) perf.push(`直近期の純利益 ${n1 < 0 ? "△" : ""}${oku(Math.abs(n1))}`);
  }
  if (t?.forecast) perf.push(`今期予想 売上高${fmt(t.forecast.売上高)}百万円・営業利益${fmt(t.forecast.営業利益)}百万円（${t.announced || ""}短信）`);
  const pg = progress(t, fin);
  const sr = pg?.rows.find((r) => r.item === "売上高" && r.verdict);
  if (sr) perf.push(`${pg.label}の売上進捗 ${pct(sr.rate)}（前年同期${pct(sr.prate)}）→ ${sr.verdict}`);

  const stock = [];
  if (pf.price) stock.push(`株価 ${fmt(pf.price)}円（${pf.priceBasis}）`);
  if (pf.mcap) stock.push(`時価総額 ${oku(pf.mcap)}`);
  if (pf.per) stock.push(`PER ${pf.per.toFixed(1)}倍（有報の期末）`);
  if (pf.pbr !== null) stock.push(`PBR ${pf.pbr.toFixed(2)}倍`);
  stock.push(TODO("直近の株価の動きと、その理由（決算・テーマ・需給）"));

  const grow = [
    draft(ctx, "growthArea") || TODO("成長性のある事業・領域"),
    firstLine(draft(ctx, "chukeiFocus")) || TODO("中計で拡大したい事業"),
  ];
  if (ctx.chukei?.year) grow.push(`中計の目標年度 ${ctx.chukei.year}` +
    (ctx.chukei.sales ? `・売上高${fmt(ctx.chukei.sales)}百万円` : "") + (ctx.chukei.op ? `・営業利益${fmt(ctx.chukei.op)}百万円` : ""));

  const need = [];
  const y3 = ys.slice(-3);
  const sum = (k) => { let s = 0, g = false; for (const y of y3) { const v = get(k, y); if (v !== null) { s += v; g = true; } } return g ? s : null; };
  const ope3 = sum("営業CF"), fin3 = sum("財務CF"), net3 = sum("純利益");
  if (ope3 !== null) need.push(`営業CF 直近${y3.length}期累計 ${ope3 < 0 ? "△" : ""}${oku(Math.abs(ope3))}` +
    (ope3 < 0 && net3 > 0 ? "（黒字だが仕入れ・在庫で現金が出ていく）" : ""));
  if (fin3 !== null && fin3 > 0) need.push(`財務CF 累計＋${oku(fin3)}（借入などで資金を補っている）`);
  if (pf.debt) need.push(`有利子負債 ${oku(pf.debt)}・自己資本比率 ${pct(pf.eqRatio)}`);
  if (a?.noSales && a.runway?.years) need.push(`年${oku(a.runway.burn)}ずつ現金が減り、現預金は約${a.runway.years.toFixed(1)}年分`);
  const s = simulate(ctx);
  if (s && s.bs2.現預金 !== null && s.bs2.現預金 < 0) need.push(`追加調達なしでは来期末に現預金が${fmt(s.bs2.現預金)}百万円（資金ショート）`);
  need.push("→ だから資金調達が必要");

  // ---- ② どう調達するか ----
  const price = ctx.market?.price ?? null;
  const voting = ctx.basis?.voting;
  const shares = voting ? potentialShares(voting, ctx.dilution) : null;
  const raise = price && shares ? price * shares : null;
  const assets = pf.assets, r = pf.eqRatio;

  const whyEquity = [];
  if (raise && assets && r !== null) {
    const e = assets * r;
    whyEquity.push(`${oku(raise)}を借入で賄うと自己資本比率 ${pct(r)}→${pct(e / (assets + raise))}、エクイティなら${pct((e + raise) / (assets + raise))}`);
  }
  for (const p of a?.fit?.points || []) if (p.side === "equity") whyEquity.push(p.text);
  whyEquity.push("→ 返済の要らない資金で成長投資を賄い、財務基盤も厚くできる");

  const whyMS = [];
  const loss = pf.op !== null && pf.op < 0;
  if (loss) whyMS.push("営業赤字：業績の回復を見ながら段階的に資金を入れられる");
  if (pf.mcap && pf.mcap < 300e8) whyMS.push(`時価総額${oku(pf.mcap)}：一度に大きく発行するより、株価に応じて行使を進める方が需給への影響を抑えやすい`);
  whyMS.push("準備期間が短く、決算発表後のウィンドウに合わせやすい");
  whyMS.push("行使の進み方で希薄化の速さを調整でき、株価が上がれば調達額も増える");
  whyMS.push("公募増資は調達額が一度に確定する一方、準備期間が長め");
  const wm = draft(ctx, "whyMethod");
  if (wm) whyMS.push(...wm.split(/\r?\n/).map((x) => x.replace(/^[・\-\s]+/, "").trim()).filter(Boolean).slice(0, 3));

  const when = [];
  if (t?.announced) when.push(`直近の決算短信 ${t.announced}（${t.quarter}）→ 次の決算発表の後がウィンドウ`);
  else when.push(TODO("直近と次回の決算発表日"));
  if (ctx.chukei?.year) when.push("中期経営計画の公表と合わせると、資金使途と成長の説明をそろえやすい");
  when.push("決算・中計の公表直後は、会社から出ている情報が最新で、未公表の重要事実を抱えにくい");
  when.push(TODO("具体的な実施ウィンドウ"));

  const terms = [];
  const cur = ctx.stable?.ratio ?? null;
  const cap = cur !== null ? maxDilutionFor(cur, ctx.stable?.keep ?? 0.5) : null;
  terms.push(`希薄化率 ${pct(ctx.dilution)}` + (cap > 0 ? `（${ctx.stable.label || "安定株主"}の議決権${pct(ctx.stable.keep ?? 0.5, 0)}超を保てる上限は${pct(cap)}）`
    : cur !== null ? `（${ctx.stable.label || "安定株主"}は現状${pct(cur)}で、維持の上限は置けない）` : ""));
  if (shares) terms.push(`発行予定株数 ${fmt(shares)}株（議決権株式数${fmt(voting)}株×${pct(ctx.dilution)}）`);
  if (raise) terms.push(`調達予定額 ${oku(raise)}（基準株価${fmt(price)}円）`);
  if (ctx.terms?.floorRatio) terms.push(`下限行使価額 基準の${pct(ctx.terms.floorRatio, 0)}：株価が下がっても最低限の調達額を見込める水準か`);
  terms.push(TODO("行使期間・修正条項の考え方"));

  const top = diagnose(ctx, pf).slice(0, 3).map((i) => `${i.title}（候補：${String(i.products[0] || "").replace(/（.*$/, "")}）`);

  return [
    { head: "① なぜ資金調達が必要か", subs: [
      { head: "業績", items: perf.length ? perf : [TODO("業績")] },
      { head: "株価", items: stock },
      { head: "事業の拡大", items: grow },
      { head: "資金需要", items: need },
    ] },
    { head: "② どう調達するか", subs: [
      { head: "借入ではなくエクイティ", items: whyEquity },
      { head: "公募増資ではなくMSワラント", items: whyMS },
      { head: "実施時期", items: when },
      { head: "発行概要", items: terms },
    ] },
    { head: "参考：数字から見える論点", items: top.length ? top : ["数字の条件に当たる論点なし"] },
    { head: "③", items: [TODO("続きの項目（本人に確認中）")] },
  ];
}
