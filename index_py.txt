"""
EDINET 書類索引づくり
・平日だけを巡回する（土日は必ず0件）
・一度取得した日は二度と叩かない（docs_index.json に記録）
・有価証券報告書(120)と訂正有価証券報告書(130)だけを貯める
実行するたびに索引が育つ。企業の選択はこの索引を引くだけで済むようになる。
"""

import os
import sys
import json
import time
import datetime

import requests

BASE = "https://api.edinet-fsa.go.jp/api/v2"
API_KEY = os.environ.get("EDINET_API_KEY", "")
START = os.environ.get("START", "2026-06-01").strip()
END = os.environ.get("END", "2026-06-30").strip()
# 1回の実行で叩く日数の上限（GitHub Actionsの実行時間を使いすぎないため）
MAX_DAYS = int(os.environ.get("MAX_DAYS", "260"))

SLEEP = 4
RETRY = 3
INDEX_PATH = "docs_index.json"
KEEP_TYPES = ("120", "130")

FIELDS = ("docID", "edinetCode", "secCode", "filerName", "docDescription",
          "docTypeCode", "periodStart", "periodEnd", "submitDateTime",
          "csvFlag", "xbrlFlag")


def log(*a):
    print(*a, flush=True)


def load_index():
    if os.path.exists(INDEX_PATH):
        with open(INDEX_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {"days": {}, "docs": {}}


def save_index(idx):
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def get(url, params, timeout):
    last = None
    for i in range(RETRY):
        try:
            r = requests.get(url, params=params, timeout=timeout)
            time.sleep(SLEEP)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
        except Exception as e:
            last = str(e)
            time.sleep(SLEEP)
        if i < RETRY - 1:
            log(f"      再試行 {i + 1}/{RETRY - 1}（{last}）")
    return None


def main():
    if not API_KEY:
        log("EDINET_API_KEY が設定されていません。")
        sys.exit(1)

    idx = load_index()
    done = idx["days"]
    docs = idx["docs"]

    log(f"■ 索引の現状: 取得済み {len(done)}日 / 有報 {len(docs)}件")
    log(f"■ 今回の範囲: {START} 〜 {END}（1回の上限 {MAX_DAYS}日）")

    d = datetime.date.fromisoformat(START)
    end = datetime.date.fromisoformat(END)

    targets = []
    skipped_weekend = 0
    skipped_done = 0
    while d <= end:
        key = d.isoformat()
        if d.weekday() >= 5:          # 土日
            skipped_weekend += 1
        elif key in done:             # 取得済み
            skipped_done += 1
        else:
            targets.append(d)
        d += datetime.timedelta(days=1)

    log(f"■ 土日で除外 {skipped_weekend}日 / 取得済みで除外 {skipped_done}日"
        f" / これから叩く {len(targets)}日")

    if len(targets) > MAX_DAYS:
        log(f"  上限を超えるため先頭 {MAX_DAYS}日だけ処理します（続きは再実行で）")
        targets = targets[:MAX_DAYS]

    if not targets:
        log("■ 新しく調べる日はありません")
        return

    est = len(targets) * SLEEP / 60
    log(f"■ 見込み時間: 約{est:.0f}分")
    log("")

    added = 0
    failed = []

    for d in targets:
        key = d.isoformat()
        r = get(f"{BASE}/documents.json",
                {"date": key, "type": 2, "Subscription-Key": API_KEY}, 60)
        if r is None:
            log(f"  {key} 取得できませんでした（この日は未取得のまま残します）")
            failed.append(key)
            continue

        results = r.json().get("results") or []
        n = 0
        for doc in results:
            if doc.get("docTypeCode") not in KEEP_TYPES:
                continue
            did = doc.get("docID")
            if not did:
                continue
            rec = {k: doc.get(k) for k in FIELDS}
            rec["fileDate"] = key
            docs[did] = rec
            n += 1

        done[key] = {"全件": len(results), "有報": n}
        added += n
        log(f"  {key} 全{len(results):>5}件 / 有報{n:>4}件")

        # 途中で落ちても失わないよう、こまめに書き出す
        if len(done) % 20 == 0:
            save_index(idx)

    save_index(idx)

    log("")
    log(f"■ 完了: 今回 {added}件を追加 / 索引は合計 {len(docs)}件・{len(done)}日ぶん")
    if failed:
        log(f"■ 取得できなかった日（次回の実行で再挑戦します）: {failed}")

    # 索引の中身を軽く要約
    secs = {v.get("secCode", "")[:4] for v in docs.values() if v.get("secCode")}
    log(f"■ 索引に入っている会社（証券コード）: {len(secs)}社")


if __name__ == "__main__":
    main()
