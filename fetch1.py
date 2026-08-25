"""
EDINET 複数社まとめ取得＋名寄せ（検証版）
指定期間の書類一覧を1回だけなめて、対象企業ぜんぶの有価証券報告書を集め、
CSVを取得して指標を名寄せし、時系列の表にする。
"""

import os
import io
import re
import csv
import sys
import json
import time
import zipfile
import datetime

import requests

BASE = "https://api.edinet-fsa.go.jp/api/v2"
API_KEY = os.environ.get("EDINET_API_KEY", "")
SEC_CODES = [c.strip() for c in os.environ.get("SEC_CODES", "7203").split(",") if c.strip()]
START = os.environ.get("START", "2026-05-01").strip()
END = os.environ.get("END", "2026-07-10").strip()

SLEEP = 4
RETRY = 3
OUT_DIR = "out"
DOC_TYPE_YUHO = "120"

# 相対年度 -> 当期から何年さかのぼるか
REL2OFFSET = {
    "当期": 0, "当期末": 0, "当期末時点": 0,
    "前期": 1, "前期末": 1,
    "前々期": 2, "前々期末": 2,
    "三期前": 3, "三期前時点": 3,
    "四期前": 4, "四期前時点": 4,
}

# 指標名 -> (連結で使う要素ローカル名の候補, 単体で使う候補)
# 上から順に試して、最初に見つかったものを採用する
ITEMS = [
    ("売上高",
     [r"^(OperatingRevenues|Revenue|Revenues|NetSales|TotalNetRevenues|SalesRevenues|OperatingRevenue).*IFRS(KeyFinancialData|SummaryOfBusinessResults)$",
      r"^NetSalesSummaryOfBusinessResults$",
      r"^(OperatingRevenues|Revenue|Revenues|NetSales).*(KeyFinancialData|SummaryOfBusinessResults)$"],
     [r"^NetSalesSummaryOfBusinessResults$"]),

    ("純利益",
     [r"^ProfitLossAttributableToOwnersOfParentIFRSSummaryOfBusinessResults$",
      r"^ProfitLossAttributableToOwnersOfParentSummaryOfBusinessResults$",
      r"^NetIncomeLossSummaryOfBusinessResults$"],
     [r"^NetIncomeLossSummaryOfBusinessResults$"]),

    ("経常利益",
     [r"^OrdinaryIncomeLossSummaryOfBusinessResults$"],
     [r"^OrdinaryIncomeLossSummaryOfBusinessResults$"]),

    ("総資産",
     [r"^TotalAssetsIFRSSummaryOfBusinessResults$",
      r"^TotalAssetsSummaryOfBusinessResults$"],
     [r"^TotalAssetsSummaryOfBusinessResults$"]),

    ("純資産",
     [r"^EquityAttributableToOwnersOfParentIFRSSummaryOfBusinessResults$",
      r"^NetAssetsSummaryOfBusinessResults$"],
     [r"^NetAssetsSummaryOfBusinessResults$"]),

    ("営業CF",
     [r"^CashFlowsFromUsedInOperatingActivitiesIFRSSummaryOfBusinessResults$",
      r"^NetCashProvidedByUsedInOperatingActivitiesSummaryOfBusinessResults$",
      r"^CashFlowsFromUsedInOperatingActivitiesSummaryOfBusinessResults$"],
     []),

    # 注意：IFRSの自己資本比率は RatioOfOwnersEquityToGrossAssets の方。
    # EquityToAssetRatioIFRS... は項目名がずれていて中身は1株当たり持分なので使わない。
    ("自己資本比率",
     [r"^RatioOfOwnersEquityToGrossAssetsIFRSSummaryOfBusinessResults$",
      r"^EquityToAssetRatioSummaryOfBusinessResults$"],
     [r"^EquityToAssetRatioSummaryOfBusinessResults$"]),

    ("ROE",
     [r"^RateOfReturnOnEquityIFRSSummaryOfBusinessResults$",
      r"^RateOfReturnOnEquitySummaryOfBusinessResults$"],
     [r"^RateOfReturnOnEquitySummaryOfBusinessResults$"]),

    ("EPS",
     [r"^BasicEarningsLossPerShareIFRSSummaryOfBusinessResults$",
      r"^BasicEarningsLossPerShareSummaryOfBusinessResults$"],
     [r"^BasicEarningsLossPerShareSummaryOfBusinessResults$"]),

    ("従業員数",
     [r"^NumberOfEmployeesIFRSSummaryOfBusinessResults$",
      r"^NumberOfEmployeesSummaryOfBusinessResults$"],
     []),
]

NULLS = ("", "-", "－", "―", "NA")


def log(*a):
    print(*a, flush=True)


def daterange(s, e):
    d = datetime.date.fromisoformat(s)
    end = datetime.date.fromisoformat(e)
    while d <= end:
        yield d
        d += datetime.timedelta(days=1)


def get(url, params, timeout):
    """失敗しても黙って飛ばさず、必ず再試行する"""
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


