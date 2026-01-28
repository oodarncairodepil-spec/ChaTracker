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

export function calculateCurrentPeriod() {
    const today = new Date();
    const day = today.getDate();
    let startMonth = today.getMonth();
    let startYear = today.getFullYear();

    // If before the 3rd, it belongs to previous month's period
    if (day < 3) {
        startMonth--;
        if (startMonth < 0) {
            startMonth = 11;
            startYear--;
        }
    }

    const start = new Date(startYear, startMonth, 3);
    const end = new Date(startYear, startMonth + 1, 2);

    // Format YYYY-MM-DD local time
    const toLocalISO = (d: Date) => {
        const offset = d.getTimezoneOffset() * 60000;
        return new Date(d.getTime() - offset).toISOString().split('T')[0];
    };

    return {
        start: toLocalISO(start),
        end: toLocalISO(end)
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

    let uniquePeriods: { start: string, end: string }[] = [];

    if (periods && periods.length > 0) {
        uniquePeriods = periods.map(p => ({ start: p.period_start_date, end: p.period_end_date }));
    } else {
        // Fallback: Get from view if table not populated yet
        const { data: viewPeriods } = await supabase
            .from("budget_performance_summary")
            .select("period_start_date, period_end_date")
            .order("period_start_date", { ascending: false });
            
        if (viewPeriods) {
            const seen = new Set();
            for (const p of viewPeriods) {
                if (!seen.has(p.period_start_date)) {
                    seen.add(p.period_start_date);
                    uniquePeriods.push({ start: p.period_start_date, end: p.period_end_date });
                }
            }
        }
    }

    // Ensure Current Period is in the list
    const current = calculateCurrentPeriod();
    const hasCurrent = uniquePeriods.some(p => p.start === current.start);
    
    if (!hasCurrent) {
        uniquePeriods.unshift(current);
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

export async function getAllSubcategories() {
    // Load ALL mappings to ensure we find everything (Robust fallback)
    // A. Load New Schema (and check for legacy columns like main_category_id)
    const { data: allNewSubs } = await supabase.from("subcategories").select("id, name, main_category_id");
    const { data: allNewCats } = await supabase.from("categories").select("id, name");
    
    // B. Load Legacy Schema (View)
    const { data: allLegacySubs } = await supabase.from("categories_with_hierarchy").select("subcategory_id, subcategory_name, main_category_id, main_category_name");
    const { data: allLegacyCats } = await supabase.from("main_categories").select("id, name");

    // Build Category Map (ID -> Name)
    const catNameMap = new Map();
    allNewCats?.forEach((c: any) => catNameMap.set(c.id, c.name));
    allLegacyCats?.forEach((c: any) => catNameMap.set(c.id, c.name));

    const grouped: Record<string, { id: string, name: string }[]> = {};

    const add = (catName: string, sub: { id: string, name: string }) => {
        if (!grouped[catName]) grouped[catName] = [];
        // Avoid duplicates
        if (!grouped[catName].some(s => s.id === sub.id)) {
            grouped[catName].push(sub);
        }
    };

    // 1. From New Schema
    allNewSubs?.forEach((s: any) => {
        const catId = s.main_category_id;
        const catName = catNameMap.get(catId) || "Unknown Category";
        add(catName, { id: s.id, name: s.name });
    });

    // 2. From Legacy View (categories_with_hierarchy)
    allLegacySubs?.forEach((s: any) => {
        const catName = s.main_category_name || catNameMap.get(s.main_category_id) || "Unknown Category";
        add(catName, { 
            id: s.subcategory_id, 
            name: s.subcategory_name || s.name // view might have 'name' or 'subcategory_name'
        });
    });
    
    // Sort subcategories by name
    Object.keys(grouped).forEach(k => {
        grouped[k].sort((a, b) => a.name.localeCompare(b.name));
    });

    return grouped;
}

export async function getPreviousBudget(subId: string, currentStart: string) {
    // Find the budget for the period immediately preceding the current one
    // Assuming monthly periods... roughly -1 month
    const start = new Date(currentStart);
    start.setMonth(start.getMonth() - 1);
    
    // Or just query the latest budget for this subId that is BEFORE currentStart
    const { data: budgets } = await supabase.from("budgets")
        .select("budgeted_amount")
        .eq("subcategory_id", subId)
        .lt("period_start_date", currentStart)
        .order("period_start_date", { ascending: false })
        .limit(1);

    if (budgets && budgets.length > 0) {
        return budgets[0].budgeted_amount;
    }
    return 0;
}

export async function saveBudget(start: string, end: string, subId: string, amount: number, userId: string) {
    // 0. Validate UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!subId || !uuidRegex.test(subId)) {
        return { message: `Invalid Subcategory ID: ${subId}. Please restart the process.` };
    }

    // 1. Check if exists (using telegram numeric userId for uniqueness context)
    const { data: existing } = await supabase.from("budgets")
        .select("id")
        .eq("period_start_date", start)
        .eq("subcategory_id", subId)
        .single();

    let error;

    if (existing) {
        // Update (omit user_id if it's numeric/invalid for UUID column)
        const updateData: any = {
            budgeted_amount: amount,
            updated_at: new Date().toISOString()
        };
        // Only add user_id if it's a valid UUID
        if (uuidRegex.test(userId)) {
            updateData.user_id = userId;
        }
        
        const res = await supabase.from("budgets").update(updateData).eq("id", existing.id);
        error = res.error;
    } else {
        // Insert (omit user_id if it's numeric/invalid for UUID column)
        const insertData: any = {
            period_start_date: start,
            period_end_date: end,
            subcategory_id: subId,
            budgeted_amount: amount,
            period_type: "monthly",
            updated_at: new Date().toISOString()
        };
        // Only add user_id if it's a valid UUID
        if (uuidRegex.test(userId)) {
            insertData.user_id = userId;
        }
        
        const res = await supabase.from("budgets").insert(insertData);
        error = res.error;
    }

    if (error) return error;

    // 2. Trigger Recalculation (Async)
    await recalculateAllSummaries();

    return null;
}
export async function getBudgetBreakdown(start: string, end: string) {
    // Ensure dates are YYYY-MM-DD
    const cleanStart = new Date(start).toISOString().split('T')[0];
    const cleanEnd = new Date(end).toISOString().split('T')[0];

    // 1. Get Expenses
    // Note: 'category' column in transactions table holds the subcategory_id
    // Filter by type='expense' OR direction='debit' to be safe
    const { data: expenses } = await supabase.from("transactions")
        .select(`amount, category`) 
        .gte("date", cleanStart)
        .lte("date", cleanEnd)
        .or('direction.eq.debit,type.eq.expense')
        .in("status", ["completed", "paid"]);

    // 2. Get Budgets
    const { data: budgets } = await supabase.from("budgets")
        .select(`budgeted_amount, subcategory_id, category_name`)
        .eq("period_start_date", cleanStart)
        .eq("period_end_date", cleanEnd);

    // 3. Fetch Names for all involved Subcategories
    const subIds = new Set<string>();
    expenses?.forEach((e: any) => e.category && subIds.add(e.category));
    budgets?.forEach((b: any) => b.subcategory_id && subIds.add(b.subcategory_id));

    let subMap = new Map();
    
    // Strategy: Load ALL mappings to ensure we find everything (Robust fallback)
    // A. Load New Schema (and check for legacy columns like main_category_id)
    // Note: Based on inspection, 'subcategories' table has 'main_category_id' but NOT 'category_id'.
    // We select both to be safe, but we know 'main_category_id' is the one.
    const { data: allNewSubs } = await supabase.from("subcategories").select("id, name, main_category_id");
    const { data: allNewCats } = await supabase.from("categories").select("id, name");
    
    // B. Load Legacy Schema (View)
    // Note: 'categories_with_hierarchy' has 'subcategory_id' (which is the ID), 'subcategory_name', 'main_category_id', 'main_category_name'
    const { data: allLegacySubs } = await supabase.from("categories_with_hierarchy").select("subcategory_id, subcategory_name, main_category_id, main_category_name");
    const { data: allLegacyCats } = await supabase.from("main_categories").select("id, name");

    // Build Category Map (ID -> Name)
    const catNameMap = new Map();
    allNewCats?.forEach((c: any) => catNameMap.set(c.id, c.name));
    allLegacyCats?.forEach((c: any) => catNameMap.set(c.id, c.name));

    // Build Subcategory Map (ID -> { sub, cat })
    
    // 1. From New Schema
    allNewSubs?.forEach((s: any) => {
        // s.category_id might not exist, use main_category_id
        const catId = s.main_category_id; // || s.category_id
        const catName = catNameMap.get(catId) || "Unknown Category";
        subMap.set(s.id, { sub: s.name, cat: catName });
    });

    // 2. From Legacy View (categories_with_hierarchy)
    // Map 'subcategory_id' to ID
    allLegacySubs?.forEach((s: any) => {
        if (!subMap.has(s.subcategory_id)) {
            // Use explicit name from view if available
            const catName = s.main_category_name || catNameMap.get(s.main_category_id) || "Unknown Category";
            subMap.set(s.subcategory_id, { 
                sub: s.subcategory_name || s.name, // view might have 'name' or 'subcategory_name'
                cat: catName 
            });
        }
    });

    // 4. Aggregate
    const stats = new Map();

    // Helper to generate key
    const getKey = (cat: string, sub: string) => `${cat} - ${sub}`;

    // Process Budgets
    budgets?.forEach((b: any) => {
        if (!b.subcategory_id) return;
        
        // Use map or fallback to category_name from budget table
        let info = subMap.get(b.subcategory_id);
        if (!info && b.category_name) {
             info = { cat: "Budget", sub: b.category_name };
             // Update map for future lookups (e.g. expenses matching this ID)
             subMap.set(b.subcategory_id, info);
        }
        
        const cat = info?.cat || "Unknown";
        const sub = info?.sub || "Unknown";
        const key = getKey(cat, sub);
        
        if (!stats.has(key)) stats.set(key, { cat, sub, budget: 0, actual: 0 });
        stats.get(key).budget += b.budgeted_amount;
    });

    // Process Actuals
    expenses?.forEach((e: any) => {
        if (!e.category) return;
        const info = subMap.get(e.category) || { cat: "Unknown", sub: "Unknown" };
        const key = getKey(info.cat, info.sub);
        
        if (!stats.has(key)) stats.set(key, { cat: info.cat, sub: info.sub, budget: 0, actual: 0 });
        stats.get(key).actual += e.amount;
    });

    // Convert to array and sort
    return Array.from(stats.values())
        .sort((a: any, b: any) => b.actual - a.actual);
}
