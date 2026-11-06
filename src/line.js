// LINE Messaging API の最小クライアント
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(rawBody, secret, signature) {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let got;
  try { got = Buffer.from(signature, 'base64'); } catch { return false; }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export class Line {
  constructor(token, { api = process.env.LINE_API_BASE || 'https://api.line.me', data = process.env.LINE_DATA_BASE || 'https://api-data.line.me' } = {}) {
    this.token = token;
    this.api = api;
    this.data = data;
  }

  async call(base, path, { method = 'POST', body, type = 'application/json' } = {}) {
    if (!this.token) throw new Error('LINEのチャネルアクセストークンが未設定です');
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined && { 'Content-Type': type }) },
      body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`LINE API ${res.status} ${path}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }

  reply(replyToken, messages) { return this.call(this.api, '/v2/bot/message/reply', { body: { replyToken, messages } }); }
  push(to, messages) { return this.call(this.api, '/v2/bot/message/push', { body: { to, messages } }); }
  setWebhook(endpoint) { return this.call(this.api, '/v2/bot/channel/webhook/endpoint', { method: 'PUT', body: { endpoint } }); }
  botInfo() { return this.call(this.api, '/v2/bot/info', { method: 'GET' }); }

  async createRichMenu(menu, png) {
    const { richMenuId } = await this.call(this.api, '/v2/bot/richmenu', { body: menu });
    await this.call(this.data, `/v2/bot/richmenu/${richMenuId}/content`, { body: png, type: 'image/png' });
    await this.call(this.api, `/v2/bot/user/all/richmenu/${richMenuId}`, {});
    return richMenuId;
  }

  deleteRichMenu(id) { return this.call(this.api, `/v2/bot/richmenu/${id}`, { method: 'DELETE' }); }
}
