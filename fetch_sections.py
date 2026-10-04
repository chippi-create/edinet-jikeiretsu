#!/usr/bin/env python3
"""
fetch_sections.py — 有報の記述部分を集める

  事業の内容 / セグメント情報 / 配当政策 / 事業等のリスク
  所有者別状況 / 大株主の状況 / 役員の状況
  （要約用の材料として 経営者による分析・主要な設備・主要な顧客も保存する）

  LIMIT=300 python fetch_sections.py

提出本文書(type=1)のZIPからHTMLを取り出して貯める。3つは表として、
残りは文章として扱う。fetch2.py と同じく、索引の書類構成が
変わった会社だけを取り直す。

これらは「その時点の断面」しか有報に載らないので、財務指標のように
1回で5年分は取れない。毎年の有報を積み上げることで時系列になる。
"""

import os
import csv
import unicodedata
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
BUSINESS = os.path.join(DATA_DIR, "business.csv")
DIVIDEND = os.path.join(DATA_DIR, "dividend.csv")
# 事業等のリスクは1社2万字ほどあり、全社ぶんを1ファイルにすると60MB近くなって
# GitHubの大きなファイルの警告に触れる。会社ごとに分けて、変更のあった
# ファイルだけが書き換わるようにする。
RISK_DIR = os.path.join(DATA_DIR, "risks")
# 役員の略歴も同じ理由で会社ごとに分ける。1人あたり数百字あり、
# 全社ぶんを officers.csv に入れると30MB近くなって毎日書き換わる。
BIO_DIR = os.path.join(DATA_DIR, "bios")
# 沿革は会社ごとのファイル。[[年月, 事項], ...]
HIST_DIR = os.path.join(DATA_DIR, "history")

# 取得する項目の版。項目を足したらここを変える。版が違う会社は取り直す（記録は消さない）。
SECTIONS_VERSION = "2026-10-04c 関係会社・新株予約権・自己株式・監査法人・沿革の改行"
# 株式まわり（関係会社・新株予約権・自己株式・監査法人）は会社ごとのファイル。/kabu/{code}.json
KABU_DIR = os.path.join(DATA_DIR, "kabu")
WEBSITES = os.path.join(DATA_DIR, "websites.csv")
SEGMENTS = os.path.join(DATA_DIR, "segments.csv")
# 所有者別状況・大株主の期ごとの記録。会社ごとのファイル。
#   {"periods": [{"k": 基準日, "d": docID, "own": [[区分, 株主数, 単元, 割合]], "sh": [[順位, 氏名, 住所, 株数, 単位, 割合]]}]}
# ownership.csv / shareholders.csv は最新の1期だけを持つ（上書き）。こちらは基準日ごとに積む。
OWNHIST_DIR = os.path.join(DATA_DIR, "ownhist")
OWNHIST_KEEP = 5
# 証券コード指定のときだけ、前の期の有報からも所有者別・大株主を取る（何期さかのぼるか）。
PAST_YEARS = int(os.environ.get("PAST_YEARS", "0") or 0)
# 要約を書くための材料。事業の内容だけでは仕入や販売先が分からないので、
# 経営者による分析・主要な設備・主要な顧客も渡す。1社1万字を超えるため会社ごとに分ける。
CONTEXT_DIR = os.path.join(DATA_DIR, "context")

