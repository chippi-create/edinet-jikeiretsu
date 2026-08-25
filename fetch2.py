"""
EDINET 抽出（索引参照版・訂正優先）
・docs_index.json から対象企業の有価証券報告書を引く（日付の巡回はしない）
・訂正有価証券報告書(130)があれば、古い順に重ねて値を上書きする
・どの数値がどの書類から来たかを記録する
"""

import os
import io
import re
import csv
import sys
import json
import time
import zipfile

import requests

BASE = "https://api.edinet-fsa.go.jp/api/v2"
API_KEY = os.environ.get("EDINET_API_KEY", "")
SEC_CODES = [c.strip() for c in os.environ.get("SEC_CODES", "").split(",") if c.strip()]
# 訂正が出ている会社を索引から自動で選ぶ数（SEC_CODESが空のとき使う）
AUTO_PICK = int(os.environ.get("AUTO_PICK", "5"))

SLEEP = 4
RETRY = 3
INDEX_PATH = "docs_index.json"
OUT_DIR = "out"

CTX_HEAD = {
    "CurrentYearDuration": 0, "CurrentYearInstant": 0,
    "Prior1YearDuration": 1, "Prior1YearInstant": 1,
    "Prior2YearDuration": 2, "Prior2YearInstant": 2,
    "Prior3YearDuration": 3, "Prior3YearInstant": 3,
    "Prior4YearDuration": 4, "Prior4YearInstant": 4,
}

ITEMS = [
    ("売上高",
     [r"^(?!.*Cost).*(Revenue|Revenues|NetSales).*IFRS(KeyFinancialData|SummaryOfBusinessResults)$"],
     [r"^NetSalesSummaryOfBusinessResults$",
      r"^OrdinaryIncomeSummaryOfBusinessResults$",
      r"^OperatingRevenues?SummaryOfBusinessResults$",
      r"^NetSalesJGAAPSummaryOfBusinessResults$"]),
    ("営業利益",
     [r"^OperatingProfitLoss.*IFRS(KeyFinancialData|SummaryOfBusinessResults)$"],
     [r"^OperatingIncomeLossSummaryOfBusinessResults$"]),
    ("経常利益", [], [r"^OrdinaryIncomeLossSummaryOfBusinessResults$"]),
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
    ("自己資本比率",
     [r"^RatioOfOwnersEquityToGrossAssetsIFRSSummaryOfBusinessResults$"],
     [r"^EquityToAssetRatioSummaryOfBusinessResults$"]),
    ("ROE",
     [r"^RateOfReturnOnEquityIFRSSummaryOfBusinessResults$"],
     [r"^RateOfReturnOnEquitySummaryOfBusinessResults$"]),
    ("EPS",
     [r"^BasicEarningsLossPerShareIFRSSummaryOfBusinessResults$"],
     [r"^BasicEarningsLossPerShareSummaryOfBusinessResults$"]),
    ("従業員数",
     [r"^NumberOfEmployeesIFRSSummaryOfBusinessResults$", r"^NumberOfEmployees$"],
     [r"^NumberOfEmployees(JGAAP)?SummaryOfBusinessResults$", r"^NumberOfEmployees$"]),
]

NULLS = ("", "-", "－", "―", "NA")


def log(*a):
    print(*a, flush=True)


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
    """1つの書類から meta と {指標: {年: {値, 基準}}} を取り出す"""
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
        "訂正か": dei(rows, "AmendmentFlagDEI"),
        "訂正対象": dei(rows, "IdentificationOfDocumentSubjectToAmendmentDEI"),
        "XBRL訂正": dei(rows, "XBRLAmendmentFlagDEI"),
        "行数": len(rows),
    }
    scope = "連結" if meta["renketsu"] == "true" else "単体"
    primary = "IFRS" if meta["kijun"] == "IFRS" else "JGAAP"
    other = "JGAAP" if primary == "IFRS" else "IFRS"

    data = {}
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
            data[label] = merged
    return meta, data


def pick_docs(index):
    """索引から、対象企業の本体(120)と訂正(130)を選ぶ"""
    docs = index["docs"]
    by_sec = {}
    for d in docs.values():
        sec = (d.get("secCode") or "")[:4]
        if not sec:
            continue
        by_sec.setdefault(sec, []).append(d)

    targets = SEC_CODES
    if not targets:
        # 訂正が出ている会社を自動で選ぶ（訂正の中身を確認するため）
        cand = [s for s, v in by_sec.items()
                if any(x.get("docTypeCode") == "130" for x in v)
                and any(x.get("docTypeCode") == "120" for x in v)]
        targets = sorted(cand)[:AUTO_PICK]
        log(f"■ 訂正のある会社を索引から自動選択: {targets}")
        log(f"   （索引内で訂正のある会社は全部で {len(cand)}社）")

    out = {}
    for sec in targets:
        lst = by_sec.get(sec)
        if not lst:
            log(f"  {sec}: 索引にありません")
            continue
        honbun = sorted([d for d in lst if d.get("docTypeCode") == "120"],
                        key=lambda x: x.get("submitDateTime") or "")
        if not honbun:
            log(f"  {sec}: 有価証券報告書(120)が索引にありません")
            continue
        main = honbun[-1]
        # 訂正は「同じ会社・同じ決算期末」のものを古い順に
        teisei = [d for d in lst
                  if d.get("docTypeCode") == "130"
                  and d.get("edinetCode") == main.get("edinetCode")
                  and (d.get("periodEnd") == main.get("periodEnd") or not d.get("periodEnd"))]
        teisei.sort(key=lambda x: x.get("submitDateTime") or "")
        out[sec] = {"本体": main, "訂正": teisei}
    return out


