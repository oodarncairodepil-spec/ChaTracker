import { supabase } from "@/lib/supabase";
import { sendTelegramMessage, editMessageText, answerCallbackQuery, setMyCommands, setChatMenuButton } from "@/utils/telegram";
import { getMonthlyReport, getTodaySummary, getAvailablePeriods, getPeriodStats, recalculateAllSummaries, getTransactionsForPeriod } from "@/lib/reporting";
import { getCategories, getSubcategories } from "@/lib/dbCompatibility";

export async function handleUpdate(update: any) {
  try {
    // 1. Callback Query
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return;
    }

    // 2. Message
    if (update.message) {
      await handleMessage(update.message);
      return;
    }
  } catch (error) {
    console.error("Bot Logic Error:", error);
  }
}

async function handleMessage(message: any) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || "";

  // Get or Create Session
  let { data: session } = await supabase
    .from("bot_sessions")
    .select("*")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .single();

  if (!session) {
    const { data: newSession } = await supabase
      .from("bot_sessions")
      .insert({ chat_id: chatId, user_id: userId, state: "idle" })
      .select()
      .single();
    session = newSession;
  }

  // Commands (cancel flow if command)
  const isCommand = text.startsWith("/") || ["Period", "Recalculate", "Today", "Pending"].includes(text);
  if (isCommand) {
    if (session.state !== "idle") {
        await updateSession(session.id, "idle", {});
    }
    await handleCommand(chatId, text, session);
    return;
  }

  // State Machine Input
  if (session.state !== "idle") {
    await handleStateInput(chatId, text, session);
    return;
  }

  // Default
  await sendTelegramMessage(chatId, "I didn't understand that. Try /pending, /new, /today, /month or /period.");
}

async function handleCommand(chatId: number, text: string, session: any) {
  try {
    const command = text.split(" ")[0]; // e.g. "/start"
    const isPeriod = command === "/period" || text === "Period";
    const isRecalculate = command === "/recalculate" || text === "Recalculate";
    const isToday = command === "/today" || text === "Today";
    const isPending = command === "/pending" || text === "Pending";
    
    console.log(`Processing command: ${text} from ${chatId}`);

    if (command === "/start") {
      await updateSession(session.id, "idle", {});
      await sendTelegramMessage(chatId, "Welcome to WalleTracker! 🤖💰\nSelect an option below:", {
        reply_markup: {
          keyboard: [
            [{ text: "Period" }, { text: "Today" }],
            [{ text: "Recalculate" }, { text: "Pending" }]
          ],
          resize_keyboard: true,
          persistent: true
        }
      });
    } else if (isPending) {
      await showPendingTransactions(chatId);
    } else if (command === "/new") {
      await updateSession(session.id, "await_amount", { type: "manual_entry" });
      await sendTelegramMessage(chatId, "Enter amount (e.g. 50000):");
    } else if (command === "/budget" || command === "/month") {
      await showBudget(chatId);
    } else if (isToday) {
      await showToday(chatId);
    } else if (isPeriod) {
      console.log("Showing period menu...");
      await showPeriodMenu(chatId);
    } else if (isRecalculate) {
      console.log("Starting recalculation...");
      await sendTelegramMessage(chatId, "⏳ Recalculating budget summaries... this may take a moment.");
      const result: any = await recalculateAllSummaries();
      console.log("Recalculation result:", result);
      if (result.error) {
          await sendTelegramMessage(chatId, `⚠️ Error: ${result.error}`);
      } else {
          await sendTelegramMessage(chatId, `✅ Done! Updated ${result.count} summary rows.\n\n🔍 Debug: Total TXs in DB: ${result.totalTx}\n${result.debugMsg}`);
      }
    } else if (command === "/setmenu") {
      await setMyCommands([
          { command: "start", description: "Start & Menu" },
          { command: "period", description: "Check Tracker Period" },
          { command: "today", description: "Today's Spending" },
          { command: "pending", description: "Check Pending Transactions" },
          { command: "recalculate", description: "Refresh Data" }
      ]);
      await setChatMenuButton(chatId); // Reset to commands mode
      await sendTelegramMessage(chatId, "✅ Menu commands updated and button reset to 'Menu'. Restart app if needed.");
    } else if (command === "/resetmenu") {
      await setChatMenuButton(chatId);
      await sendTelegramMessage(chatId, "✅ Menu button reset to standard Commands list.");
    } else if (command === "/setwebapp") {
      const url = text.split(" ")[1];
      if (!url) {
          await sendTelegramMessage(chatId, "Please provide the Web App URL. Usage: /setwebapp https://your-app.com");
          return;
      }
      await setChatMenuButton(chatId, url);
      await sendTelegramMessage(chatId, "✅ Web App button set! Restart Telegram to see it.");
    } else {
      console.log("Unknown command");
      await sendTelegramMessage(chatId, "Unknown command.");
    }
  } catch (error: any) {
    console.error("Command Error:", error);
    await sendTelegramMessage(chatId, `⚠️ Error processing command: ${error.message}`);
  }
}