F_OWN = ["証券コード", "会社名", "基準日", "区分", "株主数", "所有株式数_単元", "割合"]
F_SH = ["証券コード", "会社名", "基準日", "順位", "氏名又は名称", "住所", "所有株式数", "単位", "割合"]
F_OF = ["証券コード", "会社名", "基準日", "役職名", "氏名", "生年月日", "任期", "所有株式数", "単位"]
F_BIZ = ["証券コード", "会社名", "基準日", "本文"]
F_DIV = ["証券コード", "会社名", "基準日", "本文"]
# 会社サイトは有報の本文中のリンクから推定したもの。確実ではないので
# 出現回数も残して、あとから怪しいものを洗い出せるようにする。
F_WEB = ["証券コード", "会社名", "ホスト", "出現回数"]
F_SEG = ["証券コード", "会社名", "基準日", "セグメント", "外部顧客への売上高", "セグメント利益", "単位"]


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
        # 見出しが1行目とは限らない。「2026年３月31日現在」だけの行が上に付く
        # 会社があり、1行目で決め打ちすると表ごと取りこぼす。
        h = -1
        for i, row in enumerate(t[:4]):
            joined = " ".join(row)
            # 「氏名又は名称」と「氏名または名称」の両方がある。漢字だけを見ると取りこぼす。
            if "氏名" in joined and "名称" in joined \
                    and "所有株式数" in joined and "保有株券等" not in joined:
                h = i
                break
        if h < 0:
            continue
        unit = unit_of(t[h][2] if len(t[h]) > 2 else "")
        out, rank = [], 0
        for row in t[h + 1:]:
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
    """役員の状況。1つの一覧が複数の表に分かれていることがあるのでつなぐ。

    改ページで分割された表に同じ人が重ねて載っていることがあり、
    そのままつなぐと二重になる（ニッスイで31名が41行になっていた）。
    氏名と生年月日が一致する行はまとめる。

    ただし先に出た行を採るだけでは駄目で、略歴の列が無い表に先に載っている人が
    略歴を失う。空いている項目は後から出てきた行で埋める。
    """
    out, seen = [], {}
    for t in tabs:
        if not t:
            continue
        head = [clean(c) for c in t[0]]
        joined = " ".join(head)
        if "氏名" not in joined or "役職名" not in joined:
            continue
        idx = {}
        for j, name in enumerate(head):
            for key in ("役職名", "氏名", "生年月日", "任期", "所有株式数", "略歴"):
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
            rec = {"役職名": get("役職名"), "氏名": name,
                   "生年月日": get("生年月日"), "任期": get("任期"),
                   "所有株式数": num(get("所有株式数")), "単位": unit,
                   "略歴": get("略歴")}
            key = (clean(name), clean(get("生年月日")))
            if key in seen:
                have = seen[key]
                for k, v in rec.items():
                    if v and not have.get(k):
                        have[k] = v
                continue
            seen[key] = rec
            out.append(rec)
    return out


def parse_segments(tabs):
    """セグメント情報の表から、セグメントごとの外部売上高と利益を取る。

    当期と前期の2つが載るので、後に出てくる当期の表を採る。
    「計」「調整額」「連結財務諸表計上額」は個別のセグメントではないので、
    そこに当たったら打ち切る。「その他」も報告セグメントではないため入らない。
    """
    best = ([], "")
    for t in tabs:
        sales = profit = None
        for r in t:
            if not r:
                continue
            head = clean(r[0])
            if sales is None and head.startswith("外部顧客への売上"):
                sales = r
            elif profit is None and head.startswith("セグメント利益"):
                profit = r
        if sales is None or profit is None:
            continue

        # セグメント名の行は、売上高の行より上で、2列目に中身がある最後の行
        i = t.index(sales)
        names = None
        for j in range(i - 1, -1, -1):
            cand = t[j]
            if len(cand) > 2 and clean(cand[1]) and "報告セグメント" not in clean(cand[1]):
                names = cand
                break
        if names is None:
            continue

        unit = ""
        for r in t[:3]:
            m = re.search(r"単位[：:]\s*([^)）]+)", " ".join(r))
            if m:
                unit = m.group(1).strip()
                break

        out = []
        for c in range(1, min(len(names), len(sales), len(profit))):
            nm = clean(names[c])
            if not nm or nm in ("計", "合計", "調整額") or nm.startswith("連結財務諸表"):
                break
            out.append({"セグメント": nm, "外部顧客への売上高": num(sales[c]),
                        "セグメント利益": num(profit[c]), "単位": unit})
        if out:
            best = (out, unit)
    return best[0]


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


