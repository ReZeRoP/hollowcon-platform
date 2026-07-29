export const messages = {
  fa: {
    welcome: "به هالوکان خوش آمدید",
    buy: "خرید سرویس",
    services: "سرویس‌های من",
    support: "پشتیبانی",
    exactAmount: "مبلغ دقیق قابل پرداخت",
    rial: "ریال",
    uploadReceipt: "تصویر رسید را ارسال کنید",
    pendingReview: "رسید شما در انتظار بررسی است",
  },
  en: {
    welcome: "Welcome to Hollowcon",
    buy: "Buy service",
    services: "My services",
    support: "Support",
    exactAmount: "Exact amount to pay",
    rial: "IRR",
    uploadReceipt: "Upload your receipt image",
    pendingReview: "Your receipt is awaiting review",
  },
} as const;

export type Locale = keyof typeof messages;
export const direction = (locale: Locale): "rtl" | "ltr" => locale === "fa" ? "rtl" : "ltr";
export const formatRial = (amount: number, locale: Locale): string => new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-US").format(amount);
