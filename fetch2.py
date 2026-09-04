"""
EDINET 抽出（索引参照版・訂正優先／紐付け検証つき）
訂正有報は「本体より後に出ている」かつ「訂正対象の書類管理番号が本体（または既に適用した訂正）と一致する」
ものだけを適用する。前年度の有報に対する訂正を誤って重ねないため。
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
# 0 なら索引にある全社が対象。数字を入れるとその社数だけ試しに取る。
AUTO_PICK = int(os.environ.get("AUTO_PICK", "0") or "0")

SLEEP = 4
RETRY = 3
INDEX_PATH = "docs_index.json"
OUT_DIR = "out"

# 取得結果はリポジトリに貯める。out/ はActionsのアーティファクト用（90日で消える）。
DATA_DIR = "data"
TS_PATH = os.path.join(DATA_DIR, "timeseries.csv")
STATE_PATH = os.path.join(DATA_DIR, "fetch_state.json")
# 1回の実行で処理する会社数の上限。EDINETに短時間で大量アクセスしないための歯止め。
LIMIT = int(os.environ.get("LIMIT", "600"))
FIELDNAMES = ["証券コード", "会社名", "会計基準", "決算期", "年度",
              "指標", "値", "この値の基準", "出所書類", "本体か訂正か"]

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
      # 営業収益。不動産・サービス業などで使われ、末尾に1が付く形がある。
      r"^OperatingRevenues?[0-9]?SummaryOfBusinessResults$",
      # 収益認識基準を適用した会社の「売上収益」。
      r"^RevenueSummaryOfBusinessResults$",
      r"^NetSalesJGAAPSummaryOfBusinessResults$",
      # 建設業は「完成工事高」。主要な経営指標等の推移に5年分載っている。
      r"^NetSalesOfCompletedConstructionContractsSummaryOfBusinessResults$",
      # 主要な経営指標に載らない会社（バイオ等の事業収益など）は本表から補う。2年分。
      r"^(NetSales|OperatingRevenues?|BusinessRevenue|Revenue)$"]),
    ("営業利益",
     [r"^OperatingProfitLoss.*IFRS(KeyFinancialData|SummaryOfBusinessResults)$",
      r"^OperatingProfitLoss(IFRS)?$"],
     [r"^OperatingIncomeLossSummaryOfBusinessResults$",
      # 日本基準の主要な経営指標等の推移に営業利益の欄はないため、損益計算書本体から拾う。
      # 本表は当期・前期しか載らないので、この指標だけ2年分になる。
      r"^OperatingIncome(Loss)?$"]),
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


def load_state():
    """どの会社をどの書類で取得済みかの記録。CSVと対で使う。"""
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def load_rows():
    """蓄積済みのCSVを会社ごとに読み込む。"""
    rows = {}
    if not os.path.exists(TS_PATH):
        return rows
    with open(TS_PATH, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            rows.setdefault(r["証券コード"], []).append(r)
    return rows


def save_all(rows, state):
    """会社コード順・指標順に並べて書き出す。並びを固定しないとGitの差分が毎回全行になる。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    flat = []
    for sec in sorted(rows):
        flat.extend(sorted(rows[sec], key=lambda r: (r["指標"], r["年度"])))
    with open(TS_PATH, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDNAMES)
        w.writeheader()
        w.writerows(flat)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1, sort_keys=True)
    return len(flat)


def needs_update(sec, pair, state):
    """索引の書類構成が記録と違えば取り直す。新しい有報や訂正が出た会社だけが対象になる。"""
    got = state.get(sec)
    if not got:
        return True
    if got.get("本体") != pair["本体"]["docID"]:
        return True
    return got.get("訂正候補", []) != [t["docID"] for t in pair["訂正"]]


