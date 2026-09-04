#!/usr/bin/env python3
"""
fetch_sections.py — 所有者別状況・大株主の状況・役員の状況を集める

  LIMIT=300 python fetch_sections.py

提出本文書(type=1)のZIPからHTMLの表を取り出して、3つのCSVに貯める。
fetch2.py と同じく、索引の書類構成が変わった会社だけを取り直す。

これらは「その時点の断面」しか有報に載らないので、財務指標のように
1回で5年分は取れない。毎年の有報を積み上げることで時系列になる。
"""

import os
import csv
import re
import sys
import json
import time

import fetch2
import sections

DATA_DIR = "data"
STATE_PATH = os.path.join(DATA_DIR, "sections_state.json")
LIMIT = int(os.environ.get("LIMIT", "300"))

OWNERSHIP = os.path.join(DATA_DIR, "ownership.csv")
SHAREHOLDERS = os.path.join(DATA_DIR, "shareholders.csv")
OFFICERS = os.path.join(DATA_DIR, "officers.csv")

F_OWN = ["証券コード", "会社名", "基準日", "区分", "株主数", "所有株式数_単元", "割合"]
F_SH = ["証券コード", "会社名", "基準日", "順位", "氏名又は名称", "住所", "所有株式数", "単位", "割合"]
F_OF = ["証券コード", "会社名", "基準日", "役職名", "氏名", "生年月日", "任期", "所有株式数", "単位"]

# 略歴はCSVに入れない。1人あたり数百字あり、3,800社ぶんでは巨大になって
# 毎日の書き換えでGit履歴が膨らむため。必要になったら別ファイルにする。


def log(*a):
    print(*a, flush=True)


def clean(s):
    return (s or "").replace(" ", "").replace("―", "").replace("－", "").strip()


def unit_of(text):
    """見出しから単位を読む。会社によって千株だったり株だったりする。

    決め打ちにすると桁が1000倍ずれる。極洋の役員欄は「株」、大株主欄は「千株」だった。
    """
    m = re.search(r"[（(]\s*(千株|百株|株)\s*[)）]", text or "")
    return m.group(1) if m else ""


def num(s):
    """表示用の数字をそのまま残す。単位や桁区切りは加工しない。"""
    s = (s or "").strip()
    return "" if s in ("―", "－", "-", "") else s


def col_labels(head_rows):
    """見出しが複数行あるので、下2行を突き合わせて列名を作る。

    「外国法人等」と「個人以外／個人」のように、上下で意味が分かれている。
    """
    if not head_rows:
        return []
    last = head_rows[-1]
    prev = head_rows[-2] if len(head_rows) >= 2 else last
    # 見出しは元のHTMLで改行されており、そのままだと「金融商品 取引業者」のように
    # 語中に空白が残る。区切りは上下の段をつなぐときだけに使う。
    nos = lambda s: re.sub(r"\s+", "", s or "")
    out = []
    for j, name in enumerate(last):
        a, b = nos(prev[j] if j < len(prev) else ""), nos(name)
        out.append(b if a == b or not a else f"{a} {b}")
    return out


def parse_ownership(tabs):
    """所有者別状況。行が指標、列が区分という形で載っている。"""
    for t in tabs:
        head, data = [], []
        for row in t:
            if row and clean(row[0]).startswith(("株主数", "所有株式数")):
                data.append(row)
            elif not data:
                head.append(row)
        if not data:
            continue
        labels = col_labels(head)
        got = {}
        for row in data:
            raw = clean(row[0])
            # 見出しには単位が付く（株主数(人) / 所有株式数(単元) / 所有株式数の割合(％)）
            if raw.startswith("所有株式数の割合"):
                key = "割合"
            elif raw.startswith("所有株式数"):
                key = "単元"
            elif raw.startswith("株主数"):
                key = "株主数"
            else:
                continue
            for j in range(1, min(len(row), len(labels))):
                got.setdefault(labels[j], {})[key] = num(row[j])
        if got:
            return got
    return {}


def parse_shareholders(tabs):
    """大株主の状況。大量保有報告書を引いた参考表は除く。"""
    for t in tabs:
        if not t:
            continue
        head = " ".join(t[0])
        if "氏名又は名称" not in head or "所有株式数" not in head:
            continue
        if "保有株券等" in head:      # 大量保有報告書ベースの参考表
            continue
        unit = unit_of(t[0][2] if len(t[0]) > 2 else "")
        out, rank = [], 0
        for row in t[1:]:
            if len(row) < 4:
                continue
            name = row[0].strip()
            if not name or clean(name) in ("計", "合計"):
                continue
            rank += 1
            out.append({"順位": rank, "氏名又は名称": name, "住所": row[1].strip(),
                        "所有株式数": num(row[2]), "単位": unit, "割合": num(row[3])})
        if out:
            return out
    return []


