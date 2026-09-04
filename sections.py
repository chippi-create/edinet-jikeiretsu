#!/usr/bin/env python3
"""
sections.py — 有価証券報告書の記述部分から表を取り出す

  SEC_CODES=1332 python sections.py        解析結果を目で見る
  （蓄積は fetch_sections.py 側でやる）

所有者別状況・大株主の状況・役員の状況は、CSV(type=5)では
HTMLタグが落ちてセルの区切りが失われるため復元できない。
提出本文書(type=1)のZIPに入っているiXBRLのHTMLから表として取り出す。
"""

import os
import io
import re
import sys
import json
import zipfile
from html.parser import HTMLParser

import fetch2

# 取り出す対象。要素名 -> ラベル
TARGETS = {
    "ShareholdingByShareholderCategoryTextBlock": "所有者別状況",
    "MajorShareholdersTextBlock": "大株主の状況",
    "InformationAboutOfficersTextBlock": "役員の状況",
}


def log(*a):
    print(*a, flush=True)


def fetch_zip(doc_id):
    """提出本文書(type=1)のZIPを取る。"""
    r = fetch2.get(f"{fetch2.BASE}/documents/{doc_id}",
                   {"type": 1, "Subscription-Key": fetch2.API_KEY}, 300)
    if r is None:
        return None
    try:
        return zipfile.ZipFile(io.BytesIO(r.content))
    except zipfile.BadZipFile:
        return None


def find_block(html, element):
    """iXBRLの ix:nonNumeric から、指定要素の中身だけを切り出す。

    役員の状況のように入れ子になっている（1人ずつの略歴が内側にある）ので、
    開きタグと閉じタグを数えて対応を取る。
    """
    m = re.search(r"<ix:nonNumeric[^>]*name=\"[^\"]*" + re.escape(element) + r"\"[^>]*>", html)
    if not m:
        return None
    i = m.end()
    depth = 1
    pos = i
    open_re = re.compile(r"<ix:nonNumeric\b", re.I)
    close_re = re.compile(r"</ix:nonNumeric>", re.I)
    while depth > 0:
        o = open_re.search(html, pos)
        c = close_re.search(html, pos)
        if c is None:
            return html[i:]
        if o is not None and o.start() < c.start():
            depth += 1
            pos = o.end()
        else:
            depth -= 1
            pos = c.end()
            if depth == 0:
                return html[i:c.start()]
    return None


class TableParser(HTMLParser):
    """HTMLの表をセルの二次元配列にする。rowspan / colspan を展開する。

    有報の表はセル結合が多く、展開しないと列がずれる。
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self._depth = 0
        self._grid = None
        self._row = None
        self._buf = None
        self._span = None      # 次以降の行に持ち越すセル {(行, 列): 文字列}
        self._rowno = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table":
            self._depth += 1
            if self._depth == 1:
                self._grid, self._span, self._rowno = [], {}, 0
            return
        # 入れ子の表（役員の略歴が年月の表になっている）は、外側のセルの
        # 文字列として畳む。行として拾うと役員一覧の構造が壊れる。
        if self._depth >= 2:
            if self._buf is not None:
                if tag == "tr":
                    self._buf.append(" / ")
                elif tag in ("td", "th", "br"):
                    self._buf.append(" ")
            return
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._buf = []
            self._cs = int(a.get("colspan") or 1)
            self._rs = int(a.get("rowspan") or 1)
        elif tag == "br" and self._buf is not None:
            self._buf.append(" ")

    def handle_data(self, data):
        if self._buf is not None:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if tag == "table":
            if self._depth == 1 and self._grid:
                self.tables.append(self._grid)
                self._grid = None
            self._depth = max(0, self._depth - 1)
            return
        if self._depth >= 2:
            return
        if tag in ("td", "th") and self._buf is not None:
            text = re.sub(r"\s+", " ", "".join(self._buf)).strip()
            text = text.replace("　", " ").strip()
            # 入れ子の表を畳んだときに前後に付く区切りを落とす
            text = re.sub(r"^(?:\s*/\s*)+|(?:\s*/\s*)+$", "", text)
            if self._row is not None:
                col = len(self._row)
                while (self._rowno, col) in self._span:
                    self._row.append(self._span.pop((self._rowno, col)))
                    col = len(self._row)
                for k in range(self._cs):
                    self._row.append(text)
                    for r in range(1, self._rs):
                        self._span[(self._rowno + r, col + k)] = text
            self._buf = None
        elif tag == "tr" and self._row is not None:
            col = len(self._row)
            while (self._rowno, col) in self._span:
                self._row.append(self._span.pop((self._rowno, col)))
                col = len(self._row)
            if self._grid is not None:
                self._grid.append(self._row)
            self._row = None
            self._rowno += 1


def tables_of(html):
    p = TableParser()
    p.feed(html)
    p.close()
    return p.tables


def sections_of(z):
    """ZIP内のiXBRLから、対象3つのHTMLを取り出す。"""
    out = {}
    names = [n for n in z.namelist() if n.endswith("_ixbrl.htm") and "/PublicDoc/" in n]
    for n in sorted(names):
        body = z.read(n).decode("utf-8", "replace")
        for element in TARGETS:
            if element in out:
                continue
            if element not in body:
                continue
            block = find_block(body, element)
            if block:
                out[element] = block
    return out


def main():
    codes = [c.strip() for c in os.environ.get("SEC_CODES", "").split(",") if c.strip()]
    if not codes:
        raise SystemExit("SEC_CODES を指定してください。")
    if not fetch2.API_KEY:
        raise SystemExit("EDINET_API_KEY が設定されていません。")

    with open(fetch2.INDEX_PATH, encoding="utf-8") as f:
        index = json.load(f)
    picked = fetch2.pick_docs(index, targets=codes)

    for sec, pair in picked.items():
        doc = pair["本体"]
        log("=" * 78)
        log(f"■ {sec} {doc.get('filerName')}  docID={doc['docID']}")
        z = fetch_zip(doc["docID"])
        if z is None:
            log("  ZIPを取得できませんでした")
            continue
        blocks = sections_of(z)
        for element, label in TARGETS.items():
            html = blocks.get(element)
            if not html:
                log(f"\n  --- {label}: 見つかりません ---")
                continue
            tabs = tables_of(html)
            log(f"\n  --- {label}（表 {len(tabs)}個 / HTML {len(html):,}字）---")
            for t in tabs[:2]:
                log(f"    行数={len(t)} 列数={max(len(r) for r in t)}")
                for row in t[:int(os.environ.get("ROWS", "8"))]:
                    log("      | " + " | ".join(c[:22] for c in row))


if __name__ == "__main__":
    main()
