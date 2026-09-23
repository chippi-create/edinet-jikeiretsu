// teian.js — 上場会社のEDINETデータから、MSワラント提案の中身を組み立てる
//
// 出すのは「ページごとの文章と表」。体裁は持たない。
// 判断が要るところは 【　】 で空けておき、埋める人に任せる。勝手に書かない。
//
// 依存なし。ブラウザでもNodeでも動く。

import {
  potentialShares, dailyExercise, daysNeeded, marketCap,
  maxDilutionFor, dilutedRatio, checkBasis,
} from "./sim.js";
import { analyze } from "./shikin.js";

// ---- 小道具 --------------------------------------------------------------

export const TODO = (what) => `【${what}】`;

/** AIの下書きがあればそれを使い、無ければ【　】のまま残す。
 *  下書きは提案書の中身そのものではなく、開示から読み取れる論点として作らせている。 */
const NO_MATERIAL = /材料が足りません|該当する記載はありません/;

const D = (ctx, id, label) => {
  const v = ctx.drafts?.[id];
  // 「材料が足りません」は下書きの答えであって、本文に差し込む文ではない。
  // そのまま入れると定型文とつながって壊れた文になるので、【　】に戻す。
  if (typeof v !== "string" || !v.trim() || NO_MATERIAL.test(v)) return TODO(label);
  return v.trim();
};

/** 複数行の下書きを箇条書きに割る。無ければ【　】をn個返す。 */
const Dlines = (ctx, id, label, n = 3) => {
  const v = ctx.drafts?.[id];
  if (typeof v === "string" && v.trim() && !NO_MATERIAL.test(v)) {
    return v.split(/\r?\n/).map((t) => t.replace(/^[・\-\s]+/, "").trim()).filter(Boolean);
  }
  return Array.from({ length: n }, () => TODO(label));
};

const num = (v) => {
  const t = String(v ?? "").replace(/,/g, "").trim();
  if (t === "") return null;          // Number("") は0になる。取れていない年が0に見えてしまう
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
};

/** 百万円に直して整数で返す。単位はEDINETが円なので1e6で割る。 */
const mm = (v) => (v === null ? null : Math.round(v / 1e6));

const fmt = (v) => (v === null || v === undefined) ? "—" : v.toLocaleString("ja-JP");
const oku = (v) => (v === null ? "—" : (v / 1e8).toFixed(1));
const pct = (v, d = 1) => (v === null ? "—" : (v * 100).toFixed(d) + "%");

/** 比率の値。EDINETは会社によって 0.654 と 65.4 の両方で入っている。
 *  1.5を超えていたら百分率で入っているとみなす。 */
const asRatio = (v) => (v === null ? null : (Math.abs(v) > 1.5 ? v / 100 : v));

/** 系列（年度→値）から、新しい順にn年ぶんを [年度, 値] で返す。 */
export function series(x, n = 5) {
  if (!x) return [];
  return Object.keys(x).sort().slice(-n).map((y) => [y, num(x[y])]);
}

/** 系列の最新値。 */
export function latest(x) {
  const s = series(x, 1);
  return s.length ? s[0][1] : null;
}

/** 増減を日本語にする。「増収」「減益」など言い切る。評価語は使わない。 */
function trend(cur, prev, up, down, flat = "横ばい") {
  if (cur === null || prev === null || prev === 0) return null;
  const r = (cur - prev) / Math.abs(prev);
  if (Math.abs(r) < 0.01) return flat;
  return r > 0 ? up : down;
}

// ---- 株主 ----------------------------------------------------------------

/**
 * 大株主の表を読む。サイトのJSONは
 *   [順位, 氏名または名称, 住所, 所有株式数, 単位, 比率]
 * で、単位は会社によって 株 / 千株 / 百株 と違う。株数に直して返す。
 */
