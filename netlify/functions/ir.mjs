// 会社のIRページから、決算短信・決算説明資料・中期経営計画などを拾ってくる。
//
// EDINETには決算短信も説明資料も中計も入っていない（適時開示と会社のIRページ）。
// 提案の材料としては有報より新しい四半期の数字が効くので、そこを取りに行く。
// 取りに行くのは会社のIRページだけ。TDnetは叩かない。同じものが会社のページにある。
//
//   mode=find … ページをたどってPDFの一覧を作る
//   mode=text … PDFを1本読んで本文を返す
//
// 押されたときだけ動く。まとめて巡回はしない。
//
// IRページはJavaScriptで組み立てられていることが多く、HTMLを読むだけでは
// 資料が1本も見つからない。実際の作りはこうなっていた。
//
//   会社のページ → /ir/parts/xxx.js（会社のサイト上の小さなJS）
//                 → //ssl4.eir-parts.net/V4Public/EIR/<コード>/ja/... .js（配信元のJSONP）
//
// 最後のJSONPに、題名・日付・PDFのURL・ページ数が構造化されて入っている。
// ブラウザと同じ順にたどれば、静的な取得だけで届く。

import { extractText, getDocumentProxy } from "unpdf";

const UA = "yu-ho-matome/1.0 (IR document reader)";
const TIMEOUT = 10000;
const MAX_HTML = 5 * 1024 * 1024;
const MAX_PDF = 25 * 1024 * 1024;
const MAX_TEXT = 120000;
const MAX_FETCH = 34;      // 1回の探索で叩く上限。相手に負担をかけないため。
const BUDGET = 18000;      // 全体の持ち時間。関数の上限(26秒)より手前で切り上げる。

// IRページ・IR用JSらしさの見分け方。会社ごとにばらばらなので広めに取る。
const IR_HINT = /(^|[\/_.-])(ir|investor|investors|library|kessan|tanshin|press|material|financial|highlight)([\/_.-]|$)|IR情報|IRライブラリ|投資家|株主|決算|資料/i;

const DOC_HINT = {
  決算短信: /決算短信/,
  決算説明資料: /説明(会)?資料|決算説明|決算プレゼン|プレゼンテーション/,
  中期経営計画: /中期経営計画|中期計画|中計|経営計画|長期(経営)?ビジョン|成長戦略|事業計画/,
  有価証券報告書: /有価証券報告書|四半期報告書|半期報告書/,
  招集通知: /招集ご?通知|株主総会/,
  統合報告書: /統合報告|アニュアルレポート|統合レポート/,
  適時開示: /お知らせ|に関する|修正|開示/,
};

// 「決算説明動画及び資料公開のお知らせ」のように、資料の名前を含んだ“告知”がある。
// 中身は1ページの案内文で、資料そのものではない。題名の終わりで見分ける。
const NOTICE = /(お知らせ|ご案内|について)\s*[)）]?\s*$/;

