#!/usr/bin/env python3
"""
po_parse.py — 公募増資・売出・第三者割当・自己株式処分のお知らせ（TDnetのPDFの文字）から項目を読む

数字はAIに読ませない。正規表現で拾い、拾えなければ空欄（None）。
本文は保存しない（TDnetの転載を避ける）。ここで読んだ数字と短い要点だけを残す。

お知らせの種類
  決議 … 新株式発行及び株式売出しに関するお知らせ／株式の売出しに関するお知らせ／
          第三者割当による新株式発行（自己株式処分）に関するお知らせ
  決定 … 発行価格及び売出価格等の決定に関するお知らせ（条件決定日に出る）
  完了 … 払込完了／第三者割当増資の結果・発行株式数の確定（OAに伴う第三者割当の最終株数）
  中止 … 新株式発行及び株式売出しの中止
  変更 … （訂正）（開示事項の変更）… 決議と同じように読み直す
"""
import re
import unicodedata

DATE = r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"
NUM = r"(\d[\d,]*(?:\.\d+)?)"


def norm(t):
    t = unicodedata.normalize("NFKC", t)
    # どのページにも入る注意書き（投資勧誘ではない旨）を落とす
    # （1行のことも、ページの終わりまで続くこともある。「行われません。」「ください。」で終わる）
    t = re.sub(r"ご注意\s*[::][\s\S]{0,700}?(?:行われません|ご注意ください|お願いいたします|ありません)。", "", t)
    t = re.sub(r"令和\s*(\d+|元)\s*年", lambda m: f"{2018 + (1 if m.group(1) == '元' else int(m.group(1)))}年", t)
    t = re.sub(r"[ \t　]+", " ", t)
    t = re.sub(r"\n\s*\n+", "\n", t)
    # 「売 出 価 格」のように1字ずつ空いた見出しを詰める（日本語の間の空白だけ）
    t = re.sub(r"(?<=[぀-ヿ一-鿿]) (?=[぀-ヿ一-鿿])", "", t)
    return t


def ymd(m, i=1):
    return f"{m.group(i)}-{int(m.group(i + 1)):02d}-{int(m.group(i + 2)):02d}"


def num(s):
    if s is None:
        return None
    v = float(s.replace(",", ""))
    return int(v) if v.is_integer() else v


def kind_of(title):
    if re.search(r"補足説明|説明資料|プレゼンテーション", title):
        return "参考"
    if re.search(r"中止", title):
        return "中止"
    # 「第三者割当増資における発行株式数の確定」はOAに伴う第三者割当の最終株数（HENNGE・IPS）
    if re.search(r"払込完了|払込みの完了|処分の完了|結果に関する|株式数の確定", title):
        return "完了"
    if re.search(r"決定(?:に関する|及び|のお知らせ)", title) and re.search(r"価格|価額|株式数", title) \
            and not re.search(r"内容の決定|発行に関する|処分に関する|売出しに関する", title):
        return "決定"
    if re.search(r"^[(（]\s*(?:訂正|変更|開示事項の変更|開示事項の経過)", title):
        return "変更"
    return "決議"


def sections(t):
    """「記」から「以上」までを「1.見出し」で区切る。(見出し, 本文) の並び。"""
    a = t.find("\n記\n")
    body = t[a:] if a >= 0 else t
    e = re.search(r"\n\s*<\s*ご参考\s*>|\n以上\n", body)
    main = body[:e.start()] if e else body
    out = []
    # 「I.新株式発行及び株式売出し 1.公募による…」のように大見出しの後に続くこともある
    ms = list(re.finditer(r"(?:^|\n)\s*(?:[IVX]+\s*\.[^\n]{0,40}?\s)?(\d{1,2})\s*\.\s*([^\n(]{2,60}?(?:\([^\n)]{0,40}\))?)(?=\s|\()", main))
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(main)
        out.append((m.group(2).strip(), main[m.end():end]))
    return out, body


