import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { CommerceService } from "@hollowcon/commerce";
import { loadConfig } from "@hollowcon/config";
import { decryptSecret, maskIranianPan } from "@hollowcon/security";
import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";

const config = loadConfig();
const token = config.TELEGRAM_BOT_TOKEN;
const port = Number.parseInt(process.env["BOT_HEALTH_PORT"] ?? "3002", 10);
const prisma = new PrismaClient();
const commerce = new CommerceService(prisma);
const bot = new Bot(token);
let botReady = false;

type Locale = "fa" | "en";

function text(locale: Locale, key: keyof typeof messages.fa): string {
  return messages[locale][key];
}

const messages = {
  fa: {
    welcome: "به هالوکان خوش آمدید.",
    chooseLanguage: "زبان موردنظر را انتخاب کنید.",
    terms: "با استفاده از هالوکان، قوانین سرویس را می‌پذیرید. پرداخت فقط کارت‌به‌کارت و بررسی رسید کاملا دستی است.",
    accept: "قوانین را می‌پذیرم",
    buy: "خرید سرویس",
    services: "سرویس‌های من",
    orders: "سفارش‌های من",
    support: "پشتیبانی",
    language: "زبان",
    selectPlan: "پلن موردنظر را انتخاب کنید.",
    noPlans: "در حال حاضر هیچ پلن فعالی موجود نیست.",
    ordersDisabled: "ثبت سفارش هنوز فعال نشده است.",
    payment: "مبلغ دقیق را فقط به کارت زیر انتقال دهید. پس از انتقال، تصویر یا فایل PDF رسید را همین‌جا ارسال کنید.",
    receiptPrompt: "لطفا تصویر JPEG/PNG/WebP یا فایل PDF رسید را ارسال کنید.",
    receiptStored: "رسید شما ثبت شد و در انتظار بررسی دستی است.",
    receiptInvalid: "فایل رسید قابل قبول نیست. فقط JPEG، PNG، WebP یا PDF تا ۸ مگابایت ارسال کنید.",
    noOrders: "سفارشی برای نمایش ندارید.",
    noServices: "هنوز سرویس فعالی ندارید.",
    supportUnavailable: "اطلاعات پشتیبانی هنوز تنظیم نشده است.",
    chooseAction: "یک گزینه را انتخاب کنید.",
  },
  en: {
    welcome: "Welcome to Hollowcon.",
    chooseLanguage: "Choose your language.",
    terms: "By using Hollowcon you accept the service terms. Payment is manual card-to-card transfer only and every receipt is reviewed manually.",
    accept: "I accept the terms",
    buy: "Buy service",
    services: "My services",
    orders: "My orders",
    support: "Support",
    language: "Language",
    selectPlan: "Choose a plan.",
    noPlans: "There are no active plans right now.",
    ordersDisabled: "Ordering has not been enabled yet.",
    payment: "Transfer the exact amount only to the card below, then send the receipt image or PDF in this chat.",
    receiptPrompt: "Send a JPEG, PNG, WebP image, or PDF receipt.",
    receiptStored: "Your receipt was saved and is waiting for manual review.",
    receiptInvalid: "The receipt file is not accepted. Send JPEG, PNG, WebP, or PDF up to 8 MB.",
    noOrders: "You do not have any orders yet.",
    noServices: "You do not have an active service yet.",
    supportUnavailable: "Support contact has not been configured yet.",
    chooseAction: "Choose an option.",
  },
} as const;

bot.command("start", async (context) => {
  const user = await upsertTelegramUser(context.from);
  const locale = user.locale;
  await context.reply(text(locale, "welcome"));
  await context.reply(text(locale, "chooseLanguage"), {
    reply_markup: new InlineKeyboard().text("فارسی", "lang:fa").text("English", "lang:en"),
  });
});

bot.callbackQuery(/^lang:(fa|en)$/u, async (context) => {
  const locale = context.match[1] as Locale;
  const user = await upsertTelegramUser(context.from, locale);
  await context.answerCallbackQuery();
  if (!user.termsAcceptedAt) {
    await context.reply(text(locale, "terms"), { reply_markup: new InlineKeyboard().text(text(locale, "accept"), "terms:accept") });
    return;
  }
  await showMainMenu(context, locale);
});

bot.callbackQuery("terms:accept", async (context) => {
  const user = await upsertTelegramUser(context.from);
  await prisma.user.update({ where: { id: user.id }, data: { termsAcceptedAt: new Date() } });
  await context.answerCallbackQuery();
  await showMainMenu(context, user.locale);
});

bot.hears([messages.fa.buy, messages.en.buy], async (context) => {
  const user = await upsertTelegramUser(context.from);
  await showPlans(context, user.locale);
});

bot.hears([messages.fa.orders, messages.en.orders], async (context) => {
  const user = await upsertTelegramUser(context.from);
  await showOrders(context, user.locale);
});

