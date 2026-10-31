#!/usr/bin/env python3
"""
ms_parse.py — 有価証券届出書の本文から、MSワラント（行使価額修正条項付新株予約権）の項目を読む

数字はAIに読ませず、届出書の決まった言い回しから拾う。拾えなかった項目は空欄（None）にし、
推測で埋めない。1つの届出書に第◯回・第◯回と複数の回号があるときは回号ごとに読む
（固定価額の回号や転換社債も同じ届出書に入ることがある。アンジェス2026-08）。

入力は ms_probe.to_text と同じ形の文字列（表のセルは「｜」で区切る）。
"""
import re
import unicodedata


def norm(t):
    """全角数字・記号をならし、空行をつめる。「｜」はそのまま残す。"""
    t = unicodedata.normalize("NFKC", t or "").replace("｜", "\u0001")
    t = t.replace("|", "\u0001").replace("\u0001", "｜")
    t = re.sub(r"[ \t]*\n[\s\n]*", "\n", t)
    # 和暦（令和）は西暦に直す（アイビー化粧品は「令和8年8月5日」）
    t = re.sub(r"令和\s*(\d+|元)\s*年", lambda m: f"{2018 + (1 if m.group(1) == '元' else int(m.group(1)))}年", t)
    return t


def num(s):
    if s is None:
        return None
    s = str(s).replace(",", "").strip()
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return None


DATE = r"(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日"


def ymd(m, i=1):
    return f"{m.group(i)}-{int(m.group(i + 1)):02d}-{int(m.group(i + 2)):02d}"


def first(pattern, text, group=1, flags=0):
    m = re.search(pattern, text, flags)
    return m.group(group) if m else None


def earliest(patterns, text):
    """いくつかの書き方のうち、本文で最も前に出てくるものの値。
    書き方ごとに優先順を付けると、注記の中の別の回号の説明を先に拾ってしまう（シンバイオ第70回）。"""
    best = None
    for p in patterns:
        m = re.search(p, text)
        if m and (best is None or m.start() < best.start()):
            best = m
    return best.group(1) if best else None


def cell_after(label, text, span=1500):
    """「label｜値｜」の値。表のセルが複数に割れていても、次の「｜」までを返す。"""
    m = re.search(re.escape(label) + r"\s*｜\s*", text)
    if not m:
        return None
    rest = text[m.end():m.end() + span]
    return rest.split("｜", 1)[0].strip()


# ---- 回号ごとの区切り --------------------------------------------------------

TRANCHE = re.compile(r"\n\s*\d+\s*【新規発行(新株予約権証券|新株予約権付社債)[^】]*?第\s*(\d+)\s*回[^】]*】")
DEAL_END = re.compile(r"【新規発行による手取金の使途】|【新規発行による手取金の額】")


def tranches(text):
    """[(回号, 種類, 本文)]。種類は「新株予約権」か「新株予約権付社債」。"""
    heads = list(TRANCHE.finditer(text))
    out = []
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        e2 = DEAL_END.search(text, m.end())
        if e2 and e2.start() < end:
            end = e2.start()
        kind = "新株予約権付社債" if m.group(1) == "新株予約権付社債" else "新株予約権"
        out.append((int(m.group(2)), kind, text[m.start():end]))
    return out


# ---- 回号の項目 --------------------------------------------------------------

def fraction_rule(s):
    """「0.1円未満の端数を切り上げ」→ "0.1円未満切り上げ"。"""
    m = re.search(r"(\d+(?:\.\d+)?円|\d+銭)未満の端数[^。]{0,25}?(切り?上げ|切り?捨て|四捨五入)", s)
    if not m:
        return None
    how = {"切上げ": "切り上げ", "切捨て": "切り捨て"}.get(m.group(2), m.group(2))
    return f"{m.group(1)}未満{how}"


