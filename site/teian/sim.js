// sim.js — 調達シミュレーションの計算
//
// 既存の提案書（菊池製作所・2026年8月17日）の数字を逆算して、
// 丸めのルールまで一致することを確認してある。test-sim.js を参照。
//
// ブラウザでもNodeでも動くよう、依存を持たない。

// ---- 丸め ----------------------------------------------------------------

/** 単位ごとの四捨五入。round(1206350, 10000) -> 1210000 */
export function round(v, unit) {
  return Math.round(v / unit) * unit;
}

/** 単位未満の切り捨て。floor(1580318, 1000) -> 1580000 */
export function floorTo(v, unit) {
  return Math.floor(v / unit) * unit;
}

// ---- 前提 ----------------------------------------------------------------

/**
 * 議決権株式数を出す。
 *
 * XBRLに入っているのは議決権の「個数」で、株数ではない。
 * 単元株式数という項目はXBRLに存在しないため、上場会社は100株として扱う。
 * 検算：発行済株式数 − 自己株式数 − 議決権株式数 = 単元未満株式（0以上の小さな数）
 */
export function votingShares(votingUnits, sharesPerUnit = 100) {
  return votingUnits * sharesPerUnit;
}

/** 単元未満株式。差し引きで出す。マイナスになったら前提が崩れている。 */
export function oddLotShares(issued, treasury, voting) {
  return issued - treasury - voting;
}

/**
 * 前提の整合性を確かめる。おかしければ理由を返す。
 * 数字を出す前に必ず通す。単元株式数が100でない会社をここで弾く。
 */
export function checkBasis({ issued, treasury, voting }) {
  const problems = [];
  if (!issued || !voting) problems.push("発行済株式数または議決権株式数が取れていません");
  const odd = oddLotShares(issued, treasury, voting);
  if (odd < 0) {
    problems.push(
      `発行済 − 自己株式 − 議決権株式数 が ${odd.toLocaleString()}株 とマイナスになります。` +
      `単元株式数が100株でない可能性があります`);
  } else if (odd > issued * 0.01) {
    problems.push(
      `単元未満株式が ${odd.toLocaleString()}株（発行済の` +
      `${(odd / issued * 100).toFixed(1)}%）と多すぎます。前提を確かめてください`);
  }
  return { odd, problems };
}

// ---- 本体 ----------------------------------------------------------------

/**
 * 1日の権利行使株数。1日の平均出来高の10%と仮定し、100株単位で四捨五入する。
 * 元資料の3期間すべてでこの丸め方と一致した。
 */
export function dailyExercise(avgVolume, ratio = 0.1) {
  return round(avgVolume * ratio, 100);
}

/**
 * 潜在株式数 = 議決権株式数 × 希薄化率。1,000株未満切り捨て。
 *
 * 元資料のシミュレーション表(p.14)は10,000株単位の四捨五入になっていたが、
 * 正しいルールは切り捨て。提案値13.1%では結果が同じ（1,580,000株）だが、
 * 10%は1,210,000→1,206,000、25%は3,020,000→3,015,000 と変わる。
 * 発行概要(p.13)の「発行予定株数」と同じ数字になる。
 */
export function potentialShares(voting, dilution) {
  return floorTo(voting * dilution, 1000);
}

/** 発行概要に書く発行予定株数。潜在株式数と同じ。 */
export const plannedShares = potentialShares;

/** 必要日数 = 潜在株式数 ÷ 1日の権利行使株数。四捨五入。 */
export function daysNeeded(potential, daily) {
  if (!daily) return null;
  return Math.round(potential / daily);
}

/** 時価総額 = 株価 × 発行済株式数（自己株式は引かない。元資料がそうしている）。 */
export function marketCap(price, issued) {
  return price * issued;
}

/**
 * 調達シミュレーションを丸ごと組み立てる。
 *
 * basis    : { issued, treasury, voting, asOf }        EDINETから
 * market   : { price, asOf, volumes: {1年, 6ヶ月, 3ヶ月} }  手入力
 * dilutions: [0.10, 0.131, 0.25]  希薄化率のシナリオ
 * prices   : 平均行使価額の段（省略すると株価から自動で作る）
 */
export function simulate({ basis, market, dilutions, prices }) {
  const { odd, problems } = checkBasis(basis);

  const daily = {};
  for (const [label, v] of Object.entries(market.volumes)) {
    daily[label] = dailyExercise(v);
  }

  const scenarios = dilutions.map((d) => {
    const potential = potentialShares(basis.voting, d);
    const days = {};
    for (const [label, v] of Object.entries(daily)) {
      days[label] = daysNeeded(potential, v);
    }
    return { dilution: d, potential, days };
  });

  const rows = (prices || priceLadder(market.price)).map((p) => ({
    price: p,
    amounts: scenarios.map((s) => p * s.potential),
  }));

  return {
    marketCap: marketCap(market.price, basis.issued),
    oddLot: odd,
    problems,
    daily,
    scenarios,
    ladder: rows,
  };
}

/**
 * 平均行使価額の段を作る。
 * 元資料は基準株価1,027円に対して600〜1,600円を100円刻みで、
 * 基準株価に近い段（1,000円）を枠で囲っていた。
 * ここでは基準株価を100円単位に丸めて、上下6段ずつを出す。
 */
export function priceLadder(price, step, below = 4, above = 6) {
  const center = round(price, step || pickStep(price));
  const s = step || pickStep(price);
  const out = [];
  for (let i = above; i >= -below; i--) {
    const v = center + i * s;
    if (v > 0) out.push(v);
  }
  return out;
}

/** 株価の桁に合わせて刻み幅を決める。1,027円なら100円刻み。 */
export function pickStep(price) {
  if (price < 200) return 10;
  if (price < 2000) return 100;
  if (price < 20000) return 500;
  return 1000;
}

/**
 * 創業家などの議決権比率を維持できる希薄化率の上限。
 *
 * 現在の比率 r が、希薄化率 d の発行後に threshold を下回らない条件：
 *   r / (1 + d) > threshold  →  d < r / threshold − 1
 * 元資料では 56.58% / 50% − 1 = 13.16% を 13.1% としていた（切り捨て）。
 */
export function maxDilutionFor(currentRatio, threshold = 0.5) {
  const d = currentRatio / threshold - 1;
  return Math.floor(d * 1000) / 1000;   // 0.1%刻みで切り捨て
}

/** 希薄化後の議決権比率。 */
export function dilutedRatio(currentRatio, dilution) {
  return currentRatio / (1 + dilution);
}
