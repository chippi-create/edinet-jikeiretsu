#!/usr/bin/env python3
"""
merge_index.py — 索引（docs_index.json）を、上書きではなく足し合わせる

  python merge_index.py 今回作った索引 リモートの索引

結果はリモートの索引のファイルに書く。書類（docs）と取得済みの日（days）の和をとる。
同じ書類・同じ日は今回作った方を採る。

以前は日次の実行が、自分が起動したときの索引をそのまま上書きしていた。そのため、同じ時間帯に
索引だけを遡る実行（edinet-index）が足した分（過去の有報・半期報告書）が消えた（2026-10-04）。
索引は足していくだけのものなので、和をとれば消えることはない。
"""
import json
import sys


def main(mine, remote):
    with open(mine, encoding="utf-8") as f:
        a = json.load(f)
    try:
        with open(remote, encoding="utf-8") as f:
            b = json.load(f)
    except FileNotFoundError:
        b = {"docs": {}, "days": {}}
    docs = {**b.get("docs", {}), **a.get("docs", {})}
    days = {**b.get("days", {}), **a.get("days", {})}
    out = {**b, **a, "docs": docs, "days": days}
    with open(remote, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"索引を足し合わせました: 書類 {len(docs)}件 / {len(days)}日")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