def parse_tranche(no, kind, s):
    r = {"回号": no, "種類": kind}
    r["修正条項付"] = bool(re.search(r"(?:行使|転換)価額の修正基準|(?:行使|転換)価額の修正頻度|修正日価額", s))
    r["発行数_個"] = num(first(r"発行数\s*｜\s*([\d,]+)\s*個", s))
    r["1個当たり株数"] = num(first(r"新株予約権\s*1\s*個(?:当たり|につき)[^0-9｜]{0,20}?([\d,]+)\s*株", s))
    r["潜在株式数"] = num(first(r"(?:株式の種類及び総数は|総数は)[^。]{0,60}?([\d,]+)\s*株", s))
    if r["潜在株式数"] is None and r["発行数_個"] and r["1個当たり株数"]:
        r["潜在株式数"] = r["発行数_個"] * r["1個当たり株数"]
    r["払込金額_新株予約権"] = num(first(r"発行価額の総額\s*｜\s*([\d,]+)\s*円", s))
    price = cell_after("発行価格", s) or ""
    r["評価額_1株当たり"] = num(first(r"1\s*株(?:当たり|につき)\s*([\d,]+(?:\.\d+)?)\s*円", price))
    r["評価額_1個当たり"] = num(first(r"^(?:新株予約権\s*1\s*個につき)?\s*([\d,]+(?:\.\d+)?)\s*円", price))

    # 当初行使価額。「行使価額」という。)は、当初50.0円とする。下限の「当初25.0円」と取り違えない。
    # 書き方：「行使価額」という。)は、当初50.0円／といいます。)は、当初1,215円／当初、金63円／
    # 当初行使価額である72円／（MSCB）「転換価額」という。)は、当初、500円
    r["当初行使価額"] = num(earliest([
        r"「(?:行使|転換)価額」と(?:いう|いいます)。?[)）]?(?:は|を)?、?\s*当初\s*、?\s*金?\s*([\d,]+(?:\.\d+)?)\s*円",
        r"当初(?:行使|転換)価額(?:は|である)、?\s*金?\s*([\d,]+(?:\.\d+)?)\s*円",
        r"(?<!下限)(?:行使|転換)価額は、?\s*当初\s*、?\s*金?\s*([\d,]+(?:\.\d+)?)\s*円"], s))

    # 行使価額の修正：修正の基準（何％か）・頻度・端数
    mod = ""
    m = re.search(r"(?:行使|転換)価額の修正(?!頻度)", s)
    if m:
        mod = s[m.start():m.start() + 2500]
    r["修正_基準価格の何%"] = num(first(r"(\d+(?:\.\d+)?)\s*%\s*に相当する金額", mod))
    m = re.search(r"(?:行使|転換)価額の修正頻度[\s｜]*([^｜\n。]{1,80})", s)
    r["修正頻度"] = m.group(1).strip() if m else None
    r["修正の型"] = None
    if r["修正条項付"]:
        m6 = re.search(r"(\d+)\s*(?:か|ヶ|ケ|カ)月(?:ごと|毎)", mod)
        freq = r["修正頻度"] or ""
        # 修正頻度の欄の書き方を先に見る。注記に別の型の説明が出てくることがあるので、本文全体では決めない。
        r["修正の型"] = ("毎取引日" if re.search(r"1\s*取引日が経過する(?:毎|ごと)|毎取引日", freq + mod[:600])
                       else f"{m6.group(1)}か月ごと" if m6
                       else "行使の都度" if re.search(r"都度", freq)
                       else "会社の選択で修正" if re.search(r"修正選択決議|当社取締役会の決議により[^。]{0,40}修正", mod)
                       else "行使の都度" if re.search(r"行使請求の効力発生日|行使請求に係る通知|修正日」と", mod)
                       else None)
        # 会社の選択で修正する型でも、修正頻度の欄は「都度」と書かれることがある（直前の修正から6か月以上など）
        if r["修正の型"] == "行使の都度" and re.search(r"修正選択決議|当社取締役会の決議により[^。]{0,60}修正", mod):
            r["修正の型"] = "会社の選択で修正（行使の都度）"
    r["修正時の端数処理"] = fraction_rule(mod)

    # 上限・下限
    r["上限行使価額"] = "なし" if re.search(r"行使価額の上限\s*[:：]?\s*(?:なし|該当事項なし|ありません)", s) else \
        num(first(r"上限行使価額[^。\n]{0,20}?(?:は|:|：)\s*、?\s*(?:当初)?\s*([\d,]+(?:\.\d+)?)\s*円", s))
    r["下限行使価額"] = num(earliest([r"行使価額の下限\s*[:：]\s*(?:当初)?\s*([\d,]+(?:\.\d+)?)\s*円",
                                     r"行使価額の下限は、?\s*(?:当初)?\s*([\d,]+(?:\.\d+)?)\s*円",
                                     r"([\d,]+(?:\.\d+)?)\s*円\s*[(（](?:[^()（）]{0,80}[)）]\s*[(（])?以下[^)）]{0,80}?「下限行使価額」",
                                     r"行使価額の下限[\s｜]*当初\s*([\d,]+(?:\.\d+)?)\s*円",
                                     r"下限行使価額は、[\s\S]{0,120}?に相当する\s*([\d,]+(?:\.\d+)?)\s*円",
                                     r"「下限行使価額」とは、?\s*([\d,]+(?:\.\d+)?)\s*円",
                                     r"「下限行使価額」という。?[)）]?は、?\s*当初\s*、?\s*([\d,]+(?:\.\d+)?)\s*円",
                                     r"下限行使価額[^。\n]{0,30}?(?:は|:|：)\s*、?\s*(?:当初)?\s*([\d,]+(?:\.\d+)?)\s*円"], s))
    # 下限行使価額が当初行使価額を上回ることは無い。上回るなら別の金額（資金調達額の下限など）を拾っている。
    if r["下限行使価額"] is not None and r["当初行使価額"] is not None and r["下限行使価額"] > r["当初行使価額"]:
        r["下限行使価額"] = None
    if r["下限行使価額"] is not None and r["下限行使価額"] >= 1e6:
        r["下限行使価額"] = None
    r["下限_基準価格の何%"] = num(first(r"下限行使価額[^。]{0,160}?(\d+(?:\.\d+)?)\s*%\s*(?:に相当する|を乗じた)", s)
                              or first(r"行使価額の下限[^。]{0,160}?(\d+(?:\.\d+)?)\s*%\s*(?:に相当する|を乗じた)", s))
    # 下限行使価額そのものを後から修正（変更・引下げ）できるか。調整（株式分割など）とは別。
    r["下限行使価額の修正"] = "有" if re.search(
        r"下限行使価額を(?:修正|変更|引き?下げ)|下限行使価額の(?:修正|変更|引下げ|引き下げ)(?!.{0,5}調整)", s) else "無"

    # 行使期間
    per = cell_after("新株予約権の行使期間", s) or ""
    m = re.search(DATE + r"[\s\S]{0,40}?から[\s\S]{0,40}?" + DATE, per)
    r["行使開始日"], r["行使終了日"] = (ymd(m, 1), ymd(m, 4)) if m else (None, None)

    # 条件決定日（決議日の翌日以降に条件を決める型）
    cd = re.search(r"条件決定日", s)
    r["条件決定日の有無"] = "有" if cd else "無"
    m = re.search(DATE + r"[^。]{0,40}?「条件決定日」", s) or re.search(r"条件決定日[^。]{0,40}?" + DATE, s)
    r["条件決定日"] = ymd(m) if m else None

    # プット（割当予定先・新株予約権者から会社に取得を求められる）
    r["プット"] = "有" if re.search(
        r"(?:割当予定先|新株予約権者|本新株予約権者|割当先)(?:は|が)[^。]{0,160}?(?:取得を請求|取得することを請求|取得するよう請求|買取り?を請求|買い取ることを請求)", s) else "無"
    r["停止指定"] = "有" if re.search(r"停止指定|行使停止", s) else "無"
    return r