export function shareholders(rows) {
  if (!rows) return [];
  const unit = (u) => (u || "").includes("千") ? 1000
    : (u || "").includes("百") ? 100 : 1;
  return rows.map((r) => ({
    rank: num(r[0]),
    name: (r[1] || "").replace(/\s+/g, " ").trim(),
    address: r[2] || "",
    shares: num(r[3]) === null ? null : num(r[3]) * unit(r[4]),
    ratio: num(r[5]) === null ? null : num(r[5]) / 100,
  })).filter((r) => r.name);
}

/** 所有者別状況。[区分, 株主数, 株式数, 比率] */
export function ownership(rows) {
  if (!rows) return [];
  return rows.map((r) => ({
    category: (r[0] || "").trim(),
    holders: num(r[1]),
    shares: num(r[2]),
    ratio: num(r[3]) === null ? null : num(r[3]) / 100,
  })).filter((r) => r.category
    && !/^計$/.test(r.category)
    && !/単元未満/.test(r.category)
    && r.shares !== null);
}

/** 選んだ株主の合計比率。議決権株式数を分母に取り直す。 */
export function stableRatio(list, picked, voting) {
  let shares = 0;
  for (const i of picked) {
    const s = list[i];
    if (s && s.shares) shares += s.shares;
  }
  return { shares, ratio: voting ? shares / voting : null };
}

// ---- 各ページの中身 ------------------------------------------------------

/**
 * 提案書の中身を組み立てる。
 *
 * ctx = {
 *   code, name, kessan,          会社
 *   fin:  帯JSONの d,            財務（年度→値）
 *   ext:  帯JSONの x,            株式数など
 *   sec:  s帯JSONの中身,          大株主・所有者別・セグメント・事業の内容
 *   basis:{issued, voting, treasury},
 *   market:{price, asOf, volumes},   手入力。無くてもよい
 *   stable:{names, ratio},           安定株主として数えた人と合計比率
 *   dilution,                        提案する希薄化率
 * }
 */
export function buildProposal(ctx) {
  const pages = [];
  pages.push(pageSummary(ctx));
  pages.push(pageVoting(ctx));
  pages.push(...pageCash(ctx));
  pages.push(pageStock(ctx));
  pages.push(pageGrowth(ctx));
  pages.push(pageShareholders(ctx));
  pages.push(pageCompare(ctx));
  pages.push(pageTerms(ctx));
  return pages.flat().filter(Boolean);
}

// --- p.2 エグゼクティブサマリー -------------------------------------------

