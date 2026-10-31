#!/usr/bin/env python3
"""
ms_probe.py — MSワラント（行使価額修正条項付新株予約権）の有価証券届出書を探して、本文を書き出す

  START=2026-08-01 END=2026-10-31 MAX=8 python ms_probe.py

一覧表を作る前に、届出書の中で各項目（行使価額の修正・下限・行使期間・発行諸費用など）が
どう書かれているかを目で見るための道具。本番の取得には関わらない。
書き出し先は out/ms/{docID}.txt（表のセルは「｜」で区切る）。
"""
import datetime
import os
import re

import fetch2
import sections

START = os.environ.get("START", "2026-09-01")
END = os.environ.get("END", "2026-10-31")
MAX = int(os.environ.get("MAX", "8"))
OUT = os.path.join("out", "ms")
# 届出書（030）と訂正届出書（040）。臨時報告書（180）も見ておく。
TYPES = {"030", "040", "180"}
MARK = re.compile(r"行使価額修正条項付")


def to_text(html):
    html = re.sub(r"</t[dh]>", " ｜ </td>", html, flags=re.I)
    return sections.text_of(html)


def main():
    os.makedirs(OUT, exist_ok=True)
    d = datetime.date.fromisoformat(START)
    end = datetime.date.fromisoformat(END)
    docs = []
    while d <= end:
        if d.weekday() < 5:
            r = fetch2.get(f"{fetch2.BASE}/documents.json",
                           {"date": d.isoformat(), "type": 2, "Subscription-Key": fetch2.API_KEY}, 60)
            for x in (r.json().get("results") or []) if r else []:
                if x.get("docTypeCode") in TYPES and x.get("secCode"):
                    docs.append(x)
        d += datetime.timedelta(days=1)
    print(f"■ 届出書・訂正・臨時報告書 {len(docs)}件（{START}〜{END}）", flush=True)
    hits = 0
    for x in docs:
        if hits >= MAX:
            break
        z = sections.fetch_zip(x["docID"])
        if z is None:
            continue
        names = sorted(n for n in z.namelist() if "/PublicDoc/" in n and n.endswith(".htm"))
        bodies = [z.read(n).decode("utf-8", "replace") for n in names]
        if not any(MARK.search(b) for b in bodies):
            continue
        hits += 1
        text = "\n\n".join(f"##### {n}\n" + to_text(b) for n, b in zip(names, bodies))
        head = f"{x['docID']} {x['docTypeCode']} {x.get('secCode')} {x.get('filerName')} {x.get('docDescription')} {x.get('submitDateTime')}"
        with open(os.path.join(OUT, f"{x['docID']}.txt"), "w", encoding="utf-8") as f:
            f.write(head + "\n\n" + text)
        print(f"  {head} / {len(text):,}字", flush=True)
    print(f"■ 該当 {hits}件", flush=True)


if __name__ == "__main__":
    main()
