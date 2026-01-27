import { NextRequest, NextResponse } from "next/server";
import { handleUpdate } from "@/lib/botLogic";

const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

export async function POST(req: NextRequest) {
  try {
    // 1. Secret Token Validation
    const secretToken = req.headers.get("x-telegram-bot-api-secret-token");
    if (TELEGRAM_WEBHOOK_SECRET && secretToken !== TELEGRAM_WEBHOOK_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Parse Update
    const update = await req.json();
    
    // 3. Handle Update
    console.log("Received update:", JSON.stringify(update, null, 2));
    await handleUpdate(update);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Webhook Error:", error);
    return NextResponse.json({ ok: true }); // Always return 200 to Telegram
  }
}
