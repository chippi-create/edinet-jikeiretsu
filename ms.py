#!/usr/bin/env python3
"""
ms.py — MSワラント（行使価額修正条項付新株予約権・MSCB）の届出書を集めて一覧にする

  MS_START=2025-01-01 MS_LIMIT=150 python ms.py

1. EDINETの書類一覧を日ごとに見て、有価証券届出書（030）と訂正届出書（040）を拾う
   （有報の索引 docs_index.json とは別に持つ。索引の上書き事故に巻き込まれないように）
2. 提出本文書のZIPを取り、「行使価額修正条項付」「転換価額の修正」がある届出書だけ読む（ms_parse）
3. 書類ごとに data/ms/{docID}.json、全体を data/ms.json（案件ごと・回号ごと）に書く

一度見た日・一度読んだ書類は data/ms_state.json に記録して飛ばす。直近2日は毎回見直す
（夕方に出た書類が翌日の一覧に入ることがあるため）。
数字はAIに読ませない。拾えなかった項目は空欄で、元の書類へのリンクで確かめる。
"""
import datetime
import json
import os
import re
import time

import fetch2
import sections
import ms_parse

DATA = "data"
DOC_DIR = os.path.join(DATA, "ms")
STATE = os.path.join(DATA, "ms_state.json")
OUT = os.path.join(DATA, "ms.json")
# どこから遡るか。空なら直近7日。
MS_START = os.environ.get("MS_START", "").strip()
MS_LIMIT = int(os.environ.get("MS_LIMIT", "150") or 150)
TYPES = ("030", "040")
# 読み取り（ms_parse）の版。読み方を直したら変える。版が違うMSワラントの書類は取り直して読み直す
# （MSワラントの書類だけなので数は少ない）。
PARSE_VERSION = "2026-10-31d 決議日の書き方を追加、MSCBの転換価額、行使期間の始まりが割当日の型"
MARK = re.compile(r"行使価額修正条項付|転換価額の修正")


def log(*a):
    print(*a, flush=True)


def to_text(html):
    html = re.sub(r"</t[dh]>", " ｜ </td>", html, flags=re.I)
    return sections.text_of(html)


def load_state():
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    return {"days": {}, "docs": {}}


def save_state(st):
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=0, sort_keys=True)


def list_days(st):
    today = datetime.date.today()
    start = datetime.date.fromisoformat(MS_START) if MS_START else today - datetime.timedelta(days=7)
    d, out = start, []
    while d <= today:
        key = d.isoformat()
        if d.weekday() < 5 and (key not in st["days"] or (today - d).days <= 2):
            out.append(d)
        d += datetime.timedelta(days=1)
    return out


def scan(st):
    """日ごとの一覧から、まだ読んでいない届出書・訂正届出書を集める。"""
    found = []
    for d in list_days(st):
        r = fetch2.get(f"{fetch2.BASE}/documents.json",
                       {"date": d.isoformat(), "type": 2, "Subscription-Key": fetch2.API_KEY}, 60)
        if r is None:
            log(f"  {d} 一覧を取れませんでした")
            continue
        n = 0
        for x in r.json().get("results") or []:
            if x.get("docTypeCode") in TYPES and x.get("secCode") and x["docID"] not in st["docs"]:
                found.append(x)
                n += 1
        st["days"][d.isoformat()] = n
    return found


def read_doc(x):
    z = sections.fetch_zip(x["docID"])
    if z is None:
        return None
    names = sorted(n for n in z.namelist() if "/PublicDoc/" in n and n.endswith(".htm"))
    text = "\n\n".join(to_text(z.read(n).decode("utf-8", "replace")) for n in names)
    head = ms_parse.norm(text)
    i = head.find("第一部")
    if i < 0 or not MARK.search(head[i:i + 200000]):
        return False
    deal = ms_parse.parse_deal(text)
    if not any(t["修正条項付"] for t in deal["回号"]) and not deal["ASR"]:
        return False
    meta = {k: x.get(k) for k in ("docID", "docTypeCode", "parentDocID", "secCode", "filerName",
                                   "docDescription", "submitDateTime", "edinetCode")}
    return {"meta": meta, "版": PARSE_VERSION, **deal}


