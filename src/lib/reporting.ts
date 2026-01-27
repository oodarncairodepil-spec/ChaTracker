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
    // 1. Get unique periods from the View
    const { data: viewRows, error } = await supabase.from("budget_performance_summary").select("*");
    
    if (error) return { error: error.message };
    if (!viewRows) return { count: 0 };

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

    // 2. Process each period
    for (const p of periodsMap.values()) {
        // Calculate Actuals
        const { data: txs } = await supabase.from("transactions")
            .select("amount, direction")
            .eq("status", "completed")
            .gte("happened_at", p.start)
            .lte("happened_at", p.end);
        
        let actualExpense = 0;
        let actualIncome = 0;

        txs?.forEach((t: any) => {
            if (t.direction === 'debit') actualExpense += t.amount;
            if (t.direction === 'credit') actualIncome += t.amount;
        });

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

    return { count };
}
