import { supabase } from "./supabase";
import { startOfMonth, endOfMonth, format } from "date-fns";

export async function getMonthlyReport(date: Date = new Date()) {
  const start = startOfMonth(date).toISOString();
  const end = endOfMonth(date).toISOString();

  // 1. Get Expenses (Debit, Completed)
  const { data: expenses } = await supabase
    .from("transactions")
    .select(`
      amount,
      category_id,
      categories (name),
      subcategory_id,
      subcategories (name)
    `)
    .eq("direction", "debit")
    .eq("status", "completed")
    .gte("happened_at", start)
    .lte("happened_at", end);

  // 2. Get Budgets
  const { data: budgets } = await supabase
    .from("budgets")
    .select(`
      amount,
      category_id,
      categories (name),
      subcategory_id,
      subcategories (name)
    `)
    .eq("month", format(date, "yyyy-MM-01"));

  // 3. Aggregate
  const categoryStats: Record<string, { spent: number; budget: number; name: string }> = {};

  // Sum Expenses
  expenses?.forEach((tx: any) => {
    const catName = tx.categories?.name || "Uncategorized";
    if (!categoryStats[catName]) {
      categoryStats[catName] = { spent: 0, budget: 0, name: catName };
    }
    categoryStats[catName].spent += tx.amount;
  });

  // Sum Budgets
  budgets?.forEach((b: any) => {
    const catName = b.categories?.name || "Uncategorized";
    if (!categoryStats[catName]) {
      categoryStats[catName] = { spent: 0, budget: 0, name: catName };
    }
    categoryStats[catName].budget += b.amount;
  });

  return {
    month: format(date, "MMMM yyyy"),
    stats: Object.values(categoryStats),
    totalSpent: Object.values(categoryStats).reduce((sum, item) => sum + item.spent, 0),
    totalBudget: Object.values(categoryStats).reduce((sum, item) => sum + item.budget, 0),
  };
}

export async function getTodaySummary() {
    const start = new Date();
    start.setHours(0,0,0,0);
    const end = new Date();
    end.setHours(23,59,59,999);
    
    const { data: txs } = await supabase
        .from("transactions")
        .select("amount, categories(name), merchant")
        .eq("direction", "debit")
        .eq("status", "completed")
        .gte("happened_at", start.toISOString())
        .lte("happened_at", end.toISOString());
        
    let total = 0;
    const summary: string[] = [];
    
    txs?.forEach((tx: any) => {
        total += tx.amount;
        summary.push(`- ${tx.categories?.name || 'Uncat'}: ${new Intl.NumberFormat('id-ID').format(tx.amount)} (${tx.merchant})`);
    });
    
    return {
        total,
        lines: summary
    };
}

export async function getAvailablePeriods() {
    // Read from the new table 'period_summaries' first
    const { data: periods, error } = await supabase
        .from("period_summaries")
        .select("period_start_date, period_end_date")
        .order("period_start_date", { ascending: false });

    if (error) {
        console.error("Error fetching periods from table:", error);
        // Fallback to view if table is empty
    }

    if (periods && periods.length > 0) {
        return periods.map(p => ({ start: p.period_start_date, end: p.period_end_date }));
    }

    // Fallback: Get from view if table not populated yet
    const { data: viewPeriods } = await supabase
        .from("budget_performance_summary")
        .select("period_start_date, period_end_date")
        .order("period_start_date", { ascending: false });
        
    if (!viewPeriods) return [];

    const seen = new Set();
    const uniquePeriods: { start: string, end: string }[] = [];
    for (const p of viewPeriods) {
        if (!seen.has(p.period_start_date)) {
            seen.add(p.period_start_date);
            uniquePeriods.push({ start: p.period_start_date, end: p.period_end_date });
        }
    }
    return uniquePeriods.slice(0, 5);
}