def build(st):
    """書類ごとの記録を案件にまとめる。訂正届出書は元の届出書（parentDocID）にひも付け、
    回号の数字が読めていれば訂正後の値を使う（条件決定日の後に数字が確定する型があるため）。"""
    docs = {}
    for fn in os.listdir(DOC_DIR) if os.path.isdir(DOC_DIR) else []:
        with open(os.path.join(DOC_DIR, fn), encoding="utf-8") as f:
            j = json.load(f)
        docs[j["meta"]["docID"]] = j
    originals = {k: v for k, v in docs.items() if v["meta"]["docTypeCode"] == "030"}
    fixes = {}
    for k, v in docs.items():
        if v["meta"]["docTypeCode"] == "040":
            fixes.setdefault(v["meta"].get("parentDocID") or "", []).append(v)
    deals = []
    for k, o in originals.items():
        fx = sorted(fixes.get(k, []), key=lambda v: v["meta"]["submitDateTime"] or "")
        cur = o
        for v in fx:
            if v.get("回号"):
                cur = {**v, "meta": o["meta"]}
        sec = (o["meta"]["secCode"] or "")[:4]
        deals.append({
            "docID": k, "訂正": [v["meta"]["docID"] for v in fx],
            "提出日": (o["meta"]["submitDateTime"] or "")[:10], "コード": sec,
            "会社名": o["meta"]["filerName"],
            **{key: cur.get(key) for key in ("ASR", "決議日", "割当予定先", "払込金額の総額", "発行諸費用の概算額",
                                            "差引手取概算額", "発行諸費用率", "発行諸費用の内訳", "資金使途", "使途の単位",
                                            "希薄化率", "貸株", "貸株の内容", "複数回号")},
            "回号": cur.get("回号", []),
        })
    # 訂正届出書だけがあり、元の届出書を読めていないもの（期間の外など）も載せる
    seen = set(originals)
    for parent, fx in fixes.items():
        if parent in seen or not fx:
            continue
        v = fx[-1]
        deals.append({
            "docID": v["meta"]["docID"], "訂正": [], "訂正のみ": True,
            "提出日": (v["meta"]["submitDateTime"] or "")[:10], "コード": (v["meta"]["secCode"] or "")[:4],
            "会社名": v["meta"]["filerName"],
            **{key: v.get(key) for key in ("ASR", "決議日", "割当予定先", "払込金額の総額", "発行諸費用の概算額",
                                            "差引手取概算額", "発行諸費用率", "発行諸費用の内訳", "資金使途", "使途の単位",
                                            "希薄化率", "貸株", "貸株の内容", "複数回号")},
            "回号": v.get("回号", []),
        })
    deals.sort(key=lambda d: (d["決議日"] or d["提出日"] or ""), reverse=True)
    gen = time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.gmtime(time.time() + 9 * 3600))
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"generated": gen, "deals": deals}, f, ensure_ascii=False, separators=(",", ":"))
    return len(deals)


def main():
    if not fetch2.API_KEY:
        raise SystemExit("EDINET_API_KEY が設定されていません。")
    os.makedirs(DOC_DIR, exist_ok=True)
    st = load_state()
    found = scan(st)
    # 読み取りの版が古いMSワラントの書類を先に読み直す
    stale = []
    for fn in sorted(os.listdir(DOC_DIR)):
        with open(os.path.join(DOC_DIR, fn), encoding="utf-8") as f:
            j = json.load(f)
        if j.get("版") != PARSE_VERSION and j.get("回号"):
            stale.append(j["meta"])
    if stale:
        log(f"■ MSワラント：読み取りの版が古い書類 {len(stale)}件を読み直す")
    found = stale + found
    log(f"■ MSワラント：未読の届出書・訂正届出書 {len(found)}件（今回 {min(len(found), MS_LIMIT)}件まで）")
    hit = 0
    for x in found[:MS_LIMIT]:
        try:
            j = read_doc(x)
        except Exception as e:  # 1件の読み取りの失敗で全体を止めない
            log(f"  {x['docID']} {x.get('filerName')}: 読み取りに失敗（{e}）")
            st["docs"][x["docID"]] = "fail"
            continue
        if j is None:
            log(f"  {x['docID']} {x.get('filerName')}: ZIPを取得できませんでした")
            continue
        if j is False:
            # 訂正届出書は訂正箇所だけのことが多く、読めなくても元の届出書がMSワラントならひも付けて残す
            if x.get("docTypeCode") == "040" and st["docs"].get(x.get("parentDocID") or "") == "ms":
                j = {"meta": {k: x.get(k) for k in ("docID", "docTypeCode", "parentDocID", "secCode", "filerName",
                                                     "docDescription", "submitDateTime", "edinetCode")}, "回号": []}
            else:
                st["docs"][x["docID"]] = "no"
                # 読み直した結果MSワラントでなかったものは、前の記録を消す
                old = os.path.join(DOC_DIR, f"{x['docID']}.json")
                if os.path.exists(old):
                    os.remove(old)
                continue
        with open(os.path.join(DOC_DIR, f"{x['docID']}.json"), "w", encoding="utf-8") as f:
            json.dump(j, f, ensure_ascii=False, separators=(",", ":"))
        st["docs"][x["docID"]] = "ms"
        hit += 1
        ms_tr = [t for t in j["回号"] if t["修正条項付"]]
        log(f"  {x['docID']} {x.get('secCode')} {x.get('filerName')} {x.get('docDescription')}: "
            f"回号{[t['回号'] for t in ms_tr]} 当初{[t['当初行使価額'] for t in ms_tr]} "
            f"下限{[t['下限行使価額'] for t in ms_tr]} 希薄化{j['希薄化率']}%")
    # 上限で読み残した日は、次回また一覧から拾えるように「見た日」から外す
    if len(found) > MS_LIMIT:
        rest = {x["submitDateTime"][:10] for x in found[MS_LIMIT:] if x.get("submitDateTime")}
        for d in rest:
            st["days"].pop(d, None)
    save_state(st)
    n = build(st)
    log(f"■ MSワラント：今回 {hit}件を追加 / 一覧 {n}件")


if __name__ == "__main__":
    main()