function bad(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * 取りに行ってよいURLかを確かめる。
 * 公開された窓口なので、社内ネットワークや実行環境のメタデータへ
 * 踏みに行かせないよう、ホスト名の時点で断る。
 */
function safeURL(raw, base) {
  let u;
  try { u = new URL(raw, base); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return null;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return null;
  // IPアドレス直書きは私設網や実行環境のメタデータを指せるので一律で断る。
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return null;
  if (!h.includes(".")) return null;
  return u;
}

function makeFetcher(deadline) {
  let count = 0;
  return async function get(url, limit) {
    if (count >= MAX_FETCH) return { error: "これ以上たどりません" };
    if (Date.now() > deadline) return { error: "時間切れ" };
    count++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(TIMEOUT, deadline - Date.now()));
    try {
      const res = await fetch(url, {
        redirect: "follow", signal: ac.signal,
        headers: { "user-agent": UA, "accept-language": "ja,en" },
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const len = Number(res.headers.get("content-length") || 0);
      if (len && len > limit) return { error: `大きすぎます（${Math.round(len / 1e6)}MB）` };
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > limit) return { error: "大きすぎます" };
      return { buf, url: res.url, type: res.headers.get("content-type") || "" };
    } catch (e) {
      return { error: e.name === "AbortError" ? "応答がありません" : "取得できません" };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * 文字コードを当てる。日本語のIRページはShift_JISのこともある。
 *
 * IRサイトのJSにはUTF-16で書かれたものがあり、UTF-8として読むと
 * 中身が全部文字化けして、配信元のURLが1つも見つからなかった。
 * BOMがあればそれを優先する。
 */
function decode(buf, type) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
  const pick = (s) => (/charset=["']?([\w-]+)/i.exec(s || "") || [])[1];
  let cs = pick(type);
  if (!cs) cs = pick(new TextDecoder("utf-8").decode(buf.slice(0, 2048)));
  try { return new TextDecoder(cs || "utf-8").decode(buf); }
  catch { return new TextDecoder("utf-8").decode(buf); }
}

const unesc = (s) => s
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
const strip = (s) => unesc(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** 2026.09.11 / 2026年9月11日 / 2026-09-11 を拾う。 */
function findDate(s) {
  const m = /(20\d{2})[.\-年\/](\d{1,2})[.\-月\/](\d{1,2})/.exec(String(s || ""));
  if (!m) return null;
  const p = (v) => String(v).padStart(2, "0");
  return `${m[1]}-${p(m[2])}-${p(m[3])}`;
}

/**
 * たどる順番を決める点数。高いものから見に行く。
 *
 * 何も考えずに出てきた順で追うと、会社案内やガバナンスのページで
 * 上限を使い切ってしまい、肝心の資料までたどり着けなかった。
 * 資料の実体を持っているのは、IR用のJSと配信元のJSなので、そこを先に見る。
 */
function score(url) {
  const u = url.toLowerCase();
  let n = 0;
  if (/\.js(\?|$)/.test(u)) n += 8;                       // JSが資料の実体を持っている
  if (/eir-parts|pronexus|net-ir|irwebsite|nikkei|qri/.test(u)) n += 8;  // 配信元
  if (/\/parts\//.test(u)) n += 4;
  if (/tanshin|material|press|library|kessan|setsumei|presentation/.test(u)) n += 4;
  if (/chuki|chukei|plan|vision|meeting|yuho|report/.test(u)) n += 2;
  // ライブラリの下の各ページ（短信・説明資料・その他）は、
  // それぞれが別の配信元JSを抱えている。ここを回らないと種類が偏る。
  if (/\/(library|shiryou|shiryo|ir_?data)\/[^\/]*\.html?$/.test(u)) n += 5;
  if (/governance|faq|calendar|policy|disclaimer|contact|strength|news/.test(u)) n -= 6;
  return n;
}

/**
 * 題名やページの中に日付が無いとき、URLから拾う。
 *
 * 適時開示のPDFはファイル名に提出日が入っている。
 *   140120260805510138.pdf → 1401（書類の種類）+ 20260805（提出日）+ 連番
 * 「決算短信（PDF）835KB」のように題名が定型で、日付が表の別の列にある
 * サイトでは、これが唯一の手がかりになる。
 */
function dateFromURL(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return null; }
  const ok = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31)
    ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
  // 20260805 のように続いているもの。いちばん後ろを採る（連番と紛れにくい）。
  const runs = [...path.matchAll(/(20\d{2})(\d{2})(\d{2})/g)];
  for (const m of runs.reverse()) {
    const v = ok(m[1], Number(m[2]), Number(m[3]));
    if (v) return v;
  }
  // /2026/08/05/ のように区切られているもの。
  const sep = /(20\d{2})[\/\-_](\d{1,2})[\/\-_](\d{1,2})(?![\d])/.exec(path);
  if (sep) return ok(sep[1], Number(sep[2]), Number(sep[3]));
  return null;
}

function classify(title) {
  // 題名が「〜のお知らせ」で終わるものは、資料ではなく告知。
  // これを外さないと、28ページの決算説明資料より1ページの告知が先に並ぶ。
  if (NOTICE.test(title)) return "適時開示";
  for (const [kind, re] of Object.entries(DOC_HINT)) if (re.test(title)) return kind;
  return "その他";
}

const isPdf = (s) => typeof s === "string" && /^https?:\/\/[^\s"']+\.pdf(\?|$)/i.test(s);

/** HTMLの中の、PDFへのリンク。 */
function fromHTML(html, base) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = safeURL(unesc(m[1]), base);
    if (!u) continue;
    const title = strip(m[2]).slice(0, 120);
    // 日付はリンクの外に置かれることが多い。同じ行の中だけを見る。
    // 行をまたぐと別の資料の日付を拾ってしまう。
    let before = html.slice(Math.max(0, m.index - 300), m.index);
    // <dt>日付</dt><dd><a>題名</a></dd> の形があるので <dd> では切らない。
    // 切ると日付が窓の外に出てしまう。
    const cut = Math.max(before.lastIndexOf("<tr"), before.lastIndexOf("<li"),
                         before.lastIndexOf("<dt"));
    if (cut >= 0) before = before.slice(cut);
    out.push({
      url: u.toString(), title: title || "（題名なし）",
      date: findDate(title) || findDate(strip(before)) || dateFromURL(u.toString()),
      kind: classify(title),
    });
  }
  return out;
}

/**
 * 配信元のJSONP（またはJSON）から資料を拾う。
 * 項目名は資料の種類ごとに違う（tanshin_type / material_type / title など）ので、
 * 名前では探さず、PDFのURLを持つオブジェクトを見つけて、その中から
 * いちばん説明的な文字列を題名として採る。
 */
function fromJSON(text) {
  let data;
  const i = text.indexOf("("), j = text.lastIndexOf(")");
  const body = (i > 0 && j > i) ? text.slice(i + 1, j) : text;
  try { data = JSON.parse(body); } catch { return []; }

  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;

    const links = Object.values(node).filter(isPdf);
    if (links.length) {
      const strs = Object.entries(node)
        .filter(([k, v]) => typeof v === "string" && v.length > 4 && !isPdf(v)
                && !/^https?:/.test(v) && !/_size$/.test(k))
        .map(([, v]) => v);
      // 題名は「いちばん長い文字列」で当たるが、日付時刻の文字列
      //（"2026/09/14 13:40:00"）が題名より長いことがあり、それを拾ってしまった。
      // 数字と記号だけのものは題名ではないので外す。
      const words = strs.filter((v) => /[^\d\s\/:.\-]/.test(v));
      const title = words.sort((a, b) => b.length - a.length)[0] || "（題名なし）";
      const date = findDate(node.date) || findDate(node.format_date)
        || findDate(strs.find((s) => findDate(s)) || "")
        || dateFromURL(links[0]);
      for (const url of links) {
        const u = safeURL(url);
        if (!u) continue;
        out.push({
          url: u.toString(), title: title.slice(0, 120), date,
          kind: classify(title), pages: node.page_num || null,
        });
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(data);
  return out;
}

/**
 * 配信元(E-IR)のURLは規則的で、こうなっている。
 *   //ssl4.eir-parts.net/V4Public/EIR/<コード>/ja/<種別>/<種別>_<番号>.js
 * 実物では press_2=決算短信、press_3=プレスリリース、ir_material_5=その他資料 だった。
 *
 * 1本見つかれば兄弟も同じ形なので、会社のページを順に追うより直接叩くほうが
 * 確実で速い。番号は会社ごとに違うので、少ない範囲だけ当たってみる。
 */
const EIR_CATS = { press: 5, ir_material: 6, yuho: 3, meeting: 2 };

/**
 * 証券コードだけで当てにいく配信元のURL。
 *
 * 会社のページをたどらなくても、ここに当たれば資料が全部取れる。
 * 実測では8社中2社が当たった（7794、4893）。
 * とくに4893は会社のサイトすら分からない会社で、これ以外に手が無かった。
 *
 * パスの大文字小文字は会社によって違う（EIR と eir の両方が実在する）。
 * サーバーが区別するので、両方あたる。
 */
function eirSeeds(code) {
  const out = [];
  for (const dir of ["eir", "EIR"]) {
    const b = `https://ssl4.eir-parts.net/V4Public/${dir}/${code}/ja`;
    out.push(`${b}/announcement/announcement_0.js`);
    out.push(`${b}/press/press_2.js`);
  }
  return out;
}

function eirSiblings(url) {
  const m = /^(https?:\/\/[^\/]+\/V4Public\/EIR\/[^\/]+\/[a-z]{2})\/[^\/]+\/[^\/]+\.js/i.exec(url);
  if (!m) return [];
  const out = [];
  for (const [cat, max] of Object.entries(EIR_CATS)) {
    for (let n = 1; n <= max; n++) out.push(`${m[1]}/${cat}/${cat}_${n}.js`);
  }
  return out;
}

/** 次にたどる先。同じ会社のIRページと、IR用のJS。 */
function nextLinks(text, base, isHTML) {
  const host = new URL(base).hostname;
  const out = [];
  const add = (raw) => {
    const u = safeURL(raw, base);
    if (u) out.push(u.toString());
  };
  if (isHTML) {
    // IR用のJS。ここに配信元のURLが書かれている。
    const s = /<script\b[^>]*src=["']([^"']+\.js[^"']*)["']/gi;
    let m;
    while ((m = s.exec(text)) !== null) {
      const raw = unesc(m[1]);
      if (IR_HINT.test(raw)) add(raw);
    }
    // 同じ会社のIRページ
    const a = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
    while ((m = a.exec(text)) !== null) {
      const raw = unesc(m[1]);
      if (/\.(pdf|jpe?g|png|gif|zip|xlsx?|docx?)$/i.test(raw)) continue;
      if (!IR_HINT.test(raw) && !IR_HINT.test(strip(m[2]))) continue;
      const u = safeURL(raw, base);
      if (u && u.hostname === host) out.push(u.toString());
    }
  } else {
    // JSの中に書かれた、配信元のJSへの参照
    const r = /["'`]((?:https?:)?\/\/[A-Za-z0-9.\-]+\/[^"'`\s]+\.js[^"'`\s]*)["'`]/g;
    let m;
    while ((m = r.exec(text)) !== null) add(m[1]);
  }
  return [...new Set(out)];
}

export default async (req) => {
  if (req.method !== "POST") return bad("POSTしてください", 405);
  let body;
  try { body = await req.json(); } catch { return bad("本文を読めません"); }

  const deadline = Date.now() + BUDGET;
  const get = makeFetcher(deadline);

  // ---- PDFを1本読む ----
  if (body.mode === "text") {
    const u = safeURL(String(body.url || ""));
    if (!u) return bad("そのURLは開けません");
    const r = await get(u.toString(), MAX_PDF);
    if (r.error) return bad(`PDFを取得できませんでした（${r.error}）`, 502);
    try {
      const doc = await getDocumentProxy(r.buf);
      const { totalPages, text } = await extractText(doc, { mergePages: true });
      const clean = String(text).replace(/ /g, "").replace(/[ \t]+\n/g, "\n").trim();
      if (clean.length < 200) {
        return bad("文字がほとんど取り出せませんでした（画像だけのPDFかもしれません）", 422);
      }
      return Response.json({
        url: u.toString(), pages: totalPages, chars: clean.length,
        truncated: clean.length > MAX_TEXT, text: clean.slice(0, MAX_TEXT),
      });
    } catch {
      return bad("PDFから文字を取り出せませんでした", 422);
    }
  }

  // ---- IRページをたどってPDFを探す ----
  let start = body.url ? safeURL(String(body.url)) : null;
  if (!start) {
    const code = String(body.code || "").trim();
    if (!/^[0-9A-Za-z]{4}$/.test(code)) return bad("証券コードかURLを指定してください");
    const origin = new URL(req.url).origin;
    const res = await fetch(`${origin}/s/${code.slice(0, 2)}.json`);
    if (!res.ok) return bad("その証券コードのデータがありません", 404);
    const host = ((await res.json())[code]?.web || [])[0]?.[0];
    if (!host) return bad("この会社のサイトが分かりません。IRページのURLを入れてください", 404);
    start = safeURL(`https://${host}/`);
    if (!start) return bad("この会社のサイトが分かりません。IRページのURLを入れてください", 404);
  }

  const docs = new Map();
  const visited = [];
  const notes = [];
  // 会社のページ → IR用のJS → 配信元のJS、と3段までたどる。
  let queue = [{ url: start.toString(), depth: 0 }];

  // 証券コードが分かっているなら、配信元を先に当たる。
  // 当たれば会社のページをたどらずに済む。外れても4回叩くだけ。
  const code = String(body.code || "").trim();
  if (/^[0-9A-Za-z]{4}$/.test(code)) {
    for (const u of eirSeeds(code)) queue.unshift({ url: u, depth: 0, sibling: true });
  }

  // URLを指定されていないときだけ、配信元で足りたら会社のページは見に行かない。
  // 有報から拾ったサイトが間違っていることがあるので、無駄に叩かない。
  const explicit = Boolean(body.url);

  while (queue.length && Date.now() < deadline) {
    if (!explicit && docs.size >= 20 && !queue[0].sibling) break;
    const { url, depth } = queue.shift();
    if (visited.includes(url)) continue;
    const r = await get(url, MAX_HTML);
    visited.push(url);
    if (r.error) { notes.push(`${url}: ${r.error}`); continue; }

    const text = decode(r.buf, r.type);
    const isHTML = /html/i.test(r.type) || /^\s*<(!doctype|html)/i.test(text);

    for (const d of (isHTML ? fromHTML(text, r.url) : fromJSON(text))) {
      if (!docs.has(d.url)) docs.set(d.url, d);
    }
    // JSでもHTMLのリンクが書かれていることがあるので、両方見る。
    if (!isHTML) for (const d of fromHTML(text, r.url)) {
      if (!docs.has(d.url)) docs.set(d.url, d);
    }

    // 配信元が1本見つかったら、その兄弟をまとめて先頭に積む。
    // 会社のページを順に追うより確実なので、深さの制限とは別扱いにする。
    for (const sib of eirSiblings(r.url)) {
      if (visited.includes(sib) || queue.some((q) => q.url === sib)) continue;
      queue.unshift({ url: sib, depth: 0, sibling: true });
    }

    if (depth < 2) {
      for (const u of nextLinks(text, r.url, isHTML)) {
        if (visited.includes(u) || queue.some((q) => q.url === u)) continue;
        queue.push({ url: u, depth: depth + 1 });
      }
      // 点数の高いものから見に行く。浅いほうを少し優先する。
      // 配信元の兄弟は確実に当たるので、いちばん前に置く。
      queue.sort((a, b) =>
        (b.sibling ? 100 : 0) - (a.sibling ? 100 : 0)
        || (score(b.url) - b.depth) - (score(a.url) - a.depth));
      queue = queue.slice(0, 40);
    }
  }

  // 同じ資料が複数の配信元から出てくる。URLが違うので題名と日付でも畳む。
  const byTitle = new Map();
  for (const d of docs.values()) {
    const k = `${d.kind}|${d.date}|${d.title}`;
    const prev = byTitle.get(k);
    // ページ数が分かっているほうを残す。
    if (!prev || (!prev.pages && d.pages)) byTitle.set(k, d);
  }

  const list = [...byTitle.values()]
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return Response.json({
    start: start.toString(),
    visited,
    notes,
    count: list.length,
    docs: list.slice(0, 300),
  });
};

export const config = { path: "/api/ir" };