def _own_cells(rows):
    return [[r.get("区分", ""), r.get("株主数", ""), r.get("所有株式数_単元", ""), r.get("割合", "")] for r in rows]


def _sh_cells(rows):
    return [[r.get(k, "") for k in ("順位", "氏名又は名称", "住所", "所有株式数", "単位", "割合")] for r in rows]


def put_ownhist(sec, kijun, doc_id, own_rows, sh_rows, src="有価証券報告書"):
    """所有者別・大株主を基準日ごとに積む。同じ基準日は新しい書類で置き換える。
    src は書類の種類（有価証券報告書／半期報告書）。半期報告書には所有者別状況が無い。"""
    if not kijun or not (own_rows or sh_rows):
        return
    os.makedirs(OWNHIST_DIR, exist_ok=True)
    path = os.path.join(OWNHIST_DIR, f"{sec}.json")
    periods = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fp:
            periods = json.load(fp).get("periods", [])
    periods = [x for x in periods if x.get("k") != kijun]
    periods.append({"k": kijun, "d": doc_id, "src": src, "own": _own_cells(own_rows), "sh": _sh_cells(sh_rows)})
    periods.sort(key=lambda x: x["k"], reverse=True)
    with open(path, "w", encoding="utf-8") as fp:
        json.dump({"periods": periods[:OWNHIST_KEEP]}, fp, ensure_ascii=False, separators=(",", ":"))


def seed_ownhist(own, sh, state):
    """いま持っている最新の1期を、まだ記録のない会社だけ積みはじめる（取り直しは不要）。"""
    n = 0
    for sec in set(own) | set(sh):
        if os.path.exists(os.path.join(OWNHIST_DIR, f"{sec}.json")):
            continue
        rows = own.get(sec) or sh.get(sec) or []
        kijun = rows[0].get("基準日", "") if rows else ""
        put_ownhist(sec, kijun, state.get(sec, {}).get("docID", ""), own.get(sec, []), sh.get(sec, []))
        n += 1
    if n:
        log(f"■ 所有者別・大株主の期ごとの記録を {n}社 で積みはじめました")


def interim_end(doc):
    """半期報告書の基準日（中間期末）。索引の periodStart/periodEnd は事業年度の始めと終わりなので、
    期首から6か月後の前日にする（2026-01-01 → 2026-06-30）。期首が無ければ期末の6か月前の月末。"""
    import datetime
    ps, pe = (doc.get("periodStart") or "")[:10], (doc.get("periodEnd") or "")[:10]
    try:
        if ps:
            d = datetime.date.fromisoformat(ps)
            y, m = d.year + (d.month + 5) // 12, (d.month + 5) % 12 + 1
            return (datetime.date(y, m, d.day) - datetime.timedelta(days=1)).isoformat()
        d = datetime.date.fromisoformat(pe)
        y, m = (d.year, d.month - 6) if d.month > 6 else (d.year - 1, d.month + 6)
        nxt = datetime.date(y + (m == 12), m % 12 + 1, 1)
        return (nxt - datetime.timedelta(days=1)).isoformat()
    except ValueError:
        return pe