function pageSummary(ctx) {
  const { fin, ext, market, dilution } = ctx;
  const op = series(fin["営業利益"], 3);
  const eq = latest(fin["自己資本比率"]);
  // 現預金が取れないときに営業CFで代用してはいけない。別物なので黙って落とす。
  const cash = latest(ext["現金及び現金同等物"]) ?? latest(ext["現金及び預金"]);
  const capex = latest(ext["設備投資"]);
  const rd = latest(ext["研究開発費"]);

  const opNow = op.length ? op[op.length - 1][1] : null;
  const opPrev = op.length > 1 ? op[op.length - 2][1] : null;

  const zaimu = [];
  if (opNow !== null) {
    // 赤字のときに「増益」と書くと意味が通らないので、言い方を変える。
    const neg = opNow < 0 || (opPrev !== null && opPrev < 0);
    // 赤字どうしの比較では、値が増える＝損失が減る。増減の向きが利益と逆になる。
    const t = neg
      ? trend(opNow, opPrev, "損失が縮小", "損失が拡大")
      : trend(opNow, opPrev, "増益", "減益");
    const kuro = opPrev !== null && opPrev < 0 && opNow >= 0 ? "黒字転換" : null;
    zaimu.push(
      `直近期の営業${opNow < 0 ? "損失" : "利益"}は${fmt(Math.abs(mm(opNow)))}百万円` +
      (kuro ? "（前期比黒字転換）" : t ? `（前期比${t}）` : "") + "。" +
      D(ctx, "mgmtSummary", "中期経営計画での総括を一文で"));
  }
  if (eq !== null) {
    zaimu.push(`自己資本比率は${pct(asRatio(eq))}。` +
      (cash !== null ? `現預金は${oku(cash)}億円。` : ""));
  }
  if (capex !== null || rd !== null) {
    const parts = [];
    if (capex !== null) parts.push(`設備投資${fmt(mm(capex))}百万円`);
    if (rd !== null) parts.push(`研究開発費${fmt(mm(rd))}百万円`);
    zaimu.push(`${parts.join("、")}を計画しており、成長投資の局面にある。`);
  }

  return {
    no: 2,
    title: "エグゼクティブサマリー",
    lead: null,
    blocks: [
      {
        head: "要点", subs: [
          {
            head: "【株価動向】", items: [
              TODO("株式市場からの評価・注目テーマ・直近の株価形成を2〜3行"),
              market?.price
                ? `直近株価は${fmt(market.price)}円。`
                : TODO("直近株価と時価総額"),
            ],
          },
          { head: "【経営・財務状況】", items: zaimu.length ? zaimu : [TODO("経営・財務状況")] },
        ],
      },
      {
        head: "提案骨子", subs: [
          {
            head: "【資金調達手法】", items: [
              D(ctx, "story", "資金使途（設備投資・研究開発・借入金返済など）を一文で") +
              "の実行に向けた機動的なエクイティファイナンスを提案。",
              "株価形成に応じた資金調達が可能な行使価額修正条項付新株予約権" +
              "（以下、MSワラント）を有力な選択肢として提案。",
            ],
          },
          {
            head: "【発行株数】", items: [
              `資金調達額の最大化と、${ctx.stable?.label || "安定株主"}の議決権比率の維持を考慮し、` +
              `希薄化率${pct(dilution)}を想定。`,
            ],
          },
          {
            head: "【スケジュール】", items: [
              TODO("決算発表・中計公表の予定") +
              "を踏まえ、" + TODO("実施ウィンドウ") + "を有力な実施ウィンドウとして想定。",
            ],
          },
        ],
      },
      {
        // 自社の話なので、ここは作らない。ひな形の文言をそのまま使う。
        head: "弊社の意義", items: [TODO("ひな形の文言をそのまま使う")],
      },
    ],
  };
}

// --- p.3 議決権比率について ------------------------------------------------

function pageVoting(ctx) {
  const { basis, stable, dilution, sec } = ctx;
  const list = shareholders(sec?.sh);
  const label = stable?.label || "安定株主";
  const cur = stable?.ratio ?? null;
  const cap = cur !== null ? maxDilutionFor(cur, 0.5) : null;
  const shares = basis.voting ? potentialShares(basis.voting, dilution) : null;

  const rows = (stable?.picked || []).map((i) => list[i]).filter(Boolean);

  return {
    no: 3,
    title: "議決権比率について",
    lead: cur !== null
      ? `${label}の議決権比率50%維持を前提とした希薄化率は${pct(cap)}`
      : TODO("このページの結論を一文で"),
    blocks: [{
      head: `【${label}の議決権比率】`, items: [
        "エクイティファイナンスを行う場合、株式の発行に伴い" +
        `${label}の議決権比率は低下。`,
        cur !== null
          ? `現状、${label}の議決権比率（近親者含む）は${pct(cur, 2)}程度と推定。`
          : TODO("現状の議決権比率"),
        cap !== null
          ? `${label}の議決権比率が50%超を維持できる希薄化率は${pct(cap)}` +
            (shares ? `（${fmt(shares)}株）` : "") + "と試算。"
          : TODO("維持できる希薄化率"),
        basis.voting && shares
          ? `（計算式）議決権株式数${fmt(basis.voting)}株×${pct(dilution)}＝${fmt(shares)}株` +
            "（1,000株未満切り捨て）"
          : null,
      ].filter(Boolean),
    }],
    tables: [
      rows.length ? {
        caption: `${label}の内訳`,
        head: ["株主名", "保有株数", "議決権比率"],
        rows: rows.map((r) => [
          r.name, fmt(r.shares),
          basis.voting && r.shares ? pct(r.shares / basis.voting, 2) : "—",
        ]),
        foot: cur !== null
          ? ["合計", fmt(stable.shares), pct(cur, 2)] : null,
      } : null,
      basis.voting ? dilutionTable(ctx, rows, label) : null,
    ].filter(Boolean),
    notes: ["大量保有報告書、変更報告書をもとに作成"],
  };
}

