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
      // 太字の区切りごとに分ける。箇条書きと字下げは同じ行の部分すべてに付ける
      // （先頭だけに付けたら、太字を含む行だけ記号と字下げが消えた）。改行は最後だけ。
      const rs = runs(i);
      rs.forEach((r, k) => {
        out.push({ text: r.text, options: { ...r.options, bullet: true, indentLevel: indent + 1,
          ...(k === rs.length - 1 ? { breakLine: true } : {}) } });
      });
    }
    flatten(b.subs, indent + 1, out);
  }
  return out;
}

/** 文字の幅のあたり。全角1、半角0.55。 */
const textWidth = (s) => [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) < 0x100 ? 0.55 : 1), 0);

/**
 * 表の高さのあたり。セルの文字が列の幅で折り返すぶんも数える。
 * 以前は改行だけ数えていて、見出し「中計目標（2028年4月期）」や区分名が3行に折れた表が
 * 次の表や注記に重なった（PowerPointで書き出して見つけた）。
 * 9ptの全角1文字はおよそ0.125インチ。
 */
function tableHeight(t, width = 6.1) {
  const n = Math.max(1, t.head.length);
  const perLine = Math.max(3, Math.floor((width / n - 0.15) / 0.125));
  const lines = (row) => Math.max(1, ...row.map((c) =>
    String(c).split("\n").reduce((a, part) => a + Math.max(1, Math.ceil(textWidth(part) / perLine)), 0)));
  const all = [t.head, ...t.rows, ...(t.foot ? [t.foot] : [])];
  return all.reduce((a, r) => a + 0.19 * lines(r) + 0.08, 0) + 0.1;
}

/**
 * 「**太字**」の記号を取り除く。PPTXでは太字にしない。
 * 行の途中で太字に切り替えると、PowerPointでは箇条書きの記号と字下げが外れるか、
 * 部分ごとに別の段落に割れた（書き出して確かめた）。骨格だけの資料なので記号を消すだけにする。
 */
function runs(text, base = {}) {
  return [{ text: String(text).replace(/\*\*/g, ""), options: { ...base } }];
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
      s.addText(runs("➤ " + p.lead), { x: 0.48, y, w: 12.4, h: 0.38, fontSize: 12,
        color: FG, fontFace: FONT, valign: "middle", margin: 6,
        line: { color: GRAY, width: 1 } });
      y += 0.54;
    }

    if (p.layout === "wideTable") { wideTable(s, p, y); footer(s, p); continue; }
    if (p.layout === "fullTable") { fullTable(s, p, y); footer(s, p); continue; }
    if (p.layout === "stack") { stack(s, p, y); footer(s, p); continue; }
    if (p.layout === "story") { story(s, p, y); footer(s, p); continue; }
    if (p.layout === "plans") { plans(s, p, y); footer(s, p); continue; }

    // 左右2段（エグゼクティブサマリー）。1つ目のブロックを左、残りを右に置く。
    if (p.layout === "split") {
      const H = Math.min(6.65, notesTop(p) - 0.08) - y;
      const box = (blocks, x) => s.addText(flatten(blocks).map((r) =>
        ({ text: r.text, options: { ...r.options, fontSize: 10 } })),
        { x, y, w: 6.1, h: H, fontFace: FONT, color: FG, valign: "top", lineSpacingMultiple: 1.1 });
      box((p.blocks || []).slice(0, 1), 0.48);
      box((p.blocks || []).slice(1), 6.9);
      footer(s, p);
      continue;
    }

    // 4つの枠を2×2に並べるページ（バックアッププラン）。1枚に収めるための組み方。
    if (p.layout === "grid4") {
      grid4(s, p, y);
      footer(s, p);
      continue;
    }

    const lines = flatten(p.blocks);
    const tables = p.tables || [];
    const twoCol = lines.length > 0 && tables.length > 0;
    const colW = twoCol ? 6.1 : 12.4;
    // 注記が複数行だと上に伸びて表に重なった（現状②）。注記の行数から高さを出し、
    // 表と文章はその上までに収める。
    const BOTTOM = Math.min(6.65, notesTop(p) - 0.08);

    // 文章の高さのあたり。11ptで1行あたり0.22インチ、幅で折り返す。
    const textH = twoCol
      ? Math.min(5.6, lines.reduce((a, l) =>
          a + 0.22 * Math.max(1, Math.ceil(textWidth(l.text) / 36)), 0.1))   // 11ptで幅6.1インチに全角およそ36字
      : 0;

    if (lines.length) {
      s.addText(lines, { x: 0.48, y, w: colW, h: twoCol ? textH : 5.6, fontSize: 11,
        color: FG, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.2 });
    }

    // 表は右の段から入れ、入りきらなければ左の段の文章の下へ回す。
    // 資金のページのように表が4つあると、1段では必ずあふれる。
    const cols = twoCol
      ? [{ x: 6.9, y }, { x: 0.48, y: y + textH + 0.3 }]
      : [{ x: 0.48, y }];
    let ci = 0;
    const dropped = [];

    for (const t of tables) {
      const h = tableHeight(t, colW) + (t.caption ? 0.28 : 0) + (t.note ? 0.26 : 0);
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
      col.y += tableHeight(t, colW);
      if (t.note) {
        s.addText("※ " + t.note, { x: col.x, y: col.y, w: colW, h: 0.24,
          fontSize: 8, color: SOFT, fontFace: FONT });
        col.y += 0.26;
      }
    }
    // 入りきらなかった表は、黙って消さずに名前だけ残す。
    if (dropped.length) {
      s.addText(`※ 紙面に入りきらなかった表：${dropped.join("、")}（画面で確認）`,
        { x: 0.48, y: BOTTOM - 0.24, w: 12.4, h: 0.22, fontSize: 8, color: SOFT, fontFace: FONT });
    }

    footer(s, p);
  }
  return pptx;
}

