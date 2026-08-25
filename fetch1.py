"""
EDINET 動作確認スクリプト（診断モード付き）
証券コードだけでなく社名でも照合し、書類種別を問わず候補を全部表示する。
有価証券報告書が見つかればそのままCSVを取得して中身を出す。
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
NAME_KEYWORD = os.environ.get("NAME_KEYWORD", "トヨタ自動車").strip()
START = os.environ.get("START", "2026-06-15").strip()
END = os.environ.get("END", "2026-07-10").strip()

SLEEP = 4
OUT_DIR = "out"
DOC_TYPE_YUHO = "120"

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


def is_candidate(doc):
    """証券コードの先頭4桁が一致、または社名にキーワードを含むものを候補にする"""
    sec = (doc.get("secCode") or "")
    if SEC_CODE and sec[:4] == SEC_CODE:
        return True
    name = (doc.get("filerName") or "")
    if NAME_KEYWORD and NAME_KEYWORD in name:
        return True
    return False


def collect():
    log(f"■ 診断モード")
    log(f"   証券コード : {SEC_CODE!r}")
    log(f"   社名キーワード : {NAME_KEYWORD!r}")
    log(f"   期間 : {START} 〜 {END}")
    log("")

    candidates = []
    printed_keys = False

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
            log(f"  {d} HTTP {r.status_code}")
            continue

        results = r.json().get("results") or []

        # 最初にデータが取れた日だけ、1件目の項目名を出して構造を確認する
        if results and not printed_keys:
            printed_keys = True
            log("  【参考】1件目のデータ項目:")
            log(f"    {list(results[0].keys())}")
            log("  【参考】1件目の中身:")
            for k in ("docID", "edinetCode", "secCode", "filerName",
                      "docTypeCode", "docDescription", "ordinanceCode", "formCode"):
                log(f"    {k} = {results[0].get(k)!r}")
            log("")

        n120 = sum(1 for doc in results if doc.get("docTypeCode") == DOC_TYPE_YUHO)
        hits = [doc for doc in results if is_candidate(doc)]

        log(f"  {d} 全{len(results)}件 / 有報(120)は{n120}件 / 候補{len(hits)}件")

        for doc in hits:
            log("     -> docTypeCode={} secCode={!r} {} ｜ {}".format(
                doc.get("docTypeCode"),
                doc.get("secCode"),
                doc.get("filerName"),
                doc.get("docDescription"),
            ))
            candidates.append(doc)

    return candidates


def download_csv(doc_id):
    log("")
    log(f"■ CSVをダウンロードします（docID={doc_id}）")
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

    text = z.read(target).decode("utf-16")

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

    log("")
    log("■ キーワードに一致した行（先頭60件）")
    hits = [r for r in rows if any(k in col(r, "項目名") for k in KEYWORDS)]
    log(f"   {len(hits)} 行")
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
        log("EDINET_API_KEY が設定されていません。")
        sys.exit(1)

    candidates = collect()

    log("")
    log(f"■ 候補は全部で {len(candidates)} 件でした")

    if not candidates:
        log("  この会社の書類が1件も見つかりませんでした。")
        log("  社名キーワードを短く（例: トヨタ）して試してください。")
        sys.exit(1)

    yuho = [d for d in candidates if d.get("docTypeCode") == DOC_TYPE_YUHO]
    if not yuho:
        log("  候補はありましたが、有価証券報告書(120)はありませんでした。")
        log("  上の一覧の docTypeCode を見て、どれを対象にするか決めます。")
        sys.exit(1)

    doc = yuho[0]
    log(f"  有価証券報告書を使います: {doc.get('docID')} {doc.get('filerName')}")

    text = download_csv(doc["docID"])
    if text is None:
        sys.exit(1)

    show(text)
    log("")
    log("■ 完了")


if __name__ == "__main__":
    main()