/** 希薄化率ごとの議決権比率推移。 */
function dilutionTable(ctx, rows, label) {
  const { basis, dilution } = ctx;
  const scen = [0.10, dilution, 0.25].sort((a, b) => a - b);
  const head = ["希薄化率", ...scen.map((d) => pct(d))];
  const body = rows.map((r) => [
    r.name,
    ...scen.map((d) => r.shares
      ? pct(dilutedRatio(r.shares / basis.voting, d), 2) : "—"),
  ]);
  const total = ctx.stable?.ratio ?? null;
  return {
    caption: `希薄化率と${label}の議決権比率`,
    head, rows: body,
    foot: total !== null
      ? ["合計", ...scen.map((d) => pct(dilutedRatio(total, d), 2))] : null,
  };
}

// --- p.5 資金の余力と調達の要否 --------------------------------------------
//
// 「いくら持っていて、そのうちいくら使えて、このままだといつ足りなくなるか」
// を出す。前提は全部ページの下に書く。数字より前提のほうが効くため。

function pageCash(ctx) {
  const a = analyze({ fin: ctx.fin, ext: ctx.ext, opts: ctx.cashOpts || {} });
  if (a.missing.length) {
    return [{
      no: 5, title: "資金の余力と調達の要否",
      lead: TODO("資金の状況についての結論を一文で"),
      blocks: [{ items: [
        `${a.missing.join("・")}がまだ取得できていないため、計算できません。`,
      ] }],
    }];
  }
  const h = a.headroom, c = a.ccc, d = a.debt, f = a.fit;
  const y = (v) => v === null ? "—" : `${(v / 1e8).toFixed(1)}億円`;
  const dd = (v) => v === null ? "—" : `${Math.round(v)}日`;
  const x = (v, n = 1) => v === null ? "—" : `${v.toFixed(n)}倍`;

  const items = [];
  items.push(
    `現預金${y(h.cash)}は月商の${h.months === null ? "—" : h.months.toFixed(1)}ヶ月ぶん。` +
    `事業を回すのに${y(h.need)}、1年内の借入返済に${y(h.within1y)}を置くと、` +
    `**自由に使えるのは${y(h.free)}**。`);
  if (c.days !== null) {
    items.push(
      `仕入れてから現金として戻るまで${dd(c.days)}かかる（売上債権${dd(c.dso)}＋` +
      `棚卸${dd(c.dio)}−仕入債務${dd(c.dpo)}）。売上が伸びると、` +
      `その分だけ運転資本${y(a.wc.wc)}も増える。`);
  }
  const p = a.projection;
  items.push(p.shortfallYear
    ? `いまのペース（年${(a.growth * 100).toFixed(1)}%増収、投資年${y(a.capexPerYear)}）` +
      `が続くと、**${p.shortfallYear}年後に手元資金の下限を割る**見込み。`
    : `いまのペースなら、${a.opts.years}年後も手元資金の下限を保てる見込み。`);
  if (a.gap > 0) {
    items.push(`年${y(a.capexPerYear)}の投資を続けるには、` +
      `自己資金（使える現金＋営業CF${y(a.opeCf)}）では**${y(a.gap)}足りない**。`);
  }

  // 1枚に表を4つ置くと紙面に入らない。現状と将来で2枚に分ける。
  return [
    {
      no: 5,
      title: "資金の余力",
      lead: `現預金${y(h.cash)}のうち、自由に使えるのは${y(h.free)}`,
      blocks: [{ items: items.slice(0, 2) }],
      tables: [
        {
          caption: "手元資金の内訳",
          head: ["項目", "金額"],
          rows: [
            ["現預金", y(h.cash)],
            ["月商", y(h.monthly)],
            [`− 事業に要る手元資金（月商×${a.opts.monthsOfSales}ヶ月）`, y(h.need)],
            ["− 1年内に返す借入", y(h.within1y)],
            ["＝ 自由に使える現金", y(h.free)],
          ],
          pick: 4,
        },
        c.days === null ? null : {
          caption: "運転資本と現金化までの日数",
          head: ["項目", "金額", "日数"],
          rows: [
            ["売上債権", y(a.wc.ar), dd(c.dso)],
            ["棚卸資産", y(a.wc.inv), dd(c.dio)],
            ["仕入債務", y(a.wc.ap), `−${dd(c.dpo)}`],
            ["運転資本 / CCC", y(a.wc.wc), dd(c.days)],
          ],
        },
      ].filter(Boolean),
      notes: [
        `前提：事業に要る手元資金＝月商×${a.opts.monthsOfSales}ヶ月。` +
        "棚卸資産と仕入債務の日数は売上原価で割っています（売上高で割ると粗利のぶん短く出ます）。",
      ],
    },
    {
      no: 5,
      title: "調達の要否",
      lead: p.shortfallYear
        ? `いまのペースが続くと、${p.shortfallYear}年後に手元資金の下限を割る`
        : `いまのペースなら、${a.opts.years}年後も手元資金の下限を保てる`,
      blocks: [
        { items: items.slice(2) },
        { head: "借入とエクイティのどちらが向くか", items: f.points.map((q) => q.text) },
      ],
      tables: [
        {
          caption: `現金の見込み（年${(a.growth * 100).toFixed(1)}%増収・営業CF率` +
                   `${(a.opeCfRatio * 100).toFixed(1)}%・投資年${y(a.capexPerYear)}）`,
          head: ["", ...p.rows.map((r) => `${r.year}年後`)],
          rows: [
            ["営業CF", ...p.rows.map((r) => y(r.ope))],
            ["投資・返済", ...p.rows.map((r) => `−${y(r.out)}`)],
            ["現金残高", ...p.rows.map((r) => y(r.cash))],
            ["下限との差", ...p.rows.map((r) => y(r.short))],
          ],
        },
        {
          caption: "借入余力の指標",
          head: ["項目", "値"],
          rows: [
            ["有利子負債", y(d.total)],
            ["ネット有利子負債（−現預金）", y(f.netDebt)],
            ["EBITDA（営業利益＋減価償却費）", y(f.ebitda)],
            ["有利子負債 ÷ EBITDA", x(f.debtEbitda)],
            ["営業利益 ÷ 支払利息", x(f.cover)],
            ["自己資本比率", f.equityRatio === null ? "—" : `${(f.equityRatio * 100).toFixed(1)}%`],
            ["D/Eレシオ", x(f.de, 2)],
          ],
        },
      ],
      notes: [
        `前提：売上の伸び＝${(a.growth * 100).toFixed(1)}%、営業CF率＝` +
        `${(a.opeCfRatio * 100).toFixed(1)}%、投資＝年${y(a.capexPerYear)}、` +
        "返済＝1年内返済額が毎年続くと仮定。返済予定表は有報から取れないため粗い仮定です。",
        `見立て：${f.lean}。株価と金利の状況、会社の意向で変わります。`,
      ],
    },
  ];
}