def fetch_hanki(index, state, codes, limit):
    """半期報告書の大株主の状況を取る。最新の有報より後の半期報告書だけ（それより古い断面は要らない）。
    取ったものは期ごとの記録（ownhist）に「半期報告書」として積む。"""
    if limit <= 0:
        return 0
    latest = {}
    for d in index["docs"].values():
        sec = (d.get("secCode") or "")[:4]
        if not sec or d.get("docTypeCode") not in ("120", "160"):
            continue
        key = (d.get("docTypeCode"), sec)
        if (d.get("submitDateTime") or "") > (latest.get(key, {}).get("submitDateTime") or ""):
            latest[key] = d
    targets = codes or sorted({s for t, s in latest if t == "160"})
    todo = []
    for sec in targets:
        h = latest.get(("160", sec))
        y = latest.get(("120", sec))
        if not h or state.get(sec, {}).get("半期") == h["docID"]:
            continue
        if y and (h.get("periodEnd") or "") <= (y.get("periodEnd") or ""):
            continue
        todo.append(sec)
    if not todo:
        return 0
    log(f"■ 半期報告書の大株主: 対象 {len(todo)}社（今回 {min(limit, len(todo))}社）")
    n = 0
    for sec in todo[:limit]:
        h = latest[("160", sec)]
        kijun = interim_end(h)
        z = sections.fetch_zip(h["docID"])
        if z is None:
            log(f"  {sec} 半期 {kijun}: ZIPを取得できませんでした")
            continue
        blocks = sections.sections_of(z)
        sh_rows = parse_shareholders(sections.tables_of(blocks.get("MajorShareholdersTextBlock", "")))
        put_ownhist(sec, kijun, h["docID"], [], sh_rows, src="半期報告書")
        state.setdefault(sec, {})["半期"] = h["docID"]
        log(f"  {sec} 半期 {kijun}: 大株主{len(sh_rows)}名")
        n += 1
    return n


