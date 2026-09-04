#!/usr/bin/env python3
"""
build_site.py — data/timeseries.csv からサイトを組み立てる

  python build_site.py

3,768社ぶんを1ページに埋め込むと重すぎるので、
  site/index.html          会社の索引（コード・社名・決算期）だけを埋め込む
  site/d/<コード上2桁>.json 指標の中身。会社を選んだときだけ読み込む
に分ける。
"""

import os
import csv
import json
import datetime
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
TS_PATH = os.path.join(HERE, "data", "timeseries.csv")
SITE = os.path.join(HERE, "site")
TPL_PATH = os.path.join(HERE, "template.html")

# 表示の単位。EDINETの値は円・実数なので、そのまま出すと読めない。
UNITS = {
    "売上高": "億", "営業利益": "億", "経常利益": "億", "純利益": "億",
    "総資産": "億", "純資産": "億", "営業CF": "億",
    "自己資本比率": "%", "ROE": "%", "EPS": "円", "従業員数": "人",
}
ORDER = ["売上高", "営業利益", "経常利益", "純利益", "営業CF",
         "総資産", "純資産", "自己資本比率", "ROE", "EPS", "従業員数"]

# 日本基準の「主要な経営指標等の推移」に営業利益の欄がないため、
# 損益計算書本体から補っている。本表は当期・前期しかないので2年分になる。
NOTE_2Y = {"営業利益", "売上高"}


def bucket_of(sec):
    return sec[:2]


def main():
    if not os.path.exists(TS_PATH):
        raise SystemExit("data/timeseries.csv がありません。先に fetch2.py を実行してください。")

    companies = {}
    data = defaultdict(lambda: defaultdict(dict))
    corr = defaultdict(lambda: defaultdict(list))

    with open(TS_PATH, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            sec = r["証券コード"]
            companies[sec] = {"n": r["会社名"], "k": r["会計基準"], "e": r["決算期"]}
            data[sec][r["指標"]][r["年度"]] = r["値"]
            if r["本体か訂正か"] == "訂正":
                corr[sec][r["指標"]].append(r["年度"])

    if not companies:
        raise SystemExit("データが空です。index.html は更新しません。")

    # 前回より会社数が大きく減っていたら、取得が壊れた疑いがあるので書き換えない。
    prev_idx = os.path.join(SITE, "index.html")
    if os.path.exists(prev_idx):
        with open(prev_idx, encoding="utf-8") as f:
            head = f.read(4000)
        marker = '"companyCount":'
        if marker in head:
            n = int(head.split(marker, 1)[1].split(",", 1)[0].strip())
            if len(companies) < n * 0.8:
                raise SystemExit(
                    f"会社数が急減しました（前回 {n}社 → 今回 {len(companies)}社）。"
                    "サイトは更新しません。")

    os.makedirs(os.path.join(SITE, "d"), exist_ok=True)

    # 帯ごとに中身を書き出す
    buckets = defaultdict(dict)
    for sec in companies:
        buckets[bucket_of(sec)][sec] = {
            "n": companies[sec]["n"], "k": companies[sec]["k"], "e": companies[sec]["e"],
            "d": {m: data[sec][m] for m in ORDER if m in data[sec]},
            "c": {m: v for m, v in corr[sec].items() if v},
        }
    for b, obj in buckets.items():
        with open(os.path.join(SITE, "d", f"{b}.json"), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))

    # 索引はコード順。検索と一覧はこれだけで動く。
    index = [[sec, companies[sec]["n"], companies[sec]["e"], companies[sec]["k"]]
             for sec in sorted(companies)]

    jst = datetime.timezone(datetime.timedelta(hours=9))
    generated = datetime.datetime.now(jst).strftime("%Y-%m-%dT%H:%M:%S+09:00")

    with open(TPL_PATH, encoding="utf-8") as f:
        html = f.read()
    html = html.replace("__GENERATED__", generated)
    html = html.replace("__COUNT__", str(len(companies)))
    html = html.replace("__UNITS__", json.dumps(UNITS, ensure_ascii=False))
    html = html.replace("__ORDER__", json.dumps(ORDER, ensure_ascii=False))
    html = html.replace("__NOTE2Y__", json.dumps(sorted(NOTE_2Y), ensure_ascii=False))
    html = html.replace("__INDEX__", json.dumps(index, ensure_ascii=False, separators=(",", ":")))

    with open(prev_idx, "w", encoding="utf-8") as f:
        f.write(html)

    size = len(html) // 1024
    print(f"site/index.html を書き出しました（{len(companies)}社 / {size}KB / 生成 {generated}）")
    print(f"site/d/ に {len(buckets)}個のJSON")


if __name__ == "__main__":
    main()