// --- p.6 株価の状況 --------------------------------------------------------

function pageStock(ctx) {
  const { fin, ext, market, basis } = ctx;
  const years = Object.keys(fin["売上高"] || {}).sort().slice(-3);
  const row = (label, key, src) => [
    label, ...years.map((y) => {
      const v = num((src || fin)[key]?.[y]);
      return v === null ? "—" : fmt(mm(v));
    }),
  ];

  const sales = series(fin["売上高"], 2);
  const items = [];
  if (sales.length === 2) {
    const t = trend(sales[1][1], sales[0][1], "増収", "減収");
    items.push(`直近期は${t}。` + TODO("その理由を1行"));
  }
  items.push(TODO("株価が動いた出来事（決算発表・業績修正・テーマ化・役員異動など）を2〜3点"));

  const cap = market?.price && basis.issued
    ? marketCap(market.price, basis.issued) : null;

  return {
    no: 6,
    title: "株価の状況",
    lead: D(ctx, "stockView", "株価についての結論を一文で"),
    blocks: [{ items }],
    tables: [
      {
        caption: `【通期】（百万円）`,
        head: ["決算期", ...years.map((y) => `${y}/${(ctx.kessan || "").replace("月期", "")}`)],
        rows: [
          row("売上高", "売上高"),
          row("営業利益", "営業利益"),
          row("経常利益", "経常利益"),
          row("純利益", "純利益"),
          ["配当", ...years.map((y) => {
            const v = num(ext["1株当たり配当"]?.[y]);
            return v === null ? "—" : String(v);
          })],
          ["発表日", ...years.map(() => TODO("発表日"))],
        ],
      },
      {
        caption: "株価指標",
        head: ["項目", "値"],
        rows: [
          ["株価", market?.price ? `${fmt(market.price)}円` : TODO("株価")],
          ["時価総額", cap ? `${oku(cap)}億円` : TODO("時価総額")],
          ["PER", latest(ext["株価収益率"]) !== null
            ? `${latest(ext["株価収益率"])}倍（有報の期末時点）` : TODO("PER")],
          ["PBR", TODO("PBR")],
          ["1日の出来高平均（3ヶ月）", TODO("出来高")],
        ],
      },
    ],
    notes: ["株価チャートと売買高のグラフは、会社の端末で作成したものを貼る。"],
  };
}