bot.hears([messages.fa.services, messages.en.services], async (context) => {
  const user = await upsertTelegramUser(context.from);
  await showServices(context, user.locale);
});

bot.hears([messages.fa.support, messages.en.support], async (context) => {
  const user = await upsertTelegramUser(context.from);
  const settings = await prisma.systemSettings.findUnique({ where: { id: 1 } });
  await context.reply(settings?.supportContact ?? text(user.locale, "supportUnavailable"));
});

bot.hears([messages.fa.language, messages.en.language], async (context) => {
  await context.reply(messages.fa.chooseLanguage, {
    reply_markup: new InlineKeyboard().text("فارسی", "lang:fa").text("English", "lang:en"),
  });
});

bot.callbackQuery(/^plan:([A-Za-z0-9_-]{8,64})$/u, async (context) => {
  const user = await upsertTelegramUser(context.from);
  const locale = user.locale;
  const planId = context.match[1];
  if (!planId) return;
  const settings = await prisma.systemSettings.findUnique({ where: { id: 1 } });
  if (!settings?.setupCompletedAt || !settings.customerOrdersEnabled || !config.CUSTOMER_ORDERS_ENABLED) {
    await context.answerCallbackQuery({ text: text(locale, "ordersDisabled"), show_alert: true });
    return;
  }
  const card = await prisma.recipientCard.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } });
  if (!card) {
    await context.answerCallbackQuery({ text: text(locale, "ordersDisabled"), show_alert: true });
    return;
  }
  try {
    const order = await commerce.createOrder({
      userId: user.id,
      planId,
      recipientCardId: card.id,
      idempotencyKey: `telegram:${user.telegramId.toString()}:${randomUUID()}`,
      reservationMinutes: config.PAYMENT_RESERVATION_MINUTES,
      uniqueSuffixMin: config.PAYMENT_UNIQUE_SUFFIX_MIN,
      uniqueSuffixMax: config.PAYMENT_UNIQUE_SUFFIX_MAX,
    });
    const pan = decryptSecret({
      ciphertext: card.panEncrypted,
      masterKey: config.PANEL_CREDENTIAL_MASTER_KEY,
      purpose: "recipient-pan",
      context: "recipient-card",
      expectedKeyId: card.panKeyId,
    });
    await context.answerCallbackQuery();
    await context.reply([
      text(locale, "payment"),
      `${locale === "fa" ? "مبلغ دقیق" : "Exact amount"}: ${order.payableAmountRial.toString()} ${locale === "fa" ? "ریال" : "IRR"}`,
      `${locale === "fa" ? "کارت" : "Card"}: ${maskIranianPan(pan)}`,
      `${locale === "fa" ? "به نام" : "Cardholder"}: ${card.cardholderName}`,
      `${locale === "fa" ? "مهلت پرداخت" : "Pay before"}: ${order.reservationExpires.toISOString()}`,
      text(locale, "receiptPrompt"),
    ].join("\n\n"));
  } catch {
    await context.answerCallbackQuery({ text: text(locale, "ordersDisabled"), show_alert: true });
  }
});