def fetch_past(index, codes, years):
    """指定した会社の、前の期の有報から所有者別・大株主だけを取る。"""
    by_sec = {}
    for d in index["docs"].values():
        sec = (d.get("secCode") or "")[:4]
        if sec in codes and d.get("docTypeCode") == "120":
            by_sec.setdefault(sec, []).append(d)
    for sec in codes:
        docs = sorted(by_sec.get(sec, []), key=lambda x: x.get("submitDateTime") or "", reverse=True)
        # 同じ期の有報が2本ある（決算期変更など）ときは新しい方だけ
        seen, past = set(), []
        for d in docs:
            pe = (d.get("periodEnd") or "")[:10]
            if pe and pe not in seen:
                seen.add(pe)
                past.append(d)
        past = past[1:1 + years]
        have = set()
        hp = os.path.join(OWNHIST_DIR, f"{sec}.json")
        if os.path.exists(hp):
            with open(hp, encoding="utf-8") as fp:
                have = {x.get("k") for x in json.load(fp).get("periods", [])}
        if len(past) < years:
            log(f"  {sec}: 索引にある前の期の有報は {len(past)}本"
                f"（索引は2024年9月以降。それより前は edinet-index で遡ると取れる）")
        for d in past:
            kijun = (d.get("periodEnd") or "")[:10]
            if kijun in have:
                log(f"  {sec} {kijun}: 取得済み")
                continue
            z = sections.fetch_zip(d["docID"])
            if z is None:
                log(f"  {sec} {kijun}: ZIPを取得できませんでした")
                continue
            blocks = sections.sections_of(z)
            o = parse_ownership(sections.tables_of(blocks.get("ShareholdingByShareholderCategoryTextBlock", "")))
            own_rows = [{"区分": k, "株主数": v.get("株主数", ""), "所有株式数_単元": v.get("単元", ""),
                         "割合": v.get("割合", "")} for k, v in o.items()]
            sh_rows = parse_shareholders(sections.tables_of(blocks.get("MajorShareholdersTextBlock", "")))
            put_ownhist(sec, kijun, d["docID"], own_rows, sh_rows)
            log(f"  {sec} {kijun}（前の期）: 所有者別{len(own_rows)}区分 / 大株主{len(sh_rows)}名")


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
    biz = load_rows(BUSINESS)
    div = load_rows(DIVIDEND)
    web = load_rows(WEBSITES)
    segs = load_rows(SEGMENTS)
    nrisk = len(os.listdir(RISK_DIR)) if os.path.isdir(RISK_DIR) else 0
    nbio = len(os.listdir(BIO_DIR)) if os.path.isdir(BIO_DIR) else 0
    log(f"■ 略歴 {nbio}社")
    log(f"■ 蓄積の現状: 事業 {len(biz)}社 / 配当 {len(div)}社 / リスク {nrisk}社 "
        f"/ 所有者別 {len(own)}社 / 大株主 {len(sh)}社 / 役員 {len(of)}社")

    seed_ownhist(own, sh, state)

    # 証券コードを指定すると、その会社だけを取り直す。
    # 全社の一巡は7日かかるので、いま見たい会社を先に通すための逃げ道。
    codes = [c.strip() for c in os.environ.get("SEC_CODES", "").split(",") if c.strip()]
    # 前の期の所有者別・大株主は、会社を指定したときだけ取る（全社でやると2週間かかる）。
    if codes and PAST_YEARS > 0:
        log(f"■ 前の期の所有者別・大株主: {PAST_YEARS}期さかのぼる")
        fetch_past(index, codes, PAST_YEARS)
    picked = fetch2.pick_docs(index, targets=codes or None, quiet=True)
    if codes:
        log(f"■ 証券コード指定: {codes}")
    # 書類が新しくなった会社と、前の版で取った会社を取り直す。
    # 一度も取れていない会社（新しい書類）を先に、版だけ古い会社を後に回す。
    def stale(s):
        st = state.get(s, {})
        return st.get("docID") != picked[s]["本体"]["docID"] or st.get("版") != SECTIONS_VERSION
    pending = sorted((s for s in picked if stale(s)),
                     key=lambda s: (state.get(s, {}).get("docID") == picked[s]["本体"]["docID"], s))
    log(f"■ 索引 {len(picked)}社 / 未取得または更新あり {len(pending)}社")
    if not pending:
        log("■ すべて最新です。")
        fetch_hanki(index, state, codes, LIMIT)
        save_all(own, sh, of, biz, div, web, segs, state)
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

        # 事業の内容は表ではなく文章。段落の区切りを残して取り出す。
        btxt = sections.text_of(blocks.get("DescriptionOfBusinessTextBlock", ""))
        biz[sec] = [{"証券コード": sec, "会社名": name, "基準日": kijun, "本文": btxt}] if btxt else []

        seg = parse_segments(sections.tables_of(
            blocks.get("NotesSegmentInformationEtcConsolidatedFinancialStatementsTextBlock", "")))
        segs[sec] = [dict(r, 証券コード=sec, 会社名=name, 基準日=kijun) for r in seg]

        # 要約用の材料。サイトには出さず、要約を作るときだけ読む。
        ctx = {
            "analysis": sections.text_of(blocks.get(
                "ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock", "")),
            "facilities": sections.text_of(blocks.get("MajorFacilitiesTextBlock", "")),
            "customers": sections.text_of(blocks.get("InformationForEachOfMainCustomersTextBlock", "")),
            # 政策保有株式。売却提案のほか、資金余力の判断にも使う。
            "shareholdings": sections.text_of(blocks.get("ShareholdingsTextBlock", "")),
            # 経営方針・経営環境・対処すべき課題。有報の要約（/api/yuho）の材料。
            "policy": sections.text_of(blocks.get(
                "BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock", "")),
        }
        os.makedirs(CONTEXT_DIR, exist_ok=True)
        cpath = os.path.join(CONTEXT_DIR, f"{sec}.json")
        if any(ctx.values()):
            with open(cpath, "w", encoding="utf-8") as fp:
                json.dump(ctx, fp, ensure_ascii=False, separators=(",", ":"))
        elif os.path.exists(cpath):
            os.remove(cpath)

        host, hits = sections.site_host_of(z)
        web[sec] = [{"証券コード": sec, "会社名": name, "ホスト": host,
                     "出現回数": hits}] if host else []

        dtxt = sections.text_of(blocks.get("DividendPolicyTextBlock", ""))
        div[sec] = [{"証券コード": sec, "会社名": name, "基準日": kijun, "本文": dtxt}] if dtxt else []

        # リスクは長いので会社ごとのファイルにする
        rtxt = sections.text_of(blocks.get("BusinessRisksTextBlock", ""))
        os.makedirs(RISK_DIR, exist_ok=True)
        rpath = os.path.join(RISK_DIR, f"{sec}.txt")
        if rtxt:
            with open(rpath, "w", encoding="utf-8") as f:
                f.write(rtxt)
        elif os.path.exists(rpath):
            os.remove(rpath)

        o = parse_ownership(sections.tables_of(
            blocks.get("ShareholdingByShareholderCategoryTextBlock", "")))
        own[sec] = [{"証券コード": sec, "会社名": name, "基準日": kijun, "区分": k,
                     "株主数": v.get("株主数", ""),
                     "所有株式数_単元": v.get("単元", ""),
                     "割合": v.get("割合", "")} for k, v in o.items()]

        s = parse_shareholders(sections.tables_of(
            blocks.get("MajorShareholdersTextBlock", "")))
        sh[sec] = [dict(r, 証券コード=sec, 会社名=name, 基準日=kijun) for r in s]
        put_ownhist(sec, kijun, doc["docID"], own[sec], sh[sec])

        f = parse_officers(sections.tables_of(
            blocks.get("InformationAboutOfficersTextBlock", "")))
        of[sec] = [{k: v for k, v in dict(r, 証券コード=sec, 会社名=name,
                                          基準日=(doc.get("submitDateTime") or "")[:10]).items()
                    if k != "略歴"} for r in f]
        # 略歴は会社ごとのファイルへ。氏名も一緒に持たせて、表の行と照合できるようにする。
        os.makedirs(BIO_DIR, exist_ok=True)
        bpath = os.path.join(BIO_DIR, f"{sec}.json")
        bios = [[r["氏名"], r.get("略歴", "")] for r in f if r.get("略歴")]
        if bios:
            with open(bpath, "w", encoding="utf-8") as fp:
                json.dump(bios, fp, ensure_ascii=False, separators=(",", ":"))
        elif os.path.exists(bpath):
            os.remove(bpath)

        # 株式まわり。有報の要約（提案書ツール）で使う。
        kabu = parse_kabu(blocks)
        os.makedirs(KABU_DIR, exist_ok=True)
        kpath = os.path.join(KABU_DIR, f"{sec}.json")
        if any(kabu.values()):
            with open(kpath, "w", encoding="utf-8") as fp:
                json.dump(kabu, fp, ensure_ascii=False, separators=(",", ":"))
        elif os.path.exists(kpath):
            os.remove(kpath)

        # 沿革。表の各行から「年月」と「事項」を取り出す。表になっていない会社は本文の行から拾う。
        hist = parse_history(blocks.get("CompanyHistoryTextBlock", ""))
        os.makedirs(HIST_DIR, exist_ok=True)
        hpath = os.path.join(HIST_DIR, f"{sec}.json")
        if hist:
            with open(hpath, "w", encoding="utf-8") as fp:
                json.dump(hist, fp, ensure_ascii=False, separators=(",", ":"))
        elif os.path.exists(hpath):
            os.remove(hpath)

        log(f"  {sec} {name}: {host or 'サイト不明'} / 沿革{len(hist)}行 / セグメント{len(seg)}件 / 事業{len(btxt)}字 / 配当{len(dtxt)}字 / リスク{len(rtxt)}字 "
            f"/ 所有者別{len(own[sec])}区分 / 大株主{len(sh[sec])}名 / 役員{len(of[sec])}名")
        done += 1
        if done % 25 == 0:
            save_all(own, sh, of, biz, div, web, segs, state)
            log(f"   （途中保存：{done}社）")

        # 半期報告書を取った記録（"半期"）は残す
        state[sec] = {**state.get(sec, {}), "docID": doc["docID"], "版": SECTIONS_VERSION,
                      "取得日時": time.strftime("%Y-%m-%dT%H:%M:%S+09:00",
                                             time.gmtime(time.time() + 9 * 3600))}

    # 残りの枠で半期報告書の大株主を取る
    fetch_hanki(index, state, codes, LIMIT - done)
    n = save_all(own, sh, of, biz, div, web, segs, state)
    log("")
    log(f"■ 今回の取得: {done}社")
    nrisk = len(os.listdir(RISK_DIR)) if os.path.isdir(RISK_DIR) else 0
    log(f"■ 蓄積の合計: 所有者別 {n[0]}行 / 大株主 {n[1]}行 / 役員 {n[2]}行 "
        f"/ 事業 {n[3]}社 / 配当 {n[4]}社 / リスク {nrisk}社")
    remain = len(pending) - done
    if remain > 0:
        log(f"■ 残り {remain}社。次回の実行で続きから取得します。")
    if failed:
        log(f"■ 取得できなかった会社: {failed}")


