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
「事業の内容」の記載から、その会社が何をやっている会社かを日本語で手短にまとめます。

出力の形式:
1行目に60字以内の要約を書く。何を作り、誰に売っているかが分かるように書く。
空行を1つ挟む。
そのあとに事業の柱を「- 」で始まる箇条書きで3〜5個。各行は40字以内。

守ること:
・記載されていないことは書かない。推測で補わない。
・売上規模や将来性の評価、投資判断につながる表現は書かない。
・「〜と考えられます」のような曖昧な言い回しを使わない。記載どおりに書く。
・見出しや前置き、末尾の感想は付けない。指定した形式だけを出力する。`;

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
      max_tokens: 2000,
      // 要約は難しい作業ではないので、深く考えさせずに速く返す。
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `会社名: ${company.n || code}\n\n` +
            `以下は有価証券報告書の「事業の内容」です。\n\n${text}`,
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