export async function getPeriodStats(start: string, end: string) {
    // Try to get from period_summaries table first
    const { data: summary } = await supabase
        .from("period_summaries")
        .select("*")
        .eq("period_start_date", start)
        .eq("period_end_date", end)
        .single();

    if (summary) {
        return {
            start: new Date(start),
            end: new Date(end),
            totalExpense: summary.total_actual_expense,
            totalIncome: summary.total_actual_income,
            net: summary.total_actual_income - summary.total_actual_expense,
            budgetedExpense: summary.total_budgeted_expense,
            budgetedIncome: summary.total_budgeted_income
        };
    }

    // Fallback to dynamic calculation if not in table
    const { data: budgetData } = await supabase
        .from("budget_performance_summary")
        .select("category_type, total_budgeted")
        .eq("period_start_date", start)
        .eq("period_end_date", end);

    let budgetedExpense = 0;
    let budgetedIncome = 0;

    budgetData?.forEach((row: any) => {
        const amount = parseFloat(row.total_budgeted || "0");
        if (row.category_type === 'expense') budgetedExpense += amount;
        if (row.category_type === 'income') budgetedIncome += amount;
    });

    // Calculate Total Expense and Income from transactions
    const { data: txs, error: txError } = await supabase
        .from("transactions")
        .select("*")
        .in("status", ["completed", "paid"])
        .gte("date", start)
        .lte("date", end);

    if (txError) {
        return { error: `Transaction query failed: ${txError.message}` };
    }

    let totalExpense = 0;
    let totalIncome = 0;

    txs?.forEach((t: any) => {
        const isExpense = t.direction === 'debit' || t.type === 'expense';
        const isIncome = t.direction === 'credit' || t.type === 'income';

        const desc = (t.description || t.merchant || "").toLowerCase();
        const isInternal = desc.includes("internal transfer");

        if (isExpense) totalExpense += t.amount;
        if (isIncome && !isInternal) totalIncome += t.amount;
    });

    return {
        start: new Date(start),
        end: new Date(end),
        totalExpense,
        totalIncome,
        net: totalIncome - totalExpense,
        budgetedExpense,
        budgetedIncome
    };
}

export async function recalculateAllSummaries() {
    // 1. Get unique periods from the View
    const { data: viewRows, error } = await supabase.from("budget_performance_summary").select("*");
    
    if (error) return { error: error.message };
    if (!viewRows) return { count: 0 };

    // Debug: Check transactions count
    const { count: txCount } = await supabase.from("transactions").select("*", { count: 'exact', head: true });
    console.log(`Total transactions in DB: ${txCount}`);

    // Group by period to merge income/expense rows
    const periodsMap = new Map();

    for (const row of viewRows) {
        const key = `${row.user_id}:${row.period_start_date}:${row.period_end_date}`;
        if (!periodsMap.has(key)) {
            periodsMap.set(key, {
                user_id: row.user_id,
                start: row.period_start_date,
                end: row.period_end_date,
                budgetExpense: 0,
                budgetIncome: 0
            });
        }
        const p = periodsMap.get(key);
        const amount = parseFloat(row.total_budgeted || "0");
        if (row.category_type === 'expense') p.budgetExpense += amount;
        if (row.category_type === 'income') p.budgetIncome += amount;
    }

    let count = 0;
    let debugMsg = "";

    // 2. Process each period
    for (const p of periodsMap.values()) {
        // Calculate Actuals
        // Note: Data might use 'date' column instead of 'happened_at'
        // And status might be 'paid' instead of 'completed'
        // Select * to avoid missing column errors if description/merchant schema varies
        const { data: txs } = await supabase.from("transactions")
            .select("*")
            .in("status", ["completed", "paid"]) 
            .gte("date", p.start)
            .lte("date", p.end);
        
        let actualExpense = 0;
        let actualIncome = 0;

        txs?.forEach((t: any) => {
            // Check direction OR type
            const isExpense = t.direction === 'debit' || t.type === 'expense';
            const isIncome = t.direction === 'credit' || t.type === 'income';
            
            // Check for Internal Transfer
            const desc = (t.description || t.merchant || "").toLowerCase();
            const isInternal = desc.includes("internal transfer");

            if (isExpense) actualExpense += t.amount;
            if (isIncome && !isInternal) actualIncome += t.amount;
        });

        // Debug log for first period
        if (count === 0) {
            debugMsg = `Debug: Period ${p.start}-${p.end}. Found ${txs?.length} txs. Exp: ${actualExpense}, Inc: ${actualIncome}.`;
            console.log(debugMsg);
        }

        // 3. Upsert into period_summaries table
        await supabase.from("period_summaries").upsert({
            user_id: p.user_id,
            period_start_date: p.start,
            period_end_date: p.end,
            total_budgeted_expense: p.budgetExpense,
            total_budgeted_income: p.budgetIncome,
            total_actual_expense: actualExpense,
            total_actual_income: actualIncome,
            last_recalculated_at: new Date().toISOString()
        }, { onConflict: 'user_id, period_start_date, period_end_date' });
        
        count++;
    }

    return { count, debugMsg, totalTx: txCount };
}