NONE = re.compile(r"該当事項は(あり|ござい)ません")


def _cells(rows):
    """表の行を、空でないセルだけ・空白を詰めた形にする。"""
    out = []
    for row in rows:
        cells = [re.sub(r"\s+", " ", unicodedata.normalize("NFKC", c or "")).strip() for c in row]
        cells = [c for c in cells if c]
        if cells:
            out.append(cells)
    return out


def _text(html, limit=1500):
    t = sections.text_of(html or "")
    return t[:limit]


def parse_kabu(blocks):
    """関係会社・新株予約権・自己株式・監査法人を取り出す。

    表はセルのまま、文章は先頭だけ。新株予約権は「該当事項はありません」かどうかで有無を決め、
    有るものは回号（第◯回新株予約権）を数える。監査法人は「監査の状況」の本文から名称を拾う。
    """
    g = lambda k: blocks.get(k, "")
    aff = []
    for tab in sections.tables_of(g("OverviewOfAffiliatedEntitiesTextBlock")):
        aff.extend(_cells(tab))
    rights = {}
    for key, el in (("so", "DetailsOfEmployeeShareOptionProgramTextBlock"),
                    ("rights_plan", "DescriptionOfRightsPlanTextBlock"),
                    ("other", "OtherInformationOnShareAcquisitionRightsTextBlock"),
                    ("moving", "ExercisesEtcOfMovingStrikeConvertibleBondsEtcTextBlock")):
        t = _text(g(el), 4000)
        if not t:
            continue
        has = not NONE.search(t)
        nums = sorted({int(n) for n in re.findall(r"第\s*(\d+)\s*回", unicodedata.normalize("NFKC", t))})
        rights[key] = {"有": has, "回号": nums[:30], "本文": t[:800] if has else ""}
    ts = []
    for tab in sections.tables_of(g("TreasurySharesEtcTextBlock")):
        ts.extend(_cells(tab))
    acq = {}
    for key, el in (("meeting", "AcquisitionsByResolutionOfShareholdersMeetingTextBlock"),
                    ("board", "AcquisitionsByResolutionOfBoardOfDirectorsMeetingTextBlock"),
                    ("other", "AcquisitionsNotBasedOnResolutionOfShareholdersMeetingOrBoardOfDirectorsMeetingTextBlock"),
                    ("disposal", "DisposalsOrHoldingOfAcquiredTreasurySharesTextBlock")):
        html = g(el)
        if not html:
            continue
        t = _text(html, 1500)
        rows = []
        for tab in sections.tables_of(html):
            rows.extend(_cells(tab))
        acq[key] = {"有": not NONE.search(t), "表": rows[:40], "本文": t if NONE.search(t) else t[:1500]}
    audit = {}
    at = unicodedata.normalize("NFKC", sections.text_of(g("AuditsTextBlock")))
    m = re.search(r"監査法人の名称\s*[:：]?\s*\n?\s*([^\n]{2,40})", at)
    name = m.group(1).strip() if m else None
    if not name:
        m = re.search(r"((?:有限責任\s*)?[^\s、。()（）「」]{1,25}?(?:有限責任)?監査法人)", at)
        name = m.group(1).strip() if m else None
    if name:
        audit["名称"] = name
        m = re.search(r"継続監査期間\s*[:：]?\s*\n?\s*([^\n]{1,30})", at)
        if m:
            audit["継続監査期間"] = m.group(1).strip()
    return {"aff": aff[:200], "rights": rights, "ts": ts[:20], "acq": acq, "audit": audit}


