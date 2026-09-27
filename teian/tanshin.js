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
  };

  // 表紙。「2027年4月期 第1四半期決算短信」と提出日。
  const head = /(\d{4})年\s*(\d{1,2})月期\s*(第\s*\d\s*四半期|中間期)?\s*決算短信/.exec(flat);
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
  const fi = lines.findIndex((l) => /業績予想/.test(norm(l)));
  if (fi >= 0) {
    for (let i = fi; i < Math.min(lines.length, fi + 20); i++) {
      if (!/^\s*通\s*期/.test(norm(lines[i]))) continue;
      const f = pickFour(lines[i]);
      if (f) {
        out.forecast = { 売上高: f[0], 営業利益: f[1], 経常利益: f[2], 純利益: f[3] };
      }
      break;
    }
    // 第2四半期（累計）の予想。上期の進捗を見るのに使う。出していない会社も多い。
    for (let i = fi; i < Math.min(lines.length, fi + 20); i++) {
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

  // 自己資本比率。「自己資本比率」の後ろに並ぶ最初の数字。
  const eq = /自己資本比率[\s\S]{0,120}?(\d{1,3}\.\d)\s*$/m.exec(norm(text).replace(/ /g, "\n"));
  if (eq) out.equityRatio = Number(eq[1]);

  return (out.forecast || out.actual) ? out : null;
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
