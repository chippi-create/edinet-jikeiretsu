// chukei.js — 読み込んだ中期経営計画の資料から、目標値の「候補」を拾う
//
// 中計の資料はスライドなので、PDFから取り出した文字は数字・項目名・年度がばらばらに並ぶ
// （ニッスイ：「売上高 9,700億円」の数行あとに「2027年度目標」）。確実には対応づけられないので、
// ここで出すのは候補だけ。画面では空欄にだけ入れ、見つかった候補と元の行を全部見せて確かめてもらう。
// AIには読ませない（数字はAIに答えさせない）。
//
// 拾う形：行の頭（または空白の直後）に「売上高／売上収益／営業収益／営業利益」があり、
// すぐ後ろに「◯億円／◯百万円／◯兆円」が続くもの。「◯◯事業の売上高」のような事業別の数字は拾わない。

const ITEMS = [
  ["sales", /(?:^|\s)(?:連結)?(?:売上高|売上収益|営業収益)\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*(兆円|億円|百万円)/g],
  ["op", /(?:^|\s)(?:連結)?営業利益\s*[:：]?\s*(△?-?[\d,]+(?:\.\d+)?)\s*(兆円|億円|百万円)/g],
];
const TO_MM = { 兆円: 1e6, 億円: 100, 百万円: 1 };

/** 全角・字間の空き（「3 6 . 7 億 円」）をならす。 */
const norm = (s) => String(s || "").normalize("NFKC")
  .replace(/(\d)\s+(?=[\d.,])/g, "$1").replace(/([.,])\s+(?=\d)/g, "$1")
  .replace(/億\s+円/g, "億円").replace(/百\s*万\s*円/g, "百万円");

/** 資料の欄から、中期経営計画（事業計画・成長可能性を含む）の部分だけを取り出す。 */
export function chukeiTexts(material) {
  const parts = String(material || "").split(/^=== (.*) ===$/m);
  const out = [];
  for (let i = 1; i < parts.length; i += 2) {
    if (/中期経営計画|中計|経営計画|事業計画|成長可能性/.test(parts[i])) out.push({ title: parts[i], text: parts[i + 1] || "" });
  }
  return out;
}

/**
 * 候補を拾う。
 *   { sales, op, roe, year, cands:[{item, value(百万円), raw, line}] } — 何も無ければ null
 * sales・op は候補の中の最大値（目標は計画期間の最後で最も大きいことが多い）。目標年度が見つからなければ null。
 * year は、売上高の候補の行に最も近い「◯年度」「FY◯」のうち、同じ行か次の行に「目標」があるもの。
 */
export function findChukei(material) {
  const docs = chukeiTexts(material);
  if (!docs.length) return null;
  const cands = [];
  const lines = docs.flatMap((d) => d.text.split(/\r?\n/).map(norm));
  lines.forEach((l, i) => {
    for (const [item, re] of ITEMS) {
      for (const m of l.matchAll(re)) {
        const v = Number(m[1].replace(/,/g, "").replace(/^△/, "-")) * TO_MM[m[2]];
        if (Number.isFinite(v)) cands.push({ item, value: Math.round(v), raw: m[0].trim(), line: l.trim().slice(0, 80), i });
      }
    }
    const r = /ROE\s*[:：]?\s*(\d{1,2}(?:\.\d+)?)\s*%/.exec(l);
    if (r && Number(r[1]) <= 50) cands.push({ item: "roe", value: Number(r[1]), raw: r[0].trim(), line: l.trim().slice(0, 80), i });
  });
  if (!cands.length) return null;
  const best = (item) => cands.filter((c) => c.item === item).sort((a, b) => b.value - a.value)[0] || null;
  const sales = best("sales"), op = best("op"), roe = best("roe");

  // 目標年度：売上高（無ければ営業利益）の候補の行から近い順に探す
  let year = null;
  const at = (sales || op)?.i;
  if (at !== undefined) {
    const isTarget = (j) => /目標/.test(lines[j] || "") || /目標/.test(lines[j + 1] || "");
    for (let d = 0; d <= 20 && !year; d++) {
      for (const j of [at + d, at - d]) {
        if (j < 0 || j >= lines.length || !isTarget(j)) continue;
        // 「2021年度実績 2024年度見込 2027年度目標」は、目標の直前の年度を採る。
        // 目標が次の行にあるときは、その行の最後の年度。
        const Y = /(?:FY\s*)?20\d\d\s*(?:年度|年\s*\d{1,2}\s*月期)?/gi;
        const before = /目標/.test(lines[j]) ? lines[j].slice(0, lines[j].indexOf("目標")) : lines[j];
        const ys = [...before.matchAll(Y)].map((m) => m[0]).filter((t) => /年|FY/i.test(t));
        if (ys.length) { year = ys[ys.length - 1].replace(/\s+/g, ""); break; }
      }
    }
  }
  // 目標年度が近くに見つからないときは、目標値とは言えない（事業別の実績などのことがある）。候補として見せるだけ。
  return { sales: year ? sales?.value ?? null : null, op: year ? op?.value ?? null : null,
    roe: year ? roe?.value ?? null : null, year, cands };
}
