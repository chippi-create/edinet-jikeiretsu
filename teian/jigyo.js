// jigyo.js — エグゼクティブサマリーの＜事業の状況＞を三段で組む
//
//   ① これまでの業績：売上・利益が何で伸びたか → その結果キャッシュはどうなったか
//   ② 今後：中計で何に注力し何を改善するか → 今期予想に対する足元の進捗
//   ③ するべきこと：ファイナンスと、その他の留意点（議決権など）
//
// 数字は全部ここで機械的に出す。「何で伸びたか」「中計で何に注力するか」の
// 文章だけAIの下書き（bizDriver / chukeiFocus）を使い、無ければ【　】で空ける。

import { diagnose } from "./shindan.js";
import { progress, chukeiGap } from "./genjo.js";
import { maxDilutionFor, dilutedRatio } from "./sim.js";

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
// 円→百万円。取れていない値を0にしない（0だと「赤字なので黒字化が前提」と誤って出る）。
const mil = (v) => { const x = num(v); return x === null ? null : x / 1e6; };
const signPct = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;

/** 年度キーを「2026年4月期」にする。 */
const ki = (y, kessan) => {
  const m = Number(String(kessan || "").replace(/[^\d]/g, ""));
  return m ? `${y}年${m}月期` : `${y}年度`;
};

/** 年度→値 から古い順の [年, 値]（値のある年だけ）。 */
function ser(map, n) {
  if (!map) return [];
  return Object.keys(map).sort().slice(-n).map((y) => [y, num(map[y])]).filter((r) => r[1] !== null);
}

/** AIの下書き。無い・材料不足なら null。 */
function draft(ctx, id) {
  const v = ctx.drafts?.[id];
  return (typeof v === "string" && v.trim() && !NO_MATERIAL.test(v)) ? v.trim() : null;
}

// ---- ① これまでの業績 ----------------------------------------------------

/** 売上・営業利益の推移を1文にする。赤字をまたぐときは言い方を変える。 */
function trendLine(fin, kessan) {
  const s = ser(fin["売上高"], 3);
  const o = ser(fin["営業利益"], 3);
  const parts = [];
  if (s.length >= 2) {
    const [y0, a] = s[0], [y1, b] = s[s.length - 1];
    const cagr = a > 0 && b > 0 ? Math.pow(b / a, 1 / (s.length - 1)) - 1 : null;
    parts.push(`売上高は${ki(y0, kessan)}${oku(a)}→${ki(y1, kessan)}${oku(b)}` + (cagr !== null ? `（年率${signPct(cagr)}）` : ""));
  }
  if (o.length >= 2) {
    const [y0, a] = o[0], [y1, b] = o[o.length - 1];
    const w = (v) => `${v < 0 ? "営業損失" : "営業利益"}${oku(Math.abs(v))}`;
    const how = a < 0 && b >= 0 ? "黒字転換"
      : a < 0 && b < 0 ? (b > a ? "損失が縮小" : "損失が拡大")
      : a > 0 && b < 0 ? "赤字転落"
      : b > a ? "増益" : b < a ? "減益" : "横ばい";
    parts.push(`${w(a)}（${ki(y0, kessan)}）→${w(b)}（${ki(y1, kessan)}）で${how}`);
  } else if (o.length === 1) {
    parts.push(`直近期の${o[0][1] < 0 ? "営業損失" : "営業利益"}は${oku(Math.abs(o[0][1]))}`);
  }
  return parts.length ? parts.join("、") + "。" : null;
}

/**
 * キャッシュの結果。直近3期の累計で、稼いだ現金（営業CF）と使った現金（投資CF）、
 * 足りない分をどう埋めたか（財務CF）を出す。
 * 1年だけだと振れるので累計で見る。
 */
function cashLine(fin, ext, kessan) {
  const get = (k) => fin[k] ?? ext[k];
  const years = ser(get("営業CF"), 3).map((r) => r[0]);
  if (!years.length) return null;
  const sum = (k) => {
    const m = get(k);
    let t = 0, got = false;
    for (const y of years) { const v = num(m?.[y]); if (v !== null) { t += v; got = true; } }
    return got ? t : null;
  };
  const ope = sum("営業CF"), inv = sum("投資CF"), fnc = sum("財務CF");
  const cash = ser(get("現金及び現金同等物"), 4);
  const n = years.length;
  let text = `直近${n}期の累計で、営業CF${oku(ope)}`;
  if (inv !== null) {
    const fcf = ope + inv;
    // 投資CFがプラス＝資産や保有株を売って現金が入った。「投資した」とは書けない（菊池 +9.5億）。
    text += inv > 0
      ? `、投資CFは${oku(inv)}の入超（資産・保有株の売却など）で、フリーCF${oku(fcf)}。`
      : `に対し投資CF${oku(inv)}、フリーCF${oku(fcf)}。`;
    if (ope < 0 && inv > 0) text += "営業CFのマイナスを資産の売却で補った。";
    if (fcf < 0 && fnc !== null && fnc > 0) {
      text += `不足分は財務CF${oku(fnc)}（借入・増資など）で補った。`;
    } else if (fcf > 0 && fnc !== null && fnc < 0) {
      text += `稼いだ現金を返済・還元（財務CF${oku(fnc)}）に回した。`;
    }
  } else {
    text += "。";
  }
  if (cash.length >= 2) {
    // 期首の現預金は、累計の最初の年の前年末。無ければ取れた最初の年。
    const first = cash.find((r) => r[0] < years[0]) || cash[0];
    const last = cash[cash.length - 1];
    text += `現預金は${oku(first[1])}（${ki(first[0], kessan)}末）→${oku(last[1])}（${ki(last[0], kessan)}末）。`;
  }
  return text;
}

