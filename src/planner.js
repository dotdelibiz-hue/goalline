// ゴール逆算プランナー: ゴール1文 → シナリオ(配信ステップ・分岐タグ・リッチメニュー)
import { z } from 'zod';

export const GOAL_TAG = 'goal';
export const CLICK_TAG = 'click';

const Step = z.object({
  id: z.string(),
  day: z.number().int(),
  hour: z.number().int().nullable(),
  text: z.string(),
  buttons: z.array(z.object({ label: z.string(), tag: z.string() })),
  cta: z.boolean(),
  onlyTag: z.string().nullable(),
});

export const PlanSchema = z.object({
  title: z.string(),
  chain: z.array(z.object({ stage: z.string(), state: z.string() })),
  cta: z.object({ label: z.string(), url: z.string() }),
  segments: z.array(z.object({ tag: z.string(), label: z.string() })),
  steps: z.array(Step),
  richMenu: z.array(z.object({ label: z.string(), type: z.enum(['cta', 'message']), text: z.string() })),
  replyPersona: z.string(),
});

const SYSTEM = `あなたはLINE公式アカウントのステップ配信を設計する専門家です。
入力されたゴールから「逆算」して、友だち追加からゴール達成までのシナリオを1つ設計します。

設計手順(必ずこの順で考える):
1. ゴールの直前に読者がとる具体的行動を決める(例: 予約ボタンを押す)。
2. その行動の直前に必要な心理状態を、ゴール側から入口側へ遡って4段階で書く(chain。先頭がゴール、最後が友だち追加直後)。
3. 各段階を満たすメッセージを、入口側から時系列に並べる(steps)。

制約:
- steps は4〜7通。1通目は day 0 / hour null(追加直後に即時送信)。以降は day を増やし hour は 8〜21 の整数。
- 1通目に、読者の関心を分ける buttons を2〜3個つける(label 20文字以内、tag は英小文字の短い識別子)。他の通には buttons をつけない(空配列)。
- segments には buttons の tag と label を全て列挙する。
- 関心別に内容を変えたい通だけ onlyTag にそのtagを入れる。全員に送る通は null。同じ day に全員向けと関心別を重ねない。
- cta: true の通は本文の最後で行動を促す。リンクはシステムが自動で付けるので本文にURLを書かない。最後の通は必ず cta: true。
- 本文は1通140文字以内。前置き・挨拶の繰り返し・絵文字の多用・誇大表現は禁止。読み手の得を先に書く。
- ゴール達成した人には以降の配信が自動で止まる前提で書く。
- richMenu はちょうど3個。1つ目は type "cta"(ゴール行動)。残り2つは type "message" で、押すと text が送信される(よくある質問など)。label は8文字以内。
- cta.url: ゴール文にURLがあればそれ、なければ空文字。cta.label は20文字以内。
- title はシナリオ名(15文字以内)。
- replyPersona: 自由入力の質問に自動返信するときの話し方と、答えてよい範囲を2文で。
- 業種や商材が不明なら、ゴール文から最も自然な業種を推定して具体的に書く。`;

const URL_RE = /https?:\/\/[^\s　、。」）)]+/;

export function extractUrl(goal) {
  const m = goal.match(URL_RE);
  return m ? m[0] : '';
}

export async function draftPlan(goal, { client, model } = {}) {
  goal = String(goal || '').trim().slice(0, 500);
  if (!goal) throw new Error('ゴールを入力してください');
  const url = extractUrl(goal);
  if (client) {
    try {
      const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
      const res = await client.messages.parse({
        model: model || process.env.PLANNER_MODEL || 'claude-sonnet-5-5',
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low', format: zodOutputFormat(PlanSchema) },
        system: SYSTEM,
        messages: [{ role: 'user', content: `ゴール: ${goal}` }],
      }, { timeout: 40_000, maxRetries: 0 }); // サーバーレスの60秒制限内に収める
      if (res.stop_reason !== 'refusal' && res.parsed_output) {
        const plan = normalize(res.parsed_output, url);
        plan.source = 'ai';
        return plan;
      }
    } catch (err) {
      console.error('[planner] AI生成に失敗したためテンプレートで下書きします:', err.message);
    }
  }
  const plan = normalize(templatePlan(goal), url);
  plan.source = 'template';
  return plan;
}