/** 表を置く。見出しの行（区切り）は太字にする。返り値は表の下端。 */
function putTable(s, t, x, y, w, fontSize = 9) {
  let top = y;
  if (t.caption) {
    s.addText(t.caption, { x, y: top, w, h: 0.24, fontSize: fontSize + 1, bold: true, color: FG, fontFace: FONT });
    top += 0.26;
  }
  const isSection = (r) => r.slice(1).every((c) => c === "");
  const rows = [
    t.head.map((c) => ({ text: String(c), options: { bold: true, fill: "F2F2F2" } })),
    ...t.rows.map((r, i) => r.map((c) => ({ text: String(c),
      options: (t.section && isSection(r)) || t.pick === i ? { bold: true } : {} }))),
    ...(t.foot ? [t.foot.map((c) => ({ text: String(c), options: { bold: true } }))] : []),
  ];
  const rowH = fontSize <= 8 ? 0.148 : 0.2;
  s.addTable(rows, { x, y: top, w, fontSize, color: FG, fontFace: FONT, valign: "middle",
    autoPage: false, rowH, margin: 0.02, border: { type: "solid", color: GRAY, pt: 0.5 } });
  top += t.section ? rows.length * rowH + 0.05 : tableHeight(t, w) * (fontSize / 9);
  if (t.note) {
    s.addText("※ " + t.note, { x, y: top, w, h: 0.22, fontSize: 7.5, color: SOFT, fontFace: FONT });
    top += 0.24;
  }
  return top;
}

/**
 * 全幅の大きな表1つ（事業の状況）。列が多いので、1列目だけ広く取り、残りは等分。
 * groups があれば、見出しの上に「通期実績／四半期累計／今期予想／中計」のくくりの行を置く。
 */
