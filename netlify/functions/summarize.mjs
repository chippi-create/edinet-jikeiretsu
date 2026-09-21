// 事業の内容をAIで要約する。押されたときだけ実行し、結果は保存して使い回す。
//
// このサイトは静的ファイルだけなので、APIキーを置ける場所がない。
// ブラウザに置けば公開されてしまうため、ここ（サーバー側）で呼ぶ。
//
// 公開サイトなので誰でも叩ける。課金が青天井にならないよう、
//   ・存在する証券コードしか受け付けない
//   ・一度作った要約は保存して、2回目以降は課金しない
//   ・1日に新しく作れる数に上限を設ける
// の3つで止める。

import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";

const MODEL = "claude-opus-5";
const DAILY_LIMIT = Number(process.env.SUMMARY_DAILY_LIMIT || 5);

const SYSTEM = `あなたは有価証券報告書を読み解く編集者です。
渡された記載から、その会社が何をやっている会社かを日本語でまとめます。

出力の形式:

【全体】
60字以内で1行。何を作り、誰に売っているかが分かるように書く。

【セグメント名】
そのセグメントについて200〜300字。可能なかぎり次の順で書く。
  何を仕入れ／調達しているか → どこでどう作っているか → 主にどこへ売っているか
セグメントは渡された名前をそのまま見出しに使い、渡された順に全部書く。

守ること:
・**記載されていないことは絶対に書かない。** 推測で補わない。業界の一般論も書かない。
・字数を満たすために内容を膨らませない。書けることが少なければ短くてよい。
  仕入先や販売先が記載されていなければ「仕入先の記載はありません」のように書く。
  200字に届かないことは失敗ではない。創作する方が失敗である。
・売上高や利益の数字は書かない。別の表に出ているので重複させない。
・将来性の評価、投資判断につながる表現、「有望」「好調」のような評価語は書かない。
・「〜と考えられます」のような曖昧な言い回しを使わない。記載どおりに書く。
・前置きや末尾の感想は付けない。指定した形式だけを出力する。`;

function badRequest(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const code = (url.searchParams.get("code") || "").trim();

  // 証券コードは英数字4文字。これ以外は弾く。
  if (!/^[0-9A-Za-z]{4}$/.test(code)) {
    return badRequest("証券コードの形式が正しくありません");
  }

  const store = getStore("summaries");
  const cached = await store.get(code, { type: "json" });
  if (cached) {
    return Response.json({ ...cached, cached: true });
  }

  // 事業の内容はサイト自身が配信しているので、そこから読む。
  // 存在しない会社はここで弾かれるので、コードの実在確認も兼ねる。
  const bucket = code.slice(0, 2);
  const res = await fetch(`${url.origin}/s/${bucket}.json`);
  if (!res.ok) return badRequest("その証券コードのデータがありません", 404);
  const company = (await res.json())[code];
  const text = company?.biz?.[0]?.[0];
  if (!text) return badRequest("この会社は事業の内容がまだ取得できていません", 404);

  // 事業の内容だけでは仕入先も販売先も書かれていないことが多い。
  // 経営者による分析・主要な設備・主要な顧客を材料として足す。
  let ctx = {};
  try {
    const cres = await fetch(`${url.origin}/context/${code}.json`);
    if (cres.ok) ctx = await cres.json();
  } catch { /* 材料が無ければ事業の内容だけで書く */ }

  const segNames = (company.seg || []).map((r) => r[0]).filter(Boolean);
  const material = [
    `会社名: ${company.n || code}`,
    segNames.length ? `報告セグメント: ${segNames.join("、")}` : "報告セグメント: 記載なし",
    `\n■ 事業の内容\n${text}`,
    ctx.analysis ? `\n■ 経営者による分析\n${ctx.analysis}` : "",
    ctx.facilities ? `\n■ 主要な設備の状況\n${ctx.facilities}` : "",
    ctx.customers ? `\n■ 主要な顧客ごとの情報\n${ctx.customers}` : "",
  ].filter(Boolean).join("\n");

  // 1日の上限。保存済みを返す場合はここまで来ないので、課金するときだけ数える。
  const today = new Date().toISOString().slice(0, 10);
  const meta = getStore("summary-meta");
  const used = (await meta.get(today, { type: "json" }))?.count || 0;
  if (used >= DAILY_LIMIT) {
    return badRequest(
      `本日の要約作成は上限（${DAILY_LIMIT}社）に達しました。明日またお試しください。` +
        `すでに要約済みの会社は引き続き表示できます。`,
      429
    );
  }

  const client = new Anthropic();
  let summary;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      // セグメントごとに書き分けるので、低すぎると雑になる。
      output_config: { effort: "medium" },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content:
            "以下は有価証券報告書からの抜粋です。ここに書かれていることだけを使って" +
            "まとめてください。\n\n" + material,
        },
      ],
    });
    // 安全側で止められた場合、content を読む前に気づけるようにする。
    if (response.stop_reason === "refusal") {
      return badRequest("この内容は要約できませんでした", 422);
    }
    summary = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return badRequest("混み合っています。少し待ってからお試しください", 429);
    }
    if (error instanceof Anthropic.APIError) {
      return badRequest(`要約に失敗しました（${error.status}）`, 502);
    }
    throw error;
  }

  if (!summary) return badRequest("要約が空でした", 502);

  const record = {
    code,
    summary,
    model: MODEL,
    generatedAt: new Date().toISOString(),
  };
  await store.setJSON(code, record);
  await meta.setJSON(today, { count: used + 1 });

  return Response.json({ ...record, cached: false, remaining: DAILY_LIMIT - used - 1 });
};

export const config = { path: "/api/summarize" };
