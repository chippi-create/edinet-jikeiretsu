#!/usr/bin/env python3
"""
probe.py — 指標が取れなかった会社で、実際の要素名を調べる

  SEC_CODES=1950,1952 python probe.py

抽出パターンを推測で書くと外すので、XBRLに実在する要素IDを目で見るための道具。
本番の取得には関わらない。
"""

import os
import re
import csv
import io
import json

import fetch2

# 見たい指標のあたり。ここに引っかかる要素IDを全部出す。
KEYWORDS = os.environ.get(
    "KEYWORDS",
    "Revenue|NetSales|Sales|OperatingIncome|OrdinaryIncome|CompletedConstruction|Income",
)


def probe_zip(doc_id):
    """提出本文書(type=1)のZIPを覗く。

    CSV(type=5)はTextBlockのHTMLタグを落としてしまい、表のセル区切りが失われる。
    元のHTMLがどこに入っているかを確かめるための道具。
    """
    import zipfile

    r = fetch2.get(f"{fetch2.BASE}/documents/{doc_id}",
                   {"type": 1, "Subscription-Key": fetch2.API_KEY}, 300)
    if r is None:
        print("  ZIPを取得できませんでした")
        return
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    print(f"  ZIP内 {len(names)}ファイル")
    for n in names:
        if n.endswith("/"):
            continue
        print(f"    {z.getinfo(n).file_size:>9,}  {n}")

    target = os.environ.get("FIND", "MajorShareholdersTextBlock")
    for n in names:
        if not (n.endswith(".xbrl") or n.endswith(".htm") or n.endswith(".html")):
            continue
        body = z.read(n).decode("utf-8", "replace")
        i = body.find(target)
        if i < 0:
            continue
        seg = body[i:i + int(os.environ.get("SAMPLE_LEN", "700"))]
        print(f"\n  ★ {target} は {n} にあります")
        print(f"    タグ数(この抜粋内): {seg.count('<')}")
        print(f"    {seg!r}")
        return
    print(f"\n  {target} は見つかりませんでした")


def main():
    codes = [c.strip() for c in os.environ.get("SEC_CODES", "").split(",") if c.strip()]
    if not codes:
        raise SystemExit("SEC_CODES を指定してください。")

    with open(fetch2.INDEX_PATH, encoding="utf-8") as f:
        index = json.load(f)
    picked = fetch2.pick_docs(index, targets=codes)

    pat = re.compile(KEYWORDS, re.I)

    for sec, pair in picked.items():
        doc = pair["本体"]
        print("=" * 70)
        print(f"■ {sec} {doc.get('filerName')}  docID={doc['docID']}")

        if os.environ.get("ZIP") == "1":
            probe_zip(doc["docID"])
            continue

        text = fetch2.download_csv(doc["docID"])
        if text is None:
            print("  CSVを取得できませんでした")
            continue
        rows = list(csv.DictReader(io.StringIO(text), delimiter="\t"))
        print(f"  全{len(rows)}行")

        # RAW=1 なら、コンテキストの絞り込みをせずそのまま出す。
        # 記述部分（所有者別状況・大株主・役員など）は本表とコンテキストの付き方が
        # 違うことがあり、通常モードだと落ちてしまうため。
        if os.environ.get("RAW") == "1":
            hit = 0
            for r in rows:
                eid = r["要素ID"].split(":")[-1]
                if not pat.search(eid):
                    continue
                v = (r["値"] or "").strip()
                if v in fetch2.NULLS:
                    continue
                hit += 1
                n = int(os.environ.get("SAMPLE_LEN", "40"))
                tags = v.count("<")
                print(f"    {eid:<58} ctx={r['コンテキストID']:<34} len={len(v):>6} "
                      f"タグ数={tags:>4} 例={v[:n]!r}")
            print(f"  （該当 {hit} 行）")
            continue

        seen = {}
        for r in rows:
            eid = r["要素ID"].split(":")[-1]
            if not pat.search(eid):
                continue
            off, scope = fetch2.parse_ctx(r["コンテキストID"])
            if off is None:
                continue
            v = (r["値"] or "").strip()
            if v in fetch2.NULLS:
                continue
            seen.setdefault((eid, scope), []).append((off, v[:20]))

        for (eid, scope), vals in sorted(seen.items()):
            years = ",".join(f"-{o}" for o, _ in sorted(vals))
            sample = sorted(vals)[0][1]
            print(f"    {eid:<62} {scope}  年={years}  例={sample}")


if __name__ == "__main__":
    main()
