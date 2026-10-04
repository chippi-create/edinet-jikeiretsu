// tanshin.js — 決算短信の本文から、数字を拾う
//
// 有価証券報告書は年1回で、いちばん新しくても半年前の数字になる。
// 提案の前に見るべきは直近の四半期と通期予想なので、そこを短信から取る。
//
// 短信は様式が決まっているので、見出しと行頭で当てにいける。
// AIに読ませて数字を答えさせる手もあるが、数字は取り違えが怖いので
// ここは機械的に当てる。文章のほうはAIに任せる。
//
// 当たらなかったら null を返す。推測はしない。

/** △や▲は負、全角数字と読点をならす。 */
function toNum(t) {
  if (t === undefined || t === null) return null;
  let s = String(t).trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,]/g, "")
    .replace(/[△▲−―]/g, "-");
  if (s === "" || s === "-" || s === "─") return null;
  const m = /^-?\d+(\.\d+)?$/.exec(s);
  return m ? Number(s) : null;
}

/** 全角を半角にならした行を返す。見出し合わせに使う。 */
const norm = (s) => String(s)
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  .replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"))
  .replace(/\s+/g, " ");

/**
 * 「通期 6,177 1.4 177 - 227 - 137 32.8 11.34」のような行から、
 * 数字と増減率が交互に並ぶ前提で、本体の数字だけを取り出す。
 *
 * 増減率が「-」になることがあるので、位置で決め打ちせず、
 * 「数字 → 率 → 数字 → 率」の並びとして読む。
 */
function figures(line) {
  const cells = norm(line).split(" ").filter(Boolean);
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    const v = toNum(cells[i]);
    if (v === null) continue;
    out.push(v);
  }
  return out;
}

/**
 * 売上高・営業利益・経常利益・純利益を、数字の並びから当てる。
 * 「金額, 率, 金額, 率, 金額, 率, 金額, 率, 1株当たり」の順に並ぶので、
 * 率が「-」で落ちるぶんを考えると位置がずれる。
 * そこで、率は必ず小数か整数の百分率であることを使って、
 * 「金額らしい大きい数」を4つ拾う。
 */
function pickFour(line) {
  const cells = norm(line).split(" ").filter(Boolean);
  const nums = [];
  for (const c of cells) {
    const v = toNum(c);
    // 率は「14.7」「△4.8」のように小数点を持つか、セルが「-」になる。
    // 金額は3桁区切りで入っているので、カンマの有無で見分ける。
    nums.push({ v, comma: /[,，]/.test(c), dot: /\./.test(c), raw: c });
  }
  const vals = nums.filter((n) => n.v !== null);
  // カンマ付き（＝1,000以上の金額）か、小数点を持たない整数を金額とみなす。
  const money = vals.filter((n) => n.comma || !n.dot).map((n) => n.v);
  return money.length >= 4 ? money.slice(0, 4) : null;
}

/**
 * 決算短信の本文から、通期予想と直近四半期の実績を取り出す。
 * 単位は百万円（短信がそう書いている）。
 */
