// sesaku.js — この会社に投げかける施策のチェック表
//
// MSワラントありきをやめて、まず会社を見て「やったほうがよさそうな施策」を並べる（本人の指定。2026-11-03）。
// 施策ごとに、条件・この会社の値・満たすか を全部出す。判断は本人。AIは使わない（数字の取り違えが怖いため）。
//
//   checklist(ctx, pf, texts) → [{ id, name, verdict, checks[], missing[], note }]
//     verdict … "当てはまる" / "一部当てはまる" / "当てはまらない" / "材料不足"
//     checks  … { label, value, rule, hit }  hit は true / false / null（値が無くて判定できない）
//
// 基準の数字は THRESHOLDS にまとめた。初期値はこちらで置いたもので、本人が直す前提。
//
// 依存：shindan.js（profile・ownerEstimate）。ブラウザでもNodeでも動く。

import { profile, ownerEstimate, floatRules } from "./shindan.js";

export const THRESHOLDS = {
  pbrLow: 1.0,              // PBR がこれ未満なら「株価が純資産を下回る」
  roeLow: 0.08,             // ROE がこれ未満なら資本効率が低い（伊藤レポートの8%）
  netCashToMcap: 0.2,       // ネットキャッシュ÷時価総額 がこれ以上なら現金が多い
  netCashToAssets: 0.15,    // ネットキャッシュ÷総資産
  eqRatioHigh: 0.6,         // 自己資本比率が高い
  eqRatioLow: 0.3,          // 自己資本比率が低い（資本の手当てが要る）
  payoutLow: 0.3,           // 配当性向が低い
  policyHeld: 0.1,          // 銀行・保険・事業会社が持つ当社株（大株主上位の合計）
  ownerHigh: 0.3,           // 創業家・資産管理会社・役員の持株（推定）
  floatMargin: 0.05,        // 流通株式比率が上場維持基準＋これ未満なら余裕が小さい
  treasuryHigh: 0.05,       // 自己株式÷発行済
  holdingsToEquity: 0.2,    // 政策保有株÷純資産（議決権行使助言会社が反対を推奨する水準）
  mcapSmall: 300e8,         // 時価総額がこれ未満は小型（公募の需要を集めにくい）
  mcapPo: 100e8,            // 公募増資の目安の下限
  runwayYears: 3,           // 現金が減る会社で、手元資金が何年分を切ったら急ぐか
};

