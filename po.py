#!/usr/bin/env python3
"""
po.py — 公募増資・売出・第三者割当・自己株式処分を TDnet から集めて一覧にする

  PO_DAYS=31 python po.py

1. TDnetの日ごとの開示一覧（公開は約1か月）から、表題で対象のお知らせを拾う
2. PDFを取り、pdftotext で文字にして po_parse で読む。PDFと本文は保存しない（転載を避ける）。
   残すのは読んだ数字と短い要点、同じ会社が同じ日に出した開示の表題だけ
3. お知らせを案件にまとめる（決議 → 条件決定 → 払込・受渡）。data/po/{id}.json と data/po.json

市場・業種はJPXの上場銘柄一覧、発行済株式数・自己株式数・議決権の個数・単元株式数は
有報（data/timeseries.csv）の最新期から。数字はAIに読ませない。
"""
import csv
import datetime
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time

import requests

import po_parse

DATA = "data"
DOC_DIR = os.path.join(DATA, "po")
STATE = os.path.join(DATA, "po_state.json")
OUT = os.path.join(DATA, "po.json")
JPX_CACHE = os.path.join(DATA, "jpx.json")
TS = os.path.join(DATA, "timeseries.csv")
LIST_URL = "https://www.release.tdnet.info/inbs/I_list_{p:03d}_{d}.html"
PDF_URL = "https://www.release.tdnet.info/inbs/{f}"
JPX_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx"
# 何日さかのぼって一覧を見るか。TDnetの公開は約1か月なので、それより前は取れない。
PO_DAYS = int(os.environ.get("PO_DAYS", "4") or 4)
# 読み取りの版。読み方を直したら変える。版が違うお知らせは、PDFが残っていれば読み直す。
PARSE_VERSION = "2026-11-03e"

INC = r"売出|新株式発行|新株式の発行|募集株式|自己株式の処分|自己株式処分|第三者割当|公募|発行価格|海外募集"
# 新株予約権（MSワラントは別の一覧）、株式報酬・従業員向け、子会社の増資、種類株式、IPO・立会外分売は外す
EXC = (r"新株予約権|ストック|譲渡制限|報酬|持株会|信託|ESOP|インセンティブ|奨励|子会社(?:と|の|による|である)|"
       r"引受け|引受に|引き受け|種類株式|優先株式|株式交付制度|再発防止|意思確認|資金使途|使途|上場|立会外|分売")
UA = {"User-Agent": "Mozilla/5.0 (compatible; edinet-jikeiretsu/1.0)"}


def log(*a):
    print(*a, flush=True)


def get(url, timeout=30):
    for i in range(3):
        try:
            r = requests.get(url, headers=UA, timeout=timeout)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r
        except requests.RequestException:
            time.sleep(2 + i * 3)
    return None


def load(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def save(path, obj, indent=None):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent, separators=None if indent is not None else (",", ":"))


def day_list(day):
    """その日の開示一覧（全ページ）。[{time, code, name, title, pdf}]"""
    rows, p = [], 1
    while True:
        r = get(LIST_URL.format(p=p, d=day.strftime("%Y%m%d")))
        if r is None:
            break
        h = r.content.decode("utf-8", "replace")
        for row in re.findall(r"<tr>(.*?)</tr>", h, re.S):
            t = re.search(r'kjTitle[^>]*><a href="([^"]+\.pdf)"[^>]*>(.*?)</a>', row, re.S)
            if not t:
                continue
            g = lambda k: re.sub(r"<.*?>", "", (re.search(k + r'[^>]*>(.*?)</td>', row, re.S) or [None, ""])[1]).strip()
            rows.append({"time": g("kjTime"), "code": g("kjCode"), "name": g("kjName"),
                         "title": re.sub(r"\s+", " ", re.sub(r"<.*?>", "", t.group(2))).strip(), "pdf": t.group(1)})
        if f"I_list_{p + 1:03d}_" not in h:
            break
        p += 1
    return rows