export async function getTransactionsForPeriod(start: string, end: string, type: 'expense' | 'income', page: number = 0) {
    const PAGE_SIZE = 10;
    
    // Fetch ALL matching transactions for the period (without pagination first)
    const { data: allTxs, error } = await supabase
        .from("transactions")
        .select("*")
        .in("status", ["completed", "paid"])
        .gte("date", start)
        .lte("date", end)
        .order("date", { ascending: false });

    if (error) {
        console.error("Error fetching txs:", error);
        return { txs: [], total: 0 };
    }

    // Fetch Source of Funds map
    let { data: sources, error: sourceError } = await supabase.from("source_of_funds").select("id, name");
    
    // Fallback: Try 'funds' table if 'source_of_funds' is empty or failed
    if (sourceError || !sources || sources.length === 0) {
        const { data: funds } = await supabase.from("funds").select("id, name");
        if (funds && funds.length > 0) {
            sources = funds;
            console.log(`Debug: Switched to 'funds' table. Found ${funds.length} rows.`);
        }
    }

    const sourceMap = new Map();
    sources?.forEach((s: any) => sourceMap.set(s.id, s.name));

    console.log(`Debug: Loaded ${sources?.length} sources.`);

    // Filter in memory
    const filteredTxs = (allTxs || []).filter((t: any) => {
        if (type === 'expense') {
            return t.direction === 'debit' || t.type === 'expense';
        } else {
            return t.direction === 'credit' || t.type === 'income';
        }
    });

    // Attach source name
    filteredTxs.forEach((t: any) => {
        // Check both possible column names
        const sourceId = t.source_of_funds_id || t.source_of_fund_id;
        t.source_name = sourceMap.get(sourceId) || "Unknown";
        
        // Debug first item
        if (filteredTxs.indexOf(t) === 0) {
             console.log(`Debug Tx: ID=${t.id}, SourceID=${sourceId}, MapHas=${sourceMap.has(sourceId)}`);
        }
    });

    // Filter out Internal Transfer for Income
    const finalTxs = filteredTxs.filter((t: any) => {
        if (type === 'income') {
            const desc = (t.description || t.merchant || "").toLowerCase();
            if (desc.includes("internal transfer")) return false;
        }
        return true;
    });

    const total = finalTxs.length;
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE;
    const paginatedTxs = finalTxs.slice(from, to);

    return { txs: paginatedTxs, total };
}

export async function getBudgetBreakdown(start: string, end: string) {
    // 1. Get Expenses with Names (Join directly)
    const { data: expenses } = await supabase.from("transactions")
        .select(`amount, subcategory_id, subcategories(name, categories(name))`)
        .gte("date", start)
        .lte("date", end)
        .eq("direction", "debit")
        .in("status", ["completed", "paid"]);

    // 2. Get Budgets with Names (Join directly)
    const { data: budgets } = await supabase.from("budgets")
        .select(`budgeted_amount, subcategory_id, subcategories(name, categories(name))`)
        .eq("period_start_date", start)
        .eq("period_end_date", end);

    // 3. Aggregate
    const stats = new Map();

    // Helper to generate key
    const getKey = (cat: string, sub: string) => `${cat} - ${sub}`;

    // Process Budgets
    budgets?.forEach((b: any) => {
        // Access nested properties
        const cat = b.subcategories?.categories?.name || "Uncategorized";
        const sub = b.subcategories?.name || "General";
        const key = getKey(cat, sub);
        
        if (!stats.has(key)) stats.set(key, { cat, sub, budget: 0, actual: 0 });
        stats.get(key).budget += b.budgeted_amount;
    });

    // Process Actuals
    expenses?.forEach((e: any) => {
        // Access nested properties
        const cat = e.subcategories?.categories?.name || "Uncategorized";
        const sub = e.subcategories?.name || "General";
        const key = getKey(cat, sub);
        
        if (!stats.has(key)) stats.set(key, { cat, sub, budget: 0, actual: 0 });
        stats.get(key).actual += e.amount;
    });

    // Convert to array and sort
    return Array.from(stats.values())
        .sort((a: any, b: any) => b.actual - a.actual);
}
