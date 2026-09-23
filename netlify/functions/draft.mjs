// 開示資料から、資本政策を検討するときの論点を下書きする。
//
// このエンドポイントは「誰が何を売りたいか」を一切持たない。
// 渡すのは会社の開示内容と数値だけで、受け取るのは論点の整理だけ。
// 証券会社名・割当先・提案主体は送らないし、書かせない。
// 何のための下書きかは、呼ぶ側の画面が知っていればよい。
//
// 材料は有価証券報告書（公開情報）と、利用者が手元で貼り付けた公表済み資料。
// 書かれていないことは書かせない。これは要約の方（summarize.mjs）と同じ方針。

import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";

const MODEL = "claude-opus-5";
const DAILY_LIMIT = Number(process.env.DRAFT_DAILY_LIMIT || 10);
const MAX_MATERIAL = 60000;   // 貼り付け資料の上限。これを超えたら切る。

// 下書きする項目。idは呼ぶ側と合わせる。
// 「提案」「推奨」という言葉は使わない。資本政策の論点として書かせる。
const SLOTS = {
  mgmtSummary: {
    label: "直近期の業績についての総括",
    spec: "直近期の業績を1文で総括する。60字以内。増減の事実と、その理由として" +
          "記載されているものだけを書く。見通しや評価は書かない。",
  },
  stockView: {
    label: "株価の状況についての結論",
    spec: "株価の状況を説明するページの結論を1文で。50字以内。" +
          "開示から分かる事業の変化と、市場からの位置づけに触れる。" +
          "株価水準の予想や割安・割高の判断は書かない。",
  },
  growthView: {
    label: "財務と投資計画についての方向性",
    spec: "財務状況と投資計画をまとめるページの結論を1文で。50字以内。" +
          "手元資金・キャッシュフロー・投資計画の関係が分かるように書く。",
  },
  story: {
    label: "資本政策の背景（エクイティストーリー）",
    spec: "この会社が資金を必要とする理由を、事業の内容と投資計画から3点にまとめる。" +
          "各60〜100字。事業の成長性と資金の使い道がつながって見えるように書く。" +
          "記載のない計画を作らない。材料が足りなければ、足りないと書く。",
  },
  useOfFunds: {
    label: "資金使途の候補",
    spec: "開示から読み取れる資金の使い道を、金額の根拠とともに2〜3点。各40〜80字。" +
          "設備投資計画・研究開発費・借入金の返済など、数字の裏付けがあるものだけ。" +
          "裏付けのない使途は書かない。",
  },
  segExisting: {
    label: "既存事業領域の状況",
    spec: "既存事業について、開示されている進捗と課題を3〜4行。" +
          "貼り付け資料に中期経営計画があればそれを優先して使う。",
  },
  segNew: {
    label: "新規事業領域の状況",
    spec: "新規事業について、開示されている進捗と課題を3〜4行。" +
          "該当する事業がなければ「該当する記載はありません」と書く。",
  },
  points: {
    label: "資本政策を検討する背景",
    spec: "この会社が株式による資金調達を検討する場合の論点を3点。各50〜80字。" +
          "資金使途と成長投資のつながり／株価形成と開示の関係／" +
          "株主構成と発行規模の関係、の3つの観点で書く。" +
          "特定の調達手法を推奨する書き方はしない。論点の整理にとどめる。",
  },
};

const SYSTEM = `あなたは、企業の開示資料を読んで資本政策の論点を整理する分析者です。

守ること:
・**渡された資料に書かれていることだけを使う。** 推測で補わない。業界の一般論も書かない。
・材料が足りない項目は、無理に書かず「材料が足りません」とだけ書く。
  空欄を埋めることより、書いていないことを書かない方が大事です。
・**将来の株価・業績の予想は書かない。** 「有望」「好調」「期待できる」のような評価語も使わない。
・投資判断につながる推奨は書かない。事実と、そこから直接言えることだけを書く。
・**特定の金融機関や調達手法を勧める書き方はしない。** 論点の整理にとどめる。
・数字を書くときは、渡された数字をそのまま使う。丸め直したり作ったりしない。
・**日本語で書く。** 英単語をそのまま混ぜない。ただし固有名詞は記載どおりの表記を使う。
・前置きや感想は付けない。指定された形式だけを出力する。

出力は次のJSONだけを返します。前後に文章を付けません。
{"項目id": "本文", ...}
本文の中の改行は \\n で表します。`;

// 別のサイトから呼べるようにするかどうか。
// 何も指定しなければ同じサイトからだけ。誰でも叩ける窓口にはしない。
const ALLOW = (process.env.DRAFT_ALLOW_ORIGIN || "").split(",")
  .map((s) => s.trim()).filter(Boolean);

function cors(req) {
  const origin = req.headers.get("origin");
  if (!origin || !ALLOW.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "vary": "origin",
  };
}

let CORS = {};