export function parseTanshin(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  const flat = norm(text);

  const out = {
    company: null, code: null, period: null, quarter: null,
    announced: null, forecast: null, halfForecast: null, actual: null, prior: null,
    equityRatio: null, dividendForecast: null, source: "決算短信",
    eps: null, epsForecast: null, revised: null, totalAssets: null, netAssets: null, equity: null, bs: null, cf: null,
  };

  // 表紙。「2027年4月期 第1四半期決算短信」と提出日。
  // 「第２四半期（中間期）決算短信」と書く会社もある（ベルトラ）。
  const head = /(\d{4})年\s*(\d{1,2})月期\s*(第\s*\d\s*四半期(?:\s*\(\s*中間期\s*\))?|中間期)?\s*決算短信/.exec(flat);
  if (head) {
    out.period = `${head[1]}年${Number(head[2])}月期`;
    out.quarter = head[3] ? head[3].replace(/\s/g, "") : "通期";
  }
  const day = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/.exec(flat);
  if (day) {
    out.announced =
      `${day[1]}-${String(day[2]).padStart(2, "0")}-${String(day[3]).padStart(2, "0")}`;
  }
  // 表紙は「コ ー ド 番 号 3444」のように字間を空けてあることがある。
  const code = /コ\s*ー\s*ド\s*番\s*号\s*(\d{4})/.exec(flat);
  if (code) out.code = code[1];
  const name = /上\s*場\s*会\s*社\s*名\s*(.+?)\s*上場取引所/.exec(flat);
  if (name) out.company = name[1].trim();

  // 通期予想。「通期」で始まる行を、業績予想の見出しの後ろから探す。
  // PDFによっては見出しが表の後ろに来る（ベルトラ：表の数字が先、「３．業績予想」が後）。
  // 見出しの後ろに無ければ、本文の頭から探す（「通期」で始まり金額が4つ並ぶ行は予想の表しか無い）。
  const fi0 = lines.findIndex((l) => /業績予想/.test(norm(l)));
  const after = fi0 >= 0 && lines.slice(fi0, fi0 + 20).some((l) => /^\s*通\s*期/.test(norm(l)) && pickFour(l));
  const fi = after ? fi0 : 0;
  if (fi0 >= 0 || lines.some((l) => /^\s*通\s*期/.test(norm(l)))) {
    for (let i = fi; i < Math.min(lines.length, after ? fi + 20 : 200); i++) {
      if (/^\s*通\s*期/.test(norm(lines[i])) && !pickFour(lines[i])) continue;
      if (!/^\s*通\s*期/.test(norm(lines[i]))) continue;
      const f = pickFour(lines[i]);
      if (f) {
        out.forecast = { 売上高: f[0], 営業利益: f[1], 経常利益: f[2], 純利益: f[3] };
        // 行末の小数が1株当たり当期純利益（「… 137 32.8 11.34」）。金額が4つ並んだ後にあるときだけ。
        const cells = norm(lines[i]).split(" ").filter(Boolean);
        const last = cells[cells.length - 1];
        if (/\./.test(last) && toNum(last) !== null && cells.filter((c) => /[,，]/.test(c) || /^[△▲-]?\d+$/.test(c)).length >= 4) {
          out.epsForecast = toNum(last);
        }
      }
      break;
    }
    // 第2四半期（累計）の予想。上期の進捗を見るのに使う。出していない会社も多い。
    for (let i = fi; i < Math.min(lines.length, after ? fi + 20 : 200); i++) {
      if (!/^\s*第\s*2\s*四\s*半\s*期\s*\(累計\)/.test(norm(lines[i]))) continue;
      const f = pickFour(lines[i]);
      if (f) out.halfForecast = { 売上高: f[0], 営業利益: f[1], 経常利益: f[2], 純利益: f[3] };
      break;
    }
  }

  // 直近四半期の実績。「◯年◯月期第◯四半期」で始まり、数字が4つ以上ある行。
  const ai = lines.findIndex((l) => /連結経営成績|経営成績\(累計\)|経営成績（累計）/.test(norm(l)));
  if (ai >= 0) {
    for (let i = ai; i < Math.min(lines.length, ai + 20); i++) {
      const l = norm(lines[i]);
      if (!/^\s*\d{4}年\s*\d{1,2}月期\s*(第\d四半期|中間期|通期)?/.test(l)) continue;
      const f = pickFour(lines[i]);
      if (f) {
        out.actual = { 期: l.split(" ")[0], 売上高: f[0], 営業利益: f[1],
                       経常利益: f[2], 純利益: f[3] };
        // 次の行が前年同期。順調かどうかは、前年の同じ時点と比べないと言えない
        // （季節性がある会社は、1Qで25%に届かないのが普通のことがある）。
        const nx = lines[i + 1] ? norm(lines[i + 1]) : "";
        const pf = /^\s*\d{4}年\s*\d{1,2}月期/.test(nx) ? pickFour(lines[i + 1]) : null;
        if (pf) {
          out.prior = { 期: nx.trim().split(" ")[0], 売上高: pf[0], 営業利益: pf[1],
                        経常利益: pf[2], 純利益: pf[3] };
        }
      }
      break;
    }
  }

  // 1株当たり四半期純利益（実績）。見出しの後ろで、年月期で始まる最初の行の最初の数字。
  const ei = lines.findIndex((l) => /1株当たり/.test(norm(l)) && /純利益/.test(norm(lines[lines.indexOf(l) + 1] || "") + norm(l)));
  if (ei >= 0 && ai >= 0) {
    for (let i = ei; i < Math.min(lines.length, ei + 8); i++) {
      const l = norm(lines[i]);
      if (!/^\s*\d{4}年\s*\d{1,2}月期/.test(l)) continue;
      const v = l.replace(/^\s*\d{4}年\s*\d{1,2}月期\s*(第\d四半期|中間期)?/, "").trim().split(" ")[0];
      out.eps = toNum(v);
      break;
    }
  }

  // 財政状態。「2027年4月期第1四半期 8,598 5,815 65.7」の総資産・純資産。
  // 見出し「財政状態」が表の後ろに来るPDFがあるので、表の見出し行（総資産 純資産 …）を先に探す。
  const zh = lines.findIndex((l) => /^\s*総資産\s+純資産/.test(norm(l)));
  const zi = zh >= 0 ? zh : lines.findIndex((l) => /財政状態/.test(norm(l)));
  if (zi >= 0) {
    for (let i = zi; i < Math.min(lines.length, zi + 8); i++) {
      const l = norm(lines[i]);
      if (!/^\s*\d{4}年\s*\d{1,2}月期/.test(l)) continue;
      const ns = l.replace(/^\s*\d{4}年\s*\d{1,2}月期\s*(第\d四半期|中間期)?/, "").trim().split(" ").map(toNum).filter((v) => v !== null);
      if (ns.length >= 2) { out.totalAssets = ns[0]; out.netAssets = ns[1]; }
      break;
    }
    const ref = /\(参考\)\s*自己資本\s*\d{4}年\s*\d{1,2}月期\s*(第\d四半期|中間期)?\s*([△▲\-]?[\d,]+)\s*百万円/.exec(norm(text));
    if (ref) out.equity = toNum(ref[2]);
  }

  // 業績予想の修正の有無（配当予想の修正の有無とは別の行）。
  const rv = /業績予想からの修正の有無\s*[:：]\s*(有|無)/.exec(flat);
  if (rv) out.revised = rv[1] === "有";

  // 年間配当の予想。「2027年4月期(予想) 0.00 - 10.00 10.00」の最後の数字（合計）。
  const dv = lines.find((l) => /^\s*\d{4}年\s*\d{1,2}月期\s*\(予想\)/.test(norm(l)));
  if (dv) {
    const ns = norm(dv).split(" ").map(toNum).filter((v) => v !== null);
    if (ns.length) out.dividendForecast = ns[ns.length - 1];
  }

  // 四半期末の貸借対照表とキャッシュ・フロー計算書（添付資料）。
  out.bs = statement(lines, BS_ROWS);
  out.cf = statement(lines, CF_ROWS);

  // 自己資本比率。「自己資本比率」の後ろに並ぶ最初の数字。
  const eq = /自己資本比率[\s\S]{0,120}?(\d{1,3}\.\d)\s*$/m.exec(norm(text).replace(/ /g, "\n"));
  if (eq) out.equityRatio = Number(eq[1]);

  return (out.forecast || out.actual) ? out : null;
}

