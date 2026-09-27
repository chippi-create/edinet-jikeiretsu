// shikin.js — 資金の余力と、調達の要否を見る
//
// 「いくら持っていて、そのうちいくら使えて、このままだといつ足りなくなるか」
// 「投資をやるなら、いくら足りないか」「それは借入かエクイティか」を、
// 有報の数字から機械的に出す。
//
// 前提は全部あらわに出す。数字より前提のほうが効くので、
// 使う人が動かせるようにしてある。当てにいくものではなく、叩き台。
//
// 依存なし。ブラウザでもNodeでも動く。

// ---- 既定の前提 ----------------------------------------------------------

export const DEFAULTS = {
  // 事業を回すのに手元に置いておく現金。月商の何ヶ月ぶんか。
  // 1〜2ヶ月が一般的な目安。業種と入金サイトで変わる。
  monthsOfSales: 1.5,
  // 将来のキャッシュフローを何年ぶん置くか。
  years: 5,
  // 売上の伸び。過去実績から出すが、上書きできる。
  growth: null,
  // 1年あたりの投資額。中計があればそれを入れる。
  capexPerYear: null,
  // 有利子負債/EBITDA がこれを超えると、借入を伸ばしにくいと見る。
  debtEbitdaLimit: 5,
  // インタレストカバレッジがこれを下回ると、同じく苦しいと見る。
  interestCoverLimit: 2,
};

// ---- 小道具 --------------------------------------------------------------

const num = (v) => {
  const t = String(v ?? "").replace(/,/g, "").trim();
  if (t === "") return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
};

/** 年度→値 の系列から、新しい順にn年ぶん [年, 値] を返す。 */
export function series(map, n = 5) {
  if (!map) return [];
  return Object.keys(map).sort().slice(-n).map((y) => [y, num(map[y])]);
}

export function latest(map) {
  const s = series(map, 1);
  return s.length ? s[0][1] : null;
}

/** 複数の科目を足す。取れていないものは0として扱うが、全部無ければnull。 */
export function sum(pick, keys) {
  let total = 0, got = false;
  for (const k of keys) {
    const v = pick(k);
    if (v !== null) { total += v; got = true; }
  }
  return got ? total : null;
}

const div = (a, b) => (a === null || b === null || b === 0) ? null : a / b;

// ---- 運転資本とCCC -------------------------------------------------------

/**
 * 売上債権・棚卸資産・仕入債務を、内訳から組み立てる。
 *
 * 会社によって科目の分け方が違うので、取れているものを足す。
 * 「受取手形及び売掛金」で一本にしている会社と、分けている会社の両方がある。
 * 両方に値が入ることは通常ないが、入っていたら二重に数えるので、
 * まとめ科目があればそちらを優先する。
 */
export function workingCapital(pick) {
  const ar = pick("売上債権IFRS")
    ?? sum(pick, pick("受取手形及び売掛金") !== null
      ? ["受取手形及び売掛金", "契約資産", "電子記録債権"]
      : ["受取手形", "売掛金", "契約資産", "電子記録債権"]);

  const inv = pick("棚卸資産")
    ?? sum(pick, ["商品及び製品", "仕掛品", "原材料及び貯蔵品"]);

  const ap = pick("仕入債務IFRS")
    ?? sum(pick, pick("支払手形及び買掛金") !== null
      ? ["支払手形及び買掛金", "電子記録債務"]
      : ["支払手形", "買掛金", "電子記録債務"]);

  const wc = (ar === null && inv === null && ap === null)
    ? null : (ar || 0) + (inv || 0) - (ap || 0);
  return { ar, inv, ap, wc };
}

/**
 * CCC（現金が出てから戻るまでの日数）。
 *   売上債権回転日数 ＋ 棚卸資産回転日数 － 仕入債務回転日数
 * 棚卸と仕入債務は売上原価で割る。売上高で割ると粗利のぶん短く出る。
 */
export function ccc({ ar, inv, ap }, sales, cogs) {
  const perDaySales = div(sales, 365);
  const perDayCogs = div(cogs, 365);
  const dso = div(ar, perDaySales);
  const dio = div(inv, perDayCogs);
  const dpo = div(ap, perDayCogs);
  const days = (dso === null || dio === null || dpo === null)
    ? null : dso + dio - dpo;
  return { dso, dio, dpo, days };
}

