// 有価証券報告書をパートごとに要約する。提案書ツールの「有報の要約」で使う。
//
// 有報は読むのが大変なので、章ごとに要点だけを箇条書きにする。
// 数字の表（主要な経営指標・沿革・株主など）は画面側で機械的に出すので、
// ここでは文章のパートだけを扱い、金額や比率の数字は書かせない（取り違えが怖いため）。
//
// 公開サイトなので誰でも叩ける。summarize.mjs と同じく、
//   ・存在する証券コードとパート名しか受け付けない
//   ・一度作った要約は保存して、2回目以降は課金しない（有報が新しくなれば作り直す）
//   ・1日に新しく作れる数に上限を設ける
// の3つで止める。

import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";

const MODEL = "claude-opus-5";
const DAILY_LIMIT = Number(process.env.YUHO_DAILY_LIMIT || 60);
const MAX_MATERIAL = 30000;

// パート → 有報の章の名前と、材料の置き場所
const PARTS = {
  policy: { title: "経営方針、経営環境及び対処すべき課題等", from: "context", key: "policy" },
  risk: { title: "事業等のリスク", from: "risk" },
  mdna: { title: "経営者による財政状態、経営成績及びキャッシュ・フローの状況の分析", from: "context", key: "analysis" },
  facilities: { title: "設備の状況", from: "context", key: "facilities" },
  dividend: { title: "配当政策", from: "section", key: "div" },
};

const SYSTEM = `あなたは有価証券報告書を読み解く編集者です。
渡された有価証券報告書の1つの章を、忙しい読み手が1分でつかめるように要約します。

出力の形式:
・要点を3〜6行の箇条書きにする。1行60字以内。行頭は「・」。
・大事な順に並べる。最初の1行で、その章でいちばん言いたいことが分かるようにする。

守ること:
・**記載されていないことは絶対に書かない。** 推測で補わない。業界の一般論も書かない。
・**金額・比率・件数などの数字は書かない。** 別の表に出ているので重複させない。
  増えた・減った・黒字化した、のような向きは書いてよい。年や期の名前は書いてよい。
・将来性の評価、投資判断につながる表現、「有望」「好調」のような評価語は書かない。
・**「です・ます」は使わない。** 常体（〜である・〜した）か体言止めで書く。
・本文は日本語で書く。固有名詞（会社名・商品名・地名）は記載どおりの表記を使う。
・前置きや末尾の感想は付けない。箇条書きだけを出力する。`;

function bad(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const code = (url.searchParams.get("code") || "").trim();
  const part = (url.searchParams.get("part") || "").trim();
  if (!/^[0-9A-Za-z]{4}$/.test(code)) return bad("証券コードの形式が正しくありません");
  if (!PARTS[part]) return bad("パートの指定が正しくありません");
  const P = PARTS[part];

  // 会社の実在確認と、有報の書類ID（保存の鍵に使う。新しい有報が出たら作り直す）。
  const sres = await fetch(`${url.origin}/s/${code.slice(0, 2)}.json`);
  if (!sres.ok) return bad("その証券コードのデータがありません", 404);
  const company = (await sres.json())[code];
  if (!company) return bad("その証券コードのデータがありません", 404);
  const doc = company.d || "-";

  const store = getStore("yuho");
  const key = `${code}-${part}-${doc}`;
  if (url.searchParams.get("refresh") !== "1") {
    const cached = await store.get(key, { type: "json" });
    if (cached) return Response.json({ ...cached, cached: true });
  }

  // 材料。このサイト自身が配信しているものを読む。
  let text = "";
  try {
    if (P.from === "context") {
      const r = await fetch(`${url.origin}/context/${code}.json`);
      if (r.ok) text = String((await r.json())[P.key] || "");
    } else if (P.from === "risk") {
      const r = await fetch(`${url.origin}/risk/${code}.txt`);
      if (r.ok) text = await r.text();
    } else if (P.from === "section") {
      text = String(company[P.key]?.[0]?.[0] || "");
    }
  } catch { /* 下で判定する */ }
  text = text.trim().slice(0, MAX_MATERIAL);
  if (!text) return bad(`「${P.title}」はまだ取得できていません`, 404);

  const today = new Date().toISOString().slice(0, 10);
  const meta = getStore("yuho-meta");
  const used = (await meta.get(today, { type: "json" }))?.count || 0;
  if (used >= DAILY_LIMIT) {
    return bad(`本日の要約作成は上限（${DAILY_LIMIT}件）に達しました。作成済みの要約は引き続き表示できます。`, 429);
  }

  const client = new Anthropic();
  let summary;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `以下は有価証券報告書の「${P.title}」です。ここに書かれていることだけを使って要約してください。\n\n${text}`,
      }],
    });
    if (response.stop_reason === "refusal") return bad("この内容は要約できませんでした", 422);
    summary = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return bad("混み合っています。少し待ってからお試しください", 429);
    if (error instanceof Anthropic.APIError) return bad(`要約に失敗しました（${error.status}）`, 502);
    throw error;
  }
  if (!summary) return bad("要約が空でした", 502);

  const record = { code, part, title: P.title, summary, doc, model: MODEL, generatedAt: new Date().toISOString() };
  await store.setJSON(key, record);
  await meta.setJSON(today, { count: used + 1 });
  return Response.json({ ...record, cached: false, remaining: DAILY_LIMIT - used - 1 });
};

export const config = { path: "/api/yuho" };
