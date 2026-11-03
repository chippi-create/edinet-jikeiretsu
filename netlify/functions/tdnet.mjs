// 適時開示の表題を、直近2年ぶん返す。提案書ツールの「この会社の分析」で使う。
//
// TDnet本体は約1か月で一覧もPDFも消えるので、過去の表題は民間の無料API（やのしん TDnet WEB-API）から引く
// （公式ではない。本人の了承済み 2026-11-03）。ブラウザから直接は読めない（CORSの許可が無い）ので、ここで中継する。
// 返すのは日付・時刻・表題・PDFのURLだけ。PDFのURLはTDnet本体を指すので、1か月より前のものは開けない。
// 押されたときだけ動く。まとめて巡回はしない。

const UA = "yu-ho-matome/1.0 (disclosure titles)";
const YEARS = 2;

function bad(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();
  if (!/^[0-9A-Z]{4}$/.test(code)) return bad("証券コードの形式が正しくありません");

  let j;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(`https://webapi.yanoshin.jp/webapi/tdnet/list/${code}.json?limit=1000`,
      { headers: { "user-agent": UA }, signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return bad(`適時開示の一覧を取れませんでした（${r.status}）`, 502);
    j = await r.json();
  } catch {
    return bad("適時開示の一覧につながりませんでした", 502);
  }
  const since = new Date(Date.now() - YEARS * 365 * 86400000).toISOString().slice(0, 10);
  const items = (j.items || []).map((x) => x.Tdnet || {}).filter((t) => (t.pubdate || "") >= since).map((t) => ({
    date: String(t.pubdate || "").slice(0, 10),
    time: String(t.pubdate || "").slice(11, 16),
    title: String(t.title || "").trim(),
    // やのしんの転送URL（rd.php?…）からTDnet本体のURLを取り出す
    url: String(t.document_url || "").replace(/^https?:\/\/webapi\.yanoshin\.jp\/rd\.php\?/, ""),
  }));
  return new Response(JSON.stringify({ code, since, items }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
};

export const config = { path: "/api/tdnet" };