// ---- 有利子負債 ----------------------------------------------------------

export function debt(pick) {
  const short = sum(pick, ["短期借入金", "コマーシャルペーパー"]);
  const within1y = pick("1年内返済長期借入金");
  const long = sum(pick, ["長期借入金", "社債"]);
  const total = sum(pick, ["短期借入金", "コマーシャルペーパー",
    "1年内返済長期借入金", "長期借入金", "社債"]);
  return { short, within1y, long, total };
}

// ---- 手元資金の余力 ------------------------------------------------------

/**
 * いくら持っていて、そのうちいくら使えるか。
 *
 * 使える現金 ＝ 現預金 − 事業を回すのに要る分 − 1年内に返す借入
 * 事業を回すのに要る分は「月商×◯ヶ月」で置く。ここが最大の前提。
 */
export function headroom({ cash, sales, within1y, monthsOfSales }) {
  const monthly = div(sales, 12);
  const need = monthly === null ? null : monthly * monthsOfSales;
  const free = (cash === null || need === null)
    ? null : cash - need - (within1y || 0);
  return {
    cash, monthly, need, within1y: within1y || 0, free,
    // 手元流動性。現預金が月商の何ヶ月ぶんか。
    months: div(cash, monthly),
  };
}

// ---- 将来のキャッシュ ----------------------------------------------------

/**
 * このままいくと現金がどう動くかを、年ごとに置く。
 *
 * 営業CFは「売上に対する比率」が続くとみなして伸ばす。
 * 額をそのまま横置きすると、売上が伸びる前提と噛み合わない。
 * 投資は、入れた投資計画（無ければ過去の投資CFの平均）を毎年引く。
 * 借入の返済は、1年内返済額が毎年続くとみなす。粗いが、
 * 返済予定表は有報から取れないのでこれ以上は詰められない。
 */
export function project({ cash, sales, opeCfRatio, growth, capexPerYear,
                          repayPerYear, need, years }) {
  const rows = [];
  let c = cash, s = sales;
  for (let i = 1; i <= years; i++) {
    s = s * (1 + growth);
    const ope = s * opeCfRatio;
    const out = (capexPerYear || 0) + (repayPerYear || 0);
    c = c + ope - out;
    rows.push({ year: i, sales: s, ope, out, cash: c, short: c - (need || 0) });
  }
  // 必要な手元資金を割り込む最初の年。
  const hit = rows.find((r) => r.short < 0);
  return { rows, shortfallYear: hit ? hit.year : null };
}

// ---- 借入かエクイティか --------------------------------------------------

/**
 * どちらが向くかを、指標で並べる。
 *
 * 断定はしない。「この数字だとこう見られやすい」という材料を出すだけ。
 * 実際の判断は、会社の意向・株価・金利環境で変わる。
 */
export function financingFit({ debtTotal, cash, equity, assets,
                               opProfit, depreciation, interest,
                               debtEbitdaLimit, interestCoverLimit }) {
  const ebitda = (opProfit === null) ? null : opProfit + (depreciation || 0);
  const netDebt = (debtTotal === null) ? null : debtTotal - (cash || 0);
  const points = [];

  const equityRatio = div(equity, assets);
  const de = div(debtTotal, equity);
  const netDe = div(netDebt, equity);
  const debtEbitda = (ebitda !== null && ebitda > 0) ? div(debtTotal, ebitda) : null;
  const cover = (interest && interest > 0) ? div(opProfit, interest) : null;

  if (ebitda !== null && ebitda <= 0) {
    points.push({ side: "equity", text:
      "EBITDAがマイナス。返済原資を利益で示せないため、借入は組み立てにくい。" });
  } else if (debtEbitda !== null) {
    points.push(debtEbitda > debtEbitdaLimit
      ? { side: "equity", text:
          `有利子負債はEBITDAの${debtEbitda.toFixed(1)}倍。` +
          `${debtEbitdaLimit}倍を超えており、借入の積み増し余地は小さい。` }
      : { side: "debt", text:
          `有利子負債はEBITDAの${debtEbitda.toFixed(1)}倍。借入の余地がある。` });
  }

  if (cover !== null) {
    points.push(cover < interestCoverLimit
      ? { side: "equity", text:
          `営業利益は支払利息の${cover.toFixed(1)}倍。利払いの余裕が小さい。` }
      : { side: "debt", text:
          `営業利益は支払利息の${cover.toFixed(1)}倍。利払いの余裕がある。` });
  }

  if (equityRatio !== null) {
    points.push(equityRatio < 0.3
      ? { side: "equity", text:
          `自己資本比率は${(equityRatio * 100).toFixed(1)}%。` +
          `資本を厚くする必要性が高い。` }
      : { side: "debt", text:
          `自己資本比率は${(equityRatio * 100).toFixed(1)}%。` +
          `財務の余力があり、希薄化を伴わない借入を選びやすい。` });
  }

  if (netDe !== null && netDe < 0) {
    points.push({ side: "debt", text:
      "現預金が有利子負債を上回っている（実質無借金）。借入の余地は大きい。" });
  }

  const e = points.filter((p) => p.side === "equity").length;
  const d = points.filter((p) => p.side === "debt").length;
  return {
    ebitda, netDebt, equityRatio, de, netDe, debtEbitda, cover, points,
    lean: e === d ? "どちらとも言えない" : e > d ? "エクイティ寄り" : "借入寄り",
  };
}

