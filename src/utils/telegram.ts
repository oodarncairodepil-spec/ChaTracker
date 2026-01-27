const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export async function sendTelegramMessage(chatId: number | string, text: string, options: any = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return;
  }
  
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "HTML",
        ...options,
      }),
    });
    const data = await response.json();
    if (!data.ok) {
      console.error("Telegram API Error:", data);
    }
    return data;
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
    if (!TELEGRAM_BOT_TOKEN) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
    await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: text
        })
    });
}

export async function editMessageText(chatId: number | string, messageId: number, text: string, options: any = {}) {
    if (!TELEGRAM_BOT_TOKEN) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
    await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: text,
            parse_mode: "HTML",
            ...options
        })
    });
}

export async function setMyCommands(commands: { command: string; description: string }[]) {
    if (!TELEGRAM_BOT_TOKEN) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands })
    });
    return res.json();
}

export async function setChatMenuButton(chatId: number | string, webAppUrl?: string) {
    if (!TELEGRAM_BOT_TOKEN) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setChatMenuButton`;
    
    const body: any = { chat_id: chatId };
    if (webAppUrl) {
        body.menu_button = {
            type: "web_app",
            text: "Open App",
            web_app: { url: webAppUrl }
        };
    } else {
        // Reset to default commands menu
        body.menu_button = { type: "commands" };
    }

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    return res.json();
}