function bad(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function ok(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

export default async (req) => {
  CORS = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return bad("POSTしてください", 405);

  let body;
  try { body = await req.json(); } catch { return bad("本文を読めません"); }

  const code = String(body.code || "").trim();
  if (!/^[0-9A-Za-z]{4}$/.test(code)) return bad("証券コードの形式が正しくありません");

  const want = Array.isArray(body.slots) ? body.slots.filter((s) => SLOTS[s]) : [];
  if (!want.length) return bad("下書きする項目が指定されていません");

  // 貼り付け資料。公表済みのものを利用者が貼る前提。長すぎるものは切る。
  const material = String(body.material || "").slice(0, MAX_MATERIAL);

  const url = new URL(req.url);
  const bucket = code.slice(0, 2);

  // 保存済みがあれば使い回す。貼り付け資料と項目が変われば別物として扱う。
  const key = `${code}-${want.slice().sort().join(",")}-${hash(material)}`;
  const store = getStore("drafts");
  if (body.refresh !== true) {
    const cached = await store.get(key, { type: "json" });
    if (cached) return ok({ ...cached, cached: true });
  }

  // 会社の開示内容はこのサイト自身が配信しているので、そこから読む。
  // 呼ぶ側から中身を送らせない（送る内容を増やさないため）。
  const [dres, sres] = await Promise.all([
    fetch(`${url.origin}/d/${bucket}.json`),
    fetch(`${url.origin}/s/${bucket}.json`),
  ]);
  if (!dres.ok) return bad("その証券コードのデータがありません", 404);
  const fin = (await dres.json())[code];
  if (!fin) return bad("その証券コードのデータがありません", 404);
  const sec = sres.ok ? ((await sres.json())[code] || {}) : {};

  const x = fin.x || {};
  const facts = [
    `会社名: ${fin.n}（${code}） 決算期: ${fin.e} 会計基準: ${fin.k}`,
    "",
    "■ 主要な経営指標（円。年度は決算期の年）",
    ...Object.entries(fin.d || {}).map(([k, v]) =>
      `${k}: ` + Object.entries(v).map(([y, n]) => `${y}=${n}`).join(" / ")),
    "",
    "■ そのほかの数値",
    ...Object.entries(x).map(([k, v]) =>
      `${k}: ` + Object.entries(v).map(([y, n]) => `${y}=${n}`).join(" / ")),
    "",
    sec.biz?.[0]?.[0] ? `■ 事業の内容\n${sec.biz[0][0].slice(0, 20000)}` : "",
    sec.seg?.length
      ? "■ 報告セグメントごとの売上\n" + sec.seg.map((r) => r.join(" / ")).join("\n") : "",
    sec.div?.[0]?.[0] ? `■ 配当政策\n${sec.div[0][0].slice(0, 4000)}` : "",
    sec.own?.length
      ? "■ 所有者別状況\n" + sec.own.map((r) => r.join(" / ")).join("\n") : "",
    sec.sh?.length
      ? "■ 大株主\n" + sec.sh.map((r) => r.join(" / ")).join("\n") : "",
    material ? `■ 利用者が貼り付けた公表済み資料\n${material}` : "",
  ].filter(Boolean).join("\n");

  const ask = want.map((s) => `【${s}】${SLOTS[s].label}\n  ${SLOTS[s].spec}`).join("\n\n");

  // 1日の上限。保存済みを返すときはここまで来ない。
  const today = new Date().toISOString().slice(0, 10);
  const meta = getStore("draft-meta");
  const used = (await meta.get(today, { type: "json" }))?.count || 0;
  if (used >= DAILY_LIMIT) {
    return bad(`本日の下書き作成は上限（${DAILY_LIMIT}回）に達しました。` +
               `作成済みのものは引き続き表示できます。`, 429);
  }

  const client = new Anthropic();
  let text;
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: "medium" },
      system: SYSTEM,
      messages: [{
        role: "user",
        content:
          "以下は有価証券報告書などの開示資料からの抜粋です。" +
          "ここに書かれていることだけを使って、指定された項目を書いてください。\n\n" +
          `=== 資料 ===\n${facts}\n\n=== 書く項目 ===\n${ask}`,
      }],
    });
    if (res.stop_reason === "refusal") return bad("この内容は下書きできませんでした", 422);
    text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return bad("混み合っています。少し待ってからお試しください", 429);
    }
    if (error instanceof Anthropic.APIError) {
      return bad(`下書きに失敗しました（${error.status}）`, 502);
    }
    throw error;
  }

  // JSONだけを返させているが、前後に何か付くことがあるので括弧で切り出す。
  let drafts;
  try {
    const i = text.indexOf("{"), j = text.lastIndexOf("}");
    drafts = JSON.parse(text.slice(i, j + 1));
  } catch {
    return bad("下書きの形式を読み取れませんでした", 502);
  }

  const record = {
    code, drafts, model: MODEL,
    generatedAt: new Date().toISOString(),
    usedMaterial: Boolean(material),
  };
  await store.setJSON(key, record);
  await meta.setJSON(today, { count: used + 1 });

  return ok({ ...record, cached: false, remaining: DAILY_LIMIT - used - 1 });
};

/** 貼り付け資料が変わったら別の保存にするための短い指紋。 */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export const config = { path: "/api/draft" };