# 説明のための節（OAの仕組み、ロックアップ、発行済株式総数の推移など）は株数を数えない
SKIP_HEAD = r"等について|ロックアップ|推移|使途|目的|理由|配分|異動|参考|概要について|経緯"


def shares(s):
    m = re.search(r"(?<![\d,.])(\d[\d,]*)\s*株(?!につき|当たり|主|式|価|券)", s)
    return num(m.group(1)) if m else None


def price(label, s, loose=False):
    label = f"(?:{label})"
    m = re.search(label + r"[\s\S]{0,40}?1\s*株(?:につき|当たり)\s*(?:金)?\s*" + NUM + r"\s*円", s)
    if m:
        return num(m.group(1))
    if not loose:
        return None
    # 表の見出しと値が離れて出る（ソディックの決定、セイファートの第三者割当）。見出しの後の最初の「◯円」。
    # 見出しは何度も出るので順に見る。「未定」「端数」を挟むなら価格ではない。
    for m in re.finditer(label + r"([\s\S]{0,300}?)(?<![\d,.])" + NUM + r"\s*円", s):
        if re.search(r"未定|端数|乗じた", m.group(1)):
            continue
        v = num(m.group(2))
        if v and 10 <= v < 1_000_000:  # 総額を拾わない（1株の価格が100万円以上の会社はまず無い）
            return v
    return None


# 法人の売出人。これに当たらなければ個人とみなす
CORP = (r"株式会社|有限会社|合同会社|合資会社|銀行|保険|相互会社|組合|財団|社団|法人|ファンド|証券|信託|"
        r"Fund|Inc|Ltd|LLC|L\.?P\b|PLC|Limited|Corp|Co\.|Partners|Capital|Holdings|Trust|"
        r"インク|エルピー|ピーエルシー|リミテッド|コーポレーション|トラスト|キャピタル|ホールディングス|パートナーズ")
ADDR = r"(?:都|道|府|県|市|区|町|村)[^\n]{0,30}(?:\d+\s*番|丁目|番地|号)"


def sellers(s):
    """売出しの節から売出人の名前を拾う。[(名前, "法人"|"個人")]"""
    m = re.search(r"\(\d+\)\s*(?:売出人|売出株式の所有者)(?:\s*及び\s*売出株式数)?", s)
    if not m:
        return []
    blk = s[m.end():]
    e = re.search(r"\(\d+\)|\n\s*\d+\s*\n|この文書は|\n\s*\d+\s*\.", blk)
    blk = blk[:e.start()] if e else blk[:400]
    blk = re.sub(r"\(上限\)", "", blk)
    lines = [l.strip() for l in blk.split("\n") if l.strip() and not re.search(ADDR, l)]
    counts = re.findall(r"(?<![\d,.])\d[\d,]*\s*株", blk)
    plain = [l for l in lines if not re.search(r"\d[\d,]*\s*株", l)]
    only = [l for l in lines if re.fullmatch(r"\d[\d,]*\s*株", l)]
    if counts and len(only) == len(counts) and len(plain) == len(counts):
        # 名前が並んだ後に株数が並ぶ形（ノースサンド）
        names = plain
    elif counts:
        # 「名前 ◯株」の形。名前が2行にまたがることがある（ダルトン）
        names = [re.sub(r"\s*\n\s*", "", re.sub(r"(?<=[A-Za-z,.])\s*\n\s*(?=[A-Za-z])", " ", x)) for x in re.split(r"(?<![\d,.])\d[\d,]*\s*株", "\n".join(lines))]
    else:
        names = lines[:1]
    out = []
    for n in names:
        n = re.sub(r"^[\s、,]+|[\s、,]+$", "", n)
        if 2 <= len(n) <= 80:
            out.append((n, "法人" if re.search(CORP, n, re.I) else "個人"))
    return out


