// shindan.js — この会社で何が論点になりそうかを、数字の条件でざっくり並べる
//
// MSワラントに入る前の入口。「現金が多くROEが低い → 自社株買い・増配」
// 「流通株式が少ない → 売出し」「資金が要る → エクイティ（その中にMSワラント）」
// のように、有報の数字に条件を当てて、論点と候補の手法を出す。
//
// ここは判断ではなく「数字がこう並んでいるので、この論点が立ちやすい」という材料。
// 条件と根拠の数字は全部出す。AIは使わない（数字の取り違えが怖いため）。
//
// 依存なし。ブラウザでもNodeでも動く。

import { analyze, debt as debtOf, asRatio } from "./shikin.js";

// ---- 小道具 --------------------------------------------------------------

const num = (v) => {
  const t = String(v ?? "").replace(/,/g, "").trim();
  if (t === "") return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
};

/** 年度→値 の系列から、古い順にn年ぶん [年, 値] を返す。 */
export function series(map, n = 3) {
  if (!map) return [];
  return Object.keys(map).sort().slice(-n).map((y) => [y, num(map[y])]);
}
const latest = (map) => { const s = series(map, 1); return s.length ? s[0][1] : null; };
const div = (a, b) => (a === null || a === undefined || b === null || b === undefined || b === 0)
  ? null : a / b;

const oku = (v) => v === null ? "—" : `${(v / 1e8).toFixed(1)}億円`;
const pct = (v, d = 1) => v === null ? "—" : `${(v * 100).toFixed(d)}%`;
const x2 = (v) => v === null ? "—" : `${v.toFixed(2)}倍`;

// 東証の上場維持基準（流通株式）。市場区分はデータに無いので、3つとも並べる。
export const FLOAT_RULES = [
  { market: "プライム", ratio: 0.35, cap: 100e8 },
  { market: "スタンダード", ratio: 0.25, cap: 10e8 },
  { market: "グロース", ratio: 0.25, cap: 5e8 },
];

/** 比べる基準。市場区分が分かればその1つ、分からなければ3つとも。 */
export function floatRules(segment) {
  const r = FLOAT_RULES.filter((x) => x.market === segment);
  return r.length ? r : FLOAT_RULES;
}

// ---- 株主の分類 ----------------------------------------------------------

/**
 * 大株主の名前から種類を当てる。
 * 信託口・カストディは投資家の持ち分を預かっているだけなので「政策保有」に数えない。
 * 株式会社の中には創業家の資産管理会社も入るが、名前からは見分けられない。
 */