// 添付資料の表から拾う行。「科目 前期末 当四半期末」と並ぶので、行末の数字を当期とする。
const BS_ROWS = {
  流動資産: /^流動資産合計$/, 固定資産: /^固定資産合計$/, 総資産: /^資産合計$/,
  流動負債: /^流動負債合計$/, 固定負債: /^固定負債合計$/, 純資産: /^純資産合計$/,
  資本金: /^資本金$/, 現金及び預金: /^現金及び預金$/,
  短期借入金: /^短期借入金$/, 一年内返済長期借入金: /^1年内返済予定の長期借入金$/,
  長期借入金: /^長期借入金$/, 社債: /^社債$/, 一年内償還社債: /^1年内償還予定の社債$/,
  コマーシャルペーパー: /^コマーシャル・?ペーパー$/,
};
const CF_ROWS = {
  // 「営業活動によるCF」と略すのは説明資料の表。財務諸表は略さないので、略した形は拾わない。
  営業CF: /^営業活動によるキャッシュ・フロー$/, 投資CF: /^投資活動によるキャッシュ・フロー$/,
  財務CF: /^財務活動によるキャッシュ・フロー$/, 現金同等物期末: /^現金及び現金同等物の(四半期末|中間期末|期末)残高$/,
};

/**
 * 「(単位：千円)」の表から科目ごとの当期の数字を拾い、百万円（切り捨て）にそろえる。
 * 説明資料は「=== 資料名 ===」で別の資料に分かれているので、ここには入らない。
 */