const T = THRESHOLDS;
const pct = (v, d = 1) => v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`;
const oku = (v) => v === null || v === undefined ? "—" : `${(v / 1e8).toFixed(1)}億円`;
const x2 = (v) => v === null || v === undefined ? "—" : `${v.toFixed(2)}倍`;
const ge = (v, t) => v === null || v === undefined ? null : v >= t;
const lt = (v, t) => v === null || v === undefined ? null : v < t;
const div = (a, b) => (a === null || a === undefined || !b) ? null : a / b;

/** 文章（経営方針・分析）に言葉があるか。文章が無ければ null（判定できない）。 */
const says = (text, re) => (text ? re.test(text) : null);

function verdictOf(checks, core) {
  // core … 「これが満たされれば当てはまる」とみる条件の番号（checksの添字）の組。どれか1組を全部満たせば当てはまる。
  // 満たしていない組でも、外れた条件が無く値が欠けているだけなら「材料不足」（値が入れば当てはまりうる）。
  if (core.some((set) => set.every((i) => checks[i]?.hit === true))) return "当てはまる";
  if (core.some((set) => set.every((i) => checks[i]?.hit !== false))) return "材料不足";
  if (checks.some((c) => c.hit === true)) return "一部当てはまる";
  return "当てはまらない";
}

export function checklist(ctx, pf = profile(ctx), texts = {}) {
  const a = pf.cashAnalysis || {};
  const basis = ctx.basis || {};
  const seg = ctx.market?.segment || "";
  const rule = floatRules(seg)[0];
  const words = [texts.policy, texts.mdna].filter(Boolean).join("\n");
  const owner = ownerEstimate(ctx.sec?.sh, ctx.sec?.of, basis, ctx.listedNames || null);
  const treasuryRatio = div(basis.treasury, basis.issued);
  const steady = pf.op !== null && pf.op > 0 && pf.opPrev !== null && pf.opPrev > 0;
  const loss2 = pf.op !== null && pf.op < 0 && pf.opPrev !== null && pf.opPrev < 0;
  const runway = a.noSales && a.runway?.years !== null && a.runway?.years !== undefined ? a.runway.years : null;
  // 資金需要：現金が減っている・投資に対して自己資金が足りない・手元資金の下限を割る見込み
  const need = [
    runway !== null ? runway < T.runwayYears : null,
    a.gap !== undefined && a.gap !== null ? a.gap > 0 : null,
    a.projection ? !!a.projection.shortfallYear : null,
  ];
  const needHit = need.some((x) => x === true) ? true : need.every((x) => x === null) ? null : false;
  const needValue = [
    runway !== null ? `手元資金 約${runway.toFixed(1)}年分` : null,
    a.gap > 0 ? `投資に対して自己資金が${oku(a.gap)}不足` : null,
    a.projection?.shortfallYear ? `${a.projection.shortfallYear}年後に手元資金の下限を割る見込み` : null,
  ].filter(Boolean).join("、") || (needHit === false ? "数字上は不足なし" : "—");
  const floatRatio = pf.float?.ratio ?? null;
  const floatCap = pf.float?.cap ?? null;
  const fundHolders = (pf.holders || []).filter((h) => /ファンド|FUND|CAPITAL|PARTNERS|INVESTMENT|ASSET MANAGEMENT|インベストメント|キャピタル|パートナーズ/i.test(h.name || "")
    && h.kind !== "信託・カストディ");

  const out = [];
  const add = (id, name, checks, core, note) => {
    out.push({ id, name, verdict: verdictOf(checks, core), checks,
      missing: checks.filter((c) => c.hit === null).map((c) => c.label), note });
  };

  // 1. 自社株買い（還元・資本効率）
  add("buyback", "自社株買い", [
    { label: "PBR", value: x2(pf.pbr), rule: `${T.pbrLow}倍未満`, hit: lt(pf.pbr, T.pbrLow) },
    { label: "ROE", value: pct(pf.roe), rule: `${pct(T.roeLow, 0)}未満`, hit: lt(pf.roe, T.roeLow) },
    { label: "ネットキャッシュ÷時価総額", value: pct(pf.netCashToMcap), rule: `${pct(T.netCashToMcap, 0)}以上`, hit: ge(pf.netCashToMcap, T.netCashToMcap) },
    { label: "自己資本比率", value: pct(pf.eqRatio), rule: `${pct(T.eqRatioHigh, 0)}以上`, hit: ge(pf.eqRatio, T.eqRatioHigh) },
    { label: "営業黒字が2期続く", value: steady ? "続いている" : "続いていない", rule: "続いている", hit: pf.op === null ? null : steady },
  ], [[0, 2, 4], [1, 3, 4], [0, 3, 4]],
  "現金が多く利益が安定しているのに資本効率・株価が低い会社。売出しの受け皿としての自社株買いもある。");

  // 2. 売出し（政策保有の解消・創業家の持分）
  add("secondary", "売出し", [
    { label: "銀行・保険・事業会社の持株（大株主上位）", value: pct(pf.policyHeldRatio), rule: `${pct(T.policyHeld, 0)}以上`, hit: pf.holders?.length ? ge(pf.policyHeldRatio, T.policyHeld) : null },
    { label: "創業家・資産管理会社・役員の持株（推定）", value: pct(owner.ratio), rule: `${pct(T.ownerHigh, 0)}以上`, hit: pf.holders?.length ? ge(owner.ratio, T.ownerHigh) : null },
    { label: "流通株式比率（推定）", value: pct(floatRatio), rule: `${rule.market}基準${pct(rule.ratio, 0)}＋${pct(T.floatMargin, 0)}未満`, hit: lt(floatRatio, rule.ratio + T.floatMargin) },
  ], [[0], [1], [2]],
  "持ち合いの解消や創業家の持分の現金化を、市場で受け止める。流通株式も増える。");

  // 3. 流通株式比率の引き上げ（上場維持基準）
  add("float", "流通株式比率の引き上げ", [
    { label: "流通株式比率（推定）", value: pct(floatRatio), rule: `${rule.market}基準${pct(rule.ratio, 0)}＋${pct(T.floatMargin, 0)}未満`, hit: lt(floatRatio, rule.ratio + T.floatMargin) },
    { label: "流通株式時価総額（推定）", value: oku(floatCap), rule: `${rule.market}基準${oku(rule.cap)}の1.5倍未満`, hit: lt(floatCap, rule.cap * 1.5) },
  ], [[0], [1]],
  `市場区分${seg ? `（${seg}）` : "が未選択のため最も厳しい基準で比較"}。手法は売出し・立会外分売・公募増資・自己株式処分。`);

  // 4. 公募増資
  add("po", "公募増資", [
    { label: "資金需要", value: needValue, rule: "不足がある", hit: needHit },
    { label: "時価総額", value: oku(pf.mcap), rule: `${oku(T.mcapPo)}以上`, hit: ge(pf.mcap, T.mcapPo) },
    { label: "営業黒字が2期続く", value: steady ? "続いている" : "続いていない", rule: "続いている", hit: pf.op === null ? null : steady },
    { label: "自己資本比率", value: pct(pf.eqRatio), rule: `${pct(T.eqRatioLow, 0)}未満（資本の手当て）`, hit: lt(pf.eqRatio, T.eqRatioLow) },
    { label: "経営方針・分析に成長投資の記載", value: says(words, /設備投資|成長投資|新工場|増設|出店|投資計画/) ? "あり" : words ? "見当たらない" : "—", rule: "あり", hit: says(words, /設備投資|成長投資|新工場|増設|出店|投資計画/) },
  ], [[0, 1, 2], [3, 1, 2]],
  "調達額が一度に確定する。準備期間は長め。時価総額と株式の流動性で需要の集まり方が変わる。");

  // 5. MSワラント
  add("ms", "MSワラント", [
    { label: "資金需要", value: needValue, rule: "不足がある", hit: needHit },
    { label: "時価総額", value: oku(pf.mcap), rule: `${oku(T.mcapSmall)}未満`, hit: lt(pf.mcap, T.mcapSmall) },
    { label: "営業赤字が2期続く", value: loss2 ? "続いている" : "続いていない", rule: "続いている", hit: pf.op === null ? null : loss2 },
    { label: "現金が減っている会社の手元資金", value: runway !== null ? `約${runway.toFixed(1)}年分` : a.noSales ? "—" : "売上があり、現金が減り続ける会社ではない", rule: `${T.runwayYears}年分未満`, hit: runway !== null ? runway < T.runwayYears : a.noSales ? null : false },
  ], [[0, 1], [3], [2, 1]],
  "株価に応じて段階的に資金が入る。準備期間が短く、行使の進み方で希薄化の速さを調整できる。");

  // 6. 自己株式処分
  add("treasury", "自己株式処分", [
    { label: "自己株式÷発行済株式", value: pct(treasuryRatio), rule: `${pct(T.treasuryHigh, 0)}以上`, hit: ge(treasuryRatio, T.treasuryHigh) },
    { label: "資金需要", value: needValue, rule: "不足がある", hit: needHit },
  ], [[0, 1], [0]],
  "手持ちの自己株式を、資金調達・提携先への割当・株式報酬に使う。新株を出さないので発行済株式数は増えない。");

  // 7. 資本業務提携（第三者割当）
  const corpHolders = (pf.holders || []).filter((h) => h.kind === "事業法人等");
  add("alliance", "資本業務提携（第三者割当）", [
    { label: "大株主に事業会社", value: corpHolders.length ? corpHolders.slice(0, 3).map((h) => `${h.label} ${pct(h.ratio)}`).join("、") : "いない", rule: "いる", hit: pf.holders?.length ? corpHolders.length > 0 : null },
    { label: "経営方針・分析に提携の記載", value: says(words, /提携|アライアンス|協業|パートナー/) ? "あり" : words ? "見当たらない" : "—", rule: "あり", hit: says(words, /提携|アライアンス|協業|パートナー/) },
    { label: "資金需要", value: needValue, rule: "不足がある", hit: needHit },
  ], [[1, 2], [0, 2]],
  "事業上の相手に株を持ってもらい、資金と事業の連携を同時に得る。");

  // 8. M&A
  add("ma", "M&A", [
    { label: "経営方針・分析にM&Aの記載", value: says(words, /M&A|M＆A|買収|企業結合|事業取得/) ? "あり" : words ? "見当たらない" : "—", rule: "あり", hit: says(words, /M&A|M＆A|買収|企業結合|事業取得/) },
    { label: "ネットキャッシュ", value: oku(pf.netCash), rule: "プラス", hit: pf.netCash === null ? null : pf.netCash > 0 },
    { label: "自己資本比率", value: pct(pf.eqRatio), rule: `${pct(T.eqRatioHigh, 0)}以上`, hit: ge(pf.eqRatio, T.eqRatioHigh) },
  ], [[0, 1], [0, 2]],
  "買収の資金はネットキャッシュ・借入・株式（株式交付・第三者割当）。");

  // 9. アクティビスト対策
  add("activist", "アクティビスト対策", [
    { label: "PBR", value: x2(pf.pbr), rule: `${T.pbrLow}倍未満`, hit: lt(pf.pbr, T.pbrLow) },
    { label: "ネットキャッシュ÷時価総額", value: pct(pf.netCashToMcap), rule: `${pct(T.netCashToMcap, 0)}以上`, hit: ge(pf.netCashToMcap, T.netCashToMcap) },
    { label: "政策保有株÷純資産", value: pf.holdings ? pct(pf.holdings.toEquity) : "—（未取得）", rule: `${pct(T.holdingsToEquity, 0)}以上`, hit: pf.holdings ? ge(pf.holdings.toEquity, T.holdingsToEquity) : null },
    { label: "配当性向", value: pct(pf.payout), rule: `${pct(T.payoutLow, 0)}未満`, hit: lt(pf.payout, T.payoutLow) },
    { label: "大株主にファンドらしい名前", value: fundHolders.length ? fundHolders.map((h) => `${h.label} ${pct(h.ratio)}`).join("、") : "いない（大量保有報告書はまだ見ていない）", rule: "いる", hit: pf.holders?.length ? fundHolders.length > 0 : null },
  ], [[0, 1], [0, 2], [4]],
  "株価が低く現金や保有株が多い会社は提案を受けやすい。還元方針・政策保有株の縮減・安定株主づくりで備える。");

  // 10. その他：政策保有株の縮減
  add("crosshold", "その他：政策保有株の縮減", [
    { label: "政策保有株÷純資産", value: pf.holdings ? pct(pf.holdings.toEquity) : "—（未取得）", rule: `${pct(T.holdingsToEquity, 0)}以上`, hit: pf.holdings ? ge(pf.holdings.toEquity, T.holdingsToEquity) : null },
  ], [[0]],
  "売った資金を還元・成長投資に回す。相手先が持つ当社株の売却（売出し）とセットになりやすい。");

  // 11. その他：創業家の持分・事業承継
  add("owner", "その他：創業家の持分・事業承継", [
    { label: "創業家・資産管理会社・役員の持株（推定）", value: pct(owner.ratio), rule: `${pct(T.ownerHigh, 0)}以上`, hit: pf.holders?.length ? ge(owner.ratio, T.ownerHigh) : null },
  ], [[0]],
  "相続・承継に向けた持分の整理（売出し・資産管理会社・自社株買いでの受け皿）。");

  const order = { "当てはまる": 0, "一部当てはまる": 1, "材料不足": 2, "当てはまらない": 3 };
  return out.sort((p, q) => order[p.verdict] - order[q.verdict]);
}
