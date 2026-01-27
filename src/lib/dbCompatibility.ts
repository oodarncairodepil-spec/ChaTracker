import { supabase } from "@/lib/supabase";

// Helper to get categories - works with both new and old schema
export async function getCategories() {
  // Try new categories table first
  let { data: categories } = await supabase
    .from("categories")
    .select("*")
    .order("name");
  
  if (!categories || categories.length === 0) {
    // Fall back to main_categories (existing schema)
    const { data: oldCats } = await supabase
      .from("main_categories")
      .select("id, name, created_at, updated_at")
      .order("name");
    
    if (oldCats) {
      categories = oldCats;
    }
  }
  
  return categories || [];
}

// Helper to get subcategories - works with both schemas
export async function getSubcategories(categoryId: string) {
  // Try new subcategories table
  let { data: subcategories } = await supabase
    .from("subcategories")
    .select("*")
    .eq("category_id", categoryId)
    .order("name");
  
  if (!subcategories || subcategories.length === 0) {
    // Fall back to categories_with_hierarchy
    const { data: oldSubs } = await supabase
      .from("categories_with_hierarchy")
      .select("id, name, created_at, updated_at")
      .eq("parent_id", categoryId)
      .order("name");
    
    if (oldSubs) {
      subcategories = oldSubs;
    }
  }
  
  return subcategories || [];
}

// Helper to get transactions with category info
export async function getTransactionsWithCategories(options: any = {}) {
  // Try new schema first
  let query = supabase
    .from("transactions")
    .select(`
      *,
      categories (name),
      subcategories (name)
    `);
  
  // Apply filters
  if (options.status) query = query.eq("status", options.status);
  if (options.direction) query = query.eq("direction", options.direction);
  if (options.order) query = query.order(options.order.column, { ascending: options.order.ascending });
  if (options.limit) query = query.limit(options.limit);
  
  const { data: transactions } = await query;
  
  // If no categories joined, try to join with main_categories manually
  if (transactions && transactions.length > 0) {
    for (const tx of transactions) {
      if (!tx.categories && tx.category_id) {
        const { data: cat } = await supabase
          .from("main_categories")
          .select("name")
          .eq("id", tx.category_id)
          .single();
        if (cat) tx.categories = cat;
      }
      if (!tx.subcategories && tx.subcategory_id) {
        const { data: sub } = await supabase
          .from("categories_with_hierarchy")
          .select("name")
          .eq("id", tx.subcategory_id)
          .single();
        if (sub) tx.subcategories = sub;
      }
    }
  }
  
  return transactions || [];
}

// Helper to update transaction category
export async function updateTransactionCategory(txId: string, categoryId: string, subcategoryId?: string) {
  const updateData: any = { category_id: categoryId };
  if (subcategoryId && subcategoryId !== 'skip') {
    updateData.subcategory_id = subcategoryId;
  }
  
  return await supabase.from("transactions").update(updateData).eq("id", txId);
}