# ---- 届出書全体の項目 --------------------------------------------------------

def parse_deal(text):
    t = norm(text)
    i = t.find("第一部")
    body = t[i:] if i >= 0 else t
    d = {}
    d["ASR"] = bool(re.search(r"ファシリティ型自己株式取得|\(ASR\)|（ASR）", body))
    m = re.search(DATE + r"(?:\([^)]*\))?\s*(?:に開催された|開催の|付の|付)?\s*(?:当社)?取締役会(?:において|決議|の決議)", body)
    d["決議日"] = ymd(m) if m else None
    names = [re.sub(r"\s+", " ", m.group(1)).strip()
             for m in re.finditer(r"割当予定先の概要[\s\S]{0,150}?名称\s*｜\s*([^｜]+?)\s*｜", body)]
    d["割当予定先"] = "、".join(dict.fromkeys(names)) or None

    # 手取金：払込金額の総額・発行諸費用の概算額・差引手取概算額（見出しの3セルの後に数字が3つ）
    d["払込金額の総額"] = d["発行諸費用の概算額"] = d["差引手取概算額"] = None
    m = re.search(r"【新規発行による手取金の額】", body)
    if m:
        seg = body[m.end():m.end() + 1500]
        nums = [num(x) for x in re.findall(r"｜\s*([\d,]{4,})\s*(?=｜|\n)", "｜" + seg)]
        nums = [x for x in nums if x is not None][:3]
        if len(nums) == 3:
            d["払込金額の総額"], d["発行諸費用の概算額"], d["差引手取概算額"] = nums
        d["発行諸費用の内訳"] = first(r"発行諸費用の概算額(?:の内訳)?は、([^。]{5,400}?)(?:の合計額|です|であります|となります)", seg)
    else:
        d["発行諸費用の内訳"] = None
    d["発行諸費用率"] = (round(d["発行諸費用の概算額"] / d["払込金額の総額"], 4)
                     if d["発行諸費用の概算額"] and d["払込金額の総額"] else None)

    # 手取金の使途：具体的な使途｜金額｜支出予定時期 の行
    d["資金使途"] = []
    m = re.search(r"【手取金の使途】", body)
    if m:
        seg = body[m.end():m.end() + 4000]
        h = re.search(r"支出予定時期\s*｜", seg)
        if h:
            cells = [c.strip() for c in seg[h.end():].split("｜")]
            row = []
            for c in cells:
                if c.startswith("(注)") or re.match(r"^(合計|計|合\s*計)$", c):
                    break
                if not c:
                    continue
                row.append(c)
                # 時期のセル（2026年9月~2028年4月、2026年8月 など）で1行が終わる
                if re.search(r"\d{4}年\s*\d{1,2}月|以降|随時", c) and len(row) >= 2:
                    amt = next((x for x in reversed(row[:-1]) if re.fullmatch(r"[\d,]+(?:\.\d+)?\s*(?:百万円|千円|円|億円)?", x)), None)
                    what = " ".join(x for x in row[:-1] if x is not amt)
                    d["資金使途"].append({"使途": re.sub(r"\s+", " ", what), "金額": amt, "支出予定時期": row[-1]})
                    row = []
        d["使途の単位"] = first(r"金額\s*[(（]([^)）]+)[)）]", seg) if m else None

    # 希薄化率
    # 希薄化率（議決権ベースを優先）。「希薄化率(…。以下同じです。)は45.88%」のように括弧の中に句点が入る。
    d["希薄化率"] = num(first(r"希薄化率[\s\S]{0,300}?は\s*(\d+(?:\.\d+)?)\s*%", body)
                     or first(r"議決権(?:の)?総数[^。]{0,40}?に対し(?:て)?\s*(\d+(?:\.\d+)?)\s*%", body)
                     or first(r"総議決権数の\s*(\d+(?:\.\d+)?)\s*%", body)
                     or first(r"(\d+(?:\.\d+)?)\s*%[^。]{0,40}?(?:の希薄化|希薄化が生じ)", body))
    # 貸株（割当予定先が株を借りるか）。割当予定先ごとに書かれることがあるので、文ごとに見る。
    # 「貸株を利用する予定」「貸株を継続する予定」「株券貸借契約を締結しております」→ 有、
    # 「締結する予定はありません」だけ → 無。
    sents = [x + "。" for x in re.split(r"。", body) if re.search(r"貸株|株券貸借|借株", x)]
    pos = [x for x in sents if re.search(r"(?:貸株|株券貸借|借株)[^。]{0,80}?(?:利用する予定|継続する予定|締結する予定であり|締結する予定です|締結しております|締結しました|締結します|を行う予定)", x)
           and not re.search(r"(?:貸株|株券貸借)[^。]{0,40}?予定はありません", x)]
    neg = [x for x in sents if re.search(r"予定はありません|締結しておりません|行っておりません|該当事項はありません", x)]
    d["貸株"] = "有" if pos else "無" if neg else ("記載あり" if sents else None)
    d["貸株の内容"] = (re.sub(r"\s+", " ", re.sub(r"^[\s\S]*?(?:取決めの内容|株券貸借に関する契約)\s*", "", pos[0])).strip()[:200]
                     if pos else None)
    d["回号"] = [parse_tranche(no, kind, s) for no, kind, s in tranches(body)]
    d["複数回号"] = "有" if len([x for x in d["回号"] if x["種類"] == "新株予約権"]) > 1 else "無"
    return d