def collect_docs():
    targets = set(SEC_CODES)
    found = {}
    failed_days = []

    log(f"■ 対象 {len(targets)}社: {', '.join(SEC_CODES)}")
    log(f"■ 期間 {START} 〜 {END}")
    log("")

    for d in daterange(START, END):
        r = get(f"{BASE}/documents.json",
                {"date": d.isoformat(), "type": 2, "Subscription-Key": API_KEY}, 60)
        if r is None:
            log(f"  {d} 取得できませんでした")
            failed_days.append(d.isoformat())
            continue

        results = r.json().get("results") or []
        hits = []
        for doc in results:
            sec = (doc.get("secCode") or "")[:4]
            if sec in targets and doc.get("docTypeCode") == DOC_TYPE_YUHO:
                if sec not in found:
                    found[sec] = doc
                    hits.append(f"{sec} {doc.get('filerName')}")

        mark = "  ★ " + " / ".join(hits) if hits else ""
        log(f"  {d} {len(results):>5}件{mark}")

    log("")
    log(f"■ 見つかった: {len(found)}社 / 未発見: {sorted(targets - set(found))}")
    if failed_days:
        log(f"■ 取得できなかった日（要再実行）: {failed_days}")
    return found, failed_days


def download_csv(doc_id):
    r = get(f"{BASE}/documents/{doc_id}", {"type": 5, "Subscription-Key": API_KEY}, 300)
    if r is None:
        return None
    try:
        z = zipfile.ZipFile(io.BytesIO(r.content))
    except zipfile.BadZipFile:
        return None
    names = [n for n in z.namelist() if n.lower().endswith(".csv")]
    target = None
    for n in names:
        if os.path.basename(n).startswith("jpcrp"):
            target = n
            break
    if target is None:
        return None
    return z.read(target).decode("utf-16")


def dei(rows, name):
    for r in rows:
        if r["要素ID"] == "jpdei_cor:" + name:
            return (r["値"] or "").strip()
    return ""


def normalize(text):
    rows = list(csv.DictReader(io.StringIO(text), delimiter="\t"))

    end = dei(rows, "CurrentFiscalYearEndDateDEI")
    if len(end) < 7:
        return None, None
    base_year = int(end[:4])

    meta = {
        "edinet": dei(rows, "EDINETCodeDEI"),
        "sec": dei(rows, "SecurityCodeDEI")[:4],
        "name": dei(rows, "FilerNameInJapaneseDEI"),
        "kijun": dei(rows, "AccountingStandardsDEI"),
        "renketsu": dei(rows, "WhetherConsolidatedFinancialStatementsArePreparedDEI"),
        "kessanki": end[5:7] + "月期",
        "kijun_hi": end,
    }
    is_consol = (meta["renketsu"] == "true")

    data = {}
    picked_pattern = {}

    for label, cons_pats, non_pats in ITEMS:
        pats = cons_pats if is_consol else (non_pats or cons_pats)
        want_non = not is_consol
        for pat in pats:
            found = {}
            for r in rows:
                if ("NonConsolidatedMember" in r["コンテキストID"]) != want_non:
                    continue
                if re.match(pat, r["要素ID"].split(":")[-1]) is None:
                    continue
                off = REL2OFFSET.get((r["相対年度"] or "").strip())
                if off is None:
                    continue
                v = (r["値"] or "").strip()
                if v in NULLS:
                    continue
                found[base_year - off] = v
            if found:
                data[label] = found
                picked_pattern[label] = pat
                break

    meta["_patterns"] = picked_pattern
    return meta, data


def main():
    if not API_KEY:
        log("EDINET_API_KEY が設定されていません。")
        sys.exit(1)

    os.makedirs(OUT_DIR, exist_ok=True)

    found, failed_days = collect_docs()
    if not found:
        log("対象の有価証券報告書が1件も見つかりませんでした。期間を広げてください。")
        sys.exit(1)

    all_rows = []
    store = {}

    for sec, doc in found.items():
        log("")
        log(f"■ {sec} {doc.get('filerName')} の数値を取り出します")
        text = download_csv(doc["docID"])
        if text is None:
            log("   CSVを取得できませんでした")
            continue

        with open(os.path.join(OUT_DIR, f"{sec}_{doc['docID']}.csv"), "w",
                  encoding="utf-8", newline="") as f:
            f.write(text)

        meta, data = normalize(text)
        if meta is None:
            log("   中身を読めませんでした")
            continue

        log(f"   会計基準={meta['kijun']} 連結={meta['renketsu']} 決算={meta['kessanki']}")

        years = sorted({y for v in data.values() for y in v})
        log("   " + " " * 12 + "".join(f"{y:>16}" for y in years))
        for label, _, _ in ITEMS:
            v = data.get(label)
            if not v:
                log(f"   {label:<12}" + "（取得できず）")
                continue
            log(f"   {label:<12}" + "".join(f"{v.get(y, '-'):>16}" for y in years))

        store[sec] = {"meta": meta, "data": data,
                      "docID": doc["docID"], "submit": doc.get("submitDateTime")}

        for label, v in data.items():
            for y, val in v.items():
                all_rows.append({
                    "証券コード": sec, "会社名": meta["name"], "会計基準": meta["kijun"],
                    "決算期": meta["kessanki"], "年度": y, "指標": label, "値": val,
                })

    with open(os.path.join(OUT_DIR, "timeseries.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["証券コード", "会社名", "会計基準", "決算期", "年度", "指標", "値"])
        w.writeheader()
        w.writerows(all_rows)

    with open(os.path.join(OUT_DIR, "store.json"), "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=1)

    log("")
    log(f"■ 完了：{len(store)}社 / {len(all_rows)}行 を out/timeseries.csv に書き出しました")
    if failed_days:
        log(f"■ 取得できなかった日があります: {failed_days}")


if __name__ == "__main__":
    main()
