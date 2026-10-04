// genjo.js — 提案書の冒頭「御社の現状」2ページ
//
// ① 事業の状況：PL・BS・CF・株価指標を、通期実績（最大5期）・今期の四半期累計・今期予想・中計の順に1枚の表に並べる。
//    見出しの一文は、直近四半期の進捗が前年と比べて順調か遅れているかと、中計の達成に要る伸び。
// ② 資本効率と株主構成：ROE・自己資本比率・PBR・配当性向と、株主の顔ぶれ。
//
// 判定は数字の比較だけで行う（前年同期の進捗率との差、中計に要る伸び率と過去の伸び率）。
// 理由や背景は書かない。そこは【　】で空けて、会話の中で埋める。

import { profile, diagnose, floatRules, looksLikeOwner } from "./shindan.js";
import { quarterNo } from "./tanshin.js";
import { asRatio } from "./shikin.js";

const TODO = (w) => `【${w}】`;
const num = (v) => {
  const t = String(v ?? "").replace(/,/g, "").trim();
  if (t === "") return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
};
// 百万円未満は切り捨て（有報の表記。ページごとに四捨五入と混ざると同じ数字が1違って見える）。
const mm = (v) => (v === null || v === undefined ? null : Math.trunc(v / 1e6));
const fmt = (v) => (v === null || v === undefined) ? "—" : Math.round(v).toLocaleString("ja-JP");
const pct = (v, d = 1) => (v === null || v === undefined) ? "—" : `${(v * 100).toFixed(d)}%`;
const pt = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}pt`;
const div = (a, b) => (a === null || a === undefined || b === null || b === undefined || b === 0) ? null : a / b;
const yoy = (a, b) => (a === null || b === null || b <= 0) ? null : a / b - 1;

/** 決算期の年（「2027年4月期」→2027、"2026"→2026）。 */
const fyOf = (s) => { const m = /(\d{4})/.exec(String(s || "")); return m ? Number(m[1]) : null; };

// ---- 四半期の進捗 --------------------------------------------------------

/**
 * 直近の累計が、通期予想の何%まで来ているか。前年の同じ時点と比べる。
 *
 * 前年同期の進捗率 ＝ 前年同期の累計 ÷ 前年の通期実績（有報）。
 * 季節性がある会社は1Qで25%に届かないのが普通なので、25%・50%と比べるのではなく
 * 前年の同じ時点と比べる。差が±3pt以内なら「前年並み」。
 */
export function progress(t, fin) {
  if (!t?.actual || !t?.forecast) return null;
  const q = quarterNo(t.quarter);
  if (!q || q === 4) return null;
  const fy = fyOf(t.period);
  const prevFull = (k) => {
    const v = num(fin[k]?.[String(fy - 1)]);
    return v === null ? null : v / 1e6;       // 有報は円、短信は百万円
  };
  const row = (k) => {
    const cur = t.actual[k], fc = t.forecast[k], pr = t.prior?.[k] ?? null;
    // 赤字を含むと進捗率は意味を持たない（−152 ÷ 177 など）。出さない。
    const ok = cur > 0 && fc > 0;
    const rate = ok ? cur / fc : null;
    const pf = prevFull(k);
    const prate = (pr > 0 && pf > 0) ? pr / pf : null;
    const diff = rate !== null && prate !== null ? rate - prate : null;
    return {
      item: k, cur, fc, rate, prior: pr, prevFull: pf, prate, diff,
      growth: yoy(cur, pr),
      verdict: diff === null ? null : diff >= 0.03 ? "前年より先行" : diff <= -0.03 ? "前年より遅れ" : "前年並み",
    };
  };
  return { q, label: t.actual.期, rows: [row("売上高"), row("営業利益")] };
}

/**
 * 短信を何本か入れてあれば、四半期ごとの単独の数字を出す（2Q単独＝2Q累計−1Q累計）。
 * 同じ決算期のものだけ使う。
 */
export function quarters(all, period) {
  const same = (all || []).filter((t) => t.period === period && t.actual)
    .map((t) => ({ q: quarterNo(t.quarter), a: t.actual }))
    .filter((t) => t.q && t.q < 4)
    .sort((a, b) => a.q - b.q);
  const byQ = new Map(same.map((t) => [t.q, t.a]));
  const qs = [...byQ.keys()].sort();
  if (qs.length < 2) return null;
  return qs.map((q) => {
    const cur = byQ.get(q), prev = byQ.get(q - 1);
    const single = (k) => q === 1 ? cur[k] : (prev ? cur[k] - prev[k] : null);
    return { q, 売上高: single("売上高"), 営業利益: single("営業利益") };
  });
}

// ---- 中計 ----------------------------------------------------------------

/**
 * 中計目標に届くのに、年何%の伸びが要るか。過去3年の伸びと並べる。
 * 起点は今期予想（無ければ直近実績）。
 */
export function chukeiGap(ck, base, baseYear, fin) {
  if (!ck || !ck.year) return null;
  const years = fyOf(ck.year) - baseYear;
  const out = [];
  for (const [k, target] of [["売上高", ck.sales], ["営業利益", ck.op]]) {
    if (!(target > 0)) continue;
    const b = base[k];
    const need = (b > 0 && years > 0) ? Math.pow(target / b, 1 / years) - 1 : null;
    const hist = Object.keys(fin[k] || {}).sort().slice(-4).map((y) => num(fin[k][y]));
    const past = (hist.length >= 2 && hist[0] > 0 && hist[hist.length - 1] > 0)
      ? Math.pow(hist[hist.length - 1] / hist[0], 1 / (hist.length - 1)) - 1 : null;
    out.push({
      item: k, target, base: b, ratio: div(b, target), years, need, past,
      verdict: need === null ? null : years <= 0 ? null
        : need <= 0 ? "今期予想の段階で目標に届いている"
        : past !== null && need <= past ? "過去のペースで届く水準"
        : "過去のペースを上回る伸びが必要",
    });
  }
  return { years, rows: out };
}

// ---- ① 事業の状況 ---------------------------------------------------------
//
// 本人の指定した並び（上からPL・BS・CF・その他）で、左から
//   通期実績（有報・最大5期）→ 今期の四半期累計（短信）→ 今期の通期予想（短信）→ 中計目標（画面で入力）
// を1枚の表に並べる。有報は円、短信は百万円なので、ここで百万円（切り捨て）にそろえる。

/** 短信を決算期と四半期でならべ、今期の四半期累計と、今期の通期予想を出す。 */
export function currentTerm(all) {
  const list = (all || []).map((t) => ({ t, fy: fyOf(t.period), q: quarterNo(t.quarter) }))
    .filter((x) => x.fy && x.q)
    .sort((a, b) => a.fy - b.fy || a.q - b.q || String(a.t.announced || "").localeCompare(String(b.t.announced || "")));
  if (!list.length) return null;
  const last = list[list.length - 1];
  // 通期の決算短信なら、載っている予想は翌期のもの。四半期はまだ無い。
  const fy = last.q === 4 ? last.fy + 1 : last.fy;
  const byQ = new Map();
  for (const x of list) if (x.fy === fy && x.q < 4 && x.t.actual) byQ.set(x.q, x.t);   // 同じ四半期は後のものを使う
  return { fy, quarters: [...byQ.keys()].sort().map((q) => ({ q, t: byQ.get(q) })), forecast: last.t.forecast ? last.t : null };
}

const BIZ_ROWS = [
  ["PL"],
  ["売上高", "sales"], ["売上高伸び率", "salesG"], ["営業利益", "op"], ["営業利益伸び率", "opG"],
  ["経常利益", "ord"], ["当期純利益", "net"], ["1株当たり配当金（円）", "dps"],
  ["BS（資産）"],
  ["流動資産", "ca"], ["固定資産", "fa"], ["現金・現金同等物", "cash"], ["総資産", "ta"],
  ["BS（負債）"],
  ["流動負債", "cl"], ["固定負債", "fl"], ["有利子負債", "debt"],
  ["BS（純資産）"],
  ["純資産", "na"], ["資本金", "cap"], ["自己資本", "eq"], ["自己資本比率", "eqr"],
  ["キャッシュフロー"],
  ["営業CF", "ocf"], ["投資CF", "icf"], ["財務CF", "fcf0"], ["フリーCF（営業CF＋投資CF）", "fcf"],
  ["その他"],
  ["EPS（円）", "eps"], ["BPS（円）", "bps"], ["PER（倍）", "per"], ["PBR（倍）", "pbr"],
];
const DEBT = ["短期借入金", "コマーシャルペーパー", "1年内返済長期借入金", "長期借入金", "社債"];
const DEBT_Q = ["短期借入金", "コマーシャルペーパー", "一年内返済長期借入金", "長期借入金", "社債", "一年内償還社債"];
const sumOf = (vals) => { const v = vals.filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
const growthOf = (cur, prev) => (cur === null || cur === undefined || !(prev > 0)) ? null : cur / prev - 1;

/** 有報の1期ぶん。金額は百万円（切り捨て）。 */
function yearCol(get, y) {
  const m = (k) => mm(get(k, y));
  const fl = get("固定負債", y) ?? (get("負債合計", y) !== null && get("流動負債", y) !== null ? get("負債合計", y) - get("流動負債", y) : null);
  const ta = get("総資産", y), eqr = asRatio(get("自己資本比率", y));
  const ocf = get("営業CF", y), icf = get("投資CF", y);
  const per = get("株価収益率", y), eps = get("EPS", y), bps = get("BPS", y);
  const price = per > 0 && eps > 0 ? per * eps : null;
  const prev = String(Number(y) - 1);
  return {
    sales: m("売上高"), op: m("営業利益"), ord: m("経常利益"), net: m("純利益"), dps: get("1株当たり配当", y),
    salesG: growthOf(get("売上高", y), get("売上高", prev)), opG: growthOf(get("営業利益", y), get("営業利益", prev)),
    ca: m("流動資産"), fa: m("固定資産"), cash: m("現金及び現金同等物"), ta: mm(ta),
    cl: m("流動負債"), fl: mm(fl), debt: mm(sumOf(DEBT.map((k) => get(k, y)))),
    na: m("純資産"), cap: m("資本金"), eq: ta !== null && eqr !== null ? mm(ta * eqr) : null, eqr,
    ocf: mm(ocf), icf: mm(icf), fcf0: m("財務CF"), fcf: ocf !== null && icf !== null ? mm(ocf + icf) : null,
    eps, bps, per, pbr: price && bps > 0 ? price / bps : null,
  };
}

/** 短信の四半期累計1本ぶん（短信は百万円）。伸び率は前年同期比。 */
function quarterCol(t) {
  const a = t.actual || {}, p = t.prior || {}, bs = t.bs || {}, cf = t.cf || {};
  const ocf = cf.営業CF ?? null, icf = cf.投資CF ?? null;
  return {
    sales: a.売上高 ?? null, op: a.営業利益 ?? null, ord: a.経常利益 ?? null, net: a.純利益 ?? null, dps: null,
    salesG: growthOf(a.売上高, p.売上高), opG: growthOf(a.営業利益, p.営業利益),
    ca: bs.流動資産 ?? null, fa: bs.固定資産 ?? null, cash: cf.現金同等物期末 ?? bs.現金及び預金 ?? null,
    ta: bs.総資産 ?? t.totalAssets ?? null,
    cl: bs.流動負債 ?? null, fl: bs.固定負債 ?? null, debt: sumOf(DEBT_Q.map((k) => bs[k])),
    na: bs.純資産 ?? t.netAssets ?? null, cap: bs.資本金 ?? null, eq: t.equity ?? null,
    eqr: t.equityRatio === null || t.equityRatio === undefined ? null : t.equityRatio / 100,
    ocf, icf, fcf0: cf.財務CF ?? null, fcf: ocf !== null && icf !== null ? ocf + icf : null,
    eps: t.eps ?? null, bps: null, per: null, pbr: null,
  };
}

/** 今期の通期予想（短信）。伸び率は前期実績（有報）比。 */
function forecastCol(t, get, lastY) {
  const f = t.forecast;
  return {
    sales: f.売上高, op: f.営業利益, ord: f.経常利益, net: f.純利益, dps: t.dividendForecast ?? null,
    salesG: growthOf(f.売上高 * 1e6, get("売上高", lastY)), opG: growthOf(f.営業利益 * 1e6, get("営業利益", lastY)),
    eps: t.epsForecast ?? null,
  };
}

export function pageBiz(ctx) {
  const { fin = {}, ext = {} } = ctx;
  const get = (k, y) => num((fin[k] ?? ext[k])?.[y]);
  const ck = ctx.chukei && (ctx.chukei.sales || ctx.chukei.op) ? ctx.chukei : null;
  const years = [...new Set(["売上高", "純利益", "総資産", "営業CF"]
    .flatMap((k) => Object.keys(fin[k] || {})))].sort().slice(-5);
  const lastY = years[years.length - 1];
  const km = Number(String(ctx.kessan || "").replace(/[^\d]/g, "")) || null;
  const ym = (y) => km ? `${y}/${km}` : String(y);
  const cur = currentTerm(ctx.tanshinAll?.length ? ctx.tanshinAll : (ctx.tanshin ? [ctx.tanshin] : []));
  // 今期＝有報の直近期の翌期。短信がそれより古ければ使わない（前の期の短信を今期として出さない）。
  const term = cur && lastY && cur.fy === Number(lastY) + 1 ? cur : null;

  const cols = [
    ...years.map((y) => ({ head: ym(y), v: yearCol(get, y) })),
    ...(term?.quarters || []).map(({ q, t }) => ({ head: q === 2 ? "中間期" : `${q}Q累計`, v: quarterCol(t) })),
    ...(term?.forecast ? [{ head: "通期予想", v: forecastCol(term.forecast, get, lastY) }] : []),
    ...(ck ? [{ head: `${String(ck.year).replace(/年(\d+)月期/, "/$1")}${/期/.test(String(ck.year)) ? "期" : ""}目標`,
      v: { sales: ck.sales || null, op: ck.op || null } }] : []),
  ];
  const show = (key, v) => {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    if (key === "salesG" || key === "opG" || key === "eqr") return pct(v);
    if (key === "dps" || key === "eps" || key === "bps") return Number.isInteger(v) ? fmt(v) : v.toFixed(2);
    if (key === "per" || key === "pbr") return v.toFixed(key === "pbr" ? 2 : 1);
    return fmt(v);
  };
  const rows = BIZ_ROWS.map(([label, key]) => key
    ? [label, ...cols.map((c) => show(key, c.v[key]))]
    : [label, ...cols.map(() => "")]);
  const groups = [
    { text: "", span: 1 },
    { text: "通期実績（有価証券報告書）", span: years.length },
    ...(term && (term.quarters.length || term.forecast)
      ? [{ text: `今期（${ym(term.fy)}期・決算短信）`, span: term.quarters.length + (term.forecast ? 1 : 0) }] : []),
    ...(ck ? [{ text: "中期経営計画", span: 1 }] : []),
  ];

  const t = ctx.tanshin?.forecast || ctx.tanshin?.actual ? ctx.tanshin : null;
  const pg = progress(t, fin);
  const base = t?.forecast ? t.forecast
    : { 売上高: mm(get("売上高", lastY)), 営業利益: mm(get("営業利益", lastY)) };
  const gap = ck ? chukeiGap(ck, base, t?.forecast ? fyOf(t.period) : fyOf(lastY), fin) : null;
  const missing = [
    !term?.quarters.length ? "今期の四半期" : null,
    !term?.forecast ? "今期予想" : null,
  ].filter(Boolean);

  return {
    no: 1, title: "事業の状況",
    lead: leadBiz(pg, gap) || TODO("業績の現状を一文で"),
    layout: "fullTable",
    tables: [{ caption: "", head: ["（百万円）", ...cols.map((c) => c.head)], groups, rows, section: true }],
    notes: [
      "出典：有価証券報告書、決算短信" + (ck ? "、中期経営計画" : "") + "。百万円未満切り捨て。伸び率は四半期が前年同期比、予想が前期比。" +
      "PER・PBRは有報の期末値（株価＝PER×EPS）。四半期の現金は現金及び預金。",
      ...(missing.length ? [`${missing.join("・")}は決算短信が読み込めると入る。`] : []),
    ],
  };
}

function leadBiz(pg, gap) {
  const parts = [];
  const s = pg?.rows.find((r) => r.item === "売上高" && r.verdict);
  if (s) parts.push(`${pg.label}の売上進捗は${s.verdict}`);
  const g = gap?.rows.find((r) => r.verdict);
  if (g) parts.push(`中計の${g.item}目標は${g.verdict}`);
  return parts.join("。");
}

// ---- ② 資本効率と株主構成 -------------------------------------------------

export function pageCapital(ctx) {
  const pf = profile(ctx);
  const kessan = (ctx.kessan || "").replace(/^0/, "").replace("月期", "");
  const by = pf.byYear;

  const items = [];
  if (pf.roe !== null) {
    items.push(`ROEは${pct(pf.roe)}` + (pf.roe < 0.08 ? "で、一般に意識される8%を下回る。" : "。") +
      (ctx.chukei?.roe ? `中計目標は${pct(ctx.chukei.roe)}。` : ""));
  }
  if (pf.eqRatio !== null) {
    items.push(`自己資本比率は${pct(pf.eqRatio)}、ネットキャッシュ（現預金−有利子負債）は` +
      `${pf.netCash === null ? "—" : `${(pf.netCash / 1e8).toFixed(1)}億円`}。`);
  }
  if (pf.pbr !== null) {
    items.push(`PBRは${pf.pbr.toFixed(2)}倍（${pf.priceBasis}）` + (pf.pbr < 1 ? "で1倍を下回る。" : "。"));
  }
  if (pf.holdings) {
    const h = pf.holdings;
    items.push(h.total > 0
      ? `政策保有株は${(h.total / 1e8).toFixed(1)}億円（純資産の${pct(h.toEquity)}` +
        (h.count !== null ? `、上場${h.count}銘柄` : "") + "）" +
        (h.toEquity >= 0.2 ? "で、純資産の20%を超える。" : "。") +
        (h.sold ? `当期に${(h.sold / 1e8).toFixed(1)}億円を売却。` : "")
      : "政策保有株は保有していない（有報の開示上）。");
    if (h.pure > 0) {
      items.push(`ほかに純投資目的の上場株を${(h.pure / 1e8).toFixed(1)}億円（純資産の${pct(h.pureToEquity)}）保有。`);
    }
  }
  if (pf.float) {
    // 市場区分が選ばれていなければ、どの基準を下回るかは書かない（菊池はスタンダード上場で、
    // 「プライムの基準を下回る」と書くと事実と違う印象になる）。
    const seg = ctx.market?.segment || "";
    const r = seg ? floatRules(seg)[0] : null;
    const below = r && (pf.float.ratio < r.ratio || (pf.float.cap !== null && pf.float.cap < r.cap));
    items.push(`流通株式比率は推定${pct(pf.float.ratio)}` +
      (pf.float.cap !== null ? `、流通時価総額は推定${(pf.float.cap / 1e8).toFixed(0)}億円` : "") +
      (r ? `（${seg}の上場維持基準は${pct(r.ratio, 0)}・${r.cap / 1e8}億円${below ? "で、下回る水準" : ""}）。` : "。"));
  }
  // 信託口と証券会社（個人の信用取引などの預かり）は、実質の持ち主ではないので外す。
  const top = pf.holders.filter((h) => h.kind !== "信託・カストディ" && h.kind !== "証券会社").slice(0, 3);
  if (top.length) {
    items.push("主な株主は" + top.map((h) => `${h.label}（${pct(h.ratio, 1)}）`).join("、") + "。");
  }

  // 所有者別はまとめて短くする（外国は法人と個人を足す）
  const cat = (re) => pf.own.filter((o) => re.test(o.category)).reduce((a, o) => a + o.ratio, 0);
  const ownRows = pf.own.length ? [
    ["金融機関", pct(cat(/^金融機関/))],
    ["証券会社", pct(cat(/金融商品取引業者|証券会社/))],
    ["事業法人等", pct(cat(/その他の法人/))],
    ["外国法人等", pct(cat(/外国/))],
    ["個人その他", pct(cat(/^個人/))],
  ] : [];

  const issues = diagnose(ctx, pf);
  return {
    no: 1, title: "御社の現状②　資本効率と株主構成",
    lead: issues.length ? `数字から見える論点：${issues.slice(0, 2).map((i) => i.title.split("：")[0]).join("・")}`
      : TODO("資本効率と株主構成の現状を一文で"),
    blocks: [{ items }],
    tables: [
      {
        caption: "資本効率の推移",
        head: ["", ...by.map((b) => `${b.year}/${kessan}`)],
        rows: [
          ["ROE", ...by.map((b) => pct(b.roe))],
          ["自己資本比率", ...by.map((b) => pct(b.eqRatio))],
          ["配当性向", ...by.map((b) => pct(b.payout))],
          ["PBR（期末）", ...by.map((b) => b.pbr === null ? "—" : `${b.pbr.toFixed(2)}倍`)],
          ["現預金（億円）", ...by.map((b) => b.cash === null ? "—" : (b.cash / 1e8).toFixed(1))],
          ["ネットキャッシュ（億円）", ...by.map((b) => b.netCash === null ? "—" : (b.netCash / 1e8).toFixed(1))],
        ].filter((r) => r.slice(1).some((c) => c !== "—")),
      },
      ownRows.length ? {
        caption: "株主構成（所有者別・有報）",
        head: ["区分", "比率"],
        rows: [...ownRows,
          ["流通株式比率（推定）", pf.float ? pct(pf.float.ratio) : "—"]],
        pick: 5,
      } : null,
      pf.holders.length ? {
        caption: "大株主上位5位",
        head: ["株主名", "区分", "比率"],
        rows: pf.holders.slice(0, 5).map((h) => [h.label,
          looksLikeOwner(h) ? `${h.kind}（資産管理会社か）` : h.kind, pct(h.ratio, 2)]),
      } : null,
    ].filter(Boolean),
    notes: [
      "PBR（期末）＝有報の期末株価（PER×EPS）÷BPS。赤字の期はPERが出ないため空欄。" +
      "ネットキャッシュ＝現預金−有利子負債。有利子負債は有報に2期分しか無いため、それ以前は空欄。",
      "流通株式比率は、自己株式・役員・10%以上の大株主・事業法人等・銀行保険の保有を除いた推定。" +
      "東証の算定とは一致しないので、会社の開示で確かめる。",
      "区分は株主名からの推定（信託口は投資家の預かりとして「信託・カストディ」）。",
    ],
  };
}

export function buildGenjo(ctx) {
  return [pageBiz(ctx), pageCapital(ctx)];
}
