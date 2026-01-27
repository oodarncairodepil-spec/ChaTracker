import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Validate X-API-KEY
    const apiKey = req.headers.get("x-api-key");
    const envApiKey = Deno.env.get("INGEST_API_KEY");
    if (!apiKey || apiKey !== envApiKey) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = await req.json();
    const {
      received_at,
      from_email,
      to_email,
      subject,
      date_header,
      gmail_message_id,
      thread_id,
      text_body,
      html_body,
      email_label,
    } = payload;

    // Supabase Client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 2. Deduplication check
    const { data: existing } = await supabase
      .from("raw_emails")
      .select("id, transactions(id)")
      .eq("gmail_message_id", gmail_message_id)
      .single();

    if (existing) {
      return new Response(
        JSON.stringify({
          message: "Duplicate email",
          raw_email_id: existing.id,
          transaction_id: existing.transactions?.[0]?.id,
          deduped: true,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        }
      );
    }

    // 3. Insert into raw_emails
    const { data: rawEmail, error: rawError } = await supabase
      .from("raw_emails")
      .insert({
        received_at: received_at || new Date().toISOString(),
        from_email,
        to_email,
        subject,
        date_header,
        gmail_message_id,
        thread_id,
        email_label: email_label || "WalleTracker",
        text_body,
        html_body,
        raw_payload: payload,
      })
      .select()
      .single();

    if (rawError) {
      throw rawError;
    }

    // 4. Parse Transaction
    const parseResult = parseEmail(payload);
    
    // Resolve Source of Fund ID
    let sourceOfFundId = null;
    if (parseResult.source_of_fund) {
      const { data: sof } = await supabase
        .from("source_of_funds")
        .select("id")
        .ilike("name", parseResult.source_of_fund)
        .single();
        
      if (sof) {
        sourceOfFundId = sof.id;
      } else {
        // Create if missing (optional, per prompt "create if missing")
        const { data: newSof } = await supabase
          .from("source_of_funds")
          .insert({ 
            name: parseResult.source_of_fund,
            type: 'other' // default
          })
          .select("id")
          .single();
        if (newSof) sourceOfFundId = newSof.id;
      }
    }

    // 5. Insert Transaction
    const { data: transaction, error: txError } = await supabase
      .from("transactions")
      .insert({
        status: "pending",
        happened_at: parseResult.happened_at || date_header || new Date().toISOString(),
        amount: parseResult.amount,
        direction: parseResult.direction,
        merchant: parseResult.merchant,
        note: parseResult.note,
        source: "email",
        source_ref: rawEmail.id,
        source_of_fund_id: sourceOfFundId,
        parse_meta: {
          confidence: parseResult.confidence,
          evidence: parseResult.evidence,
          rules_triggered: parseResult.rules_triggered
        }
      })
      .select()
      .single();

    if (txError) throw txError;

    // 6. Notify Telegram
    // Using direct Telegram API call for speed/simplicity of notification
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    // We need a chat_id. Since we don't know who the user is from the email solely,
    // we assume a single user system or we look up the user from bot_sessions (if we had a mapping).
    // For this MVP, we'll fetch the most recent active session or broadcast to a specific ID if provided in env.
    // However, the prompt implies "chat-based", so there must be a chat_id. 
    // We'll fetch the most recently updated bot_session as a heuristic, or require TELEGRAM_CHAT_ID env var.
    // Let's use TELEGRAM_CHAT_ID env var for the "owner" of the tracker.
    
    const chatId = Deno.env.get("TELEGRAM_CHAT_ID"); 
    
    if (botToken && chatId) {
        await sendTelegramNotification(botToken, chatId, transaction, parseResult.source_of_fund);
    }

    return new Response(
      JSON.stringify({
        raw_email_id: rawEmail.id,
        transaction_id: transaction.id,
        deduped: false,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );

  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// --- Parsing Logic ---

function parseEmail(payload: any) {
  const { subject, text_body, html_body, date_header, from_email } = payload;
  const content = (text_body || "") + " " + (html_body || ""); // naive combine
  const cleanContent = cleanText(content);
  
  const rules_triggered = [];
  const evidence: any = {};
  
  // 1. Amount
  let amount = 0;
  // Regex for IDR: Rp 35.000, Rp35,000, IDR 35000, 35.000,00
  // Simplification: look for Rp/IDR followed by digits/dots/commas
  const amountRegex = /(?:Rp|IDR)\s?\.?([0-9.,]+)/i;
  const amountMatch = cleanContent.match(amountRegex);
  if (amountMatch) {
    const rawAmount = amountMatch[1];
    // Remove non-digits to get integer
    const numericString = rawAmount.replace(/[^0-9]/g, "");
    amount = parseInt(numericString, 10);
    evidence.amount_line = amountMatch[0];
    rules_triggered.push("amount_regex_match");
  }

  // 2. Direction
  let direction = "debit"; // default
  const debitKeywords = ["Pembayaran", "Berhasil dibayar", "Total Tagihan", "Total Pembayaran", "Purchase", "Payment"];
  const creditKeywords = ["Refund", "Pengembalian", "Dana masuk", "Cashback", "Top Up", "Topup"];
  
  const lowerContent = cleanContent.toLowerCase();
  const lowerSubject = (subject || "").toLowerCase();
  
  if (creditKeywords.some(k => lowerContent.includes(k.toLowerCase()) || lowerSubject.includes(k.toLowerCase()))) {
    direction = "credit";
    rules_triggered.push("direction_keyword_credit");
  } else if (debitKeywords.some(k => lowerContent.includes(k.toLowerCase()) || lowerSubject.includes(k.toLowerCase()))) {
    direction = "debit";
    rules_triggered.push("direction_keyword_debit");
  }

  // 3. Merchant
  let merchant = subject || "Unknown Merchant";
  // Try to clean up merchant from subject if possible (e.g. "Receipt from Gojek")
  if (merchant.toLowerCase().includes("receipt from ")) {
    merchant = merchant.replace(/receipt from /i, "").trim();
  }
  // If from_email is known domain
  if (from_email && from_email.includes("gojek")) merchant = "Gojek";
  if (from_email && from_email.includes("grab")) merchant = "Grab";
  if (from_email && from_email.includes("tokopedia")) merchant = "Tokopedia";
  if (from_email && from_email.includes("shopee")) merchant = "Shopee";

  // 4. Source of Fund
  let source_of_fund = null;
  const sourceKeywords = ["OVO", "GoPay", "Dana", "BCA", "Mandiri", "Jenius", "Credit Card"];
  for (const src of sourceKeywords) {
    if (cleanContent.includes(src)) {
      source_of_fund = src;
      evidence.method_line = src;
      rules_triggered.push("source_keyword_match");
      break;
    }
  }

  // 5. Note
  const note = subject;

  return {
    happened_at: date_header, // Fallback
    amount,
    direction,
    merchant,
    source_of_fund,
    note,
    confidence: amount > 0 ? 0.8 : 0.3,
    evidence,
    rules_triggered
  };
}

function cleanText(text: string) {
  if (!text) return "";
  // Remove HTML tags
  let cleaned = text.replace(/<[^>]*>?/gm, " ");
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

async function sendTelegramNotification(token: string, chatId: string, tx: any, sourceName: string | null) {
  const text = `
🆕 <b>Pending Transaction</b>

💰 <b>${tx.currency} ${new Intl.NumberFormat('id-ID').format(tx.amount)}</b>
🏪 ${tx.merchant}
📅 ${new Date(tx.happened_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
🔄 ${tx.direction.toUpperCase()}
💳 ${sourceName || "Unknown Source"}
📝 ${tx.note || "-"}

Please categorize or edit this transaction.
`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Confirm & Categorize", callback_data: `tx_confirm:${tx.id}` }
      ],
      [
        { text: "🏷️ Set Category", callback_data: `tx_cat:${tx.id}` },
        { text: "🏦 Set Source", callback_data: `tx_src:${tx.id}` }
      ],
      [
         { text: "✏️ Edit Amount", callback_data: `tx_amt:${tx.id}` },
         { text: "🕒 Edit Date", callback_data: `tx_date:${tx.id}` }
      ],
      [
        { text: "❌ Reject", callback_data: `tx_reject:${tx.id}` }
      ]
    ]
  };

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      reply_markup: keyboard
    })
  });
}