// --- p.7 成長投資フェーズへの移行 ------------------------------------------

function pageGrowth(ctx) {
  const { fin, ext, sec } = ctx;
  const years = Object.keys(fin["売上高"] || {}).sort().slice(-3);
  const line = (label, key, src, conv = mm) => [
    label, ...years.map((y) => {
      const v = num((src || fin)[key]?.[y]);
      return v === null ? "—" : fmt(conv(v));
    }),
  ];

  const rows = [line("売上高", "売上高")];
  // セグメント別の売上。当期しか取れないので、取れた年度だけ埋める。
  for (const s of (sec?.seg || [])) {
    const name = (s[0] || "").trim();
    const v = num(s[1]);
    if (!name || v === null) continue;
    rows.push([`　${name}`, ...years.map((y, i) =>
      i === years.length - 1 ? fmt(mm(v)) : "—")]);
  }
  rows.push(line("営業利益", "営業利益"));
  rows.push(line("当期純利益", "純利益"));
  rows.push(["自己資本比率", ...years.map((y) => {
    const v = asRatio(num(fin["自己資本比率"]?.[y]));
    return v === null ? "—" : pct(v);
  })]);
  rows.push(line("営業CF", "営業CF"));
  rows.push(line("現金・現金同等物", "現金及び現金同等物", ext));
  rows.push(line("設備投資", "設備投資", ext));
  rows.push(line("研究開発費", "研究開発費", ext));

  const eq = latest(fin["自己資本比率"]);
  const cf = latest(fin["営業CF"]);
  const cash = latest(ext["現金及び現金同等物"]);
  const capex = latest(ext["設備投資"]);
  const rd = latest(ext["研究開発費"]);

  const items = [];
  if (cf !== null) {
    items.push(`営業CFは${fmt(mm(cf))}百万円。` +
      (cash !== null ? `現預金は${oku(cash)}億円を維持している。` : ""));
  }
  if (eq !== null) items.push(`自己資本比率は${pct(asRatio(eq))}。`);
  if (capex !== null || rd !== null) {
    const p = [];
    if (capex !== null) p.push(`設備投資${fmt(mm(capex))}百万円`);
    if (rd !== null) p.push(`研究開発費${fmt(mm(rd))}百万円`);
    items.push(`${p.join("、")}を計画しており、成長投資フェーズへ移行。`);
  }
  items.push(TODO("中期経営計画の策定・公表を見据えた、エクイティファイナンスへの橋渡しを一文で"));

  return {
    no: 7,
    title: "成長投資フェーズへの移行",
    lead: D(ctx, "growthView", "中期経営計画を踏まえた方向性を一文で"),
    tables: [{ caption: "主な経営指標（連結・百万円）",
               head: ["決算期", ...years], rows }],
    blocks: [
      { items },
      {
        head: "内訳別中計総評", subs: [
          { head: "◆既存事業領域", items: Dlines(ctx, "segExisting", "中計の記載から3〜4行", 1) },
          { head: "◆新規事業領域", items: Dlines(ctx, "segNew", "中計の記載から3〜4行", 1) },
        ],
      },
    ],
  };
}

