// backup.js — MSワラント提案の「バックアッププラン」1枚
//
// 成長投資にお金を使う代わりに、
//   ① 何にいくら使うか（成長投資）
//   ② その代わりにどこを削るか（コスト削減）
//   ③ 投資と成果をどう管理するか
//   ④ 投資資金を確保できなかった場合にどうするか
// を1枚にまとめる。
//
// 数字は機械で出す（販管費、1%削減の効果、中計に要る利益の伸び、行使の進み方ごとの調達額、
// 不足を埋める手元資金・保有株・借入の余地）。取り組みの中身はAIの下書き（costCut / investKpi）
// か【　】。④は「行使が進まなかった場合」という仕組みの話として書き、会社の信用や審査には触れない。

import { potentialShares } from "./sim.js";
import { analyze } from "./shikin.js";
import { profile } from "./shindan.js";

const TODO = (w) => `【${w}】`;
const NO_MATERIAL = /材料が足りません|該当する記載はありません/;
const num = (v) => {
  const t = String(v ?? "").replace(/,/g, "").trim();
  if (t === "") return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
};
const oku = (v) => (v === null || v === undefined) ? "—" : `${(v / 1e8).toFixed(1)}億円`;
const pct = (v, d = 1) => (v === null || v === undefined) ? "—" : `${(v * 100).toFixed(d)}%`;
const latest = (m) => { if (!m) return null; const ys = Object.keys(m).sort(); return ys.length ? num(m[ys[ys.length - 1]]) : null; };

function draftLines(ctx, id, label, n = 2) {
  const v = ctx.drafts?.[id];
  if (typeof v === "string" && v.trim() && !NO_MATERIAL.test(v)) {
    return v.split(/\r?\n/).map((t) => t.replace(/^[・\-\s]+/, "").trim()).filter(Boolean);
  }
  return Array.from({ length: n }, () => TODO(label));
}

/**
 * 販管費。有報に販管費の合計は取っていないので、売上高−売上原価−営業利益で出す。
 * 売上原価が取れていない会社（IFRSの一部・サービス業）は出せない。
 */
function sga(fin, ext) {
  const pick = (k) => latest(fin[k]) ?? latest(ext[k]);
  const s = pick("売上高"), c = pick("売上原価"), o = pick("営業利益");
  if (!(s > 0) || c === null || o === null) return null;
  const v = s - c - o;
  return v > 0 ? { amount: v, ratio: v / s, sales: s } : null;
}

export function pageBackup(ctx) {
  const { fin = {}, ext = {}, basis = {}, market = {}, dilution, terms = {} } = ctx;
  const price = market.price ?? null;
  const shares = basis.voting ? potentialShares(basis.voting, dilution) : null;
  const full = price && shares ? price * shares : null;
  const floorR = terms.floorRatio ?? null;

  // ① 成長投資
  const capex = latest(ext["設備投資"]);
  const rd = latest(ext["研究開発費"]);
  const invest = [
    full ? `調達予定額 ${oku(full)}（基準株価×発行予定株数）を、次の成長投資に充てる。`
      : TODO("調達予定額（株価を入れると計算します）"),
    ...draftLines(ctx, "useOfFunds", "資金使途と金額・時期", 1).slice(0, 2),
    (capex !== null || rd !== null)
      ? `参考：直近期の実績は${capex !== null ? `設備投資${oku(capex)}` : ""}` +
        `${capex !== null && rd !== null ? "、" : ""}${rd !== null ? `研究開発費${oku(rd)}` : ""}。`
      : null,
  ].filter(Boolean);

  // ② コスト削減
  const g = sga(fin, ext);
  const cost = [
    g ? `販管費は${oku(g.amount)}（売上高の${pct(g.ratio)}）。1%削減で年${oku(g.amount * 0.01)}、` +
        `5%削減で年${oku(g.amount * 0.05)}の利益押し上げ。`
      : TODO("販管費の規模（売上原価が取れていないため計算できません）"),
    ...draftLines(ctx, "costCut", "コスト削減・効率化の具体策", 2),
  ];

  // ③ 投資と成果の管理
  const opNow = latest(fin["営業利益"]);
  const ck = ctx.chukei;
  const manage = [];
  if (ck?.op > 0 && full) {
    // 中計の営業利益目標まで、いくら利益を増やす必要があるか。投資額と比べる。
    const add = ck.op * 1e6 - (opNow ?? 0);
    manage.push(add > 0
      // 上積みは事業全体で出すもので、投資だけで出すものではない。比較は「相当」にとどめる。
      ? `中計（${ck.year}）の営業利益目標まで年${oku(add)}の上積みが要る（調達額${oku(full)}の${pct(add / full)}に相当）。` +
        "投資ごとに利益の見込みと回収の時期を置いて管理する。"
      : `中計（${ck.year}）の営業利益目標は、直近期の実績で既に上回っている。`);
  } else {
    manage.push(TODO("投資に対して求める利益の水準（中計目標と株価を入れると計算します）"));
  }
  manage.push(...draftLines(ctx, "investKpi", "投資の管理指標と見直しの仕組み", 2));

  // ④ 資金を確保できなかった場合
  const a = analyze({ fin, ext, opts: ctx.cashOpts || {} });
  const pf = profile(ctx);
  const cashFree = a.noSales ? null : Math.max(0, a.headroom?.free ?? 0);
  const stocks = pf.holdings?.sellable || 0;
  // 借入の余地。有利子負債がEBITDAの5倍に収まる範囲まで。赤字なら出さない。
  const ebitda = a.fit?.ebitda ?? null;
  const debtRoom = ebitda !== null && ebitda > 0
    ? Math.max(0, ebitda * (a.opts.debtEbitdaLimit || 5) - (a.debt?.total || 0)) : null;

  const scen = [];
  if (full) {
    scen.push(["全額行使（基準株価）", full]);
    if (floorR) scen.push([`全額行使（下限行使価額：基準の${pct(floorR, 0)}）`, full * floorR]);
    scen.push(["半分だけ行使", full * 0.5]);
  }
  const rows = scen.map(([label, got]) => {
    const gap = full - got;
    return [label, oku(got), gap > 0 ? oku(gap) : "—"];
  });

  const fallback = [];
  const worst = scen.length ? full - Math.min(...scen.map((s) => s[1])) : null;
  const cover = (cashFree || 0) + stocks + (debtRoom || 0);
  if (worst !== null && worst > 0) {
    fallback.push(`行使が進まず最大${oku(worst)}不足した場合、次の順で埋める。`);
  } else {
    fallback.push(TODO("不足額（株価を入れると、行使の進み方ごとに計算します）"));
  }
  if (cashFree !== null) {
    fallback.push(`手元資金：月商の目安を置いたうえで使える${oku(cashFree)}。`);
  } else if (a.runway?.burn > 0 && a.cash !== null) {
    // 売上の無い会社。現預金はあっても毎年減っているので「使える」とは書けない（サンバイオ）。
    fallback.push(`手元資金：${oku(a.cash)}あるが年${oku(a.runway.burn)}ずつ減っており（約${a.runway.years.toFixed(1)}年分）、` +
      "充てると資金の持ちが短くなる。");
  }
  if (pf.holdings === null) {
    fallback.push("保有株の売却：政策保有株のデータを取得中（2026年10月上旬までに全社）。");
  } else if (stocks > 0) {
    fallback.push(`保有株の売却：上場株${oku(stocks)}（政策保有・純投資）。`);
  }
  fallback.push(debtRoom !== null
    ? `借入：有利子負債がEBITDAの${a.opts.debtEbitdaLimit || 5}倍に収まる範囲で${oku(debtRoom)}の余地。`
    : "借入：EBITDAがマイナスのため、利益を返済の裏付けにした借入は組みにくい。");
  if (worst !== null && worst > 0 && cover >= worst) {
    fallback.push(`手元資金・保有株・借入の余地（計${oku(cover)}）で、不足分を賄える水準。`);
  }
  fallback.push(worst !== null && worst > 0 && cover < worst
    ? `それでも残る${oku(worst - cover)}は、投資の優先順位を付けて時期を後ろ倒しにする。`
    : "投資の優先順位と、後ろ倒しにできる投資を事前に決めておく。");
  fallback.push(TODO("行使の状況を見て投資を止める・進める判断の時期"));

  return {
    no: TODO("ページ番号"),
    title: "バックアッププラン",
    // PPTXでは4つの枠を2×2に並べる（1枚に収めるため）。画面は通常どおり。
    layout: "grid4",
    lead: worst !== null && worst > 0
      ? `成長投資と並行してコストを抑え、行使が進まず最大${oku(worst)}不足しても投資を続けられる備えを置く`
      : TODO("このページの結論を一文で"),
    blocks: [
      { head: "①成長投資（資金の使い道）", items: invest },
      { head: "②その代わりのコスト削減", items: cost },
      { head: "③投資と成果の管理", items: manage },
      { head: "④投資資金を確保できなかった場合", items: fallback },
    ],
    tables: rows.length ? [{
      caption: "行使の進み方ごとの調達額",
      head: ["", "調達額", "予定との差"],
      rows,
      note: "下限行使価額は画面で入れたときだけ計算します。",
    }] : [],
    notes: [
      "販管費＝売上高−売上原価−営業利益（有価証券報告書の直近期）。",
      "借入の余地は、有利子負債がEBITDAの5倍に収まる範囲で置いた目安。金利と借入条件で変わります。",
    ],
  };
}
