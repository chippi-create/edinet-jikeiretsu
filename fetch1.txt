"""
EDINET 動作確認スクリプト（1社ぶん）
指定した期間の書類一覧から、指定した証券コードの有価証券報告書を探し、
XBRL→CSV（type=5）をダウンロードして中身を確認する。
"""

import os
import io
import csv
import sys
import time
import zipfile
import datetime

import requests

BASE = "https://api.edinet-fsa.go.jp/api/v2"
API_KEY = os.environ.get("EDINET_API_KEY", "")
SEC_CODE = os.environ.get("SEC_CODE", "7203").strip()
START = os.environ.get("START", "2026-06-15").strip()
END = os.environ.get("END", "2026-07-10").strip()

# EDINETは連続で叩くと切断されるので必ず間隔を空ける
SLEEP = 4

OUT_DIR = "out"

# 有価証券報告書
DOC_TYPE_YUHO = "120"

# 画面に出したい項目のキーワード（項目名に含まれていたら表示）
KEYWORDS = [
    "売上", "営業利益", "経常利益", "純利益", "純損失",
    "総資産", "純資産", "自己資本", "従業員", "平均年間給与",
    "営業活動によるキャッシュ", "1株当たり",
]


def log(*args):
    print(*args, flush=True)


def daterange(start_str, end_str):
    d = datetime.date.fromisoformat(start_str)
    end = datetime.date.fromisoformat(end_str)
    while d <= end:
        yield d
        d += datetime.timedelta(days=1)


def find_document():
    """期間内の書類一覧を1日ずつ見て、対象企業の有報を探す"""
    log(f"■ {SEC_CODE} の有価証券報告書を {START} 〜 {END} の範囲で探します")
    for d in daterange(START, END):
        try:
            r = requests.get(
                f"{BASE}/documents.json",
                params={"date": d.isoformat(), "type": 2, "Subscription-Key": API_KEY},
                timeout=60,
            )
        except Exception as e:
            log(f"  {d} 取得エラー: {e}")
            time.sleep(SLEEP)
            continue

        time.sleep(SLEEP)

        if r.status_code != 200:
            log(f"  {d} HTTP {r.status_code} （キーが違う場合は401/403が出ます）")
            continue

        results = r.json().get("results") or []
        hit = None
        for doc in results:
            sec = (doc.get("secCode") or "")
            if doc.get("docTypeCode") == DOC_TYPE_YUHO and sec[:4] == SEC_CODE:
                hit = doc
                break

        if hit:
            log("")
            log("★ 見つかりました")
            log(f"   docID      : {hit.get('docID')}")
            log(f"   会社名     : {hit.get('filerName')}")
            log(f"   EDINETコード: {hit.get('edinetCode')}")
            log(f"   証券コード  : {hit.get('secCode')}")
            log(f"   書類        : {hit.get('docDescription')}")
            log(f"   対象期間    : {hit.get('periodStart')} 〜 {hit.get('periodEnd')}")
            log("")
            return hit

        log(f"  {d} 提出書類{len(results)}件 / 該当なし")

    return None


def download_csv(doc_id):
    """type=5（XBRLをCSVに変換したもの）をダウンロードして展開する"""
    log("■ CSVをダウンロードします")
    r = requests.get(
        f"{BASE}/documents/{doc_id}",
        params={"type": 5, "Subscription-Key": API_KEY},
        timeout=300,
    )
    time.sleep(SLEEP)

    if r.status_code != 200:
        log(f"  ダウンロード失敗 HTTP {r.status_code}")
        return None

    os.makedirs(OUT_DIR, exist_ok=True)

    try:
        z = zipfile.ZipFile(io.BytesIO(r.content))
    except zipfile.BadZipFile:
        log("  ZIPとして開けませんでした（CSVが提供されていない書類の可能性）")
        return None

    names = [n for n in z.namelist() if n.lower().endswith(".csv")]
    log(f"  ZIPの中のCSV: {len(names)}件")
    for n in names:
        log(f"    - {n}")

    # 本文＋財務諸表がまとまっているのは jpcrp で始まるファイル
    target = None
    for n in names:
        if os.path.basename(n).startswith("jpcrp"):
            target = n
            break
    if target is None and names:
        target = names[0]
    if target is None:
        log("  CSVが見つかりませんでした")
        return None

    log(f"  使うファイル: {target}")

    raw = z.read(target)
    # EDINETのCSVはUTF-16のタブ区切り
    text = raw.decode("utf-16")

    saved = os.path.join(OUT_DIR, f"{doc_id}.csv")
    with open(saved, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    log(f"  UTF-8に変換して保存しました: {saved}")

    return text


def show(text):
    reader = csv.DictReader(io.StringIO(text), delimiter="\t")
    rows = list(reader)

    log("")
    log(f"■ 全 {len(rows)} 行")
    log(f"   列名: {reader.fieldnames}")

    def col(row, name):
        return (row.get(name) or "").strip()

    # 1. 主要な経営指標等の推移（1書類で5年分入っている）
    log("")
    log("■ 主要な経営指標等の推移（要素IDに SummaryOfBusinessResults を含む行）")
    summary = [r for r in rows if "SummaryOfBusinessResults" in col(r, "要素ID")]
    log(f"   {len(summary)} 行")
    for r in summary:
        log("   | {:<12} | {:<28} | {:<8} | {:>18} | {}".format(
            col(r, "相対年度")[:12],
            col(r, "項目名")[:28],
            col(r, "連結・個別")[:8],
            col(r, "値")[:18],
            col(r, "要素ID"),
        ))

    # 2. キーワードに引っかかる行（当期の数値の確認用）
    log("")
    log("■ キーワードに一致した行（先頭60件）")
    hits = []
    for r in rows:
        name = col(r, "項目名")
        if any(k in name for k in KEYWORDS):
            hits.append(r)
    log(f"   {len(hits)} 行（多いので先頭60件だけ表示します）")
    for r in hits[:60]:
        log("   | {:<30} | {:<14} | {:<8} | {:>18} | {}".format(
            col(r, "項目名")[:30],
            col(r, "相対年度")[:14],
            col(r, "連結・個別")[:8],
            col(r, "値")[:18],
            col(r, "要素ID"),
        ))


def main():
    if not API_KEY:
        log("EDINET_API_KEY が設定されていません。SecretにEDINET_API_KEYを登録してください。")
        sys.exit(1)

    doc = find_document()
    if not doc:
        log("")
        log("該当する有価証券報告書が見つかりませんでした。")
        log("期間（START / END）を広げるか、証券コードを確認してください。")
        log("3月決算の会社は6月下旬に提出することが多いです。")
        sys.exit(1)

    text = download_csv(doc["docID"])
    if text is None:
        sys.exit(1)

    show(text)

    log("")
    log("■ 完了")


if __name__ == "__main__":
    main()