// ---- ② 今後の方向性と足元の進捗 ------------------------------------------

function outlookLines(ctx) {
  const out = [];
  const t = ctx.tanshin?.forecast || ctx.tanshin?.actual ? ctx.tanshin : null;
  const ck = ctx.chukei && (ctx.chukei.sales || ctx.chukei.op) ? ctx.chukei : null;

  const focus = draft(ctx, "chukeiFocus");
  if (focus) {
    for (const l of focus.split(/\r?\n/).map((x) => x.replace(/^[・\-\s]+/, "").trim()).filter(Boolean)) {
      out.push(l);
    }
  } else {
    out.push(TODO("中計で注力すること・改善すること（AIの下書き、または中計資料から）"));
  }

  if (ck) {
    const fyOf = (s) => { const m = /(\d{4})/.exec(String(s || "")); return m ? Number(m[1]) : null; };
    const years = Object.keys(ctx.fin["売上高"] || {}).sort();
    const lastY = years[years.length - 1];
    const base = t?.forecast ? t.forecast
      : { 売上高: mil(ctx.fin["売上高"]?.[lastY]), 営業利益: mil(ctx.fin["営業利益"]?.[lastY]) };
    const g = chukeiGap(ck, base, t?.forecast ? fyOf(t.period) : fyOf(lastY), ctx.fin);
    for (const r of g?.rows || []) {
      if (!(r.base > 0)) {
        out.push(`中計（${ck.year}）の${r.item}目標は、足元が赤字のため黒字化が前提。`);
      } else if (r.need !== null && r.need > 0) {
        out.push(`中計（${ck.year}）の${r.item}目標まで` +
          (g.years === 1 ? `来期に${(r.target / r.base).toFixed(1)}倍が要る` : `年${pct(r.need)}の伸びが要る`) +
          (r.past !== null ? `（過去3年は年${pct(r.past)}）→ ${r.verdict}。` : "。"));
      } else if (r.verdict) {
        out.push(`中計（${ck.year}）の${r.item}目標は${r.verdict}。`);
      }
    }
  }

  const pg = progress(t, ctx.fin);
  const s = pg?.rows.find((r) => r.item === "売上高");
  if (s && s.rate !== null) {
    out.push(`今期予想に対する${pg.label}の売上進捗は${pct(s.rate)}` +
      (s.prate !== null ? `（前年同期${pct(s.prate)}）→ ${s.verdict}。` : "。"));
  } else if (t?.actual) {
    out.push(`${t.actual.期}累計の売上高は${(t.actual.売上高).toLocaleString("ja-JP")}百万円` +
      (t.prior?.売上高 > 0 ? `（前年同期比${signPct(t.actual.売上高 / t.prior.売上高 - 1)}）。` : "。"));
  } else {
    out.push(TODO("今期予想に対する足元の進捗（決算短信を読み込むと入ります）"));
  }
  return out;
}

// ---- ③ するべきこと --------------------------------------------------------

function actionLines(ctx) {
  const out = [];
  const issues = diagnose(ctx);
  // 論点の上位から、候補の手法の1つ目を添える。
  for (const i of issues.slice(0, 3)) {
    // 見出しに要点の数字が入っているものは見出しだけ。資金需要のように見出しが一般的なものは根拠を1つ添える。
    // 菊池の「保有株式」で根拠の1つ目（政策保有0.5億）を出すと、肝心の純投資23.9億が消えていた。
    const withEv = i.id === "funding" || i.id === "major";
    const how = String(i.products[0] || "").replace(/（.*$/, "");
    out.push(`${i.title}` + (withEv && i.evidence[0] ? `（${i.evidence[0]}）` : "") +
      (how ? `。候補：${how}` : ""));
  }
  if (!issues.length) out.push(TODO("数字の条件に当たる論点が無い。会話の中で埋める"));

  // 議決権。選んだ安定株主の比率と、維持を前提にした希薄化率の上限。
  const st = ctx.stable;
  const keep = st?.keep ?? 0.5;
  if (st?.ratio != null) {
    const cap = maxDilutionFor(st.ratio, keep);
    out.push(cap > 0
      ? `議決権：${st.label || "安定株主"}の議決権比率は${pct(st.ratio)}。` +
        `${pct(keep, 0)}維持を前提にすると、希薄化率は${pct(cap)}までが目安。`
      : `議決権：${st.label || "安定株主"}の議決権比率は${pct(st.ratio)}で既に${pct(keep, 0)}未満。` +
        `希薄化率${pct(ctx.dilution)}の発行で${pct(dilutedRatio(st.ratio, ctx.dilution))}に下がる。`);
  } else {
    out.push(TODO("議決権：安定株主を選ぶと、維持できる希薄化率が入ります"));
  }
  return out;
}

/** ＜事業の状況＞のブロック。 */
export function jigyoBlock(ctx) {
  const done = [trendLine(ctx.fin, ctx.kessan), draft(ctx, "bizDriver")
    || TODO("売上・利益が何で伸びたか（AIの下書き、または有報の経営者による分析から）"),
  cashLine(ctx.fin, ctx.ext, ctx.kessan)].filter(Boolean);
  return {
    head: "＜事業の状況＞", subs: [
      { head: "①これまでの業績", items: done },
      { head: "②今後の方向性と足元の進捗", items: outlookLines(ctx) },
      { head: "③取り組むべきこと", items: actionLines(ctx) },
    ],
  };
}