function fullTable(s, p, top) {
  const t = (p.tables || [])[0];
  if (!t) return;
  const W = 12.4, first = 2.3, n = t.head.length - 1;
  const colW = [first, ...Array(n).fill((W - first) / Math.max(1, n))];
  const isSection = (r) => r.slice(1).every((c) => c === "");
  const rows = [
    ...(t.groups ? [t.groups.map((g) => ({ text: g.text, options: { bold: true, fill: "E7E6E6", align: "center", colspan: g.span } }))] : []),
    t.head.map((c, i) => ({ text: String(c), options: { bold: true, fill: "F2F2F2", align: i ? "center" : "left" } })),
    ...t.rows.map((r) => r.map((c, i) => ({ text: String(c),
      options: { ...(isSection(r) ? { bold: true, fill: "FAFAFA" } : {}), align: i ? "right" : "left" } }))),
  ];
  // 下端（注記の上）に収まる行の高さにする。
  // PowerPointは文字の大きさより低い行にできないので、上下の余白を0にして7ptに落とす。
  const rowH = Math.min(0.2, (notesTop(p) - 0.1 - top) / rows.length);
  s.addTable(rows, { x: 0.48, y: top, w: W, colW, fontSize: rowH < 0.16 ? 7 : 8, color: FG, fontFace: FONT,
    valign: "middle", autoPage: false, rowH, margin: [0, 0.04, 0, 0.04], border: { type: "solid", color: GRAY, pt: 0.5 } });
}

/** 左に大きな表（主な経営指標）、右にほかの表と所見。 */
function wideTable(s, p, top) {
  const [main, ...rest] = p.tables || [];
  if (main) putTable(s, main, 0.48, top, 7.3, 7.5);
  let y = top;
  for (const t of rest) y = putTable(s, t, 8.0, y, 4.85, 8) + 0.1;
  const lines = flatten(p.blocks).map((r) => ({ text: r.text, options: { ...r.options, fontSize: 9.5 } }));
  if (lines.length) {
    s.addText(lines, { x: 8.0, y, w: 4.85, h: Math.max(0.5, notesTop(p) - 0.08 - y),
      fontFace: FONT, color: FG, valign: "top", lineSpacingMultiple: 1.1 });
  }
}

/** 上に文章（全幅）、下に表（全幅）。個別論点のページ。 */
function stack(s, p, top) {
  const lines = flatten(p.blocks).map((r) => ({ text: r.text, options: { ...r.options, fontSize: 10.5 } }));
  const textH = lines.reduce((a, l) => a + 0.2 * Math.max(1, Math.ceil(textWidth(l.text) / 78)), 0.1);
  s.addText(lines, { x: 0.48, y: top, w: 12.4, h: textH, fontFace: FONT, color: FG, valign: "top" });
  let y = top + textH + 0.1;
  for (const t of p.tables || []) y = putTable(s, t, 0.48, y, 12.4, 8.5) + 0.1;
}

/** エクイティストーリー：今の状況 → 今回ファイナンス → 左右2つの枠 → 目指す姿。 */
function story(s, p, top) {
  const [now, left, right, goal] = p.blocks || [];
  const bl = (items, size) => (items || []).map((t) => ({ text: t, options: { bullet: true, breakLine: true, fontSize: size } }));
  s.addText(bl(now?.items, 11), { x: 0.9, y: top, w: 11.6, h: 0.8, fontFace: FONT, color: FG, valign: "top" });
  s.addText("今回ファイナンス", { x: 5.2, y: top + 0.85, w: 2.9, h: 0.4, fontSize: 12, bold: true,
    align: "center", fontFace: FONT, color: FG, line: { color: FG, width: 1 } });
  const bx = (b, x) => {
    s.addShape("rect", { x, y: top + 1.45, w: 5.3, h: 3.1, line: { color: FG, width: 1 } });
    s.addText(b?.head || "", { x: x + 1.2, y: top + 1.3, w: 2.9, h: 0.34, fontSize: 12, bold: true,
      align: "center", fontFace: FONT, color: FG, fill: { color: "FFFFFF" }, line: { color: FG, width: 1 } });
    s.addText(bl(b?.items, 10.5), { x: x + 0.15, y: top + 1.75, w: 5.0, h: 2.7,
      fontFace: FONT, color: FG, valign: "top", lineSpacingMultiple: 1.1 });
  };
  bx(left, 0.9);
  bx(right, 7.2);
  s.addText("×", { x: 6.2, y: top + 2.6, w: 0.9, h: 0.6, fontSize: 28, bold: true, align: "center", fontFace: FONT, color: FG });
  s.addText((goal?.items || []).join(" "), { x: 1.4, y: top + 4.75, w: 10.6, h: 0.45, fontSize: 13, bold: true,
    align: "center", fontFace: FONT, color: FG, line: { color: GRAY, width: 1 } });
}

