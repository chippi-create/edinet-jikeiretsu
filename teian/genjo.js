// genjo.js — 提案書の冒頭「御社の現状」2ページ
//
// ① 業績と中期経営計画：通期の推移・今期予想・中計目標を1枚に並べ、
//    直近四半期の進捗が前年と比べて順調か遅れているかを出す。
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
const mm = (v) => (v === null || v === undefined ? null : Math.round(v / 1e6));
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

// ---- ① 業績と中期経営計画 -------------------------------------------------

export function pageBiz(ctx) {
  const { fin = {} } = ctx;
  const t = ctx.tanshin?.forecast || ctx.tanshin?.actual ? ctx.tanshin : null;
  const ck = ctx.chukei && (ctx.chukei.sales || ctx.chukei.op || ctx.chukei.roe) ? ctx.chukei : null;
  const years = [...new Set(["売上高", "営業利益", "純利益"]
    .flatMap((k) => Object.keys(fin[k] || {})))].sort().slice(-3);
  const at = (k, y) => mm(num(fin[k]?.[y]));
  const kessan = (ctx.kessan || "").replace(/^0/, "").replace("月期", "");

  const head = ["（百万円）", ...years.map((y) => `${y}/${kessan}`),
    ...(t?.forecast ? [`${t.period}予想`] : []),
    ...(ck ? [`中計目標（${ck.year}）`] : [])];
  const line = (label, k, fc, target) => [label, ...years.map((y) => fmt(at(k, y))),
    ...(t?.forecast ? [fmt(fc)] : []), ...(ck ? [target ? fmt(target) : "—"] : [])];
  const margin = (y) => { const s = at("売上高", y), o = at("営業利益", y); return s > 0 && o !== null ? o / s : null; };
  const rows = [
    line("売上高", "売上高", t?.forecast?.売上高, ck?.sales),
    line("営業利益", "営業利益", t?.forecast?.営業利益, ck?.op),
    ["営業利益率", ...years.map((y) => pct(margin(y))),
      ...(t?.forecast ? [pct(div(t.forecast.営業利益, t.forecast.売上高))] : []),
      ...(ck ? [pct(div(ck.op, ck.sales))] : [])],
    line("当期純利益", "純利益", t?.forecast?.純利益, null),
    ["ROE", ...years.map((y) => pct(asRatio(num(fin["ROE"]?.[y])))),
      ...(t?.forecast ? ["—"] : []), ...(ck ? [ck.roe ? pct(ck.roe) : "—"] : [])],
  ];

  const items = [];
  // 全部「—」の行（売上の無い会社の売上高・利益率など）は落とす。
  const filled = rows.filter((r) => r.slice(1).some((c) => c !== "—"));
  const tables = [{ caption: "業績の推移（有価証券報告書・決算短信）", head, rows: filled }];

  // 足元（直近四半期）
  const pg = progress(t, fin);
  if (t?.actual) {
    const a = t.actual;
    const g = yoy(a.売上高, t.prior?.売上高);
    items.push(`${a.期}累計は売上高${fmt(a.売上高)}百万円` +
      (g !== null ? `（前年同期比${g >= 0 ? "+" : "−"}${Math.abs(g * 100).toFixed(1)}%）` : "") +
      `、営業${a.営業利益 < 0 ? "損失" : "利益"}${fmt(Math.abs(a.営業利益))}百万円` +
      (t.prior ? `（前年同期は営業${t.prior.営業利益 < 0 ? "損失" : "利益"}${fmt(Math.abs(t.prior.営業利益))}百万円）` : "") + "。");
  } else {
    items.push(TODO("直近四半期の実績（決算短信を読み込むと入ります）"));
  }
  if (pg) {
    for (const r of pg.rows) {
      if (r.rate === null) {
        if (r.item === "営業利益" && (r.cur <= 0 || r.fc <= 0)) {
          items.push("営業利益は赤字を含むため、進捗率では測れない。" +
            (t.halfForecast && pg.q <= 2 ? `上期予想は営業${t.halfForecast.営業利益 < 0 ? "損失" : "利益"}${fmt(Math.abs(t.halfForecast.営業利益))}百万円。` : ""));
        }
        continue;
      }
      items.push(`通期予想に対する${r.item}の進捗率は${pct(r.rate)}` +
        (r.prate !== null ? `（前年同期は${pct(r.prate)}、${pt(r.diff)}）→ **${r.verdict}**。` : "。前年同期と比べる材料が無い。"));
    }
    tables.push({
      caption: `通期予想に対する進捗（${pg.label}累計）`,
      head: ["", "累計実績", "通期予想", "進捗率", "前年同期の進捗率", "判定"],
      rows: pg.rows.map((r) => [r.item, fmt(r.cur), fmt(r.fc), pct(r.rate), pct(r.prate), r.verdict || "—"]),
      note: "前年同期の進捗率＝前年同期の累計÷前年の通期実績（有報）。季節性があるので25%・50%とではなく前年と比べる。±3pt以内は前年並み。",
    });
  }
  const qs = quarters(ctx.tanshinAll, t?.period);
  if (qs) {
    tables.push({
      caption: "四半期ごと（単独・百万円）",
      head: ["", ...qs.map((q) => `${q.q}Q`)],
      rows: [["売上高", ...qs.map((q) => fmt(q.売上高))], ["営業利益", ...qs.map((q) => fmt(q.営業利益))]],
      note: "2Q単独＝2Q累計−1Q累計。読み込んだ決算短信から計算。",
    });
  }

  // 中計
  const baseYear = t?.forecast ? fyOf(t.period) : fyOf(years[years.length - 1]);
  const base = t?.forecast ? t.forecast
    : { 売上高: at("売上高", years[years.length - 1]), 営業利益: at("営業利益", years[years.length - 1]) };
  const gap = ck ? chukeiGap(ck, base, baseYear, fin) : null;
  if (gap && gap.rows.length) {
    for (const r of gap.rows) {
      const basis = t?.forecast ? "今期予想" : "直近実績";
      // 起点が赤字だと、達成率も必要な伸び率も意味を持たない（−248 ÷ 500 ＝ −50%）。
      if (!(r.base > 0)) {
        items.push(`中計目標（${ck.year}）の${r.item}${fmt(r.target)}百万円に対し、` +
          `${basis}は${r.item === "営業利益" ? "営業損失" : ""}${fmt(Math.abs(r.base))}百万円。黒字化が前提の目標。`);
        continue;
      }
      items.push(`中計目標（${ck.year}）の${r.item}${fmt(r.target)}百万円に対し、` +
        `${basis}は${fmt(r.base)}百万円（${pct(r.ratio, 0)}）。` +
        (r.need !== null && r.need > 0
          ? (gap.years === 1 ? `来期に${(r.target / r.base).toFixed(1)}倍が要る`
                             : `残り${gap.years}年で年${pct(r.need)}の伸びが要る`) +
            (r.past !== null ? `（過去3年は年${pct(r.past)}）→ **${r.verdict}**。` : "。")
          : r.verdict ? `→ **${r.verdict}**。` : ""));
    }
  } else {
    items.push(TODO("中計の目標（年度・売上高・営業利益・ROE）を画面に入れると、達成に要る伸びを出します"));
  }

  const lead = leadBiz(pg, gap);
  return {
    no: 1, title: "御社の現状①　業績と中期経営計画",
    lead: lead || TODO("業績の現状を一文で"),
    blocks: [{ items }],
    tables,
    notes: ["出典：有価証券報告書（EDINET）、決算短信" + (ck ? "、中期経営計画（目標値は画面で入力）" : "") + "。単位は百万円。"],
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
    items.push("主な株主は" + top.map((h) => `${h.name}（${pct(h.ratio, 1)}）`).join("、") + "。");
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
        rows: pf.holders.slice(0, 5).map((h) => [h.name,
          looksLikeOwner(h) ? `${h.kind}（資産管理会社か）` : h.kind, pct(h.ratio, 2)]),
      } : null,
    ].filter(Boolean),
    notes: [
      "PBR（期末）＝有報の期末株価（PER×EPS）÷BPS。赤字の期はPERが出ないため空欄。",
      "流通株式比率は、自己株式・役員・10%以上の大株主・事業法人等・銀行保険の保有を除いた推定。" +
      "東証の算定とは一致しないので、会社の開示で確かめる。",
      "区分は株主名からの推定（信託口は投資家の預かりとして「信託・カストディ」）。",
    ],
  };
}

export function buildGenjo(ctx) {
  return [pageBiz(ctx), pageCapital(ctx)];
}
