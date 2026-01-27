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

export async function getTrackerPeriodSummary() {
    // 1. Get the newest period from budget_performance_summary
    const { data: periods, error } = await supabase
        .from("budget_performance_summary")
        .select("period_start_date, period_end_date")
        .order("period_start_date", { ascending: false })
        .limit(1);

    if (error) {
        console.error("Error fetching periods:", error);
        return { error: error.message };
    }

    if (!periods || periods.length === 0) {
        return { error: "Table 'budget_performance_summary' is empty or RLS is blocking access." };
    }

    const currentPeriod = periods[0];
    const start = currentPeriod.period_start_date;
    const end = currentPeriod.period_end_date;

    // 2. Calculate Total Expense and Income for this period
    // We use the 'transactions' table for calculation
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
        net: totalIncome - totalExpense
    };
}
