// telegram.js
// Sends alert messages via the Telegram Bot API. Unlike the original
// dashboard (where the bot token lived in browser localStorage and was
// visible to anyone with DevTools open), the token here is read from a
// server-side environment variable — it never reaches the browser.

const fetch = require('node-fetch');

async function sendTelegram(text) {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) {
    return { ok: false, error: 'Telegram not configured (set TG_BOT_TOKEN / TG_CHAT_ID)' };
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const json = await res.json();
    return json.ok ? { ok: true } : { ok: false, error: json.description || 'Unknown error' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendTelegram };
