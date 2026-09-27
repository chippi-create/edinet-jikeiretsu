// ronten.js — 「ファイナンスに向けた個別論点（想定）」と「エクイティストーリー」
//
// 個別論点は3本立て：①業績（足元の進捗と今期予想）②中期経営計画 ③議決権。
// ③には、安定株主それぞれの議決権比率が希薄化率5〜10%と上限でどう下がるかの表を付ける。
// エクイティストーリーは、見出し（何のための調達か）→ 今回ファイナンス → 左「資金の確保」
// 右「財務基盤の強化」→ 目指す姿。数字は機械、文章は下書きか【　】。

import { shareholders } from "./teian.js";
import { progress, chukeiGap } from "./genjo.js";
import { maxDilutionFor, dilutedRatio, potentialShares } from "./sim.js";
import { analyze, asRatio } from "./shikin.js";

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
const lines = (v, n) => v ? v.split(/\r?\n/).map((x) => x.replace(/^[・\-\s]+/, "").trim()).filter(Boolean).slice(0, n) : [];

// ---- ファイナンスに向けた個別論点（想定） ---------------------------------

export function pageRonten(ctx) {
  const t = ctx.tanshin?.forecast || ctx.tanshin?.actual ? ctx.tanshin : null;
  const fin = ctx.fin || {};

  // 論点①業績
  const r1 = [];
  if (t?.forecast) {
    const f = t.forecast;
    const ys = Object.keys(fin["営業利益"] || {}).sort();
    const lastOp = num(fin["営業利益"]?.[ys[ys.length - 1]]);
    const turn = lastOp !== null && lastOp < 0 && f.営業利益 > 0;
    r1.push(`${t.period}の会社予想は営業${f.営業利益 < 0 ? "損失" : "利益"}${fmt(Math.abs(f.営業利益))}百万円` +
      (turn ? "で、黒字転換が計画。" : "。"));
    const pg = progress(t, fin);
    const s = pg?.rows.find((r) => r.item === "売上高" && r.rate !== null);
    if (s) {
      r1.push(`${pg.label}の売上進捗は${pct(s.rate)}` +
        (s.prate !== null ? `（前年同期${pct(s.prate)}）で${s.verdict}。` : "。") +
        (turn ? "今期業績の達成確度が論点。" : ""));
    }
  } else {
    r1.push(TODO("今期予想と足元の進捗（決算短信の読み込みで入る）"));
  }
  r1.push(TODO("決議の時期（決算発表後のウィンドウ）と、その時点で示せる業績の根拠"));

  // 論点②中期経営計画
  const r2 = [];
  const ck = ctx.chukei && (ctx.chukei.sales || ctx.chukei.op) ? ctx.chukei : null;
  if (ck) r2.push(`「中期経営計画」の目標年度は${ck.year}。`);
  const focus = lines(draft(ctx, "chukeiFocus"), 2);
  r2.push(...(focus.length ? focus : [TODO("中計の注力分野と、マーケットの関心を集めそうなテーマ")]));
  if (ck) {
    const fyOf = (x) => { const m = /(\d{4})/.exec(String(x || "")); return m ? Number(m[1]) : null; };
    const base = t?.forecast || null;
    const g = base ? chukeiGap(ck, base, fyOf(t.period), fin) : null;
    const r = g?.rows.find((x) => x.base > 0 && x.need !== null);
    if (r && r.need > 0) {
      r2.push(`${r.item}目標まで` + (g.years === 1 ? `来期${(r.target / r.base).toFixed(1)}倍` : `年${pct(r.need)}`) +
        `の伸びが必要で、計画の策定根拠が論点。`);
    }
  }

  // 論点③議決権
  const st = ctx.stable;
  const keep = st?.keep ?? 0.5;
  const label = st?.label || "安定株主";
  const r3 = ["エクイティファイナンスを行う場合、株式の発行に伴い" + label + "の議決権比率は低下。"];
  let table = null;
  if (st?.ratio != null) {
    const cap = maxDilutionFor(st.ratio, keep);
    r3.push(`現状、${label}の議決権比率（近親者含む）は${pct(st.ratio)}程度と推定。`);
    const voting = ctx.basis?.voting;
    r3.push(cap > 0
      ? `${label}の議決権比率が${pct(keep, 0)}超を維持できる最大希薄化は${pct(cap)}と推定` +
        (voting ? `（推定発行予定株数：${fmt(potentialShares(voting, cap))}株）。` : "。")
      : `既に${pct(keep, 0)}を下回っており、維持を前提とした上限は置けない。`);
    const list = shareholders(ctx.sec?.sh);
    const rows = (st.picked || []).map((i) => list[i]).filter(Boolean);
    if (rows.length && voting) {
      const scen = [0.05, 0.06, 0.07, 0.08, 0.09, 0.10, ...(cap > 0.10 ? [cap] : [])];
      table = {
        caption: `希薄化率と${label}の議決権比率`,
        head: ["株主名", "保有株数", "現状", ...scen.map((d) => pct(d, cap === d ? 1 : 0) + (cap === d ? "（上限）" : ""))],
        rows: rows.map((r) => [r.name, fmt(r.shares), pct(r.shares / voting, 2),
          ...scen.map((d) => pct(dilutedRatio(r.shares / voting, d), 2))]),
        foot: ["合計", fmt(st.shares), pct(st.ratio, 2), ...scen.map((d) => pct(dilutedRatio(st.ratio, d), 1))],
        note: "希薄化率＝発行予定株数÷議決権株式数。大量保有報告書・変更報告書で共同保有を確認すること。",
      };
    }
  } else {
    r3.push(TODO("安定株主の選択で、現状の比率と維持できる希薄化率が入る"));
  }

  return {
    no: TODO("ページ番号"),
    title: "ファイナンスに向けた個別論点（想定）",
    lead: "論点は大きく3点",
    blocks: [
      { head: "【論点①：今期業績】", items: r1 },
      { head: "【論点②：中期経営計画】", items: r2 },
      { head: `【論点③：${label}の議決権比率】`, items: r3 },
    ],
    tables: table ? [table] : [],
    layout: "stack",
    notes: [],
  };
}