def buyback(raw):
    """同時に開示した自己株式取得のお知らせから、取得し得る株式の総数と割合（発行済株式総数（自己株式を除く）に対する）。"""
    t = norm(raw)
    m = re.search(r"取得(?:し得る|する)株式の総数(?:の上限)?\s*(\d[\d,]*)\s*株[\s\S]{0,80}?割合\s*(\d+(?:\.\d+)?)\s*%", t)
    if not m:
        return None
    return {"株数": num(m.group(1)), "割合": num(m.group(2))}


def parse(raw, title):
    t = norm(raw)
    d = {"種別": kind_of(title)}
    m = re.search(DATE + r"(?:\s*\([^)]*\))?\s*(?:開催の|の|付の|付|に開催された)?\s*(?:当社)?(?:臨時)?取締役会", t)
    d["決議日"] = ymd(m) if m else None
    if not d["決議日"] and d["種別"] == "決議":
        # 「本日付の取締役会決議」… お知らせの日付（冒頭の最初の日付）
        m = re.search(DATE, t[:400])
        d["決議日"] = ymd(m) if m else None
    # 大株主どうしの市場外の相対取引による「売出し」（売出規制の対象。引受人による募集・売出しではない）
    d["市場外"] = bool(re.search(r"市場外[^。]{0,20}相対|相対取引", t)) and not re.search(r"引受人|買取引受", t)
    d["海外募集"] = bool(re.search(r"海外募集", t)) and not re.search(r"海外募集(?:は|を)行(?:わ|いま)せん", t)
    secs, body = sections(t)
    v = {"新株": 0, "海外": 0, "売出": 0, "OA": 0, "OA三者": 0, "処分": 0}
    seen = False
    found_sellers = []
    for head, s in secs:
        h = head
        k = None
        if re.search(SKIP_HEAD, re.sub(r"\([^)]*\)", "", h)):
            continue
        # 見出しの括弧が改行で切れることがある（「当社株式の売出し」＋次の行「(オーバーアロットメントによる売出し)」）
        if re.search(r"オーバーアロットメント", h) or ("(" not in h and re.match(r"\s*\(?\s*オーバーアロットメント", s)):
            k = "OA"
        elif re.search(r"海外募集", h):
            k = "海外"
        # 「野村證券」のように旧字の会社がある（NFKCでは證→証にならない。三協フロンテア）
        elif re.search(r"第三者割当", h) and re.search(r"オーバーアロットメント", t) and re.search(r"引受人|[証證]券株式会社", s[:600] + h):
            k = "OA三者"
        elif re.search(r"自己株式の処分|自己株処分|自己株式処分|^処分の(?:概要|要領)", h):
            k = "処分"
        elif re.search(r"新株式|募集株式|一般募集|増資|^募集の(?:概要|要領)", h):
            k = "新株"
        elif re.search(r"売出", h):
            k = "売出"
        if not k:
            continue
        if k == "売出":
            for x in sellers(s):
                if x not in found_sellers:
                    found_sellers.append(x)
        # 「発行新株式数及び処分自己株式数 3,123,800株 (内訳) 1 発行新株式数 200,000株 2 処分自己株式数 2,923,800株」（アドウェイズ）
        bn = re.search(r"内訳[\s\S]{0,40}?発行新株式数\s*(\d[\d,]*)\s*株[\s\S]{0,40}?処分(?:する)?自己株式(?:の)?数\s*(\d[\d,]*)\s*株", s)
        if k == "新株" and bn:
            v["新株"] += num(bn.group(1))
            v["処分"] += num(bn.group(2))
            seen = True
            continue
        n = shares(s)
        if n:
            # OAは上限の株数が説明の節にも繰り返し出るので、足さずに大きいほう
            v[k] = max(v[k], n) if k in ("OA", "OA三者") else v[k] + n
            seen = True
    if not seen:
        # 第三者割当・自己株式処分のお知らせは「1.募集（処分）の概要」の表に並ぶ。
        # 表の見出しと値が離れて出る（PDFの段組み）ので、見出しの後の最初の「◯株」を取る
        for k, pat in (("新株", r"発行(?:する)?新株式(?:の)?数"),
                       ("処分", r"処分(?:する)?株式(?:の種類)?(?:及び)?(?:の)?数?"),
                       ("売出", r"売出株式(?:の種類及び)?数")):
            # 「最近3年間のエクイティ・ファイナンスの状況」の過去の案件は見ない
            m = re.search(pat + r"[\s\S]{0,250}?(?<![\d,.])(\d[\d,]*)\s*株(?!につき|当たり|主|式)",
                          re.split(r"エクイティ・ファイナンスの状況", t)[0])
            if m:
                v[k] = num(m.group(1))
    d.update({k: (x or None) for k, x in v.items()})
    if not found_sellers and d.get("売出"):
        # 節に分けられなかったお知らせ（市場外の相対取引など）は本文の頭から
        found_sellers = sellers(re.split(r"オーバーアロットメント", t)[0])
    d["売出人"] = found_sellers or None

    # 価格（決定のお知らせ、第三者割当は決議の時点で決まっている）
    # 決議の時点で価格等決定日を待つもの（公募・売出）は、決定のお知らせまで価格を読まない
    loose = d["種別"] == "決定" or not re.search(r"価格等決定日", t)
    d["発行価格"] = price(r"発行価格\s*\(\s*募集価格\s*\)", t, loose) or (price(r"発行価額|払込金額", t, loose) if re.search(r"第三者割当", title) else None)
    d["売出価格"] = price(r"売出価格", t, loose)
    d["処分価格"] = price(r"処分価(?:額|格)", t, loose)
    if d["種別"] == "決議" and not loose:
        d["発行価格"] = d["売出価格"] = d["処分価格"] = None
    # 総額。PDFの段組みで見出しと値がずれると、1株の価格は隣の欄（引受価額・終値）を拾うことがある。
    # 総額÷株数で確かめるために持つ（po.py で使う）
    def total(label):
        if d["種別"] == "決議" and not loose:
            return None
        for m in re.finditer(f"(?:{label})" + r"([\s\S]{0,300}?)(?<![\d,.])" + NUM + r"\s*(百万円|千円|円)", t):
            if re.search(r"未定|上限", m.group(1)):
                continue
            v = num(m.group(2)) * {"百万円": 1_000_000, "千円": 1000, "円": 1}[m.group(3)]
            if v >= 1_000_000:
                return v
        return None
    d["発行価格の総額"] = total(r"発行価格の総額") or (total(r"払込金額の総額|発行価額の総額|調達資金の額") if re.search(r"第三者割当", title) else None)
    d["売出価格の総額"] = total(r"売出価格の総額|売出価額の総額")
    d["処分価額の総額"] = total(r"処分価額の総額|処分価格の総額")
    m = re.search(r"算定基準日(?:及びその価格)?[\s\S]{0,20}?" + DATE, t)
    d["算定基準日"] = ymd(m) if m else None
    # 基準株価：決定のお知らせは算定基準日の終値。第三者割当・自己株式処分は決議の前営業日の終値
    m = re.search(r"算定基準日及びその価格\s*" + DATE + r"(?:\s*\([^)]*\))?\s*" + NUM + r"\s*円", t)
    if m:
        d["基準株価"] = num(m.group(4))
    else:
        m = re.search(r"(?:直前|前)(?:取引日|営業日)[^。円]{0,60}?終値[^。\d]{0,15}?" + NUM + r"\s*円", t)
        d["基準株価"] = num(m.group(1)) if (m and loose) else None
    d["引受価額"] = price(r"引受価額", t, loose) if d["種別"] == "決定" else None
    if d["種別"] == "決定" and not d["引受価額"] and d.get("発行価格"):
        d["引受価額"] = price(r"払込金額", t, loose)
    m = re.search(r"発行新株式数\s*(\d[\d,]*)\s*株", t)
    d["発行新株式数_確定"] = num(m.group(1)) if (m and d["種別"] == "完了") else None
    d["プライム変更"] = bool(re.search(r"プライム市場への(?:上場)?(?:市場区分の)?(?:変更|移行)", t))
    m = re.search(r"ディスカウント率[\s\S]{0,40}?(\d+(?:\.\d+)?)\s*%", t)
    d["ディスカウント率"] = num(m.group(1)) if m else None

    # 条件決定日：決議では「◯日から◯日までの間のいずれかの日」、決定では算定基準日
    # 「(以下、「売出価格等決定日」…」と読点が入る会社、「まで」の後で改行する会社がある（ノースサンド）
    m = re.search(DATE + r"(?:\s*\([^)]*\))?\s*(?:から|~|〜)\s*" + DATE + r"(?:\s*\([^)]*\))?\s*ま\s*で\s*の\s*間\s*の\s*いずれかの日\s*\(\s*以下\s*[、,]?\s*「(?:発行|売出|処分)[^」]*決定日」", t)
    d["条件決定日_予定"] = f"{ymd(m)}〜{ymd(m, 4)}" if m else None
    if not m and d["種別"] == "決議":
        # 期間ではなく1日で決める会社（日本総険：「…2026年12月4日に決定する。」）
        m = re.search(r"(?:発行価格|売出価格|処分価格)[\s\S]{0,250}?" + DATE + r"\s*に決定", t)
        d["条件決定日_予定"] = ymd(m) if m else None
    # 受渡期日・払込期日は見出しの直後の日付だけ（離れた日付は自己株式取得の期間などを拾う）
    m = re.search(r"受渡期日\s*(?:\(\d+\))?\s*" + DATE, t)
    d["受渡日"] = ymd(m) if m else None
    m = re.search(r"受渡期日\s*((?:[^\n。]{0,40}?)営業日(?:の日)?)", t)
    d["受渡日_予定"] = m.group(1).strip() if (m and not d["受渡日"]) else None
    m = re.search(r"(?:払込|処分)期日\s*(?:\(\d+\))?\s*" + DATE, t)
    d["払込期日"] = ymd(m) if m else None

    m = re.search(r"現在の発行済株式総数[\s\S]{0,20}?(\d[\d,]*)\s*株", t)
    d["発行済株式数_お知らせ"] = num(m.group(1)) if m else None

    # 資金使途：「手取概算額…については、…充当」の1文を短く
    m = re.search(r"(?:手取(?:概算)?額|調達(?:する)?資金)[^。]{0,120}?(?:充当|充て)[^。]{0,40}。", body)
    if m:
        s = re.sub(r"\s+", "", m.group(0))
        d["資金使途"] = s[:160]
    else:
        d["資金使途"] = None
    m = re.search(r"割当予定先の概要[\s\S]{0,80}?名称\s*([^\n]{2,40})", t)
    d["割当先"] = m.group(1).strip() if m else None
    # 売先指定先：市場外の相対取引の買い手（「クラボウに対する市場外での相対取引」）、親引け先
    who = None
    if d["市場外"]:
        m = re.search(r"([^\s、。()「」]{2,40}?)との(?:戦略的)?(?:資本業務提携|業務資本提携|資本提携)", title)
        who = m.group(1) if m else None
    m = None if who else re.search(r"([^\s、。()「」]{2,40}?)に対する市場外", t)
    if m:
        # 「売出方法本売出人によるクラボウ」のように前の語がつながるので、最後の語だけ
        who = re.split(r"による|により|から|より|の", m.group(1))[-1]
        # 略称なら正式名に戻す（「倉敷紡績株式会社(以下「クラボウ」という。)」）
        f = re.search(r"([^\s、。()「」]{2,40}?)\s*\(以下[、,]?\s*「" + re.escape(who) + "」", t)
        if f:
            who = f.group(1)
    if not who:
        m = re.search(r"親引け先[\s\S]{0,40}?名称\s*([^\n]{2,40})", t)
        who = m.group(1).strip() if m else None
    d["売先指定先"] = who
    return d