def pdf_text(name):
    r = get(PDF_URL.format(f=name), 60)
    if r is None:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = os.path.join(tmp, "a.pdf"), os.path.join(tmp, "a.txt")
        with open(src, "wb") as f:
            f.write(r.content)
        # -raw（PDFに書かれた順）。既定の段組み推定は pdftotext の版で並びが変わり、
        # 手元とGitHubで表の見出しと値の組み合わせがずれた（井関農機の売出価格に引受価額）
        subprocess.run(["pdftotext", "-raw", "-enc", "UTF-8", src, dst], check=True)
        with open(dst, encoding="utf-8", errors="replace") as f:
            return f.read()


def scan(st):
    """一覧を見て、対象のお知らせを読む。直近2日は毎回見直す（夕方の開示が翌日の一覧に入ることがある）。"""
    today = datetime.date.today()
    n = 0
    # 読み取りの版を上げたら、見た日も含めて一覧を見直す（PDFが残っている間だけ読み直せる）
    redo = st.get("版") != PARSE_VERSION
    for i in range(PO_DAYS):
        day = today - datetime.timedelta(days=i)
        key = day.isoformat()
        if key in st["days"] and i > 2 and not redo:
            continue
        rows = day_list(day)
        st["days"][key] = len(rows)
        for r in rows:
            if not (re.search(INC, r["title"]) and not re.search(EXC, r["title"])):
                continue
            nid = r["pdf"][:-4]
            old = st["notices"].get(nid)
            if old == PARSE_VERSION:
                continue
            raw = pdf_text(r["pdf"])
            if raw is None:
                log(f"  {key} {r['code']} {r['name']}: PDFを取れませんでした")
                continue
            d = po_parse.parse(raw, r["title"])
            same = [x["title"] for x in rows if x["code"] == r["code"] and x["pdf"] != r["pdf"]]
            rec = {"id": nid, "日": key, "時刻": r["time"], "コード": r["code"][:4], "会社名_TDnet": r["name"],
                   "表題": r["title"], "版": PARSE_VERSION, "同時開示": same, **d}
            save(os.path.join(DOC_DIR, f"{nid}.json"), rec)
            st["notices"][nid] = PARSE_VERSION
            n += 1
            log(f"  {key} {r['code']} {r['name']} [{d['種別']}] {r['title'][:40]} "
                f"新株{d['新株']} 売出{d['売出']} OA{d['OA']} 処分{d['処分']}")
    st["版"] = PARSE_VERSION
    return n




# ---------- 会社の属性 ----------

def jpx():
    """コード → {市場, 業種, 名前}。週に1回取り直す。"""
    cache = load(JPX_CACHE, {})
    if cache.get("_date") and (datetime.date.today() - datetime.date.fromisoformat(cache["_date"])).days < 7:
        return cache
    r = get(JPX_URL, 60)
    if r is None:
        return cache
    try:
        import openpyxl
        ws = openpyxl.load_workbook(io.BytesIO(r.content), read_only=True).active
        out = {"_date": datetime.date.today().isoformat()}
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i == 0 or not row[1]:
                continue
            mk = re.sub(r"[（(].*", "", str(row[3] or ""))
            c = str(row[1])[:4]
            # 同じコードで種類株式（社債型など）が並ぶことがある。普通株の行を採る。ETF・REITなどは要らない
            if c in out or re.search(r"種類株式|優先株|社債型", str(row[2])) or not re.search(r"株式|PRO", str(row[3])):
                continue
            out[c] = {"市場": mk, "業種": row[5] if row[5] != "-" else None, "名前": row[2]}
        save(JPX_CACHE, out)
        return out
    except Exception as e:  # 表の形が変わっても一覧の更新は止めない
        log(f"  JPXの上場銘柄一覧を読めませんでした（{e}）")
        return cache