bot.on(["message:photo", "message:document"], async (context) => {
  const user = await upsertTelegramUser(context.from);
  const locale = user.locale;
  const order = await prisma.order.findFirst({
    where: { userId: user.id, status: { in: ["awaiting_receipt", "rejected"] }, reservationExpires: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!order) {
    await context.reply(text(locale, "receiptPrompt"));
    return;
  }
  try {
    const attachment = getReceiptAttachment(context);
    const stored = await downloadTelegramReceipt(attachment.fileId, attachment.mediaType, attachment.fileName);
    try {
      await commerce.submitReceipt({
        orderId: order.id,
        storageKey: stored.storageKey,
        mediaType: stored.mediaType,
        detectedMediaType: stored.mediaType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        telegramFileId: attachment.fileId,
        ...(attachment.fileName ? { originalFileName: attachment.fileName } : {}),
      });
      await context.reply(text(locale, "receiptStored"));
    } catch (error) {
      await rm(stored.path, { force: true });
      throw error;
    }
  } catch {
    await context.reply(text(locale, "receiptInvalid"));
  }
});

interface ReceiptAttachment {
  readonly fileId: string;
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  readonly fileName?: string;
}

function getReceiptAttachment(context: Context): ReceiptAttachment {
  const photo = context.message?.photo?.at(-1);
  if (photo) return { fileId: photo.file_id, mediaType: "image/jpeg" };
  const document = context.message?.document;
  if (!document || !document.mime_type || !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(document.mime_type)) {
    throw new Error("Unsupported receipt document");
  }
  return {
    fileId: document.file_id,
    mediaType: document.mime_type as ReceiptAttachment["mediaType"],
    ...(document.file_name ? { fileName: document.file_name } : {}),
  };
}

async function downloadTelegramReceipt(fileId: string, mediaType: ReceiptAttachment["mediaType"], fileName?: string): Promise<{ storageKey: string; path: string; mediaType: ReceiptAttachment["mediaType"]; byteSize: number; sha256: string }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path || (file.file_size ?? 0) > config.RECEIPT_MAX_BYTES || (file.file_size ?? 0) < 1_024) {
    throw new Error("Invalid Telegram receipt size");
  }
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error("Telegram receipt download failed");
  const content = Buffer.from(await response.arrayBuffer());
  const byteSize = content.length;
  if (byteSize > config.RECEIPT_MAX_BYTES || byteSize < 1_024) throw new Error("Invalid receipt size");
  const hash = createHash("sha256").update(content);
  if (!matchesMagicBytes(content, mediaType)) throw new Error("Receipt content mismatch");
  const extension = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : "pdf";
  const storageKey = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extension}`;
  const directory = join(config.RECEIPT_STORAGE_PATH, storageKey.slice(0, 10));
  const temporary = join(config.RECEIPT_STORAGE_PATH, ".tmp", `${randomUUID()}.upload`);
  const path = join(config.RECEIPT_STORAGE_PATH, storageKey);
  await mkdir(join(config.RECEIPT_STORAGE_PATH, ".tmp"), { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  void fileName;
  return { storageKey, path, mediaType, byteSize, sha256: hash.digest("hex") };
}

function matchesMagicBytes(content: Buffer, mediaType: ReceiptAttachment["mediaType"]): boolean {
  if (mediaType === "image/jpeg") return content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (mediaType === "image/png") return content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mediaType === "image/webp") return content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP";
  return content.subarray(0, 5).toString("ascii") === "%PDF-";
}

async function showMainMenu(context: Context, locale: Locale): Promise<void> {
  const keyboard = new Keyboard()
    .text(text(locale, "buy"))
    .text(text(locale, "services"))
    .row()
    .text(text(locale, "orders"))
    .text(text(locale, "support"))
    .row()
    .text(text(locale, "language"))
    .resized();
  await context.reply(text(locale, "chooseAction"), { reply_markup: keyboard });
}

async function showPlans(context: Context, locale: Locale): Promise<void> {
  const plans = await prisma.plan.findMany({ where: { active: true }, orderBy: { priceRial: "asc" } });
  if (plans.length === 0) {
    await context.reply(text(locale, "noPlans"));
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const plan of plans) {
    keyboard.text(`${locale === "fa" ? plan.nameFa : plan.nameEn} — ${plan.priceRial.toString()} IRR`, `plan:${plan.id}`).row();
  }
  await context.reply(text(locale, "selectPlan"), { reply_markup: keyboard });
}

async function showOrders(context: Context, locale: Locale): Promise<void> {
  const user = await upsertTelegramUser(context.from);
  const orders = await prisma.order.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 10 });
  if (orders.length === 0) {
    await context.reply(text(locale, "noOrders"));
    return;
  }
  await context.reply(orders.map((order) => `${locale === "fa" ? order.planNameFa : order.planNameEn}\n${order.status} — ${order.payableAmountRial.toString()} IRR`).join("\n\n"));
}

async function showServices(context: Context, locale: Locale): Promise<void> {
  const user = await upsertTelegramUser(context.from);
  const services = await prisma.subscription.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 10 });
  if (services.length === 0) {
    await context.reply(text(locale, "noServices"));
    return;
  }
  await context.reply(services.map((service) => `${service.status}\n${locale === "fa" ? "انقضا" : "Expires"}: ${service.expiresAt.toISOString()}`).join("\n\n"));
}

async function upsertTelegramUser(from: { id: number; first_name: string; username?: string; language_code?: string } | undefined, locale?: Locale) {
  if (!from) throw new Error("Telegram user is required");
  return prisma.user.upsert({
    where: { telegramId: BigInt(from.id) },
    create: {
      telegramId: BigInt(from.id),
      firstName: from.first_name,
      ...(from.username ? { username: from.username } : {}),
      locale: locale ?? (from.language_code?.startsWith("fa") ? "fa" : config.DEFAULT_LOCALE),
      ...(BigInt(from.id) === BigInt(config.INITIAL_OWNER_TELEGRAM_ID) ? { role: "owner" } : {}),
    },
    update: {
      firstName: from.first_name,
      username: from.username ?? null,
      ...(locale ? { locale } : {}),
    },
  });
}

const healthServer = createServer((_request, response) => {
  const status = botReady ? 200 : 503;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ status: botReady ? "ready" : "starting", service: "bot", mode: "long-polling" }));
});

healthServer.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({ level: "info", service: "bot", event: "health-listening", port }));
});

void bot.start({
  onStart: () => {
    botReady = true;
    console.info(JSON.stringify({ level: "info", service: "bot", event: "polling" }));
  },
});

async function shutdown(): Promise<void> {
  botReady = false;
  await bot.stop();
  healthServer.close();
  await prisma.$disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