// ---- エクイティストーリー --------------------------------------------------

export function pageStory(ctx) {
  const use = draft(ctx, "useShort");
  const a = analyze({ fin: ctx.fin || {}, ext: ctx.ext || {}, opts: ctx.cashOpts || {} });
  const price = ctx.market?.price ?? null;
  const shares = ctx.basis?.voting ? potentialShares(ctx.basis.voting, ctx.dilution) : null;
  const raise = price && shares ? price * shares : null;

  // 今の状況（2行）：進捗は下書き、課題は数字から
  const now = [];
  const why = draft(ctx, "bizDriverShort") || draft(ctx, "chukeiShort");
  now.push(why ? `${why}が進む。` : TODO("事業の進捗を1行"));
  if (a.noSales && a.runway?.years) {
    now.push(`一方、年${oku(a.runway.burn)}のペースで現金が減っており、現預金は約${a.runway.years.toFixed(1)}年分。`);
  } else if (a.gap > 0) {
    now.push(`一方、投資を続けるには自己資金で${oku(a.gap)}不足。`);
  } else {
    now.push(TODO("資金面の課題を1行"));
  }

  // 右の枠：財務基盤の強化（調達後の数字）
  const eqNow = asRatio(num(Object.values(ctx.fin?.["自己資本比率"] || {}).slice(-1)[0]));
  const assets = num(Object.values(ctx.fin?.["総資産"] || {}).slice(-1)[0]);
  const right = [];
  if (raise && eqNow !== null && assets) {
    const eqAfter = (assets * eqNow + raise) / (assets + raise);
    right.push(`調達${oku(raise)}により、自己資本比率は${pct(eqNow)}→${pct(eqAfter)}（試算）。`);
  }
  if (raise && a.noSales && a.runway?.burn > 0 && a.cash !== null) {
    right.push(`現預金の持ちは約${a.runway.years.toFixed(1)}年分→約${((a.cash + raise) / a.runway.burn).toFixed(1)}年分（試算）。`);
  }
  right.push("返済の要らない資金で、今後の投資や費用の増加に先回りして備える。");

  const useLines = lines(draft(ctx, "useOfFunds"), 3);
  return {
    no: TODO("ページ番号"),
    title: "エクイティファイナンスの骨子 ― エクイティストーリー",
    lead: use ? `${use}のための資金を調達` : TODO("何のための調達かを一文で"),
    layout: "story",
    blocks: [
      { head: "", items: now },
      { head: "資金の確保", items: useLines.length ? useLines : [TODO("資金使途と金額・時期")] },
      { head: "財務基盤の強化", items: right },
      { head: "", items: [draft(ctx, "storySlogan") || TODO("会社の目指す姿を一文で")] },
    ],
    notes: [],
  };
}