// ---- まとめて計算 --------------------------------------------------------

/**
 * 帯JSONの中身から、一式を組み立てる。
 * fin = d（主要な経営指標）, ext = x（追加で取った項目）
 */
export function analyze({ fin, ext, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const pick = (k) => latest(fin[k]) ?? latest(ext[k]);

  const sales = pick("売上高");
  const cogs = pick("売上原価");
  const cash = pick("現金及び現金同等物") ?? pick("現金及び預金");
  const wc = workingCapital(pick);
  const cy = ccc(wc, sales, cogs);
  const d = debt(pick);
  const hr = headroom({ cash, sales, within1y: d.within1y,
                        monthsOfSales: o.monthsOfSales });

  // 売上の伸び。5年の実績から年平均で出す。入れてもらえればそれを使う。
  const ss = series(fin["売上高"], 5).filter((r) => r[1]);
  const growth = o.growth !== null && o.growth !== undefined ? o.growth
    : (ss.length >= 2 && ss[0][1] > 0)
      ? Math.pow(ss[ss.length - 1][1] / ss[0][1], 1 / (ss.length - 1)) - 1
      : 0;

  // 営業CFの売上に対する比率。直近3年の平均。単年は振れるため。
  const oc = series(fin["営業CF"], 3).map((r) => r[1]).filter((v) => v !== null);
  const sl = series(fin["売上高"], 3).map((r) => r[1]).filter((v) => v !== null);
  const opeCfRatio = (oc.length && sl.length && sl.some((v) => v > 0))
    ? oc.reduce((a, b) => a + b, 0) / sl.reduce((a, b) => a + b, 0) : 0;

  // 投資額。入れてもらえればそれ、無ければ過去の投資CFの平均（絶対値）。
  const ic = series(fin["投資CF"], 3).map((r) => r[1]).filter((v) => v !== null);
  const capexPerYear = o.capexPerYear ?? (ic.length
    ? Math.abs(ic.reduce((a, b) => a + b, 0) / ic.length) : 0);

  const pj = project({
    cash: cash || 0, sales: sales || 0, opeCfRatio, growth, capexPerYear,
    repayPerYear: d.within1y || 0, need: hr.need, years: o.years,
  });

  const fit = financingFit({
    debtTotal: d.total, cash, equity: pick("純資産"), assets: pick("総資産"),
    opProfit: pick("営業利益"), depreciation: pick("減価償却費"),
    interest: pick("支払利息"),
    debtEbitdaLimit: o.debtEbitdaLimit, interestCoverLimit: o.interestCoverLimit,
  });

  // 投資をやるのに足りない額。賄えるのは「使える現金＋年間の営業CF」まで。
  const opeCf = (sales || 0) * opeCfRatio;
  const gap = (hr.free === null) ? null
    : Math.max(0, capexPerYear - (hr.free + opeCf));

  return {
    opts: o, sales, cogs, cash, growth, opeCfRatio, opeCf, capexPerYear,
    wc, ccc: cy, debt: d, headroom: hr, projection: pj, fit, gap,
    missing: ["売上高", "売上原価", "現金及び現金同等物", "営業CF"]
      .filter((k) => pick(k) === null),
  };
}