def pick_docs(index, targets=None, quiet=False):
    docs = index["docs"]
    by_sec = {}
    for d in docs.values():
        sec = (d.get("secCode") or "")[:4]
        if sec:
            by_sec.setdefault(sec, []).append(d)

    if targets is None:
        targets = SEC_CODES
        if not targets and AUTO_PICK:
            cand = [s for s, v in by_sec.items()
                    if any(x.get("docTypeCode") == "130" for x in v)
                    and any(x.get("docTypeCode") == "120" for x in v)]
            targets = sorted(cand)[:AUTO_PICK]
            log(f"■ 訂正のある会社を自動選択: {targets}（該当 {len(cand)}社）")
        elif not targets:
            targets = sorted(by_sec)

    out = {}
    for sec in targets:
        lst = by_sec.get(sec)
        if not lst:
            if not quiet:
                log(f"  {sec}: 索引にありません")
            continue
        honbun = sorted([d for d in lst if d.get("docTypeCode") == "120"],
                        key=lambda x: x.get("submitDateTime") or "")
        if not honbun:
            if not quiet:
                log(f"  {sec}: 有価証券報告書(120)が索引にありません")
            continue
        main = honbun[-1]
        main_dt = main.get("submitDateTime") or ""

        teisei = []
        skipped_old = 0
        for d in lst:
            if d.get("docTypeCode") != "130":
                continue
            if d.get("edinetCode") != main.get("edinetCode"):
                continue
            # 本体より前に出た訂正は、前年度以前の有報に対するもの
            if (d.get("submitDateTime") or "") <= main_dt:
                skipped_old += 1
                continue
            pe, mpe = d.get("periodEnd"), main.get("periodEnd")
            if pe and mpe and pe != mpe:
                continue
            teisei.append(d)
        teisei.sort(key=lambda x: x.get("submitDateTime") or "")
        out[sec] = {"本体": main, "訂正": teisei, "古い訂正": skipped_old}
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

    state = load_state()
    rows = load_rows()
    log(f"■ 蓄積の現状: {len(rows)}社 / {sum(len(v) for v in rows.values())}行")

    picked = pick_docs(index, quiet=True)
    if not picked:
        log("対象がありません。")
        sys.exit(1)

    pending = [sec for sec in sorted(picked) if needs_update(sec, picked[sec], state)]
    log(f"■ 索引にある会社 {len(picked)}社 / 未取得または更新あり {len(pending)}社")
    if not pending:
        log("■ すべて最新です。取得するものはありません。")
        return
    picked = {sec: picked[sec] for sec in pending[:LIMIT]}
    log(f"■ 今回の対象: {len(picked)}社（1回の上限 {LIMIT}社。残りは次回の実行で）")
    est = len(picked) * SLEEP * 2 / 60
    log(f"■ 見込み時間: 約{est:.0f}分")

    done = 0
    failed = []

    for sec, pair in picked.items():
        main = pair["本体"]
        teisei = pair["訂正"]
        log("")
        log(f"■ {sec} {main.get('filerName')}")
        log(f"   本体 {main['docID']} ({main.get('submitDateTime')}) {main.get('docDescription')}")
        if pair["古い訂正"]:
            log(f"   （本体より前の訂正 {pair['古い訂正']}件は前年度以前のものとして除外）")
        for t in teisei:
            log(f"   訂正候補 {t['docID']} ({t.get('submitDateTime')}) {t.get('docDescription')}")
        if not teisei:
            log("   適用対象の訂正なし")

        text = download_csv(main["docID"])
        if text is None:
            log("   本体のCSVを取得できませんでした")
            failed.append(sec)
            continue
        meta, data = normalize(text)
        if meta is None:
            log("   本体を読めませんでした")
            failed.append(sec)
            continue

        merged = {}
        for label, v in data.items():
            merged[label] = {y: dict(d, 出所=main["docID"], 種別="本体") for y, d in v.items()}

        # 訂正の連鎖に対応：本体docIDから始めて、訂正対象が一致するものだけ適用していく
        chain = {main["docID"]}
        applied = []

        for t in teisei:
            ttext = download_csv(t["docID"])
            if ttext is None:
                log(f"   訂正 {t['docID']}: CSVを取得できず（適用しません）")
                continue
            tmeta, tdata = normalize(ttext)
            if tmeta is None:
                log(f"   訂正 {t['docID']}: 数値を含まず（適用しません）")
                continue

            taisho = tmeta["訂正対象"]
            if taisho not in chain:
                log(f"   訂正 {t['docID']}: 訂正対象={taisho} は本体({main['docID']})と別の書類。"
                    f"適用しません")
                continue
            if tmeta["kimatsu"] != meta["kimatsu"]:
                log(f"   訂正 {t['docID']}: 決算期末が本体と違う"
                    f"（{tmeta['kimatsu']} ≠ {meta['kimatsu']}）。適用しません")
                continue

            n = 0
            for label, v in tdata.items():
                for y, d in v.items():
                    prev = merged.get(label, {}).get(y)
                    if prev is None or prev["値"] != d["値"]:
                        n += 1
                    merged.setdefault(label, {})[y] = dict(d, 出所=t["docID"], 種別="訂正")
            chain.add(t["docID"])
            applied.append(t["docID"])
            log(f"   訂正 {t['docID']}: 適用 / 全{tmeta['行数']}行 / "
                f"XBRL訂正={tmeta['XBRL訂正']} / 指標{len(tdata)}件 / 変化した数値{n}件")

        log(f"   {meta['kijun']} / 連結={meta['renketsu']} / {meta['kessan']}"
            f" / 適用した訂正 {len(applied)}件")
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

        # その会社ぶんを丸ごと差し替える（訂正で値が変わることがあるため追記はしない）
        rows[sec] = [{
            "証券コード": sec, "会社名": meta["name"], "会計基準": meta["kijun"],
            "決算期": meta["kessan"], "年度": y, "指標": label, "値": d["値"],
            "この値の基準": d["基準"], "出所書類": d["出所"], "本体か訂正か": d["種別"],
        } for label, v in merged.items() for y, d in v.items()]
        state[sec] = {
            "会社名": meta["name"],
            "本体": main["docID"],
            "訂正候補": [t["docID"] for t in pair["訂正"]],
            "適用した訂正": applied,
            "取得日時": time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.gmtime(time.time() + 9 * 3600)),
        }
        done += 1

        # 途中で落ちても取得ぶんを失わないよう、こまめに書き出す
        if done % 50 == 0:
            save_all(rows, state)
            log(f"   （途中保存：{done}社ぶん）")

    total = save_all(rows, state)

    log("")
    log(f"■ 今回の取得：{done}社")
    log(f"■ 蓄積の合計：{len(rows)}社 / {total}行")
    remain = len(pending) - done
    if remain > 0:
        log(f"■ 残り {remain}社。次回の実行で続きから取得します。")
    if failed:
        log(f"■ 取得できなかった会社: {failed}")


if __name__ == "__main__":
    main()