def main():
    if not API_KEY:
        log("EDINET_API_KEY が設定されていません。")
        sys.exit(1)
    if not os.path.exists(INDEX_PATH):
        log("docs_index.json がありません。先に edinet-index を実行してください。")
        sys.exit(1)

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(INDEX_PATH, encoding="utf-8") as f:
        index = json.load(f)
    log(f"■ 索引: {len(index['docs'])}件 / {len(index['days'])}日ぶん")

    picked = pick_docs(index)
    if not picked:
        log("対象がありません。")
        sys.exit(1)

    all_rows = []
    store = {}

    for sec, pair in picked.items():
        main = pair["本体"]
        teisei = pair["訂正"]
        log("")
        log(f"■ {sec} {main.get('filerName')}")
        log(f"   本体 {main['docID']} ({main.get('submitDateTime')}) {main.get('docDescription')}")
        for t in teisei:
            log(f"   訂正 {t['docID']} ({t.get('submitDateTime')}) {t.get('docDescription')}")
        if not teisei:
            log("   訂正なし")

        text = download_csv(main["docID"])
        if text is None:
            log("   本体のCSVを取得できませんでした")
            continue
        meta, data = normalize(text)
        if meta is None:
            log("   本体を読めませんでした")
            continue

        # 値ごとに出所を持たせる
        merged = {}
        for label, v in data.items():
            merged[label] = {y: dict(d, 出所=main["docID"], 種別="本体") for y, d in v.items()}

        # 訂正を古い順に重ねる
        for t in teisei:
            ttext = download_csv(t["docID"])
            if ttext is None:
                log(f"   訂正 {t['docID']} のCSVを取得できませんでした（本体のまま）")
                continue
            tmeta, tdata = normalize(ttext)
            if tmeta is None:
                log(f"   訂正 {t['docID']} は数値を含みません（本体のまま）")
                continue
            n = 0
            for label, v in tdata.items():
                for y, d in v.items():
                    prev = merged.get(label, {}).get(y)
                    if prev is None or prev["値"] != d["値"]:
                        n += 1
                    merged.setdefault(label, {})[y] = dict(d, 出所=t["docID"], 種別="訂正")
            log(f"   訂正 {t['docID']}: 全{tmeta['行数']}行 / "
                f"XBRL訂正={tmeta['XBRL訂正']} / 指標{len(tdata)}件 / 変化した数値{n}件")

        log(f"   {meta['kijun']} / 連結={meta['renketsu']} / {meta['kessan']}")
        years = sorted({y for v in merged.values() for y in v})
        log("   " + " " * 12 + "".join(f"{y:>16}" for y in years))
        for label, _, _ in ITEMS:
            v = merged.get(label)
            if not v:
                log(f"   {label:<12}（なし）")
                continue
            cells = []
            for y in years:
                if y not in v:
                    cells.append("-")
                    continue
                d = v[y]
                mark = "訂" if d["種別"] == "訂正" else ""
                try:
                    n = float(d["値"])
                    s = f"{n / 1e8:,.0f}億" if abs(n) >= 1e8 else f"{n:g}"
                except ValueError:
                    s = d["値"][:12]
                cells.append(s + mark)
            log(f"   {label:<12}" + "".join(f"{c:>16}" for c in cells))

        store[sec] = {"meta": meta, "data": merged,
                      "本体": main["docID"], "訂正": [t["docID"] for t in teisei]}
        for label, v in merged.items():
            for y, d in v.items():
                all_rows.append({
                    "証券コード": sec, "会社名": meta["name"], "会計基準": meta["kijun"],
                    "決算期": meta["kessan"], "年度": y, "指標": label, "値": d["値"],
                    "この値の基準": d["基準"], "出所書類": d["出所"], "本体か訂正か": d["種別"],
                })

    with open(os.path.join(OUT_DIR, "timeseries.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["証券コード", "会社名", "会計基準", "決算期", "年度",
                                          "指標", "値", "この値の基準", "出所書類", "本体か訂正か"])
        w.writeheader()
        w.writerows(all_rows)
    with open(os.path.join(OUT_DIR, "store.json"), "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=1)

    log("")
    log(f"■ 完了：{len(store)}社 / {len(all_rows)}行")


if __name__ == "__main__":
    main()
