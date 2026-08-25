"""
EDINET 複数社まとめ取得＋名寄せ（v4）
・コンテキストIDの修飾子を見て、セグメント別などの行を除外する
・会計基準（IFRS／日本基準）の系列を両方保持し、混在した指標に印を付ける
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

# コンテキストIDの先頭 -> 当期から何年さかのぼるか
CTX_HEAD = {
    "CurrentYearDuration": 0, "CurrentYearInstant": 0,
    "Prior1YearDuration": 1, "Prior1YearInstant": 1,
    "Prior2YearDuration": 2, "Prior2YearInstant": 2,
    "Prior3YearDuration": 3, "Prior3YearInstant": 3,
    "Prior4YearDuration": 4, "Prior4YearInstant": 4,
}

# (指標名, IFRS系のパターン, 日本基準系のパターン)
# 注意点をコメントで残す。ここが名寄せ表の本体。
ITEMS = [
    # 売上：IFRSは会社ごとに名前が違う（OperatingRevenues / SalesAndFinancialServicesRevenue / Revenue …）
    # 日本基準は銀行が「経常収益」= OrdinaryIncome（OrdinaryIncomeLoss＝経常利益と別物なので厳密一致）
    ("売上高",
     [r"^(?!.*Cost).*(Revenue|Revenues|NetSales).*IFRS(KeyFinancialData|SummaryOfBusinessResults)$"],
     [r"^NetSalesSummaryOfBusinessResults$",
      r"^OrdinaryIncomeSummaryOfBusinessResults$",
      r"^OperatingRevenues?SummaryOfBusinessResults$",
      r"^NetSalesJGAAPSummaryOfBusinessResults$"]),

    # 営業利益：5年表に載せていない会社が多い（載っていなければ空欄）
    ("営業利益",
     [r"^OperatingProfitLoss.*IFRS(KeyFinancialData|SummaryOfBusinessResults)$"],
     [r"^OperatingIncomeLossSummaryOfBusinessResults$"]),

    # 経常利益：IFRSには存在しない概念
    ("経常利益",
     [],
     [r"^OrdinaryIncomeLossSummaryOfBusinessResults$"]),

    ("純利益",
     [r"^ProfitLossAttributableToOwnersOfParentIFRS(KeyFinancialData|SummaryOfBusinessResults)$"],
     [r"^ProfitLossAttributableToOwnersOfParentSummaryOfBusinessResults$",
      r"^NetIncomeLossSummaryOfBusinessResults$"]),

    ("総資産",
     [r"^TotalAssetsIFRS(KeyFinancialData|SummaryOfBusinessResults)$"],
     [r"^TotalAssetsSummaryOfBusinessResults$"]),

    ("純資産",
     [r"^EquityAttributableToOwnersOfParentIFRS(KeyFinancialData|SummaryOfBusinessResults)$"],
     [r"^NetAssetsSummaryOfBusinessResults$"]),

    ("営業CF",
     [r"^CashFlowsFromUsedInOperatingActivitiesIFRS(KeyFinancialData|SummaryOfBusinessResults)$"],
     [r"^NetCashProvidedByUsedInOperatingActivitiesSummaryOfBusinessResults$"]),

    # 自己資本比率：IFRSは RatioOfOwnersEquityToGrossAssets。
    # EquityToAssetRatioIFRS… は名前に反して中身が1株当たり持分なので使わない。
    ("自己資本比率",
     [r"^RatioOfOwnersEquityToGrossAssetsIFRSSummaryOfBusinessResults$"],
     [r"^EquityToAssetRatioSummaryOfBusinessResults$"]),

    ("ROE",
     [r"^RateOfReturnOnEquityIFRSSummaryOfBusinessResults$"],
     [r"^RateOfReturnOnEquitySummaryOfBusinessResults$"]),

    ("EPS",
     [r"^BasicEarningsLossPerShareIFRSSummaryOfBusinessResults$"],
     [r"^BasicEarningsLossPerShareSummaryOfBusinessResults$"]),

    # 従業員数：素の NumberOfEmployees はセグメント別の行と同じ要素IDなので、
    # コンテキストの修飾子で全社合計だけを拾う（parse_ctx が担当）
    ("従業員数",
     [r"^NumberOfEmployeesIFRSSummaryOfBusinessResults$", r"^NumberOfEmployees$"],
     [r"^NumberOfEmployees(JGAAP)?SummaryOfBusinessResults$", r"^NumberOfEmployees$"]),
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


def parse_ctx(ctx):
    """コンテキストIDから (何年前, 連結/単体) を返す。
    セグメント別など余計な修飾が付いた行は (None, None) にして捨てる。"""
    parts = ctx.split("_")
    off = CTX_HEAD.get(parts[0])
    if off is None:
        return None, None
    rest = parts[1:]
    if not rest:
        return off, "連結"
    if rest == ["NonConsolidatedMember"]:
        return off, "単体"
    return None, None


def collect_docs():
    targets = set(SEC_CODES)
    found = {}
    failed = []
    log(f"■ 対象 {len(targets)}社 / 期間 {START} 〜 {END}")
    for d in daterange(START, END):
        r = get(f"{BASE}/documents.json",
                {"date": d.isoformat(), "type": 2, "Subscription-Key": API_KEY}, 60)
        if r is None:
            log(f"  {d} 取得できませんでした")
            failed.append(d.isoformat())
            continue
        results = r.json().get("results") or []
        hits = []
        for doc in results:
            sec = (doc.get("secCode") or "")[:4]
            if sec in targets and doc.get("docTypeCode") == DOC_TYPE_YUHO and sec not in found:
                found[sec] = doc
                hits.append(f"{sec} {doc.get('filerName')}")
        log(f"  {d} {len(results):>5}件" + ("  ★ " + " / ".join(hits) if hits else ""))
    log("")
    log(f"■ 見つかった {len(found)}社 / 未発見 {sorted(targets - set(found))}")
    if failed:
        log(f"■ 取得できなかった日: {failed}")
    return found, failed


def download_csv(doc_id):
    r = get(f"{BASE}/documents/{doc_id}", {"type": 5, "Subscription-Key": API_KEY}, 300)
    if r is None:
        return None
    try:
        z = zipfile.ZipFile(io.BytesIO(r.content))
    except zipfile.BadZipFile:
        return None
    for n in z.namelist():
        if n.lower().endswith(".csv") and os.path.basename(n).startswith("jpcrp"):
            return z.read(n).decode("utf-16")
    return None


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
    base = int(end[:4])

    meta = {
        "sec": dei(rows, "SecurityCodeDEI")[:4],
        "edinet": dei(rows, "EDINETCodeDEI"),
        "name": dei(rows, "FilerNameInJapaneseDEI"),
        "kijun": dei(rows, "AccountingStandardsDEI"),
        "renketsu": dei(rows, "WhetherConsolidatedFinancialStatementsArePreparedDEI"),
        "kessan": end[5:7] + "月期",
        "kimatsu": end,
    }
    scope = "連結" if meta["renketsu"] == "true" else "単体"
    primary = "IFRS" if meta["kijun"] == "IFRS" else "JGAAP"
    other = "JGAAP" if primary == "IFRS" else "IFRS"

    data = {}
    mixed = []

    for label, ifrs_pats, jgaap_pats in ITEMS:
        series = {"IFRS": {}, "JGAAP": {}}
        for tag, pats in (("IFRS", ifrs_pats), ("JGAAP", jgaap_pats)):
            for pat in pats:
                got = {}
                for r in rows:
                    off, sc = parse_ctx(r["コンテキストID"])
                    if off is None or sc != scope:
                        continue
                    if re.match(pat, r["要素ID"].split(":")[-1]) is None:
                        continue
                    v = (r["値"] or "").strip()
                    if v in NULLS:
                        continue
                    got[base - off] = v
                if got:
                    series[tag] = got
                    break

        merged = {}
        for y, v in series[other].items():
            merged[y] = {"値": v, "基準": other}
        for y, v in series[primary].items():
            merged[y] = {"値": v, "基準": primary}

        if merged:
            data[label] = dict(sorted(merged.items()))
            if len({d["基準"] for d in merged.values()}) > 1:
                mixed.append(label)

    meta["基準混在"] = mixed
    return meta, data


def main():
    if not API_KEY:
        log("EDINET_API_KEY が設定されていません。")
        sys.exit(1)
    os.makedirs(OUT_DIR, exist_ok=True)

    found, failed = collect_docs()
    if not found:
        log("有価証券報告書が見つかりませんでした。期間を広げてください。")
        sys.exit(1)

    all_rows = []
    store = {}

    for sec, doc in found.items():
        log("")
        log(f"■ {sec} {doc.get('filerName')}")
        text = download_csv(doc["docID"])
        if text is None:
            log("   CSVを取得できませんでした")
            continue
        with open(os.path.join(OUT_DIR, f"{sec}_{doc['docID']}.csv"), "w",
                  encoding="utf-8", newline="") as f:
            f.write(text)

        meta, data = normalize(text)
        if meta is None:
            log("   読めませんでした")
            continue

        log(f"   {meta['kijun']} / 連結={meta['renketsu']} / {meta['kessan']}"
            + (f" / 基準混在: {meta['基準混在']}" if meta["基準混在"] else ""))

        years = sorted({y for v in data.values() for y in v})
        log("   " + " " * 12 + "".join(f"{y:>16}" for y in years))
        for label, _, _ in ITEMS:
            v = data.get(label)
            if not v:
                log(f"   {label:<12}（なし）")
                continue
            cells = []
            for y in years:
                if y not in v:
                    cells.append("-")
                    continue
                d = v[y]
                mark = "*" if d["基準"] != ("IFRS" if meta["kijun"] == "IFRS" else "JGAAP") else ""
                try:
                    n = float(d["値"])
                    s = f"{n / 1e8:,.0f}億" if abs(n) >= 1e8 else f"{n:g}"
                except ValueError:
                    s = d["値"][:12]
                cells.append(s + mark)
            log(f"   {label:<12}" + "".join(f"{c:>16}" for c in cells))

        store[sec] = {"meta": meta, "data": data, "docID": doc["docID"],
                      "submit": doc.get("submitDateTime")}

        for label, v in data.items():
            for y, d in v.items():
                all_rows.append({
                    "証券コード": sec, "会社名": meta["name"], "会計基準": meta["kijun"],
                    "決算期": meta["kessan"], "年度": y, "指標": label,
                    "値": d["値"], "この値の基準": d["基準"],
                })

    with open(os.path.join(OUT_DIR, "timeseries.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["証券コード", "会社名", "会計基準", "決算期",
                                          "年度", "指標", "値", "この値の基準"])
        w.writeheader()
        w.writerows(all_rows)

    with open(os.path.join(OUT_DIR, "store.json"), "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=1)

    log("")
    log(f"■ 完了：{len(store)}社 / {len(all_rows)}行")
    if failed:
        log(f"■ 取得できなかった日があります: {failed}")


if __name__ == "__main__":
    main()