// --- p.8 株主構成と希薄化余地 ----------------------------------------------

function pageShareholders(ctx) {
  const { sec, basis, stable, dilution } = ctx;
  const list = shareholders(sec?.sh).slice(0, 10);
  const own = ownership(sec?.own);
  const label = stable?.label || "安定株主";

  const kojin = own.find((o) => /個人/.test(o.category) && !/外国/.test(o.category));
  const items = [];
  if (stable?.ratio != null) {
    items.push(`${label}における株式保有割合は${pct(stable.ratio, 1)}` +
      (stable.ratio > 0.5 ? "を超えており、安定した株主構成となっている。" : "。"));
  }
  if (kojin?.ratio != null) {
    items.push(`${label}を除いた所有者別株主状況は、` +
      `個人投資家が${pct(kojin.ratio, 1)}を占めている。`);
  }
  items.push(
    `${label}を中心とした株主構成を踏まえ、エクイティファイナンス実施時は` +
    `議決権比率への配慮が重要。` +
    (stable?.ratio != null
      ? `${label}の議決権50%超維持を前提とした場合、希薄化率は` +
        `${pct(maxDilutionFor(stable.ratio, 0.5))}程度が一つの目安となる。`
      : TODO("希薄化率の目安")));

  return {
    no: 8,
    title: "株主構成と希薄化余地",
    lead: `${label}を中心とした株主構成を踏まえ、` +
          `エクイティファイナンス実施時は議決権比率への配慮が重要`,
    tables: [
      list.length ? {
        caption: `大株主上位${list.length}位の状況`,
        head: ["順位", "株主名", "保有比率", "保有株数"],
        rows: list.map((r, i) => [
          String(r.rank ?? i + 1), r.name,
          r.ratio != null ? pct(r.ratio, 2) : "—", fmt(r.shares),
        ]),
      } : null,
      own.length ? {
        caption: "所有者別株主状況",
        head: ["区分", "株主数", "株式数", "比率"],
        rows: own.map((o) => [
          o.category, fmt(o.holders), fmt(o.shares),
          o.ratio != null ? pct(o.ratio, 1) : "—",
        ]),
        note: "有価証券報告書には当期しか載らないため、3期分の推移は別途。",
      } : null,
    ].filter(Boolean),
    blocks: [{ items }],
    notes: [sec?.k?.sh ? `${sec.k.sh} 時点` : null].filter(Boolean),
  };
}

// --- p.10 ご推奨の背景 -----------------------------------------------------
//
// 手法比較の表そのものは、どの提案書でも同じものを使うため作らない。
// ここで作るのは、その会社に固有の「なぜこの手法か」の部分だけ。