export function holderKind(name) {
  // 「海外ファンド 常任代理人 株式会社三菱UFJ銀行」の後ろ半分は代理人で、持ち主ではない。
  const n = String(name || "").replace(/[（(]?常任代理人.*$/, "").replace(/\s+/g, "");
  if (/信託口|信託銀行.*口|カストディ|マスタートラスト|資産管理サービス|ノミニー|NOMINEE|CUSTODY|BNYM|STATESTREET|STATE STREET|JPMORGAN|JP MORGAN|GOLDMAN|MORGAN STANLEY|BNP|HSBC|CITI|UBS|BARCLAYS/i.test(n)) return "信託・カストディ";
  if (/自己株|自社株/.test(n)) return "自己株式";
  if (/持株会/.test(n)) return "持株会";
  if (/証券|證券/.test(n)) return "証券会社";
  if (/銀行|信用金庫|信用組合|農林中央金庫/.test(n)) return "銀行";
  if (/生命保険|損害保険|火災保険|海上火災|火災海上|海上日動|損保|日本生命|明治安田|住友生命|第一生命/.test(n)) return "保険";
  if (/投資事業|ファンド|FUND|L\.?P\.?$|LIMITED|LTD|INC|CORP|PLC|S\.?à?\s*r\.?l|S\.A\.|GmbH|B\.V\.|N\.V\.|PTE|LLC/i.test(n)) return "ファンド・海外法人";
  if (/株式会社|㈱|\(株\)|有限会社|㈲|合同会社|財団|社団/.test(n)) return "事業法人等";
  // ラテン文字だけの名前は海外の法人（「Paxalan S.à r.l.」のようにアクセント付きの文字もある。7048）
  if (/^[\p{Script=Latin}0-9 .,&'()\-]+$/u.test(n)) return "ファンド・海外法人";
  return "個人";
}

const normName = (s) => String(s || "").replace(/[\s　]+/g, "");

/**
 * 資料に出す株主名。個人は空白を詰めて「様」を付ける（本人の指定・既存の提案書の表記）。
 * 法人・信託口などはそのまま。
 */
export function holderLabel(name, kind = holderKind(name)) {
  return kind === "個人" ? `${normName(name)} 様` : String(name || "").replace(/\s+/g, " ").trim();
}

/**
 * 事業法人のうち、親会社や創業家の資産管理会社らしいもの。
 * 10%以上を持つ事業法人は持ち合い（政策保有）ではなく、親会社か資産管理会社のことが多い。
 * 「株式会社KIM」「株式会社SC」のような短い英字の社名も資産管理会社によくある。
 * 名前だけでは確定できないので、政策保有に数えずに「大株主」として扱い、確認を促す。
 */
export function looksLikeOwner(h) {
  if (h.kind !== "事業法人等") return false;
  const core = h.name.replace(/株式会社|㈱|有限会社|合同会社|\(株\)|[\s　]/g, "");
  // 短い英字の社名は資産管理会社に多いが、JTBのような事業会社もある。3%以上持っているときだけ。
  return (h.ratio !== null && h.ratio >= 0.1) || (/^[A-Za-z0-9&.\-]{1,5}$/.test(core) && h.ratio >= 0.03)
    || /財団|社団/.test(h.name);
}

/** 大株主の表。[順位, 名前, 住所, 株数, 単位, 比率%] */
function holders(rows) {
  if (!rows) return [];
  const unit = (u) => (u || "").includes("千") ? 1000 : (u || "").includes("百") ? 100 : 1;
  return rows.map((r) => ({
    name: String(r[1] || "").replace(/\s+/g, " ").trim(),
    shares: num(r[3]) === null ? null : num(r[3]) * unit(r[4]),
    ratio: num(r[5]) === null ? null : num(r[5]) / 100,
  })).filter((r) => r.name).map((r) => {
    const kind = holderKind(r.name);
    return { ...r, kind, label: holderLabel(r.name, kind) };
  });
}

/** 役員の保有株数の合計。[役職, 氏名, 生年月日, 任期, 株数, 単位] */
function officerShares(rows) {
  if (!rows) return { total: null, names: [] };
  const unit = (u) => (u || "").includes("千") ? 1000 : (u || "").includes("百") ? 100 : 1;
  let total = 0, got = false;
  const names = [];
  for (const r of rows) {
    const v = num(r[4]);
    names.push(normName(r[1]));
    if (v !== null) { total += v * unit(r[5]); got = true; }
  }
  return { total: got ? total : null, names };
}

/** 所有者別状況。[区分, 株主数, 株式数(単元), 比率%] */
function ownRows(rows) {
  if (!rows) return [];
  return rows.map((r) => ({
    category: String(r[0] || "").trim(),
    ratio: num(r[3]) === null ? null : num(r[3]) / 100,
  })).filter((r) => r.category && r.ratio !== null && !/^計$|単元未満/.test(r.category));
}

// ---- 会社の数字をまとめる ------------------------------------------------

/**
 * 診断と「会社の現状」ページの両方で使う数字を、一度に作る。
 * ctx は teian.js と同じもの（fin, ext, sec, basis, market）。
 */
export function profile(ctx) {
  const { fin = {}, ext = {}, sec = {}, basis = {}, market = {} } = ctx;
  const pick = (k) => latest(fin[k]) ?? latest(ext[k]);

  const roe = asRatio(pick("ROE"));
  const eqRatio = asRatio(pick("自己資本比率"));
  const eps = pick("EPS");
  const bps = pick("BPS");
  const per = pick("株価収益率");
  const dps = pick("1株当たり配当");
  const sales = pick("売上高");
  const op = pick("営業利益");
  const net = pick("純利益");
  const assets = pick("総資産");
  const equity = pick("純資産");
  const cash = pick("現金及び現金同等物") ?? pick("現金及び預金");
  const d = debtOf(pick);
  const netCash = cash === null ? null : cash - (d.total || 0);

  // 株価。入れてもらえばそれ。無ければ有報の期末株価（PER×EPS）を使う。
  // 赤字の会社はPERが出ないので期末株価も出ない。そのときは入れてもらう。
  const priceEnd = (per > 0 && eps > 0) ? per * eps : null;
  const price = market.price || priceEnd;
  const priceBasis = market.price ? `入力株価（${market.asOf || "基準日未入力"}）`
    : priceEnd ? "有報の期末株価（PER×EPS）" : null;
  const issued = basis.issued || null;
  const mcap = price && issued ? price * issued : null;
  const pbr = div(price, bps);

  // 年ごとの資本効率。PBRはその年の期末株価で出す。
  // 年の列は、どの会社にもある自己資本比率・純資産から取る（売上もROEも無い創薬で空になった）。
  const years = series(fin["自己資本比率"] || fin["純資産"] || fin["ROE"], 3).map((r) => r[0]);
  const at = (k, y) => num((fin[k] ?? ext[k])?.[y]);
  // 有利子負債は有報の貸借対照表から取るので当期・前期の2年分しか無い。
  // 借入の科目がどの年にも無い会社（無借金）は、現預金＝ネットキャッシュとして全年出す。
  // 借入がある会社で、その年の借入が取れていなければ「—」にする（0と書くと無借金に見える）。
  const DEBT_KEYS = ["短期借入金", "コマーシャルペーパー", "1年内返済長期借入金", "長期借入金", "社債"];
  const noDebtEver = DEBT_KEYS.every((k) => !ext[k] || !Object.keys(ext[k]).length);
  const debtAt = (y) => {
    if (noDebtEver) return 0;
    let t = 0, got = false;
    for (const k of DEBT_KEYS) { const v = num(ext[k]?.[y]); if (v !== null) { t += v; got = true; } }
    return got ? t : null;
  };
  const byYear = years.map((y) => {
    const e = at("EPS", y), p = at("株価収益率", y), b = at("BPS", y), dv = at("1株当たり配当", y);
    const pe = (p > 0 && e > 0) ? p * e : null;
    return {
      year: y,
      roe: asRatio(at("ROE", y)),
      eqRatio: asRatio(at("自己資本比率", y)),
      payout: (dv !== null && e > 0) ? dv / e : null,
      pbr: div(pe, b),
      cash: at("現金及び現金同等物", y),
      netCash: (() => { const c = at("現金及び現金同等物", y), d = debtAt(y);
        return c === null || d === null ? null : c - d; })(),
    };
  });

  // 株主
  const sh = holders(sec.sh);
  const own = ownRows(sec.own);
  const off = officerShares(sec.of);
  const ownOf = (re) => own.filter((o) => re.test(o.category))
    .reduce((a, o) => a + o.ratio, 0);
  const corp = ownOf(/その他の法人/);

  // 流通株式比率の推定（東証の定義に寄せる）。
  //   上場株式数 −（自己株式 ＋ 役員 ＋ 10%以上の大株主 ＋ 事業法人等 ＋ 銀行・保険の保有）
  // 事業法人等は所有者別の「その他の法人」、銀行・保険は大株主に出てくる分だけ（信託口は除く）。
  // 重なり（役員が10%以上の大株主でもある、など）は名前で落とす。
  let float = null;
  if (issued && own.length) {
    const offNames = new Set(off.names);
    const big = sh.filter((h) => h.ratio !== null && h.ratio >= 0.1
      && h.kind !== "事業法人等" && h.kind !== "信託・カストディ"
      && !offNames.has(normName(h.name)));
    const bankIns = sh.filter((h) => h.kind === "銀行" || h.kind === "保険");
    const fixed = (basis.treasury || 0) + (off.total || 0)
      + big.reduce((a, h) => a + (h.shares || 0), 0)
      + bankIns.reduce((a, h) => a + (h.shares || 0), 0)
      + corp * issued;
    const ratio = Math.max(0, Math.min(1, 1 - fixed / issued));
    float = { ratio, cap: mcap ? mcap * ratio : null,
              officers: off.total, treasury: basis.treasury || 0, corp };
  }

  // 政策保有されている分（相手が持っている当社株）。銀行・保険・事業法人等。
  // 資産管理会社・親会社らしいものは除く（大株主の集中の方で扱う）。
  const policyHeld = sh.filter((h) => ["銀行", "保険"].includes(h.kind)
    || (h.kind === "事業法人等" && !looksLikeOwner(h)));
  const policyHeldRatio = policyHeld.reduce((a, h) => a + (h.ratio || 0), 0);

  // 会社が持っている政策保有株（【株式の保有状況】）。
  // 持株会社は子会社（最大保有会社・第2位保有会社）の欄に載るので、3つを足す。
  // 三越伊勢丹HDは本体が非上場5.55億円だけで、上場株347.8億円は最大保有会社の欄にあった。
  const holdings = (() => {
    const sfx = ["", "_最大保有会社", "_第2位保有会社"];
    const sumOf = (k) => {
      let t = 0, got = false;
      for (const x of sfx) {
        const v = latest(ext[`政策保有_${k}${x}`]);
        if (v !== null) { t += v; got = true; }
      }
      return got ? t : null;
    };
    const listed = sumOf("上場_計上額");
    const unlisted = sumOf("非上場_計上額");
    const pure = latest(ext["純投資_上場_計上額"]);
    // 項目がどれも無ければ「まだ取得していない」。0（持っていない）と区別する。
    const fetched = Object.keys(ext).some((k) => k.startsWith("政策保有_") || k === "純投資_上場_計上額");
    if (!fetched) return null;
    const total = (listed || 0) + (unlisted || 0);
    return {
      listed, unlisted, total, count: sumOf("上場_銘柄数"), sold: sumOf("上場_売却額"), pure,
      viaSubsidiary: ["_最大保有会社", "_第2位保有会社"].some((x) => latest(ext[`政策保有_上場_計上額${x}`]) !== null),
      toEquity: div(total, equity),
      // 売って現金にできる上場株。純投資目的の分も入れる。
      // 菊池は政策保有が0.5億円だけだが、純投資目的の上場株を23.9億円（純資産の38%）持っていた。
      sellable: (listed || 0) + (pure || 0),
      pureToEquity: div(pure, equity),
    };
  })();

  const a = analyze({ fin, ext, opts: ctx.cashOpts || {} });

  return {
    roe, eqRatio, eps, bps, per, dps, sales, op, net, assets, equity,
    opMargin: div(op, sales), payout: (dps !== null && eps > 0) ? dps / eps : null,
    cash, debt: d.total, netCash, netCashToAssets: div(netCash, assets),
    price, priceBasis, mcap, pbr, netCashToMcap: div(netCash, mcap),
    byYear, holders: sh, own, float, policyHeld, policyHeldRatio, holdings,
    // 筆頭は、信託口（投資家の預かり）を除いた実質の持ち主で見る。
    top: sh.find((h) => h.kind !== "信託・カストディ" && h.kind !== "持株会") || null,
    owners: sh.filter((h) => looksLikeOwner(h) || (h.kind === "個人" && h.ratio >= 0.05)),
    opPrev: (() => { const s = series(fin["営業利益"], 2); return s.length > 1 ? s[0][1] : null; })(),
    cashAnalysis: a,
  };
}

// ---- 論点を並べる --------------------------------------------------------

/**
 * 論点と候補の手法。強いものから並べる。
 *   { id, title, score, evidence[], products[], note }
 * score は条件をいくつ満たしたか。比べるための目安で、それ以上の意味は無い。
 */
export function diagnose(ctx, pf = profile(ctx)) {
  const out = [];
  const a = pf.cashAnalysis;

  // 1. 資本効率（現金が多く、ROEが低い）→ 自社株買い・増配
  {
    const ev = [];
    let score = 0;
    const cashRich = (pf.netCashToAssets !== null && pf.netCashToAssets >= 0.15)
      || (pf.eqRatio !== null && pf.eqRatio >= 0.6);
    // ROEが低い理由が赤字（利益の側）なら、資本を減らしても解決しない。
    // 2期続けて営業黒字の会社だけを対象にする（菊池：赤字でROE1.9%、freee：前期赤字）。
    const steady = pf.op !== null && pf.op > 0 && pf.opPrev !== null && pf.opPrev > 0;
    if (pf.roe !== null && pf.roe > 0 && pf.roe < 0.08 && cashRich && steady) {
      score = 2;
      ev.push(`ROE ${pct(pf.roe)}（目安の8%を下回る）`);
      if (pf.netCash !== null) {
        ev.push(`ネットキャッシュ ${oku(pf.netCash)}（総資産の${pct(pf.netCashToAssets)}）`);
      }
      if (pf.eqRatio !== null) ev.push(`自己資本比率 ${pct(pf.eqRatio)}`);
      if (pf.pbr !== null && pf.pbr < 1) { score++; ev.push(`PBR ${x2(pf.pbr)}（1倍割れ・${pf.priceBasis}）`); }
      if (pf.netCashToMcap !== null && pf.netCashToMcap >= 0.3) {
        score++; ev.push(`ネットキャッシュが時価総額の${pct(pf.netCashToMcap)}`);
      }
      if (pf.payout !== null) ev.push(`配当性向 ${pct(pf.payout)}`);
      out.push({
        // 現金が厚いのか、自己資本が厚いだけ（借入もある）のかで書き分ける。
        // モロゾフは自己資本比率70%だがネットキャッシュはマイナス。
        id: "capital",
        title: pf.netCashToAssets !== null && pf.netCashToAssets >= 0.15
          ? "資本効率：手元資金が厚く、ROEが低い" : "資本効率：自己資本が厚く、ROEが低い",
        score, evidence: ev,
        products: ["自社株買い",
          ...(pf.dps === null || pf.dps === 0 ? ["配当の開始"]
            : pf.payout !== null && pf.payout < 0.5 ? ["増配"] : [])],
        note: "余剰資金を株主還元に回し、自己資本を圧縮してROEを上げる話になりやすい。",
      });
    }
  }

  // 2. 流通株式（少ない・流通時価総額が小さい）→ 売出し・立会外分売
  if (pf.float) {
    const f = pf.float;
    const seg = ctx.market?.segment || "";
    const rules = floatRules(seg);
    const miss = rules.filter((r) => f.ratio < r.ratio || (f.cap !== null && f.cap < r.cap));
    // 市場区分はデータに無いので画面で選んでもらう。選ばれていないときに、
    // プライムの基準だけ下回る会社（スタンダード上場かもしれない）を論点に上げると外すので、
    // 比率が35%未満か、スタンダードの基準も下回るときだけ出す。
    if (seg ? miss.length : (f.ratio < 0.35 || miss.some((r) => r.market !== "プライム"))) {
      const ev = [`流通株式比率 ${pct(f.ratio)}（推定）` +
        (f.cap !== null ? `・流通時価総額 ${oku(f.cap)}` : "")];
      ev.push((seg ? "" : "市場区分未選択のため全区分を表示。") + "上場維持基準：" + rules.map((r) =>
        `${r.market} ${pct(r.ratio, 0)}・${oku(r.cap)}` +
        ((f.ratio < r.ratio || (f.cap !== null && f.cap < r.cap)) ? "（下回る）" : "")).join(" / "));
      out.push({
        id: "float", title: "流通株式：市場で売買できる株が少ない",
        score: miss.length >= 2 ? 3 : miss.length ? 2 : 1, evidence: ev,
        products: ["売出し（大株主・創業家の持ち分）", "立会外分売"],
        note: "推定は大株主・役員・所有者別状況から組んだ概算。市場区分と会社の開示（上場維持基準への適合状況）で必ず確かめる。",
      });
    }
  }

  // 3. 大株主の集中 → 大株主の売却
  if (pf.top && pf.top.ratio !== null && pf.top.ratio >= 0.2) {
    const ownerSum = pf.owners.reduce((a, h) => a + (h.ratio || 0), 0);
    out.push({
      id: "major", title: `大株主の集中：筆頭株主が${pct(pf.top.ratio)}を保有`,
      score: pf.top.ratio >= 0.33 || ownerSum >= 0.5 ? 2 : 1,
      evidence: [
        ...pf.owners.slice(0, 4).map((h) => `${h.label}（${looksLikeOwner(h)
          ? "親会社・資産管理会社の可能性" : h.kind}）${pct(h.ratio, 2)}`),
        pf.owners.length > 1 ? `合計 ${pct(ownerSum, 1)}` : null,
      ].filter(Boolean),
      products: ["大株主の売却（売出し・ブロックトレード）", "自社株買い（受け皿として）"],
      note: "相続・事業承継・ファンドの出口などで売却ニーズが出やすい。売る側の事情は開示からは分からない。",
    });
  }

  // 4. 政策保有されている（相手が当社株を持っている）→ 政策株式の売却の受け皿
  if (pf.policyHeldRatio >= 0.05) {
    out.push({
      id: "crossheld", title: `当社株の持ち合い：銀行・保険・事業会社が${pct(pf.policyHeldRatio)}を保有（大株主上位）`,
      score: pf.policyHeldRatio >= 0.15 ? 2 : 1,
      evidence: pf.policyHeld.slice(0, 5).map((h) => `${h.label}（${h.kind}）${pct(h.ratio, 2)}`),
      products: ["政策株式の売却（売出しで受け皿を作る）", "自社株買い（受け皿として）"],
      note: "持ち合い解消の流れで売却が出やすい。10%以上の事業法人と短い英字の社名は、親会社・資産管理会社として除いてある。",
    });
  }

  // 5. 政策保有株を持っている（会社が他社の株を持っている）→ 売却して還元・投資へ
  //    目安は純資産の20%。議決権行使助言会社がこれを超えると反対を推奨する水準。
  const hd = pf.holdings;
  const allToEquity = hd ? div(hd.total + (hd.pure || 0), pf.equity) : null;
  if (hd && allToEquity !== null && allToEquity >= 0.1) {
    const ev = [];
    if (hd.total > 0) {
      ev.push(`政策保有株 ${oku(hd.total)}（純資産の${pct(hd.toEquity)}）` +
        (hd.count !== null ? `・上場${hd.count}銘柄` : "") +
        (hd.viaSubsidiary ? "・子会社（最大保有会社など）の保有を含む" : ""));
    }
    if (hd.pure > 0) ev.push(`純投資目的の上場株 ${oku(hd.pure)}（純資産の${pct(hd.pureToEquity)}）`);
    // 純資産20%の目安は政策保有の分だけに当てる（純投資は批判の対象になりにくい）。
    let score = hd.toEquity >= 0.2 || allToEquity >= 0.3 ? 2 : 1;
    if (hd.toEquity >= 0.2) ev.push("純資産の20%以上（議決権行使助言会社が反対を推奨する目安）");
    if (pf.roe !== null && pf.roe > 0 && pf.roe < 0.08) { score++; ev.push(`ROE ${pct(pf.roe)}`); }
    if (hd.sold) ev.push(`当期に${oku(hd.sold)}を売却済み（縮減を進めている）`);
    out.push({
      id: "crosshold", title: `保有株式：他社の株を純資産の${pct(allToEquity)}ぶん持っている`, score, evidence: ev,
      // 赤字の会社は還元より先に資金繰り。菊池（赤字・純投資株23.9億）で「自社株買い」を先に出していた。
      products: (() => {
        const what = hd.total >= (hd.pure || 0) ? "政策保有株の売却" : "保有株の売却";
        const give = `${what} → 売却資金で自社株買い・増配`;
        const use = `${what} → 売却資金を事業・投資に充てる（エクイティの前に）`;
        return pf.op !== null && pf.op > 0 ? [give, use] : [use];
      })(),
      note: "売却先の会社にとっては「政策株式の売却」の話にもなる。取引関係があるので、売る順番と相手の意向は会社と詰める。",
    });
  }

  // 6. 資金需要 → エクイティファイナンス（その中でMSワラント・公募増資）
  {
    const ev = [];
    let score = 0;
    if (a.noSales && a.runway?.years !== null && a.runway?.years !== undefined) {
      // 現金が減り続けている会社は、何年分あっても次の調達が前提になる。
      score += a.runway.years < 3 ? 3 : 2;
      ev.push(`年${oku(a.runway.burn)}のペースで現金が減っており、現預金は約${a.runway.years.toFixed(1)}年分`);
    }
    if (pf.op !== null && pf.op < 0 && pf.opPrev !== null && pf.opPrev < 0) {
      score++; ev.push("営業赤字が2期続いている");
    }
    // 黒字なのに営業CFがマイナスの会社（不動産の仕入れ・在庫の積み上がり）は、不足の中身が
    // 設備投資ではなく仕入れの資金。「投資に対して自己資金が足りない」と書くと取り違える
    // （アグレ都市デザイン：投資年1.6億円に対して28.8億円不足と出ていた）。
    const opeNeg = a.opeCf < 0 && pf.net !== null && pf.net > 0;
    if (opeNeg) {
      score++; ev.push("黒字だが営業CFがマイナス（仕入れ・在庫の積み上がりなど）で、借入などで資金を補っている");
    } else if (a.gap > 0) { score++; ev.push(`投資に対して自己資金が${oku(a.gap)}足りない`); }
    if (a.projection?.shortfallYear) {
      score++; ev.push(`いまのペースだと${a.projection.shortfallYear}年後に手元資金の下限を割る`);
    }
    // 「月商の目安を下回る」は大きな会社では当たらない（ニッスイ）。根拠には書くが、数えない。
    if (a.headroom?.free !== null && a.headroom.free < 0 && !a.negativeWc && !a.noSales) {
      ev.push("手元資金が月商×" + a.opts.monthsOfSales + "ヶ月の目安を下回る（大きな会社には当てはまりにくい）");
    }
    if (pf.eqRatio !== null && pf.eqRatio < 0.3) { score++; ev.push(`自己資本比率 ${pct(pf.eqRatio)}`); }
    // 実質無借金なら、借入がEBITDAの何倍でも返済の心配は無い（freee：ネットキャッシュ262億）。
    if (a.fit?.debtEbitda !== null && a.fit?.debtEbitda > 5 && a.fit?.netDebt > 0) {
      score++; ev.push(`有利子負債がEBITDAの${a.fit.debtEbitda.toFixed(1)}倍`);
    }
    if (a.fit?.ebitda !== null && a.fit?.ebitda <= 0) ev.push("EBITDAがマイナス");

    if (score > 0 && hd && hd.sellable > 0) {
      ev.push(`保有する上場株 ${oku(hd.sellable)}を売れば、一部を賄える`);
    }
    if (score > 0) {
      const loss = pf.op !== null && pf.op < 0;
      const small = pf.mcap !== null && pf.mcap < 300e8;
      const products = [];
      // 手法の違いは、準備期間・資金が入る時期・調達額の確定・希薄化の制御で書く。
      if (loss || small || a.noSales) {
        products.push("エクイティ → MSワラント（株価に応じて段階的に資金が入る。準備期間が短く、行使の進み方で希薄化の速さを調整できる）");
        products.push("エクイティ → 公募増資（調達額が一度に確定する。準備期間は長め）");
      } else {
        products.push("エクイティ → 公募増資（調達額が一度に確定する。準備期間は長め）");
        products.push("エクイティ → MSワラント（段階的に資金が入る。投資の時期に合わせて使える）");
      }
      products.push("第三者割当（提携先がある場合）");
      if (a.fit?.lean === "借入寄り") products.push("借入（指標上は借入の余地もある）");
      out.push({
        id: "funding", title: "資金需要：投資や事業継続に資金が要る", score, evidence: ev, products,
        note: "投資計画（中計）次第で大きく変わる。数字だけで見た資金の足りなさ。",
      });
    }
  }

  return out.sort((p, q) => q.score - p.score);
}

// ---- 推定オーナー比率 ----------------------------------------------------

/**
 * 創業家などオーナー側の持ち分を、名前と区分から推定する。
 *   上位10名の個人 ＋ 資産管理会社・親会社らしい法人（looksLikeOwner。上場会社は除く）＋ 上位10名に入っていない役員の持株
 * 持株会・信託口・証券会社・銀行・保険は入れない。親族関係や資産管理会社かどうかは名前だけでは確定できないので、
 * 何を入れたかを全部返して、確かめられるようにする。比率の分母は大株主の表と同じ（自己株式を除く発行済株式数）。
 *   { ratio, parts:[{label, kind, ratio, why}], officers:{ratio, count}|null }
 */
/** 社名の芯（株式会社・空白・全角半角の違いを落とす）。上場会社の一覧と照らすのに使う。 */
export const corpCore = (name) => String(name || "").normalize("NFKC")
  .replace(/[(（]?常任代理人.*$/, "").replace(/株式会社|有限会社|合同会社|\(株\)|㈱|[\s　]/g, "");

/** 事業法人の大株主が上場会社か。listed は corpCore の Set。 */
export const isListedCorp = (h, listed) => !!listed && h.kind === "事業法人等" && listed.has(corpCore(h.name));

export function ownerEstimate(shRows, ofRows, basis = {}, listed = null) {
  const sh = holders(shRows).slice(0, 10);
  const parts = [];
  for (const h of sh) {
    if (h.ratio === null) continue;
    if (h.kind === "個人") parts.push({ label: h.label, kind: h.kind, ratio: h.ratio, why: "個人の大株主" });
    // 上場会社は事業会社としての大株主（持ち合い・提携）で、創業家の資産管理会社ではない
    else if (isListedCorp(h, listed)) continue;
    else if (looksLikeOwner(h)) {
      parts.push({ label: h.label, kind: h.kind, ratio: h.ratio,
        why: h.ratio >= 0.5 ? "親会社か" : "資産管理会社・親会社などか" });
    }
  }
  // 上位10名に入っていない役員の持株（名前で重なりを落とす）。
  // 役員の状況の株数は、本人の資産管理会社を通した分も含めて書かれることがある（7048：役員の8,992千株＝
  // 大株主「Paxalan S.à r.l.」の24.56%と同じ）。10位の株主より多いのに上位10名に名前が無い役員は、
  // 会社を通して持っているとみて、比率がほぼ同じ（0.5pt以内）大株主をその役員の保有として1回だけ数える。
  let officers = null;
  const base = basis.issued ? basis.issued - (basis.treasury || 0) : null;
  if (ofRows && base > 0) {
    const inTop = new Set(sh.map((h) => normName(h.name)));
    const minTop = sh.length >= 10 ? Math.min(...sh.map((h) => h.ratio ?? 1)) : 0;
    const unit = (u) => (u || "").includes("千") ? 1000 : (u || "").includes("百") ? 100 : 1;
    let total = 0, count = 0;
    for (const r of ofRows) {
      const raw = String(r[1] || "").replace(/\s*注\s*\d+/g, "").trim();
      const name = normName(raw);
      const v = num(r[4]);
      if (!name || v === null || v <= 0 || inTop.has(name)) continue;
      const ratio = v * unit(r[5]) / base;
      if (minTop && ratio > minTop) {
        const via = sh.find((h) => h.ratio !== null && Math.abs(h.ratio - ratio) <= 0.005
          && h.kind !== "信託・カストディ" && h.kind !== "証券会社");
        const label = `${raw.replace(/[\s　]+/g, "")}氏`;
        if (via) {
          const had = parts.find((p) => p.label === via.label);
          if (had) had.why += `（役員 ${label}の保有とみられる）`;
          else parts.push({ label: via.label, kind: via.kind, ratio: via.ratio, why: `役員 ${label}の保有とみられる` });
        } else {
          parts.push({ label: `${label}（役員）`, kind: "役員", ratio, why: "役員の持株。大株主の表に名前が無く、会社を通した保有とみられる" });
        }
        continue;
      }
      total += v * unit(r[5]);
      count++;
    }
    if (count) officers = { ratio: total / base, count };
  }
  const ratio = parts.reduce((a, p) => a + p.ratio, 0) + (officers?.ratio || 0);
  return { ratio, parts, officers };
}

/** 画面に出す要約の数字。 */
export function keyFacts(pf) {
  return [
    ["ROE", pct(pf.roe)],
    ["自己資本比率", pct(pf.eqRatio)],
    ["ネットキャッシュ", oku(pf.netCash)],
    ["時価総額", pf.mcap ? `${oku(pf.mcap)}（${pf.priceBasis}）` : "—（株価の入力で算出）"],
    ["PBR", x2(pf.pbr)],
    ["配当性向", pct(pf.payout)],
    ["流通株式比率（推定）", pf.float ? pct(pf.float.ratio) : "—"],
    ["政策保有株", !pf.holdings ? "—（未取得）"
      : `${oku(pf.holdings.total)}（純資産の${pct(pf.holdings.toEquity)}）`],
  ];
}