def parse_officers(tabs):
    """役員の状況。1つの一覧が複数の表に分かれていることがあるのでつなぐ。"""
    out = []
    for t in tabs:
        if not t:
            continue
        head = [clean(c) for c in t[0]]
        joined = " ".join(head)
        if "氏名" not in joined or "役職名" not in joined:
            continue
        idx = {}
        for j, name in enumerate(head):
            for key in ("役職名", "氏名", "生年月日", "任期", "所有株式数"):
                if key in name and key not in idx:
                    idx[key] = j
        if "氏名" not in idx:
            continue
        unit = unit_of(head[idx["所有株式数"]] if "所有株式数" in idx else "")
        for row in t[1:]:
            get = lambda k: row[idx[k]].strip() if k in idx and idx[k] < len(row) else ""
            name = get("氏名")
            if not name or clean(name) in ("計", "合計"):
                continue
            out.append({"役職名": get("役職名"), "氏名": name,
                        "生年月日": get("生年月日"), "任期": get("任期"),
                        "所有株式数": num(get("所有株式数")), "単位": unit})
    return out


def load_rows(path, key="証券コード"):
    rows = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                rows.setdefault(r[key], []).append(r)
    return rows


def save_rows(path, fields, rows):
    flat = []
    for sec in sorted(rows):
        flat.extend(rows[sec])
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(flat)
    return len(flat)


def main():
    if not fetch2.API_KEY:
        raise SystemExit("EDINET_API_KEY が設定されていません。")
    os.makedirs(DATA_DIR, exist_ok=True)

    with open(fetch2.INDEX_PATH, encoding="utf-8") as f:
        index = json.load(f)

    state = json.load(open(STATE_PATH, encoding="utf-8")) if os.path.exists(STATE_PATH) else {}
    own = load_rows(OWNERSHIP)
    sh = load_rows(SHAREHOLDERS)
    of = load_rows(OFFICERS)
    log(f"■ 蓄積の現状: 所有者別 {len(own)}社 / 大株主 {len(sh)}社 / 役員 {len(of)}社")

    picked = fetch2.pick_docs(index, quiet=True)
    pending = [s for s in sorted(picked)
               if state.get(s, {}).get("docID") != picked[s]["本体"]["docID"]]
    log(f"■ 索引 {len(picked)}社 / 未取得または更新あり {len(pending)}社")
    if not pending:
        log("■ すべて最新です。")
        return
    todo = pending[:LIMIT]
    log(f"■ 今回の対象: {len(todo)}社（上限 {LIMIT}社）")

    done, failed = 0, []
    for sec in todo:
        doc = picked[sec]["本体"]
        name = doc.get("filerName") or ""
        kijun = (doc.get("periodEnd") or "")[:10]
        z = sections.fetch_zip(doc["docID"])
        if z is None:
            log(f"  {sec} {name}: ZIPを取得できませんでした")
            failed.append(sec)
            continue
        blocks = sections.sections_of(z)

        o = parse_ownership(sections.tables_of(
            blocks.get("ShareholdingByShareholderCategoryTextBlock", "")))
        own[sec] = [{"証券コード": sec, "会社名": name, "基準日": kijun, "区分": k,
                     "株主数": v.get("株主数", ""),
                     "所有株式数_単元": v.get("単元", ""),
                     "割合": v.get("割合", "")} for k, v in o.items()]

        s = parse_shareholders(sections.tables_of(
            blocks.get("MajorShareholdersTextBlock", "")))
        sh[sec] = [dict(r, 証券コード=sec, 会社名=name, 基準日=kijun) for r in s]

        f = parse_officers(sections.tables_of(
            blocks.get("InformationAboutOfficersTextBlock", "")))
        of[sec] = [dict(r, 証券コード=sec, 会社名=name,
                        基準日=(doc.get("submitDateTime") or "")[:10]) for r in f]

        log(f"  {sec} {name}: 所有者別{len(own[sec])}区分 / 大株主{len(sh[sec])}名 / 役員{len(of[sec])}名")
        done += 1
        if done % 25 == 0:
            save_all(own, sh, of, state)
            log(f"   （途中保存：{done}社）")

        state[sec] = {"docID": doc["docID"],
                      "取得日時": time.strftime("%Y-%m-%dT%H:%M:%S+09:00",
                                             time.gmtime(time.time() + 9 * 3600))}

    n = save_all(own, sh, of, state)
    log("")
    log(f"■ 今回の取得: {done}社")
    log(f"■ 蓄積の合計: 所有者別 {n[0]}行 / 大株主 {n[1]}行 / 役員 {n[2]}行")
    remain = len(pending) - done
    if remain > 0:
        log(f"■ 残り {remain}社。次回の実行で続きから取得します。")
    if failed:
        log(f"■ 取得できなかった会社: {failed}")


def save_all(own, sh, of, state):
    a = save_rows(OWNERSHIP, F_OWN, own)
    b = save_rows(SHAREHOLDERS, F_SH, sh)
    c = save_rows(OFFICERS, F_OF, of)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1, sort_keys=True)
    return a, b, c


if __name__ == "__main__":
    main()