function pageCompare(ctx) {
  const { stable } = ctx;
  return {
    no: 10,
    title: "ご推奨の背景",
    lead: null,
    blocks: [{
      items: [
        ...Dlines(ctx, "whyMethod", "推奨の背景を1行", 2).slice(0, 2),
        stable?.ratio != null
          ? `${stable.label || "安定株主"}の議決権比率50%超維持を前提とした` +
            `発行規模設計を行いながら、株価上昇局面では調達額の増額余地を確保可能。`
          : TODO("議決権比率の維持と調達額の関係を1行"),
      ],
    }],
    notes: ["手法比較の表は、ひな形のものをそのまま使う。"],
  };
}

// --- p.13 発行概要 ---------------------------------------------------------

function pageTerms(ctx) {
  const { basis, market, dilution, terms } = ctx;
  const shares = basis.voting ? potentialShares(basis.voting, dilution) : null;
  const price = market?.price ?? null;
  const amount = price && shares ? price * shares : null;
  // 行使期間・下限行使価額・修正条項は会社との個別交渉で決まる。
  // 決め打ちの数字は置かず、入れてもらったときだけ計算する。
  const p = (r) => (price && r) ? `${fmt(Math.round(price * r))}円（基準株価×${(r * 100).toFixed(0)}%）` : null;
  const floorR = terms?.floorRatio ?? null;

  return {
    no: 13,
    title: "【ご提案】MSワラント 発行概要",
    lead: price
      ? `${market.asOf || ""}終値${fmt(price)}円を基準に試算`
      : TODO("基準日と基準株価"),
    tables: [{
      caption: "発行概要",
      head: ["項目", "内容"],
      rows: [
        ["発行決議日", TODO("ウィンドウ（決算・中計公表後）")],
        ["払込日", TODO("払込日")],
        ["権利行使期間", terms?.years ? `払込日以降 ${terms.years}年間` : TODO("権利行使期間")],
        ["基準株価（決議日前日終値）", price ? `${fmt(price)}円` : TODO("基準株価")],
        ["割当先", TODO("割当先")],
        ["調達予定額", amount ? `${oku(amount)}億円 程度` : TODO("調達予定額")],
        ["発行価額（プレミアム）", "●円"],
        ["発行予定株数", shares ? `${fmt(shares)}株` : TODO("発行予定株数")],
        ["希薄化率", pct(dilution)],
        ["当初行使価額", p(1.0) || TODO("当初行使価額")],
        ["下限行使価額", p(floorR) || TODO("下限行使価額")],
        ["行使価額修正条項", TODO("行使価額修正条項")],
        ["借株の有無", TODO("借株の有無")],
        ["資金使途", D(ctx, "useOfFunds", "資金使途")],
      ],
    }],
    notes: [
      "調達予定額 ＝ 当初行使価額 × 発行予定株数",
      basis.voting && shares
        ? `発行予定株数 ＝ 議決権株式数${fmt(basis.voting)}株 × ${pct(dilution)}` +
          `（1,000株未満切り捨て）`
        : null,
    ].filter(Boolean),
  };
}

// ---- 文章だけを取り出す --------------------------------------------------

/** ページの文章部分をプレーンテキストにする。貼り付け用。 */
export function pageText(page) {
  const out = [];
  out.push(`■ ${page.title}`);
  if (page.lead) out.push(`＞ ${page.lead}`);
  const walk = (blocks, indent) => {
    for (const b of blocks || []) {
      if (b.head) out.push(indent + b.head);
      for (const i of b.items || []) out.push(indent + "・" + i);
      walk(b.subs, indent + "  ");
    }
  };
  walk(page.blocks, "");
  for (const n of page.notes || []) out.push(`※ ${n}`);
  return out.join("\n");
}

/** 埋めていない【　】を数える。書き上がったかの目安にする。 */
export function countTodo(pages) {
  const s = JSON.stringify(pages);
  return (s.match(/【[^】]+】/g) || []).length;
}
