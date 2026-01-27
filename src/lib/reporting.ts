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
    // Get unique periods from summary table
    // Since we have duplicates (income/expense), we need to group or just select distinct start dates
    // Supabase doesn't have "DISTINCT ON" easily via JS client for specific columns combined with order, 
    // so we'll fetch all and dedup in JS.
    const { data: periods, error } = await supabase
        .from("budget_performance_summary")
        .select("period_start_date, period_end_date")
        .order("period_start_date", { ascending: false });

    if (error) {
        console.error("Error fetching periods:", error);
        return [];
    }

    if (!periods) return [];

    // Dedup based on start_date
    const seen = new Set();
    const uniquePeriods: { start: string, end: string }[] = [];
    
    for (const p of periods) {
        if (!seen.has(p.period_start_date)) {
            seen.add(p.period_start_date);
            uniquePeriods.push({
                start: p.period_start_date,
                end: p.period_end_date
            });
        }
    }

    return uniquePeriods.slice(0, 5); // Return top 5
}

export async function getPeriodStats(start: string, end: string) {
    // 1. Get Budgeted amounts from summary table for this period
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

    // 2. Calculate Total Expense and Income from transactions
    const { data: txs, error: txError } = await supabase
        .from("transactions")
        .select("amount, direction")
        .eq("status", "completed")
        .gte("happened_at", start)
        .lte("happened_at", end);

    if (txError) {
        return { error: `Transaction query failed: ${txError.message}` };
    }

    let totalExpense = 0;
    let totalIncome = 0;

    txs?.forEach((tx: any) => {
        if (tx.direction === 'debit') {
            totalExpense += tx.amount;
        } else if (tx.direction === 'credit') {
            totalIncome += tx.amount;
        }
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
    const { data: rows, error } = await supabase.from("budget_performance_summary").select("*");
    
    if (error) return { error: error.message };
    if (!rows) return { count: 0 };

    let count = 0;

    for (const row of rows) {
        const start = row.period_start_date;
        const end = row.period_end_date;
        const type = row.category_type; // 'expense' or 'income'
        
        // Map category_type to transaction direction
        // expense -> debit, income -> credit
        const direction = type === 'expense' ? 'debit' : 'credit';

        // Calculate Actuals
        const { data: txs } = await supabase.from("transactions")
            .select("amount")
            .eq("direction", direction)
            .eq("status", "completed")
            .gte("happened_at", start)
            .lte("happened_at", end);
        
        const totalActual = txs?.reduce((sum, t) => sum + t.amount, 0) || 0;

        // Calculate Variance (Budget - Actual for Expense? Actual - Budget for Income?)
        // Usually Variance = Budget - Actual (Positive is good for expense)
        // JSON shows total_variance = -57401108 (when actual is 0 and budget is 57M). 
        // So Variance = Actual - Budget? 0 - 57M = -57M.
        // Let's stick to updating total_actual first.

        // Update using composite key
        await supabase.from("budget_performance_summary")
            .update({ 
                total_actual: totalActual,
                // last_recalculated_at: new Date().toISOString() // Add this if migration ran
            })
            .eq("user_id", row.user_id)
            .eq("period_start_date", start)
            .eq("period_end_date", end)
            .eq("category_type", type);
        
        count++;
    }

    return { count };
}
