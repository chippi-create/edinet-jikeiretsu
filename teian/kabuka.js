// kabuka.js — アップロードされた株価データ（CSV）から、株価の動きを一文にする
//
// 株価そのもの（チャートなど）は本人が端末で用意する。ここでは「堅調／軟調／上値が重い」の
// 判定だけを、数字の比較で機械的に出す。判定に使った数字は注記に出して確かめられるようにする。
//
// 読めるCSV：1行目が見出しで、日付の列と終値の列があるもの。
//   Yahoo Finance 形式（Date,Open,High,Low,Close,Adj Close,Volume）、
//   日本語の形式（日付,始値,高値,安値,終値,出来高）など。Shift_JIS でもよい。

/** ファイルの中身（ArrayBuffer）を文字列に。UTF-8で化けたらShift_JISで読み直す。 */
export function decodeCsv(buf) {
  const u = new TextDecoder("utf-8").decode(buf);
  if (!u.includes("�")) return u.replace(/^﻿/, "");
  try { return new TextDecoder("shift_jis").decode(buf); } catch { return u; }
}

const toNum = (s) => {
  const t = String(s ?? "").replace(/[",\s]/g, "").replace(/^[△▲]/, "-");
  if (t === "" || t === "-" || t === "null") return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
};
/** 2026/10/02・2026-10-02・2026年10月2日 を 2026-10-02 に。 */
const toDate = (s) => {
  const m = /(\d{4})\s*[\/\-年.]\s*(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})/.exec(String(s || ""));
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};

/**
 * 株価CSVを [{date, close}]（日付の古い順）にする。読めなければ空の配列。
 * 終値の列は見出しで決める（調整後終値があればそちらを使う。株式分割で途切れないため）。
 */
export function parsePrices(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].includes("\t") ? "\t" : ",";
  // 「"1,010"」のように引用符の中にカンマがあるので、引用符の外のカンマだけで切る。
  const split = (l) => {
    const out = [];
    let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === sep && !q) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  // 見出しの行：日付の入っていない最初の行。会社名などの前置きの行があっても飛ばす。
  let hi = lines.findIndex((l) => !toDate(split(l)[0]) && split(l).length >= 2 && /日付|date|終値|close/i.test(l));
  const head = hi >= 0 ? split(lines[hi]) : [];
  const find = (re) => head.findIndex((h) => re.test(h));
  let di = find(/日付|date/i);
  let ci = find(/調整後終値|adj\.?\s*close/i);
  if (ci < 0) ci = find(/^終値|^close/i);
  if (ci < 0) ci = find(/終値|close/i);
  const rows = lines.slice(hi + 1).map(split);
  if (di < 0) di = 0;
  if (ci < 0) {
    // 見出しが無い：日付・始値・高値・安値・終値… の並びとみなす。数字が1列だけならそれを終値に。
    const w = rows[0]?.length || 0;
    ci = w >= 5 ? 4 : 1;
  }
  const out = [];
  for (const r of rows) {
    const date = toDate(r[di]), close = toNum(r[ci]);
    if (date && close !== null && close > 0) out.push({ date, close });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  // 同じ日が2回あれば後のものを使う
  return out.filter((x, i) => i === out.length - 1 || out[i + 1].date !== x.date);
}

const pct = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;
const monthsBefore = (date, m) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - m);
  return d.toISOString().slice(0, 10);
};
/** 基準日以前で最も近い日の終値。 */
const closeAt = (prices, date) => {
  let hit = null;
  for (const p of prices) { if (p.date <= date) hit = p; else break; }
  return hit;
};

// 判定のしきい値。3ヶ月で±5%を超えたら堅調・軟調。動きが小さく、
// 期間中の高値から5%以上下にいれば「上値が重い」、そうでなければ「横ばい」。
const MOVE = 0.05;
const BELOW_HIGH = 0.05;
// 市場全体の影響に触れるのは、指数が同じ向きに3%以上動いたときだけ。
const MARKET = 0.03;

/**
 * 直近 months ヶ月の株価の動き。index（TOPIXなど）があれば市場全体の動きも添える。
 *   { from, to, change, high, belowHigh, verdict, phrase, index:{change}|null, note }
 */
export function trendOf(prices, index = null, months = 3) {
  if (!prices || prices.length < 10) return null;
  const last = prices[prices.length - 1];
  const start = closeAt(prices, monthsBefore(last.date, months));
  if (!start || start.date === last.date) return null;
  const span = prices.filter((p) => p.date >= start.date);
  const high = Math.max(...span.map((p) => p.close));
  const change = last.close / start.close - 1;
  const belowHigh = 1 - last.close / high;
  const verdict = change >= MOVE ? "堅調" : change <= -MOVE ? "軟調"
    : belowHigh >= BELOW_HIGH ? "上値が重い" : "横ばい";

  let idx = null;
  if (index && index.length) {
    const a = closeAt(index, start.date), b = closeAt(index, last.date);
    if (a && b && a.date !== b.date) idx = { change: b.close / a.close - 1, name: null };
  }
  const sameWay = idx && ((change > 0 && idx.change >= MARKET) || (change < 0 && idx.change <= -MARKET));
  const market = sameWay ? `マーケット全体の${idx.change > 0 ? "上昇" : "下落"}の影響も受け、` : "";
  const tail = { 堅調: "堅調に推移している", 軟調: "軟調に推移している",
    上値が重い: "足元は上値が重く推移している", 横ばい: "横ばい圏で推移している" }[verdict];
  return {
    from: start.date, to: last.date, change, high, belowHigh, verdict, index: idx,
    phrase: market + tail,
    note: `株価の判定：${start.date}→${last.date}の${months}ヶ月で${pct(change)}` +
      `（期間中の高値${Math.round(high).toLocaleString("ja-JP")}円から${(belowHigh * 100).toFixed(1)}%下）` +
      (idx ? `、指数は${pct(idx.change)}` : "") +
      `。±${MOVE * 100}%を超えたら堅調・軟調、動きが小さく高値から${BELOW_HIGH * 100}%以上下なら上値が重い。`,
  };
}