def shares_info(codes):
    """有報の最新期の 発行済株式数・自己株式数・議決権の個数・単元株式数（timeseries.csv）。"""
    want = {"発行済株式数", "自己株式数", "議決権の個数", "単元株式数"}
    out = {}
    if not os.path.exists(TS):
        return out
    with open(TS, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            c = row["証券コード"]
            if c not in codes or row["指標"] not in want:
                continue
            key = (row["年度"], row["決算期"])
            cur = out.setdefault(c, {})
            if cur.get("_key", ("", "")) < key:
                out[c] = cur = {"_key": key, "基準": f"{row['年度']}年{row['決算期']}"}
            if cur["_key"] == key:
                try:
                    cur[row["指標"]] = int(float(row["値"]))
                except ValueError:
                    pass
    return out


# ---------- 案件にまとめる ----------

def short_name(n):
    return re.sub(r"^\s*株式会社\s*|\s*株式会社\s*$", "", n or "").strip() or n


def build():
    notes = []
    for fn in os.listdir(DOC_DIR) if os.path.isdir(DOC_DIR) else []:
        notes.append(load(os.path.join(DOC_DIR, fn), None))
    # 対象の決め方を変えたときに、前に読んだ対象外のお知らせが残らないように表題で選び直す
    notes = [n for n in notes if n and re.search(INC, n["表題"]) and not re.search(EXC, n["表題"])]
    notes.sort(key=lambda n: (n["日"], n.get("時刻") or ""))
    deals = {}

    def find(n):
        # 決定・完了・変更のお知らせは、本文の「◯日開催の取締役会において決議した」と同じ決議日の案件へ。
        # 無ければ同じ会社の、45日以内に決議した直近の案件へ。
        k = (n["コード"], n.get("決議日"))
        if k in deals:
            return deals[k]
        cand = [d for (c, r), d in deals.items() if c == n["コード"] and r and r <= n["日"]
                and (datetime.date.fromisoformat(n["日"]) - datetime.date.fromisoformat(r)).days <= 45]
        return max(cand, key=lambda d: d["決議日"]) if cand else None

    FIELDS = ("新株", "売出", "OA", "OA三者", "処分", "発行価格", "売出価格", "処分価格", "条件決定日_予定",
              "受渡日", "受渡日_予定", "払込期日", "発行済株式数_お知らせ", "資金使途", "割当先", "海外募集",
              "発行価格の総額", "売出価格の総額", "処分価額の総額", "市場外")
    for n in notes:
        kind = n["種別"]
        if kind == "参考":
            continue
        if kind == "決議":
            if not any(n.get(k) for k in ("新株", "売出", "処分")):
                continue
            k = (n["コード"], n.get("決議日") or n["日"])
            d = deals.setdefault(k, {"コード": n["コード"], "決議日": k[1], "お知らせ": [], "同時開示": [], "状態": "決議"})
            for f in FIELDS:
                if n.get(f) not in (None, False):
                    d[f] = n[f]
            d["会社名_TDnet"] = n["会社名_TDnet"]
            d["同時開示"] = sorted(set(d["同時開示"]) | set(n.get("同時開示") or []))
            d["お知らせ"].append({"id": n["id"], "日": n["日"], "表題": n["表題"], "種別": kind})
            # 第三者割当・自己株式処分は決議の時点で価格が決まっている
            # 市場外の相対取引による売出しも、価格は決議（連絡）の時点で決まっている
            if (re.search(r"第三者割当|自己株式の?処分", n["表題"]) or n.get("市場外")) and not n.get("OA"):
                d["条件決定日"] = d["決議日"]
            continue
        d = find(n)
        if d is None:
            continue
        d["お知らせ"].append({"id": n["id"], "日": n["日"], "表題": n["表題"], "種別": kind})
        if kind in ("決定", "変更"):
            for f in ("OA", "発行価格", "売出価格", "処分価格", "受渡日", "払込期日", "資金使途", "海外募集",
                      "発行価格の総額", "売出価格の総額", "処分価額の総額"):
                if n.get(f) not in (None, False):
                    d[f] = n[f]
            if kind == "変更":
                for f in ("新株", "売出", "処分", "条件決定日_予定"):
                    if n.get(f):
                        d[f] = n[f]
            if kind == "決定":
                d["条件決定日"] = n.get("算定基準日") or n["日"]
                d["ディスカウント率"] = n.get("ディスカウント率")
                d["状態"] = "条件決定"
        elif kind == "完了":
            d["状態"] = "払込完了"

    out = list(deals.values())
    j = jpx()
    si = shares_info({d["コード"] for d in out})
    for d in out:
        c = d["コード"]
        info = j.get(c) or {}
        d["市場"], d["業種"] = info.get("市場"), info.get("業種")
        d["会社名"] = short_name(info.get("名前") or d.get("会社名_TDnet"))
        s = si.get(c, {})
        d["発行済株式数"] = d.get("発行済株式数_お知らせ") or s.get("発行済株式数")
        d["自己株式数"] = s.get("自己株式数")
        d["株式数の基準"] = ("お知らせ" if d.get("発行済株式数_お知らせ") else s.get("基準"))
        d["自己株式数の基準"] = s.get("基準")
        vr, unit = s.get("議決権の個数"), s.get("単元株式数") or 100
        d["議決権株式数"] = vr * unit if vr else None
        d["議決権の基準"] = s.get("基準") if vr else None
        new, sec, tr, oa = d.get("新株") or 0, d.get("売出") or 0, d.get("処分") or 0, d.get("OA") or 0
        # 1株の価格を総額÷株数で確かめる。総額が1銭単位で割り切れ、読んだ価格と3割以上離れていなければ総額側を採る
        # （総額の欄を取り違えた場合に、まったく違う価格へ置き換えない）
        for pk, tk, q in (("発行価格", "発行価格の総額", new), ("売出価格", "売出価格の総額", sec), ("処分価格", "処分価額の総額", tr)):
            tot, cur = d.get(tk), d.get(pk)
            if tot and q:
                p = round(tot / q, 2)
                if abs(p * q - tot) < 1 and p != cur and (cur is None or abs(p / cur - 1) < 0.3):
                    d[pk] = int(p) if float(p).is_integer() else p
        # OAに伴う第三者割当があれば、OA分は新株（希薄化）。無ければ株主からの借株（売出）。
        oa_new = oa if d.get("OA三者") else 0
        oa_sec = oa - oa_new
        d["合計_OA除く"] = new + sec + tr or None
        d["合計_OA含む"] = new + sec + tr + oa or None
        base = d["議決権株式数"]
        r = lambda x: round(x / base * 100, 2) if base and x else None
        d["希薄化率_OA除く"] = r(new + tr)
        d["希薄化率_OA含む"] = r(new + tr + oa_new)
        d["売出の割合_OA除く"] = r(sec)
        d["売出の割合_OA含む"] = r(sec + oa_sec)
        pn = d.get("発行価格") or d.get("売出価格")
        ps = d.get("売出価格") or d.get("発行価格")
        pt = d.get("処分価格") or d.get("発行価格")
        amt = 0
        ok = True
        for q, p in ((new, pn), (sec, ps), (tr, pt)):
            if q:
                if p is None:
                    ok = False
                else:
                    amt += q * p
        d["募集金額_OA除く"] = round(amt) if ok and amt else None
        d["募集金額_OA含む"] = round(amt + oa * (ps or 0)) if ok and amt and (not oa or ps) else None
        d["種類"] = "・".join(x for x, q in (("公募", new and not re.search(r"第三者割当", " ".join(o["表題"] for o in d["お知らせ"]))),
                                            ("第三者割当", new and re.search(r"第三者割当", " ".join(o["表題"] for o in d["お知らせ"]))),
                                            ("売出", sec), ("自己株式処分", tr)) if q)
    out.sort(key=lambda d: d["決議日"] or "", reverse=True)
    gen = time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.gmtime(time.time() + 9 * 3600))
    save(OUT, {"generated": gen, "deals": out})
    return len(out)


def main():
    os.makedirs(DOC_DIR, exist_ok=True)
    st = load(STATE, {"days": {}, "notices": {}})
    n = scan(st)
    save(STATE, st, indent=0)
    m = build()
    log(f"■ 公募・売出：今回 {n}件のお知らせを読み、一覧 {m}件")


if __name__ == "__main__":
    main()