async function showPeriodMenu(chatId: number) {
  const periods = await getAvailablePeriods();
  
  if (!periods || periods.length === 0) {
    await sendTelegramMessage(chatId, "No periods found in summary table.");
    return;
  }

  // Sort descending
  periods.sort((a: any, b: any) => new Date(b.start).getTime() - new Date(a.start).getTime());
  const latest = periods[0];

  const years = new Set<string>();
  periods.forEach((p: any) => {
      years.add(new Date(p.start).getFullYear().toString());
      years.add(new Date(p.end).getFullYear().toString());
  });
  
  const sortedYears = Array.from(years).sort().reverse();
  const buttons = [];

  // Latest
  buttons.push([{
    text: `⚡️ Latest: ${formatDate(latest.start)} - ${formatDate(latest.end)}`,
    callback_data: `period:${latest.start}:${latest.end}`
  }]);

  // Years
  sortedYears.forEach(year => {
      buttons.push([{ text: `📅 ${year}`, callback_data: `year_periods:${year}` }]);
  });

  await sendTelegramMessage(chatId, "Select Period Option:", {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showPeriodsForYear(chatId: number, year: string) {
    const periods = await getAvailablePeriods();
    // Filter periods that overlap with year
    const filtered = periods.filter((p: any) => {
        const s = new Date(p.start).getFullYear().toString();
        const e = new Date(p.end).getFullYear().toString();
        return s === year || e === year;
    });
    
    // Sort descending
    filtered.sort((a: any, b: any) => new Date(b.start).getTime() - new Date(a.start).getTime());

    const buttons = filtered.map((p: any) => [{
        text: `${formatDate(p.start)} - ${formatDate(p.end)}`,
        callback_data: `period:${p.start}:${p.end}`
    }]);

    await sendTelegramMessage(chatId, `Periods in ${year}:`, {
        reply_markup: { inline_keyboard: buttons }
    });
}

function formatDate(dateStr: string): string {
    if (!dateStr) return "";
    try {
        const d = new Date(dateStr);
        const day = d.getDate().toString().padStart(2, '0');
        const month = d.toLocaleString('en-US', { month: 'short' });
        const year = d.getFullYear().toString().slice(-2);
        return `${day} ${month} '${year}`;
    } catch (e) {
        return dateStr;
    }
}

async function showPeriodStats(chatId: number, start: string, end: string) {
  const summary: any = await getPeriodStats(start, end);
  
  if (summary?.error) {
    await sendTelegramMessage(chatId, `⚠️ Error: ${summary.error}`);
    return;
  }

  const fmt = new Intl.NumberFormat('id-ID');
  const startStr = formatDate(start);
  const endStr = formatDate(end);

  const msg = `
📊 <b>Tracker Period Summary</b>
📅 ${startStr} - ${endStr}

💸 <b>Expense:</b> Rp ${fmt.format(summary.totalExpense)}
   <i>(Budget: Rp ${fmt.format(summary.budgetedExpense)})</i>

💰 <b>Income:</b> Rp ${fmt.format(summary.totalIncome)}
   <i>(Budget: Rp ${fmt.format(summary.budgetedIncome)})</i>

📉 <b>Net Flow:</b> Rp ${fmt.format(summary.net)}
`;

  const buttons = {
      inline_keyboard: [
          [
              { text: "📉 View Expenses", callback_data: `list_tx:${start}:${end}:expense:0` },
              { text: "💰 View Income", callback_data: `list_tx:${start}:${end}:income:0` }
          ]
      ]
  };

  await sendTelegramMessage(chatId, msg, { reply_markup: buttons });
}

async function listTransactions(chatId: number, start: string, end: string, type: 'expense' | 'income', page: number) {
    const { txs, total } = await getTransactionsForPeriod(start, end, type, page);
    
    if (txs.length === 0) {
        await sendTelegramMessage(chatId, "No transactions found.");
        return;
    }

    const fmt = new Intl.NumberFormat('id-ID');
    let msg = `📋 <b>${type.toUpperCase()} List</b> (Page ${page + 1} of ${Math.ceil(total / 10)})\n`;
    msg += `📅 ${formatDate(start)} - ${formatDate(end)}\n\n`;

    txs.forEach((t: any) => {
        const dateRaw = t.date || (t.happened_at ? t.happened_at.split('T')[0] : "Unknown");
        const date = formatDate(dateRaw);
        
        // Single line format: Desc | Source | Amount | Date (Type)
        const desc = t.description || t.merchant || "No Desc";
        // Shorten description to max 6 chars
        const shortDesc = desc.length > 6 ? desc.substring(0, 6) + "..." : desc;
        
        const source = t.source_name || "Unknown";
        
        // Tag (Exp/Inc)
        const tag = type === 'expense' ? '(Exp)' : '(Inc)';
        
        msg += `${shortDesc} | ${source} | ${fmt.format(t.amount)} | ${date} ${tag}\n`;
    });

    // Pagination buttons
    const buttons = [];
    const hasNext = (page + 1) * 10 < total;
    const hasPrev = page > 0;

    if (hasPrev || hasNext) {
        const row = [];
        if (hasPrev) row.push({ text: "⬅️ Prev", callback_data: `list_tx:${start}:${end}:${type}:${page - 1}` });
        if (hasNext) row.push({ text: "Next ➡️", callback_data: `list_tx:${start}:${end}:${type}:${page + 1}` });
        buttons.push(row);
    }

    await sendTelegramMessage(chatId, msg, { reply_markup: { inline_keyboard: buttons } });
}

async function handleCallbackQuery(query: any) {
  const chatId = query.message.chat.id;
  const data = query.data;
  const messageId = query.message.message_id;

  // data format: action:id:extra
  const parts = data.split(":");
  const action = parts[0];

  if (action === "period") {
      const start = parts[1];
      const end = parts[2];
      await answerCallbackQuery(query.id, "Loading...");
      await showPeriodStats(chatId, start, end);
      return;
  }
  if (action === "year_periods") {
      const year = parts[1];
      await answerCallbackQuery(query.id, `Loading ${year}...`);
      await showPeriodsForYear(chatId, year);
      return;
  }
  if (action === "list_tx") {
      const start = parts[1];
      const end = parts[2];
      const type: any = parts[3];
      const page = parseInt(parts[4] || "0", 10);
      
      await answerCallbackQuery(query.id, "Loading list...");
      await listTransactions(chatId, start, end, type, page);
      return;
  }
  const id = parts[1]; // usually transaction_id

  if (action === "tx_confirm") {
    // Mark completed
    await supabase.from("transactions").update({ status: "completed" }).eq("id", id);
    await editMessageText(chatId, messageId, "✅ Transaction confirmed and saved.");
    await answerCallbackQuery(query.id, "Confirmed!");
  } else if (action === "tx_reject") {
    await supabase.from("transactions").update({ status: "rejected" }).eq("id", id);
    await editMessageText(chatId, messageId, "❌ Transaction rejected.");
    await answerCallbackQuery(query.id, "Rejected");
  } else if (action === "tx_cat") {
    // Show categories
    await showCategories(chatId, id);
    await answerCallbackQuery(query.id);
  } else if (action === "set_cat") {
    // set_cat:txId:catId
    const txId = parts[1];
    const catId = parts[2];
    await supabase.from("transactions").update({ category_id: catId }).eq("id", txId);
    // Ask for subcategory
    await showSubcategories(chatId, txId, catId);
    await answerCallbackQuery(query.id);
  } else if (action === "set_sub") {
    // set_sub:txId:subId
    const txId = parts[1];
    const subId = parts[2]; // could be 'skip'
    if (subId !== 'skip') {
      await supabase.from("transactions").update({ subcategory_id: subId }).eq("id", txId);
    }
    await supabase.from("transactions").update({ status: "completed" }).eq("id", txId);
    await editMessageText(chatId, messageId, "✅ Transaction categorized and saved!");
    await answerCallbackQuery(query.id);
  } else if (action === "tx_dir") {
      // Manual entry direction: tx_dir:session_id:debit|credit
      const sessionId = parts[1];
      const direction = parts[2];
      await updateSession(sessionId, "await_merchant", { direction: direction }); // Wait, context needs to merge? No, fetching fresh
      // We need to retrieve context first to merge, but here we can just pass to next step logic or update DB
      // Actually handleStateInput is for text, callbacks are here.
      // We need to update context.
      const { data: session } = await supabase.from("bot_sessions").select("*").eq("id", sessionId).single();
      const newContext = { ...session.context, direction };
      await updateSession(sessionId, "await_merchant", newContext);
      await sendTelegramMessage(chatId, `Set to ${direction.toUpperCase()}. Now enter Merchant name:`);
      await answerCallbackQuery(query.id);
  }
}

// --- Helpers ---

async function updateSession(id: string, state: string, context: any) {
  await supabase.from("bot_sessions").update({ state, context }).eq("id", id);
}

async function showPendingTransactions(chatId: number) {
  const { data: txs } = await supabase
    .from("transactions")
    .select("*")
    .eq("status", "pending")
    .order("happened_at", { ascending: false })
    .limit(5);

  if (!txs || txs.length === 0) {
    await sendTelegramMessage(chatId, "No pending transactions! 🎉");
    return;
  }

  for (const tx of txs) {
    const text = `
🆕 <b>Pending Transaction</b>
💰 ${tx.currency} ${new Intl.NumberFormat('id-ID').format(tx.amount)}
🏪 ${tx.merchant || "Unknown"}
📅 ${new Date(tx.happened_at).toLocaleDateString()}
`;
    const keyboard = {
      inline_keyboard: [
        [{ text: "✅ Confirm", callback_data: `tx_confirm:${tx.id}` }],
        [{ text: "🏷️ Categorize", callback_data: `tx_cat:${tx.id}` }],
        [{ text: "❌ Reject", callback_data: `tx_reject:${tx.id}` }]
      ]
    };
    await sendTelegramMessage(chatId, text, { reply_markup: keyboard });
  }
}

async function showCategories(chatId: number, txId: string) {
  const categories = await getCategories();
  if (!categories || categories.length === 0) {
      await sendTelegramMessage(chatId, "No categories found.");
      return;
  }

  const buttons = [];
  let row = [];
  for (const c of categories) {
      row.push({ text: c.name, callback_data: `set_cat:${txId}:${c.id}` });
      if (row.length === 2) {
          buttons.push(row);
          row = [];
      }
  }
  if (row.length > 0) buttons.push(row);

  await sendTelegramMessage(chatId, "Select Category:", {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showSubcategories(chatId: number, txId: string, catId: string) {
  const subs = await getSubcategories(catId);
  
  const buttons = [];
  if (subs) {
      let row = [];
      for (const s of subs) {
          row.push({ text: s.name, callback_data: `set_sub:${txId}:${s.id}` });
          if (row.length === 2) {
              buttons.push(row);
              row = [];
          }
      }
      if (row.length > 0) buttons.push(row);
  }
  
  buttons.push([{ text: "Skip Subcategory", callback_data: `set_sub:${txId}:skip` }]);

  await sendTelegramMessage(chatId, "Select Subcategory:", {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handleStateInput(chatId: number, text: string, session: any) {
    const state = session.state;
    const context = session.context;

    if (state === "await_amount") {
        const amount = parseInt(text.replace(/[^0-9]/g, ""), 10);
        if (isNaN(amount)) {
            await sendTelegramMessage(chatId, "Invalid amount. Please enter a number.");
            return;
        }
        const newContext = { ...context, amount };
        await updateSession(session.id, "await_direction", newContext);
        
        // Ask direction with buttons
        const keyboard = {
            inline_keyboard: [
                [{ text: "💸 Expense (Debit)", callback_data: `tx_dir:${session.id}:debit` }],
                [{ text: "💰 Income (Credit)", callback_data: `tx_dir:${session.id}:credit` }]
            ]
        };
        await sendTelegramMessage(chatId, "Is this an expense or income?", { reply_markup: keyboard });
    
    } else if (state === "await_merchant") {
        const newContext = { ...context, merchant: text };
        await updateSession(session.id, "await_date", newContext);
        await sendTelegramMessage(chatId, "Enter date (YYYY-MM-DD) or type 'today':");
    
    } else if (state === "await_date") {
        let date = text.toLowerCase() === "today" ? new Date().toISOString() : text;
        // Basic validation could go here
        const newContext = { ...context, happened_at: date };
        await updateSession(session.id, "saving", newContext);
        
        // Save
        const { error } = await supabase.from("transactions").insert({
            status: "completed", // Auto complete for manual
            amount: newContext.amount,
            direction: newContext.direction,
            merchant: newContext.merchant,
            happened_at: newContext.happened_at,
            source: "manual",
            currency: "IDR"
        });
        
        if (error) {
             await sendTelegramMessage(chatId, `Error saving: ${error.message}`);
        } else {
             await sendTelegramMessage(chatId, "✅ Transaction saved!");
        }
        await updateSession(session.id, "idle", {});
    }
}

async function showBudget(chatId: number) {
    const report = await getMonthlyReport();
    let msg = `<b>${report.month} Report</b>\n\n`;
    msg += `Total Spent: Rp ${new Intl.NumberFormat('id-ID').format(report.totalSpent)}\n`;
    msg += `Total Budget: Rp ${new Intl.NumberFormat('id-ID').format(report.totalBudget)}\n\n`;
    
    for (const stat of report.stats) {
        const pct = stat.budget > 0 ? Math.round((stat.spent / stat.budget) * 100) : 0;
        const bar = "█".repeat(Math.min(10, Math.floor(pct / 10))) + "░".repeat(Math.max(0, 10 - Math.floor(pct / 10)));
        
        msg += `<b>${stat.name}</b>\n`;
        msg += `${bar} ${pct}%\n`;
        msg += `Rp ${new Intl.NumberFormat('id-ID').format(stat.spent)} / ${new Intl.NumberFormat('id-ID').format(stat.budget)}\n\n`;
    }
    
    await sendTelegramMessage(chatId, msg);
}

async function showToday(chatId: number) {
    const summary = await getTodaySummary();
    let msg = `<b>Today's Spending</b>\nTotal: Rp ${new Intl.NumberFormat('id-ID').format(summary.total)}\n\n`;
    if (summary.lines.length === 0) {
        msg += "No spending today yet.";
    } else {
        msg += summary.lines.join("\n");
    }
    await sendTelegramMessage(chatId, msg);
}