/** PLAN①②③。左に番号の箱、右に見出しと1〜2行。 */
function plans(s, p, top) {
  const list = (p.plans || []).slice(0, 4);
  const H = Math.min(1.4, (notesTop(p) - 0.1 - top) / Math.max(1, list.length));
  const circ = ["①", "②", "③", "④"];
  list.forEach((pl, i) => {
    const y = top + 0.15 + i * H;
    s.addText(`PLAN${circ[i]}`, { x: 0.9, y, w: 1.9, h: 0.62, fontSize: 18, bold: true, align: "center",
      valign: "middle", fontFace: FONT, color: FG, line: { color: FG, width: 1.5 } });
    s.addText("➤ " + pl.title, { x: 3.0, y: y - 0.02, w: 9.6, h: 0.36, fontSize: 14, bold: true,
      underline: true, fontFace: FONT, color: FG });
    s.addText((pl.lines || []).map((l) => ({ text: "➡ " + l, options: { breakLine: true } })),
      { x: 3.2, y: y + 0.36, w: 9.4, h: H - 0.45, fontSize: 10.5, fontFace: FONT, color: FG, valign: "top" });
  });
}

/** 注記の行数。8ptで幅12.4インチに全角およそ110字。 */
function notesLines(p) {
  return (p.notes || []).reduce((a, x) => a + Math.max(1, Math.ceil(textWidth("※ " + x) / 110)), 0);
}
/** 注記の上端。下端（7.05インチ）から行数ぶん上に伸ばす。 */
function notesTop(p) {
  return 7.05 - 0.15 * notesLines(p);
}

/** 注記とページ番号。 */
function footer(s, p) {
  const notes = (p.notes || []).map((x) => "※ " + x).join("\n");
  if (notes) {
    const top = notesTop(p);
    s.addText(notes, { x: 0.48, y: top, w: 12.4, h: 7.05 - top, fontSize: 8,
      color: SOFT, fontFace: FONT, valign: "top", margin: 0 });
  }
  // 番号が【ページ番号】のままだと幅1インチでは2行に折れる。幅を取って中央に置く。
  s.addText(String(p.no), { x: 5.67, y: 7.08, w: 2, h: 0.26, fontSize: 10,
    color: SOFT, align: "center", fontFace: FONT });
}

/**
 * 4つの枠を2×2に並べる。枠ごとに見出しと箇条書き。
 * 表は4つ目の枠の中に「項目 値」の行として入れる（表を別に置く場所が無いため）。
 */
function grid4(s, p, top) {
  const W = 6.1, GAP = 0.2, BOTTOM = Math.min(6.62, notesTop(p) - 0.08);
  const H = (BOTTOM - top - GAP) / 2;
  const blocks = (p.blocks || []).slice(0, 4).map((b) => ({ ...b, items: [...(b.items || [])] }));
  const last = blocks[blocks.length - 1];
  for (const t of p.tables || []) {
    if (!last) break;
    last.items.push(`${t.caption}：` + t.rows.map((r) => `${r[0]} ${r[1]}`).join(" ／ "));
  }
  blocks.forEach((b, i) => {
    const x = 0.48 + (i % 2) * (W + GAP);
    const y = top + Math.floor(i / 2) * (H + GAP);
    s.addShape("rect", { x, y, w: W, h: H, line: { color: GRAY, width: 1 } });
    s.addText([
      { text: b.head || "", options: { bold: true, fontSize: 11, breakLine: true } },
      ...b.items.flatMap((t) => {
        const rs = runs(t, { fontSize: 9.5 });
        return rs.map((r, k) => ({ text: r.text, options: { ...r.options, bullet: true,
          ...(k === rs.length - 1 ? { breakLine: true } : {}) } }));
      }),
    ], { x: x + 0.08, y: y + 0.05, w: W - 0.16, h: H - 0.1, color: FG, fontFace: FONT,
         valign: "top", lineSpacingMultiple: 1.1 });
  });
}
