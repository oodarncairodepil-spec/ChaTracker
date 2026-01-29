import { supabase } from "@/lib/supabase";
import { sendTelegramMessage, editMessageText, answerCallbackQuery, setMyCommands, setChatMenuButton } from "@/utils/telegram";
import { getMonthlyReport, getTodaySummary, getAvailablePeriods, getPeriodStats, recalculateAllSummaries, getTransactionsForPeriod, getBudgetBreakdown, calculateCurrentPeriod, getAllSubcategories, getPreviousBudget, saveBudget, getLast10Transactions } from "@/lib/reporting";
import { getCategories, getSubcategories } from "@/lib/dbCompatibility";
import { showCategoriesForIngested, showSubcategoriesForIngested, showFundsForIngested, processIngestedTransaction } from "@/lib/ingestHelpers";

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
      // Ensure default menu button is visible
      await setChatMenuButton(chatId);

      await sendTelegramMessage(chatId, "Welcome to WalleTracker! 🤖💰\nSelect an option below:", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📋 Last 10 Transactions", callback_data: "menu_today" },
              { text: "📊 Period", callback_data: "menu_period" }
            ],
            [
              { text: "🔄 Recalculate", callback_data: "menu_recalculate" },
              { text: "⏳ Pending", callback_data: "menu_pending" }
            ],
            [
              { text: "� Process Ingested", callback_data: "menu_process_ingested" },
              { text: "�💰 Fund Balances", callback_data: "show_funds" }
            ]
          ]
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

  // NEW: Add Budget Button
  const current = calculateCurrentPeriod();
  buttons.push([{
    text: `➕ Add Budget (${formatDate(current.start)} - ${formatDate(current.end)})`,
    callback_data: "add_budget_start"
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

async function showFundBalances(chatId: number) {
  const { data: funds } = await supabase.from("funds").select("*").order("name");

  if (!funds || funds.length === 0) {
    await sendTelegramMessage(chatId, "💰 No funds found.");
    return;
  }

  const fmt = new Intl.NumberFormat('id-ID');
  let msg = "💰 <b>Fund Balances</b>\n\n";

  for (const fund of funds) {
    msg += `<b>${fund.name}</b>\n`;
    msg += `Balance: Rp ${fmt.format(fund.current_balance)}\n`;
    msg += `--------------------\n`;
  }

  await sendTelegramMessage(chatId, msg);
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
      ],
      [
        { text: "🔄 Recalculate This Period", callback_data: `recalc_period:${start}:${end}` },
        { text: "📊 View Budget", callback_data: `view_budget:${start}:${end}` }
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

  console.log(`[DEBUG] Callback action: ${action}, data: ${data}`);

  if (action === "menu_today") {
    await answerCallbackQuery(query.id);
    await showToday(chatId);
    return;
  }
  if (action === "menu_period") {
    await answerCallbackQuery(query.id);
    await showPeriodMenu(chatId);
    return;
  }
  if (action === "menu_recalculate") {
    await answerCallbackQuery(query.id, "Recalculating...");
    await sendTelegramMessage(chatId, "⏳ Recalculating budget summaries... this may take a moment.");
    const result: any = await recalculateAllSummaries();
    if (result.error) {
      await sendTelegramMessage(chatId, `⚠️ Error: ${result.error}`);
    } else {
      await sendTelegramMessage(chatId, `✅ Done! Updated ${result.count} summary rows.`);
    }
    return;
  }
  if (action === "menu_pending") {
    await answerCallbackQuery(query.id);
    await showPendingTransactions(chatId);
    return;
  }

  if (action === "menu_process_ingested") {
    await answerCallbackQuery(query.id);
    await showIngestedTransactions(chatId);
    return;
  }

  if (action === "add_budget_start") {
    await answerCallbackQuery(query.id, "Loading categories...");
    const current = calculateCurrentPeriod();

    const userId = query.from.id;
    const { data: session } = await supabase.from("bot_sessions").select("id").eq("chat_id", chatId).eq("user_id", userId).single();

    if (session) {
      await updateSession(session.id, "browsing_budget", { start: current.start, end: current.end });
    }

    const allSubs = await getAllSubcategories();
    const cats = Object.keys(allSubs).sort();

    const { data: budgets } = await supabase.from("budgets")
      .select("subcategory_id, budgeted_amount")
      .eq("period_start_date", current.start)
      .eq("period_end_date", current.end);

    const budgetedSubs = new Set(budgets?.map((b: any) => b.subcategory_id) || []);

    const buttons = [];
    let row: any[] = [];
    for (const cat of cats) {
      const subs = allSubs[cat] || [];
      const budgetedCount = subs.filter((s: any) => budgetedSubs.has(s.id)).length;
      const status = budgetedCount > 0 ? ` ${budgetedCount}/${subs.length}` : ` 0/${subs.length}`;
      row.push({ text: `${cat}${status}`, callback_data: `add_budget_cat:${cat}` });
      if (row.length === 2) {
        buttons.push(row);
        row = [];
      }
    }
    if (row.length > 0) buttons.push(row);

    await sendTelegramMessage(chatId, `📅 Budget for: ${formatDate(current.start)} - ${formatDate(current.end)}\nSelect Category Group:`, {
      reply_markup: { inline_keyboard: buttons }
    });
    return;
  }

  if (action === "show_funds") {
    await answerCallbackQuery(query.id, "Loading fund balances...");
    await showFundBalances(chatId);
    return;
  }

  if (action === "add_budget_cat") {
    const catName = parts.slice(1).join(":");
    await answerCallbackQuery(query.id);

    const userId = query.from.id;
    const { data: session } = await supabase.from("bot_sessions").select("*").eq("chat_id", chatId).eq("user_id", userId).single();

    const currentStart = session?.context?.start || calculateCurrentPeriod().start;
    const currentEnd = session?.context?.end || calculateCurrentPeriod().end;

    const allSubs = await getAllSubcategories();
    const subs = allSubs[catName] || [];

    const { data: budgets } = await supabase.from("budgets")
      .select("subcategory_id")
      .eq("period_start_date", currentStart)
      .eq("period_end_date", currentEnd);

    const budgetedSubs = new Set(budgets?.map((b: any) => b.subcategory_id) || []);

    const buttons = [];
    let row: any[] = [];
    for (const s of subs) {
      const isBudgeted = budgetedSubs.has(s.id);
      const icon = isBudgeted ? "✅ " : "  ";
      row.push({ text: `${icon}${s.name}`, callback_data: `add_budget_sub:${s.id}` });
      if (row.length === 2) {
        buttons.push(row);
        row = [];
      }
    }
    if (row.length > 0) buttons.push(row);

    buttons.push([{ text: "🔙 Back to Groups", callback_data: "add_budget_start" }]);

    await sendTelegramMessage(chatId, `📂 Group: ${catName}\nSelect Subcategory:`, {
      reply_markup: { inline_keyboard: buttons }
    });
    return;
  }

  if (action === "add_budget_sub") {
    await answerCallbackQuery(query.id);
    const subId = parts[1];

    // Basic UUID validation (8-4-4-4-12 hex digits)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(subId)) {
      await sendTelegramMessage(chatId, `⚠️ Error: The selected subcategory has an invalid ID format (${subId}). Please contact support or select another.`);
      return;
    }

    const userId = query.from.id;
    const { data: session } = await supabase.from("bot_sessions").select("*").eq("chat_id", chatId).eq("user_id", userId).single();

    if (!session) return;

    const currentStart = session.context?.start || calculateCurrentPeriod().start;
    const currentEnd = session.context?.end || calculateCurrentPeriod().end;

    const prevAmount = await getPreviousBudget(subId, currentStart);

    const { data: currentBudget } = await supabase.from("budgets")
      .select("budgeted_amount")
      .eq("period_start_date", currentStart)
      .eq("period_end_date", currentEnd)
      .eq("subcategory_id", subId)
      .maybeSingle();

    const currentAmount = currentBudget?.budgeted_amount || 0;

    const { data: subData } = await supabase.from("subcategories").select("name").eq("id", subId).single();
    const subName = subData?.name || "Subcategory";

    const fmt = new Intl.NumberFormat('id-ID');

    await updateSession(session.id, "await_budget_amount", {
      subId,
      start: currentStart,
      end: currentEnd
    });

    await sendTelegramMessage(chatId, `💰 Enter budget amount for "${subName}"\n\nPrevious: Rp ${fmt.format(prevAmount)}\nCurrent: Rp ${fmt.format(currentAmount)}\n\nType 0 to set as zero.\nType 1 to set as previous amount.`);
    return;
  }

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
  if (action === "recalc_period") {
    await answerCallbackQuery(query.id, "Recalculating...");
    await recalculateAllSummaries();
    const start = parts[1];
    const end = parts[2];
    await showPeriodStats(chatId, start, end);
    return;
  }
  if (action === "view_budget") {
    const start = parts[1];
    const end = parts[2];
    await answerCallbackQuery(query.id, "Loading summary...");

    const stats: any = await getBudgetBreakdown(start, end);
    const fmt = new Intl.NumberFormat('id-ID');

    let totalActual = 0;
    let totalBudget = 0;
    if (stats && stats.length > 0) {
      stats.forEach((s: any) => {
        totalActual += s.actual;
        totalBudget += s.budget;
      });
    }

    const pct = totalBudget > 0 ? Math.round((totalActual / totalBudget) * 100) : 0;
    const emoji = pct > 100 ? "🚨" : pct > 80 ? "⚠️" : "✅";

    let msg = `📊 <b>Budget Performance</b>\n📅 ${formatDate(start)} - ${formatDate(end)}\n\n`;
    msg += `${emoji} <b>Used vs Budget</b>\n`;
    msg += `${fmt.format(totalActual)} | ${fmt.format(totalBudget)} (${pct}%)\n`;

    const buttons = {
      inline_keyboard: [
        [
          { text: "📋 View Details", callback_data: `view_budget_details:${start}:${end}` }
        ],
        [
          { text: "📂 View by Category", callback_data: `view_budget_category:${start}:${end}` }
        ]
      ]
    };

    await sendTelegramMessage(chatId, msg, { reply_markup: buttons });
    return;
  }

  if (action === "view_budget_category") {
    const start = parts[1];
    const end = parts[2];
    await answerCallbackQuery(query.id, "Loading category view...");

    const stats: any = await getBudgetBreakdown(start, end);
    const fmt = new Intl.NumberFormat('id-ID');

    let msg = `📊 <b>Budget by Category</b>\n📅 ${formatDate(start)} - ${formatDate(end)}\n\n`;
    if (!stats || stats.length === 0) {
      msg += "No budget or expenses found.";
    } else {
      // Group by Category
      const grouped: Record<string, { actual: number, budget: number, subs: any[] }> = {};

      stats.forEach((s: any) => {
        if (!grouped[s.cat]) {
          grouped[s.cat] = { actual: 0, budget: 0, subs: [] };
        }
        grouped[s.cat].actual += s.actual;
        grouped[s.cat].budget += s.budget;
        grouped[s.cat].subs.push(s);
      });

      // Sort Categories by Total Exceed Percentage Descending
      const sortedCats = Object.entries(grouped).sort(([, a], [, b]) => {
        const pctA = a.budget > 0 ? (a.actual / a.budget) : 0;
        const pctB = b.budget > 0 ? (b.actual / b.budget) : 0;
        return pctB - pctA;
      });

      sortedCats.forEach(([catName, data]) => {
        const catPct = data.budget > 0 ? Math.round((data.actual / data.budget) * 100) : 0;
        const catEmoji = catPct > 100 ? "🚨" : catPct > 80 ? "⚠️" : "✅"; // Logic: >100 red, >80 warning, else ok
        // Use warning for >80% as per user example (95% is warning)

        msg += `<b>${catName}</b> ${fmt.format(data.actual)} | ${fmt.format(data.budget)} (${catPct}%) ${catEmoji}\n`;

        // Sort Subcategories by Pct Descending
        data.subs.sort((a: any, b: any) => {
          const pA = a.budget > 0 ? a.actual / a.budget : 0;
          const pB = b.budget > 0 ? b.actual / b.budget : 0;
          return pB - pA;
        });

        data.subs.forEach((s: any) => {
          const sPct = s.budget > 0 ? Math.round((s.actual / s.budget) * 100) : 0;
          const sEmoji = sPct > 100 ? "🚨" : sPct > 80 ? "⚠️" : "✅";
          msg += `  ${s.sub}: ${fmt.format(s.actual)} | ${fmt.format(s.budget)} (${sPct}%) ${sEmoji}\n`;
        });
        msg += "\n";
      });
    }

    await sendTelegramMessage(chatId, msg);
    return;
  }

  if (action === "view_budget_details") {
    const start = parts[1];
    const end = parts[2];
    await answerCallbackQuery(query.id, "Loading details...");

    const stats: any = await getBudgetBreakdown(start, end);
    const fmt = new Intl.NumberFormat('id-ID');

    let msg = `📊 <b>Budget Details</b>\n📅 ${formatDate(start)} - ${formatDate(end)}\n\n`;
    if (!stats || stats.length === 0) {
      msg += "No budget or expenses found.";
    } else {
      // Calculate percentage and sort by percentage descending
      const sortedStats = stats.map((s: any) => ({
        ...s,
        pct: s.budget > 0 ? Math.round((s.actual / s.budget) * 100) : 0
      })).sort((a: any, b: any) => b.pct - a.pct);

      sortedStats.forEach((s: any) => {
        const emoji = s.pct > 100 ? "🚨" : s.pct > 80 ? "⚠️" : "✅";
        // Format: "Subcategory: Actual | Budget (Pct%) Emoji"
        msg += `${s.sub}: ${fmt.format(s.actual)} | ${fmt.format(s.budget)} (${s.pct}%) ${emoji}\n`;
      });
    }

    await sendTelegramMessage(chatId, msg);
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
  } else if (action === "ingest_process") {
    try {
      const ingestId = parts[1];
      console.log(`[DEBUG] Processing ingested transaction: ${ingestId}`);
      await answerCallbackQuery(query.id);
      await showCategoriesForIngested(chatId, ingestId);
    } catch (error) {
      console.error("[ERROR] ingest_process failed:", error);
      await answerCallbackQuery(query.id, "Error occurred");
      await sendTelegramMessage(chatId, `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else if (action === "ingest_skip") {
    const ingestId = parts[1];
    await supabase.from("ingest_transactions").delete().eq("id", ingestId);
    await editMessageText(chatId, messageId, "❌ Ingested transaction skipped.");
    await answerCallbackQuery(query.id, "Skipped");
  } else if (action === "ingest_cat") {
    const txId = parts[1];
    const catId = parts[2];
    await showSubcategoriesForIngested(chatId, txId, catId);
    await answerCallbackQuery(query.id);
  } else if (action === "ingest_sub") {
    const txId = parts[1];
    const catId = parts[2];
    const subId = parts[3];
    await showFundsForIngested(chatId, txId, catId, subId);
    await answerCallbackQuery(query.id);
  } else if (action === "ingest_fund") {
    const txId = parts[1];
    const catId = parts[2];
    const subId = parts[3];
    const fundId = parts[4];
    await processIngestedTransaction(chatId, messageId, txId, catId, subId, fundId);
    await answerCallbackQuery(query.id, "Processing...");
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

async function showIngestedTransactions(chatId: number) {
  const { data: txs } = await supabase
    .from("ingest_transactions")
    .select("*")
    .is("category", null) // Only show unprocessed (no category assigned yet)
    .order("happened_at", { ascending: false })
    .limit(5);

  if (!txs || txs.length === 0) {
    await sendTelegramMessage(chatId, "No ingested transactions to process! 🎉");
    return;
  }

  for (const tx of txs) {
    const fmt = new Intl.NumberFormat('id-ID');
    const direction = tx.direction === 'debit' ? '💸 Expense' : tx.direction === 'credit' ? '💰 Income' : '❓ Unknown';

    const text = `
📥 <b>Ingested Transaction</b>
${direction}
💵 ${tx.currency} ${fmt.format(tx.amount)}
🏪 ${tx.merchant || "Unknown"}
📅 ${new Date(tx.happened_at).toLocaleDateString()}
`;
    const keyboard = {
      inline_keyboard: [
        [{ text: "✅ Process", callback_data: `ingest_process:${tx.id}` }],
        [{ text: "❌ Skip", callback_data: `ingest_skip:${tx.id}` }]
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

  const { data: budgets } = await supabase.from("budgets")
    .select("subcategory_id, budgeted_amount");

  const budgetedSubs = new Set(budgets?.map((b: any) => b.subcategory_id) || []);

  const buttons = [];
  if (subs) {
    let row = [];
    for (const s of subs) {
      const isBudgeted = budgetedSubs.has(s.id);
      const icon = isBudgeted ? "✅ " : "  ";
      row.push({ text: `${icon}${s.name}`, callback_data: `set_sub:${txId}:${s.id}` });
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

  if (state === "await_budget_amount") {
    const trimmedText = text.trim();

    if (trimmedText === "1") {
      const { subId, start, end } = context;
      const prevAmount = await getPreviousBudget(subId, start);
      const fmt = new Intl.NumberFormat('id-ID');

      const result = await saveBudget(start, end, subId, prevAmount, session.user_id);

      if (result.error) {
        await sendTelegramMessage(chatId, `⚠️ Error saving budget: ${result.error.message}`);
      } else {
        await sendTelegramMessage(chatId, `✅ Budget saved: Rp ${fmt.format(prevAmount)}\n\nPrevious: Rp ${fmt.format(result.previousAmount)}`);

        const buttons = [
          [{ text: "➕ Set Another Budget", callback_data: "add_budget_start" }],
          [{ text: "🏁 Finish", callback_data: "menu_period" }]
        ];
        await sendTelegramMessage(chatId, "What's next?", { reply_markup: { inline_keyboard: buttons } });
      }
      await updateSession(session.id, "idle", {});
      return;
    }

    const amount = parseInt(text.replace(/[^0-9]/g, ""), 10);
    if (isNaN(amount)) {
      await sendTelegramMessage(chatId, "Invalid amount. Please enter a number.");
      return;
    }

    const { subId, start, end } = context;

    // Validation for subId from context (handling legacy/broken sessions)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!subId || !uuidRegex.test(subId)) {
      await sendTelegramMessage(chatId, `⚠️ Error: The selected subcategory ID is invalid (${subId}). Please select the category again.`);
      await updateSession(session.id, "idle", {});
      return;
    }

    // Save
    const result = await saveBudget(start, end, subId, amount, session.user_id);

    if (result.error) {
      await sendTelegramMessage(chatId, `⚠️ Error saving budget: ${result.error.message}`);
    } else {
      const fmt = new Intl.NumberFormat('id-ID');
      await sendTelegramMessage(chatId, `✅ Budget saved: Rp ${fmt.format(amount)}\n\nPrevious: Rp ${fmt.format(result.previousAmount)}`);

      const buttons = [
        [{ text: "➕ Set Another Budget", callback_data: "add_budget_start" }],
        [{ text: "🏁 Finish", callback_data: "menu_period" }]
      ];
      await sendTelegramMessage(chatId, "What's next?", { reply_markup: { inline_keyboard: buttons } });
    }
    await updateSession(session.id, "idle", {});
    return;
  }

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
  const txs = await getLast10Transactions();

  if (txs.length === 0) {
    await sendTelegramMessage(chatId, "📋 <b>Last 10 Transactions</b>\n\nNo transactions found.");
    return;
  }

  const fmt = new Intl.NumberFormat('id-ID');
  let msg = "📋 <b>Last 10 Transactions</b>\n\n";

  txs.forEach((tx: any) => {
    const date = tx.date || (tx.happened_at ? tx.happened_at.split('T')[0] : "Unknown");
    const formattedDate = formatDate(date);

    // Use merchant or description, fallback to 'No Desc'
    const description = tx.merchant || tx.description || 'No Desc';
    const source = tx.source_name || tx.source || 'Unknown';

    msg += `${formattedDate} ${source} | ${fmt.format(tx.amount)} | ${description}\n`;
  });

  await sendTelegramMessage(chatId, msg);
}
