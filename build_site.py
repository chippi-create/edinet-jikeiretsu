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
import re
import csv
import json
import datetime
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
TS_PATH = os.path.join(HERE, "data", "timeseries.csv")
SITE = os.path.join(HERE, "site")
TPL_PATH = os.path.join(HERE, "template.html")

# 記述部分。財務とは別のファイルに分けて、タブを開いたときだけ読み込む。
# 一緒にすると会社を選んだ時点の読み込みが重くなる。
SECTION_FILES = {
    "biz": (os.path.join(HERE, "data", "business.csv"), ["本文"]),
    "div": (os.path.join(HERE, "data", "dividend.csv"), ["本文"]),
    "web": (os.path.join(HERE, "data", "websites.csv"), ["ホスト", "出現回数"]),
    "seg": (os.path.join(HERE, "data", "segments.csv"),
            ["セグメント", "外部顧客への売上高", "セグメント利益", "単位"]),
    "own": (os.path.join(HERE, "data", "ownership.csv"),
            ["区分", "株主数", "所有株式数_単元", "割合"]),
    "sh": (os.path.join(HERE, "data", "shareholders.csv"),
           ["順位", "氏名又は名称", "住所", "所有株式数", "単位", "割合"]),
    "of": (os.path.join(HERE, "data", "officers.csv"),
           ["役職名", "氏名", "生年月日", "任期", "所有株式数", "単位"]),
}

# 表示の単位。EDINETの値は円・実数なので、そのまま出すと読めない。
UNITS = {
    "売上高": "億", "営業利益": "億", "経常利益": "億", "純利益": "億",
    "総資産": "億", "純資産": "億", "営業CF": "億",
    "自己資本比率": "%", "ROE": "%", "EPS": "円", "従業員数": "人",
}
ORDER = ["売上高", "営業利益", "経常利益", "純利益", "営業CF",
         "総資産", "純資産", "自己資本比率", "ROE", "EPS", "従業員数"]

# 表には出さないが、配信はする項目。希薄化率や調達額の試算に使う。
# 帯のJSONに "x" として入れる。画面の表はORDERだけで作る。
EXTRA = ["発行済株式数", "議決権の個数", "自己株式数", "単体_発行済株式総数",
         "BPS", "1株当たり配当", "株価収益率",
         "現金及び現金同等物", "設備投資", "研究開発費",
         "短期借入金", "長期借入金", "1年内返済長期借入金", "社債",
         "コマーシャルペーパー",
         # 資金繰りの分析に使う
         "投資CF", "財務CF", "売上原価", "減価償却費", "支払利息",
         "受取手形", "売掛金", "受取手形及び売掛金", "契約資産", "電子記録債権",
         "売上債権IFRS",
         "商品及び製品", "仕掛品", "原材料及び貯蔵品", "棚卸資産",
         "支払手形", "買掛金", "支払手形及び買掛金", "電子記録債務",
         "仕入債務IFRS"]

# 日本基準の「主要な経営指標等の推移」に営業利益の欄がないため、
# 損益計算書本体から補っている。本表は当期・前期しかないので2年分になる。
NOTE_2Y = {"営業利益", "売上高"}


# 会社のサイトではないと分かっているドメイン。
#
# 会社のサイトは有報の本文に出てくるURLから推定しているが、
# 自社のURLを書いていない会社では、本文中の他のURLを拾ってしまう。
# 実例：ノイルイミューン・バイオテック(4893)は、論文のプレプリントサーバー
# biorxiv.org が1回だけ出てきて、それが会社のサイトとして記録されていた。
#
# ドメイン単位の完全一致で見る。部分一致にすると
# 「group.com」が「oup.com」に、朝日工業社が「asahi」に当たってしまう。
#
# なお、この一覧に当たっても消さない。アイティメディア(2148)やnote(5243)の
# ように、その会社自身がそのドメインの持ち主であることがある。
# 印を付けて、使う側に確かめてもらう。
NOT_COMPANY = {
    # 論文・学術
    "biorxiv.org", "medrxiv.org", "arxiv.org", "nih.gov", "nature.com",
    "science.org", "springer.com", "springernature.com", "sciencedirect.com",
    "elsevier.com", "wiley.com", "researchgate.net", "mdpi.com",
    "frontiersin.org", "plos.org", "oup.com", "jst.go.jp",
    # 広報配信・報道
    "prtimes.jp", "atpress.ne.jp", "kyodonews.jp", "nikkei.com", "asahi.com",
    "yomiuri.co.jp", "mainichi.jp", "sankei.com", "toyokeizai.net",
    "bloomberg.com", "reuters.com", "forbes.com", "itmedia.co.jp", "impress.co.jp",
    # 市場・開示インフラ
    "jpx.co.jp", "tse.or.jp", "xj-storage.jp", "eir-parts.net", "pronexus.co.jp",
    "net-ir.ne.jp", "jasdec.com", "jsda.or.jp", "irbank.net", "kabutan.jp",
    "minkabu.jp", "morningstar.co.jp", "quick.co.jp", "takara-dds.co.jp",
    "nikkei4946.com",
    # 国際機関・枠組み
    "un.org", "unfccc.int", "fsb-tcfd.org", "globalreporting.org", "cdp.net",
    "iso.org", "sasb.org", "unglobalcompact.org", "sbti.org",
    # 一般サービス
    "wikipedia.org", "wikimedia.org", "github.com", "gitlab.com", "adobe.com",
    "apple.com", "amazon.com", "amazonaws.com", "microsoft.com", "cloudflare.com",
    "facebook.com", "instagram.com", "linkedin.com", "note.com", "ameblo.jp",
    "hatena.ne.jp", "qiita.com",
}