YM = re.compile(r"(\d{4}|[明大昭平令][治正和成]?\s*\d{1,2}|[明大昭平令][治正和成]?元)\s*年\s*(\d{1,2}\s*月)?")


def parse_history(html):
    """沿革を [[年月, 事項], ...] にする。

    多くの会社は「年月｜事項」の2列の表。年月が「2009年４月」のほか、
    和暦や年だけのこともある。1列目に年が無い行（見出し）は捨てる。
    表になっていない会社は、本文の各行の先頭の年月で切る。
    """
    if not html:
        return []
    out = []
    # 1つのセルに複数の年月と出来事が改行区切りで入っている会社がある（7794）。
    # 改行がそのまま空白につぶれると1行につながるので、沿革だけは改行を区切りとして残す。
    SEP = "\u241e"
    marked = re.sub(r"<br\s*/?>|</p>|</div>", SEP, html, flags=re.I)
    for tab in sections.tables_of(marked):
        for row in tab:
            cells = [c for c in row if c and c.replace(SEP, "").strip()]
            if len(cells) < 2:
                continue
            parts = lambda c: [re.sub(r"\s+", " ", x).strip() for x in c.split(SEP) if x.strip()]
            yms = [unicodedata.normalize("NFKC", x) for x in parts(cells[0])]
            whats = parts(" ".join(cells[1:]).replace(SEP + " ", SEP))
            if len(yms) > 1 and len(yms) == len(whats) and all(YM.search(y) for y in yms):
                out.extend([y, w] for y, w in zip(yms, whats))
                continue
            # 年月と出来事の数が合わない（1つの年月に2段落の出来事がある）と、どれとどれが組か
            # 機械では決められない。取り違えると事実と違う沿革になるので、組にせず期間でまとめ、
            # 出来事は順に並べる。印として3つ目の要素に「未対応」を付ける。
            if len(yms) > 1 and all(YM.search(y) for y in yms):
                out.append([f"{yms[0]}〜{yms[-1]}", "／".join(whats), "未対応"])
                continue
            ym = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", cells[0].replace(SEP, " "))).strip()
            if not YM.search(ym):
                continue
            out.append([ym, re.sub(r"\s+", " ", " ".join(cells[1:]).replace(SEP, " ")).strip()])
    if out:
        return out
    for line in sections.text_of(html).split("\n"):
        t = unicodedata.normalize("NFKC", line).strip()
        m = YM.match(t)
        if m and len(t) > m.end() + 2:
            out.append([m.group(0).strip(), t[m.end():].strip(" 　:：")])
    return out


def save_all(own, sh, of, biz, div, web, segs, state):
    a = save_rows(OWNERSHIP, F_OWN, own)
    b = save_rows(SHAREHOLDERS, F_SH, sh)
    c = save_rows(OFFICERS, F_OF, of)
    d = save_rows(BUSINESS, F_BIZ, biz)
    e = save_rows(DIVIDEND, F_DIV, div)
    save_rows(WEBSITES, F_WEB, web)
    save_rows(SEGMENTS, F_SEG, segs)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1, sort_keys=True)
    return a, b, c, d, e


if __name__ == "__main__":
    main()
