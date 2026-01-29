import { supabase } from "@/lib/supabase";
import { sendTelegramMessage, editMessageText } from "@/utils/telegram";
import { getCategories, getSubcategories } from "@/lib/dbCompatibility";

const BOT_USER_ID = "354ef27f-64ae-4c6a-8833-2ee14885331e";

export async function showCategoriesForIngested(chatId: number, ingestId: string) {
    const categories = await getCategories();
    if (!categories || categories.length === 0) {
        await sendTelegramMessage(chatId, "No categories found.");
        return;
    }

    const buttons = [];
    let row: any[] = [];
    for (const c of categories) {
        row.push({ text: c.name, callback_data: `ingest_cat:${ingestId}:${c.id}` });
        if (row.length === 2) {
            buttons.push(row);
            row = [];
        }
    }
    if (row.length > 0) buttons.push(row);

    await sendTelegramMessage(chatId, "Select Category for this transaction:", {
        reply_markup: { inline_keyboard: buttons }
    });
}

export async function showSubcategoriesForIngested(chatId: number, ingestId: string, catId: string) {
    const subs = await getSubcategories(catId);

    const buttons = [];
    if (subs) {
        let row: any[] = [];
        for (const s of subs) {
            row.push({ text: s.name, callback_data: `ingest_sub:${ingestId}:${catId}:${s.id}` });
            if (row.length === 2) {
                buttons.push(row);
                row = [];
            }
        }
        if (row.length > 0) buttons.push(row);
    }

    buttons.push([{ text: "Skip Subcategory", callback_data: `ingest_sub:${ingestId}:${catId}:skip` }]);

    await sendTelegramMessage(chatId, "Select Subcategory:", {
        reply_markup: { inline_keyboard: buttons }
    });
}

export async function showFundsForIngested(chatId: number, ingestId: string, catId: string, subId: string) {
    const { data: funds } = await supabase.from("funds").select("id, name").order("name");

    if (!funds || funds.length === 0) {
        await sendTelegramMessage(chatId, "No funds found.");
        return;
    }

    const buttons = [];
    let row: any[] = [];
    for (const f of funds) {
        row.push({ text: f.name, callback_data: `ingest_fund:${ingestId}:${catId}:${subId}:${f.id}` });
        if (row.length === 2) {
            buttons.push(row);
            row = [];
        }
    }
    if (row.length > 0) buttons.push(row);

    await sendTelegramMessage(chatId, "Select Source of Funds:", {
        reply_markup: { inline_keyboard: buttons }
    });
}

export async function processIngestedTransaction(chatId: number, messageId: number, ingestId: string, catId: string, subId: string, fundId: string) {
    // Fetch the ingested transaction
    const { data: ingestTx } = await supabase
        .from("ingest_transactions")
        .select("*")
        .eq("id", ingestId)
        .single();

    if (!ingestTx) {
        await editMessageText(chatId, messageId, "❌ Error: Ingested transaction not found.");
        return;
    }

    // Determine type based on direction
    let type = "expense";
    if (ingestTx.direction === "credit") {
        type = "income";
    } else if (ingestTx.direction === "debit") {
        type = "expense";
    }

    // Create new transaction in main transactions table
    const { error } = await supabase.from("transactions").insert({
        user_id: BOT_USER_ID,
        amount: ingestTx.amount,
        description: ingestTx.merchant || "No description",
        category: catId !== "skip" ? catId : null,
        subcategory: subId !== "skip" ? subId : null,
        type: type,
        status: "paid", // As requested by user
        date: ingestTx.happened_at ? ingestTx.happened_at.split('T')[0] : new Date().toISOString().split('T')[0],
        source_of_funds_id: fundId,
        happened_at: ingestTx.happened_at,
        direction: ingestTx.direction
    });

    if (error) {
        await editMessageText(chatId, messageId, `❌ Error saving transaction: ${error.message}`);
        return;
    }

    // Delete the ingested transaction
    await supabase.from("ingest_transactions").delete().eq("id", ingestId);

    await editMessageText(chatId, messageId, "✅ Transaction processed and saved!");
}
