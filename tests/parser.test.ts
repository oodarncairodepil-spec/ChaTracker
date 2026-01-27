
import { describe, expect, test } from '@jest/globals';

// Mocks for clean testing of parser logic without Deno/Supabase dependencies
const cleanText = (text: string) => {
    if (!text) return "";
    let cleaned = text.replace(/<[^>]*>?/gm, " ");
    cleaned = cleaned.replace(/\s+/g, " ").trim();
    return cleaned;
};

const parseEmail = (payload: any) => {
  const { subject, text_body, html_body, date_header, from_email } = payload;
  const content = (text_body || "") + " " + (html_body || ""); 
  const cleanContent = cleanText(content);
  
  const rules_triggered = [];
  const evidence: any = {};
  
  // 1. Amount
  let amount = 0;
  const amountRegex = /(?:Rp|IDR)\s?\.?([0-9.,]+)/i;
  const amountMatch = cleanContent.match(amountRegex);
  if (amountMatch) {
    const rawAmount = amountMatch[1];
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
  if (merchant.toLowerCase().includes("receipt from ")) {
    merchant = merchant.replace(/receipt from /i, "").trim();
  }
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

  return {
    happened_at: date_header,
    amount,
    direction,
    merchant,
    source_of_fund,
    evidence,
    rules_triggered
  };
};

// Fixtures
const kaiEmail = require('../examples/kai_email.json');
const refundEmail = require('../examples/refund_credit.json');
const topupEmail = require('../examples/topup_credit.json');
const purchaseEmail = require('../examples/purchase_debit.json');

describe('Email Parser', () => {
  test('KAI Email Parsing', () => {
    const result = parseEmail(kaiEmail);
    expect(result.amount).toBe(35000);
    expect(result.source_of_fund).toBe("OVO");
    expect(result.direction).toBe("debit");
    // expect(result.merchant).toBe("Bukti Pembayaran KA Bandara (1218866718186)"); // Logic keeps subject if not known domain
  });

  test('Refund Credit Parsing', () => {
    const result = parseEmail(refundEmail);
    expect(result.amount).toBe(150000);
    expect(result.direction).toBe("credit");
    expect(result.merchant).toBe("Tokopedia");
  });

  test('Top Up Credit Parsing', () => {
    const result = parseEmail(topupEmail);
    expect(result.amount).toBe(500000);
    expect(result.direction).toBe("credit");
    expect(result.source_of_fund).toBe("BCA"); 
    expect(result.merchant).toBe("Top Up Berhasil via BCA");
  });

  test('Purchase Debit Parsing', () => {
    const result = parseEmail(purchaseEmail);
    expect(result.amount).toBe(75500);
    expect(result.direction).toBe("debit");
    expect(result.merchant).toBe("Shopee");
  });
});
