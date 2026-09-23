// pptx.js — 提案内容を「骨格だけ」のPPTXにする
//
// ロゴ・色・会社名の入ったものは作らない。枠と文字だけ。
// どこに何を書くかが分かればよく、体裁は手元のひな形に貼って整える前提。
//
// PptxGenJS は呼ぶ側から渡す（ブラウザはCDN、NodeはimportでOK）。

const GRAY = "BFBFBF";
const FG = "000000";
const SOFT = "808080";
const FONT = "Meiryo";

/** 箇条書きを PptxGenJS の text 配列にする。入れ子は indentLevel で表す。 */
function flatten(blocks, indent = 0, out = []) {
  for (const b of blocks || []) {
    if (b.head) out.push({ text: b.head, options: { bold: true, indentLevel: indent, breakLine: true } });
    for (const i of b.items || []) {
      out.push({ text: i, options: { bullet: true, indentLevel: indent + 1, breakLine: true } });
    }
    flatten(b.subs, indent + 1, out);
  }
  return out;
}

/** 表の行数から高さのあたりをつける。改行を含むセルは2行ぶん見る。 */
function tableHeight(t) {
  const rows = 1 + t.rows.length + (t.foot ? 1 : 0);
  const wraps = t.rows.reduce((a, r) =>
    a + Math.max(...r.map((c) => String(c).split("\n").length)) - 1, 0);
  return 0.24 * (rows + wraps) + 0.3;
}

/**
 * ページの配列からPPTXを組む。
 * 文章だけのページは1カラム、表があるページは左に文章・右に表。
 */
export function buildPptx(pages, PptxGenJS) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "W16", width: 13.333, height: 7.5 });
  pptx.layout = "W16";
  pptx.author = "";
  pptx.company = "";

  for (const p of pages) {
    const s = pptx.addSlide();

    // 見出しと、その左の縦線
    s.addShape(pptx.ShapeType.line, { x: 0.32, y: 0.28, w: 0, h: 0.42,
      line: { color: FG, width: 2.5 } });
    s.addText(p.title, { x: 0.48, y: 0.24, w: 12.4, h: 0.5,
      fontSize: 20, bold: true, color: FG, fontFace: FONT, valign: "middle" });

    let y = 0.88;
    if (p.lead) {
      s.addText("➤ " + p.lead, { x: 0.48, y, w: 12.4, h: 0.38, fontSize: 12,
        color: FG, fontFace: FONT, valign: "middle", margin: 6,
        line: { color: GRAY, width: 1 } });
      y += 0.54;
    }

    const lines = flatten(p.blocks);
    const tables = p.tables || [];
    const twoCol = lines.length > 0 && tables.length > 0;
    const colW = twoCol ? 6.1 : 12.4;
    const BOTTOM = 6.65;   // ここから下は注記とページ番号の場所

    // 文章の高さのあたり。11ptで1行あたり0.22インチ、幅で折り返す。
    const textH = twoCol
      ? Math.min(5.6, lines.reduce((a, l) =>
          a + 0.22 * Math.max(1, Math.ceil(l.text.length / 26)), 0.1))
      : 0;

    if (lines.length) {
      s.addText(lines, { x: 0.48, y, w: colW, h: twoCol ? textH : 5.6, fontSize: 11,
        color: FG, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.2 });
    }

    // 表は右の段から入れ、入りきらなければ左の段の文章の下へ回す。
    // 資金のページのように表が4つあると、1段では必ずあふれる。
    const cols = twoCol
      ? [{ x: 6.9, y }, { x: 0.48, y: y + textH + 0.15 }]
      : [{ x: 0.48, y }];
    let ci = 0;
    const dropped = [];

    for (const t of tables) {
      const h = tableHeight(t) + (t.caption ? 0.28 : 0) + (t.note ? 0.26 : 0);
      while (ci < cols.length && cols[ci].y + h > BOTTOM) ci++;
      if (ci >= cols.length) { dropped.push(t.caption || "表"); continue; }
      const col = cols[ci];
      if (t.caption) {
        s.addText(t.caption, { x: col.x, y: col.y, w: colW, h: 0.26, fontSize: 10,
          bold: true, color: FG, fontFace: FONT });
        col.y += 0.28;
      }
      const rows = [
        t.head.map((x) => ({ text: String(x), options: { bold: true, fill: "F2F2F2" } })),
        ...t.rows.map((r, i) => r.map((c) => ({
          text: String(c),
          options: t.pick === i ? { bold: true } : {},
        }))),
        ...(t.foot ? [t.foot.map((c) => ({ text: String(c), options: { bold: true } }))] : []),
      ];
      s.addTable(rows, { x: col.x, y: col.y, w: colW, fontSize: 9, color: FG,
        fontFace: FONT, valign: "top", autoPage: false,
        border: { type: "solid", color: GRAY, pt: 0.5 } });
      col.y += tableHeight(t);
      if (t.note) {
        s.addText("※ " + t.note, { x: col.x, y: col.y, w: colW, h: 0.24,
          fontSize: 8, color: SOFT, fontFace: FONT });
        col.y += 0.26;
      }
    }
    // 入りきらなかった表は、黙って消さずに名前だけ残す。
    if (dropped.length) {
      s.addText(`※ 紙面に入りきらなかった表：${dropped.join("、")}（画面で確認してください）`,
        { x: 0.48, y: BOTTOM, w: 12.4, h: 0.24, fontSize: 8, color: SOFT, fontFace: FONT });
    }

    const notes = (p.notes || []).map((x) => "※ " + x).join("\n");
    if (notes) {
      s.addText(notes, { x: 0.48, y: 6.72, w: 12.4, h: 0.42, fontSize: 8,
        color: SOFT, fontFace: FONT, valign: "bottom" });
    }
    s.addText(String(p.no), { x: 6.17, y: 7.08, w: 1, h: 0.26, fontSize: 10,
      color: SOFT, align: "center", fontFace: FONT });
  }
  return pptx;
}
