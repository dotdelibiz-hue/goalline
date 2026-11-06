// AIクライアント。Netlify AI Gateway か ANTHROPIC_API_KEY があれば使う
let client;
export async function getAi() {
  if (client !== undefined) return client;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
  } else client = null;
  return client;
}