// AIの出力を配信可能な形に整える(LINEの文字数制限・参照整合性)
export function normalize(raw, url = '') {
  const plan = PlanSchema.parse(raw);
  const cut = (s, n) => String(s).trim().slice(0, n);
  const tagOk = (t) => String(t).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || null;

  plan.title = cut(plan.title, 20) || 'シナリオ';
  plan.cta.label = cut(plan.cta.label, 20) || '詳しく見る';
  plan.cta.url = url || cut(plan.cta.url, 1000);
  plan.chain = plan.chain.slice(0, 5).map((c) => ({ stage: cut(c.stage, 10), state: cut(c.state, 60) }));

  const [head, ...rest] = plan.steps.slice(0, 8);
  const key = (s) => s.day * 100 + (s.hour == null ? -1 : s.hour);
  plan.steps = (head ? [head, ...rest.sort((a, b) => key(a) - key(b))] : []).map((s, i) => ({
    id: `s${i + 1}`,
    day: Math.max(0, Math.min(60, s.day)),
    hour: i === 0 ? null : s.hour == null ? 20 : Math.max(8, Math.min(21, s.hour)),
    text: cut(s.text, 500),
    buttons: (i === 0 ? s.buttons : []).slice(0, 3)
      .map((b) => ({ label: cut(b.label, 20), tag: tagOk(b.tag) }))
      .filter((b) => b.label && b.tag && b.tag !== GOAL_TAG && b.tag !== CLICK_TAG),
    cta: Boolean(s.cta),
    onlyTag: s.onlyTag ? tagOk(s.onlyTag) : null,
  }));
  if (!plan.steps.length) throw new Error('ステップが空です');
  plan.steps[0].day = 0;
  plan.steps.at(-1).cta = true;

  const seg = new Map();
  for (const b of plan.steps[0].buttons) seg.set(b.tag, b.label);
  plan.segments = [...seg].map(([tag, label]) => ({ tag, label }));
  for (const s of plan.steps) if (s.onlyTag && !seg.has(s.onlyTag)) s.onlyTag = null;

  const menu = plan.richMenu.slice(0, 3).map((m) => ({ label: cut(m.label, 8), type: m.type, text: cut(m.text, 300) }));
  while (menu.length < 3) menu.push({ label: 'よくある質問', type: 'message', text: 'よくある質問' });
  menu[0] = { ...menu[0], type: 'cta' };
  for (const m of menu.slice(1)) m.type = 'message';
  plan.richMenu = menu;
  plan.replyPersona = cut(plan.replyPersona, 400);
  return plan;
}

// APIキーが無い/失敗した場合でも必ず配信できる下書きを返す
const KINDS = [
  { re: /予約|来院|来店|体験|カウンセリング|面談|相談会/, noun: '予約', act: '予約する', label: '空き枠を見て予約する' },
  { re: /購入|販売|売上|注文|EC|商品|買/, noun: '購入', act: '購入する', label: '商品を見る' },
  { re: /申込|申し込み|登録|入会|契約|会員/, noun: '申込', act: '申し込む', label: '申し込む' },
  { re: /資料|ダウンロード|問い合わせ|問合せ|見積/, noun: '問い合わせ', act: '問い合わせる', label: '無料で相談する' },
];

export function templatePlan(goal) {
  const k = KINDS.find((x) => x.re.test(goal)) || { noun: '申込', act: '申し込む', label: '詳しく見る' };
  const plain = goal.replace(URL_RE, '').trim();
  const topic = (plain.includes('の') ? plain.split('の')[0] : plain.replace(/を?(増やしたい|獲得したい|伸ばしたい|集めたい|したい)[。！!]*$/, '')).trim().slice(0, 20) || k.noun;
  return {
    title: `${k.noun}獲得シナリオ`,
    chain: [
      { stage: 'ゴール', state: `${k.act}` },
      { stage: '決断', state: '今動く理由(期限・特典)がある' },
      { stage: '信頼', state: '同じ悩みの人の結果を知り不安が消える' },
      { stage: '興味', state: '自分の悩みが解決できそうだと感じる' },
    ],
    cta: { label: k.label, url: '' },
    segments: [],
    steps: [
      { id: 's1', day: 0, hour: null, cta: false, onlyTag: null,
        text: `友だち追加ありがとうございます。\nあなたに合う情報だけを送るため、いちばん近いものを1つ選んでください。`,
        buttons: [
          { label: 'まず情報を知りたい', tag: 'info' },
          { label: '料金が気になる', tag: 'price' },
          { label: 'すぐ始めたい', tag: 'hot' },
        ] },
      { id: 's2', day: 1, hour: 20, cta: false, onlyTag: null, buttons: [],
        text: `${topic}を検討する方に多い悩みは「自分に合うか分からない」ことです。\n明日、実際に始めた方の結果を1つだけ紹介します。` },
      { id: 's3', day: 1, hour: 12, cta: true, onlyTag: 'hot', buttons: [],
        text: `すぐ始めたい方へ。手続きは1分で終わります。迷ったら先に枠だけ確保しておくのがおすすめです。` },
      { id: 's4', day: 2, hour: 20, cta: false, onlyTag: null, buttons: [],
        text: `始める前は不安だった方も、最初の1回で「もっと早くやればよかった」という声が多いです。合わなければ続けなくて大丈夫です。` },
      { id: 's5', day: 3, hour: 12, cta: true, onlyTag: 'price', buttons: [],
        text: `料金が気になる方へ。最初の1回は負担が少ない形で試せます。詳細はこちらから確認できます。` },
      { id: 's6', day: 4, hour: 20, cta: true, onlyTag: null, buttons: [],
        text: `今週中の${k.noun}なら優先してご案内できます。気になっていた方は今のうちにどうぞ。` },
    ],
    richMenu: [
      { label: k.noun, type: 'cta', text: '' },
      { label: '料金', type: 'message', text: '料金を教えてください' },
      { label: '質問する', type: 'message', text: '質問があります' },
    ],
    replyPersona: '丁寧で簡潔に、1〜2文で答える。分からないことは推測せず、担当者から連絡すると伝える。',
  };
}