function statement(lines, want) {
  // 表の見出し（「中間連結貸借対照表」など）は、PDFによって表の前にも後ろにも来る（ベルトラは後ろ）。
  // 見出しに頼らず、本文の頭から読み、科目ごとに数字の付いた最初の行を採る。
  // 「流動資産合計」「営業活動によるキャッシュ・フロー」に数字が付く行は、財務諸表の中にしか無い。
  let unit = 1;   // 百万円あたりの倍率の逆数（千円なら 1/1000）
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const l = norm(lines[i]).trim();
    const u = /単位\s*[:：]\s*(千円|百万円|円)/.exec(l);
    if (u) { unit = u[1] === "千円" ? 1e-3 : u[1] === "円" ? 1e-6 : 1; continue; }
    const cells = l.split(" ");
    const nums = [];
    while (cells.length > 1 && toNum(cells[cells.length - 1]) !== null) nums.unshift(toNum(cells.pop()));
    if (!nums.length) continue;
    // 前期の欄が「－」（該当なし）だと科目名の後ろに残る。科目名から外す。
    const label = cells.join("").replace(/^[※\*]+/, "").replace(/[－―─\-]+$/, "");
    for (const [k, re] of Object.entries(want)) {
      if (out[k] === undefined && re.test(label)) out[k] = Math.trunc(nums[nums.length - 1] * unit);
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 貼られた資料に短信が何本も入っているとき、1本ずつ読む。
 * 読み込むときに「=== 資料名 ===」で区切っているので、そこで割る。
 * 1Qと2Qの短信を両方入れれば、2Q単独（2Q累計−1Q累計）が出せる。
 */
export function parseTanshinAll(text) {
  if (!text) return [];
  const parts = String(text).split(/^=== .* ===$/m).filter((t) => t.trim());
  return parts.map(parseTanshin).filter(Boolean);
}

/** 四半期の番号。通期は4、中間期は2。 */
export function quarterNo(q) {
  if (!q) return null;
  if (/中間/.test(q)) return 2;
  if (/通期/.test(q)) return 4;
  const m = /第\s*(\d)/.exec(q);
  return m ? Number(m[1]) : null;
}

/** 提案書に出せる形の1行にする。 */
export function tanshinLine(t) {
  if (!t) return null;
  const mm = (v) => (v === null || v === undefined) ? "—" : `${v.toLocaleString("ja-JP")}百万円`;
  const parts = [];
  if (t.actual) {
    parts.push(`${t.actual.期}の売上高${mm(t.actual.売上高)}、` +
      `営業${t.actual.営業利益 < 0 ? "損失" : "利益"}${mm(Math.abs(t.actual.営業利益))}`);
  }
  if (t.forecast) {
    parts.push(`${t.period}通期予想は売上高${mm(t.forecast.売上高)}、` +
      `営業${t.forecast.営業利益 < 0 ? "損失" : "利益"}${mm(Math.abs(t.forecast.営業利益))}`);
  }
  return parts.join("。") + (parts.length ? `（${t.announced || ""}公表の決算短信）` : "");
}