def not_company(host):
    p = host.lower().split(".")
    if len(p) >= 3 and p[-2] in ("co", "or", "ne", "go", "ac", "lg") and p[-1] == "jp":
        base = ".".join(p[-3:])
    else:
        base = ".".join(p[-2:])
    return base in NOT_COMPANY


def bucket_of(sec):
    return sec[:2]


def norm_category(s):
    """所有者別状況の区分名をそろえる。

    有報の表記は会社ごとに揺れる。「単元未満株式の状況」は全角括弧・半角括弧・
    括弧なしの4通り、「政府及び」と「政府および」、末尾の（注）の有無もある。
    中身は同じなので、表示と集計のためにここで寄せる。
    CSVは原典どおりのまま残す。
    """
    s = (s or "").strip()
    s = re.sub(r"\s*[（(][^（()）]*[)）]\s*$", "", s)   # 末尾の（株）（注）などを落とす
    s = s.replace("および", "及び")
    return s.strip()


def load_sections():
    """記述部分のCSVを会社ごとに読む。まだ取得していない会社は入らない。"""
    out = defaultdict(dict)
    kijun = {}
    # どの書類から取ったかを持たせて、EDINETの原本へリンクできるようにする。
    # 事業系統図のように画像で載っている部分は本サイトに出せないため。
    docs = {}
    sp = os.path.join(HERE, "data", "sections_state.json")
    if os.path.exists(sp):
        with open(sp, encoding="utf-8") as f:
            docs = {k: v.get("docID", "") for k, v in json.load(f).items()}
    for key, (path, cols) in SECTION_FILES.items():
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                sec = r["証券コード"]
                vals = [r.get(c, "") for c in cols]
                if key == "own":
                    vals[0] = norm_category(vals[0])
                if key == "web":
                    # 会社のサイトかどうかの確からしさを添える。
                    vals.append("?" if not_company(vals[0]) else "")
                out[sec].setdefault(key, []).append(vals)
                if r.get("基準日"):
                    kijun.setdefault(sec, {})[key] = r["基準日"]
    for sec in out:
        out[sec]["k"] = kijun.get(sec, {})
        if docs.get(sec):
            out[sec]["d"] = docs[sec]
    return out


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
            "x": {m: data[sec][m] for m in EXTRA if m in data[sec]},
            "c": {m: v for m, v in corr[sec].items() if v},
        }
    for b, obj in buckets.items():
        with open(os.path.join(SITE, "d", f"{b}.json"), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))

    # 提案書ドラフトのページ。中身は静的なファイルなので、そのまま置くだけ。
    # 帯のJSONと /api/draft を同じサイトから呼ぶので、別ドメインにしない。
    src_teian = os.path.join(HERE, "teian")
    if os.path.isdir(src_teian):
        dst_teian = os.path.join(SITE, "teian")
        os.makedirs(dst_teian, exist_ok=True)
        n = 0
        for fn in sorted(os.listdir(src_teian)):
            if not fn.endswith((".html", ".js")):
                continue
            with open(os.path.join(src_teian, fn), encoding="utf-8") as f:
                body = f.read()
            with open(os.path.join(dst_teian, fn), "w", encoding="utf-8") as f:
                f.write(body)
            n += 1
        print(f"提案書ドラフト: {n}ファイル -> site/teian/", flush=True)

    # 事業等のリスクは1社2万字ほどある。帯のJSONに混ぜると開いた瞬間に重くなるので、
    # 会社ごとのファイルにして、リスクのタブを見るときだけ取りに行く。
    def copy_per_company(src_name, dst_name, ext):
        src = os.path.join(HERE, "data", src_name)
        dst = os.path.join(SITE, dst_name)
        got = set()
        if not os.path.isdir(src):
            return got
        os.makedirs(dst, exist_ok=True)
        for fn in os.listdir(src):
            if not fn.endswith(ext):
                continue
            with open(os.path.join(src, fn), encoding="utf-8") as f:
                body = f.read()
            if not body.strip():
                continue
            with open(os.path.join(dst, fn), "w", encoding="utf-8") as f:
                f.write(body)
            got.add(fn[:-len(ext)])
        return got

    has_risk = copy_per_company("risks", "risk", ".txt")
    # 役員の略歴も同じ扱い。役員のタブを開いたときだけ取りに行く。
    has_bio = copy_per_company("bios", "bio", ".json")
    # 要約を作るときだけ読む材料。サイトの表示には使わない。
    copy_per_company("context", "context", ".json")

    # 記述部分は別ファイル。タブを開いたときだけ取りに行く。
    os.makedirs(os.path.join(SITE, "s"), exist_ok=True)
    secs = load_sections()
    sbuckets = defaultdict(dict)
    for sec in set(secs) | has_risk | has_bio:
        if sec not in companies:
            continue
        obj = secs.get(sec, {})
        if sec in has_risk:
            obj["r"] = 1
        if sec in has_bio:
            obj["b"] = 1
        sbuckets[bucket_of(sec)][sec] = obj
    for b, obj in sbuckets.items():
        with open(os.path.join(SITE, "s", f"{b}.json"), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    have_sections = sorted(sbuckets)

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
    html = html.replace("__SECBUCKETS__", json.dumps(have_sections, separators=(",", ":")))

    with open(prev_idx, "w", encoding="utf-8") as f:
        f.write(html)

    size = len(html) // 1024
    print(f"site/index.html を書き出しました（{len(companies)}社 / {size}KB / 生成 {generated}）")
    print(f"site/d/ に {len(buckets)}個のJSON")
    print(f"site/s/ に {len(sbuckets)}個のJSON（記述部分あり {len(secs)}社）")
    print(f"site/risk/ に {len(has_risk)}社ぶんのリスク本文")
    print(f"site/bio/ に {len(has_bio)}社ぶんの役員略歴")


if __name__ == "__main__":
    main()
