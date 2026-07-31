import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, setCsrf, uploadReceipt, type Me, type Order, type Plan, type Subscription } from "./api";
import { documentLanguage, initializeTelegramWebApp, isAcceptedReceiptFile, orderIdempotencyKey, visibleScreens, type Locale, type Screen } from "./ui-logic";
import "./styles.css";

const words = {
  fa: { app: "هالوکان", plans: "خرید سرویس", orders: "سفارش‌ها", services: "سرویس‌های من", reviews: "بررسی پرداخت", system: "مدیریت سیستم", operators: "کاربران", audit: "رویدادها", openBot: "این صفحه را از ربات تلگرام باز کنید.", manual: "پرداخت فقط کارت‌به‌کارت است و همه رسیدها به‌صورت دستی بررسی می‌شوند.", buy: "خرید", upload: "ارسال رسید", configs: "مشاهده لینک‌ها", loading: "در حال بارگذاری…", empty: "موردی وجود ندارد.", logout: "خروج", exact: "مبلغ دقیق", expires: "انقضا", save: "ذخیره", error: "خطا" },
  en: { app: "Hollowcon", plans: "Buy service", orders: "Orders", services: "My services", reviews: "Payment review", system: "System management", operators: "Operators", audit: "Audit", openBot: "Open this page from the Telegram bot.", manual: "Payment is manual card-to-card only and every receipt is reviewed by an operator.", buy: "Buy", upload: "Upload receipt", configs: "View configurations", loading: "Loading…", empty: "Nothing to show.", logout: "Sign out", exact: "Exact amount", expires: "Expires", save: "Save", error: "Error" },
} as const;

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [locale, setLocale] = useState<Locale>("fa");
  const [screen, setScreen] = useState<Screen>("plans");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(true);
  const [outsideTelegram, setOutsideTelegram] = useState(false);
  const t = words[locale];

  useEffect(() => {
    const initData = initializeTelegramWebApp(window.Telegram?.WebApp);
    if (!initData) { setOutsideTelegram(true); setBusy(false); return; }
    api<Me>("/auth/telegram", { method: "POST", body: JSON.stringify({ initData }) })
      .then((user) => { setMe(user); setLocale(user.locale); setCsrf(user.csrfToken); })
      .catch((error: Error) => setStatus(error.message))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    const language = documentLanguage(locale);
    document.documentElement.lang = language.lang;
    document.documentElement.dir = language.dir;
  }, [locale]);

  if (busy) return <Shell locale={locale}><p>{t.loading}</p></Shell>;
  if (outsideTelegram || !me) return <Shell locale={locale}><div className="empty"><h1>{t.app}</h1><p>{status || t.openBot}</p></div></Shell>;

  const allowedScreens = new Set(visibleScreens(me.role));
  const tabs: Array<[Screen, string]> = [["plans", t.plans], ["orders", t.orders], ["services", t.services], ["reviews", t.reviews], ["system", t.system], ["operators", t.operators], ["audit", t.audit]];
  return <Shell locale={locale}>
    <header className="hero"><div><span className="eyebrow">VPN · 3x-ui 3.5.0</span><h1>{t.app}</h1><p>{t.manual}</p></div><div className="profile"><strong>{me.firstName || me.username || me.telegramId}</strong><span>{me.role || "customer"}</span><div><button className="ghost" onClick={() => setLocale(locale === "fa" ? "en" : "fa")}>{locale === "fa" ? "EN" : "فا"}</button><button className="ghost" onClick={() => void api("/auth/logout", { method: "POST" }).then(() => location.reload())}>{t.logout}</button></div></div></header>
    <nav>{tabs.filter(([id]) => allowedScreens.has(id)).map(([id, label]) => <button key={id} className={screen === id ? "active" : ""} onClick={() => setScreen(id)}>{label}</button>)}</nav>
    {status && <div className="alert">{status}<button onClick={() => setStatus("")}>×</button></div>}
    {screen === "plans" && <Plans locale={locale} onError={setStatus} />}
    {screen === "orders" && <Orders locale={locale} onError={setStatus} />}
    {screen === "services" && <Services locale={locale} onError={setStatus} />}
    {screen === "reviews" && <Reviews locale={locale} onError={setStatus} />}
    {screen === "system" && <System locale={locale} me={me} onError={setStatus} />}
    {screen === "operators" && <Operators locale={locale} onError={setStatus} />}
    {screen === "audit" && <Audit locale={locale} onError={setStatus} />}
  </Shell>;
}

function Shell({ locale, children }: { locale: Locale; children: React.ReactNode }) { return <main data-locale={locale}>{children}</main>; }

function Plans({ locale, onError }: { locale: Locale; onError: (message: string) => void }) {
  const [plans, setPlans] = useState<Plan[]>([]); const [loading, setLoading] = useState(true); const t = words[locale];
  useEffect(() => { api<Plan[]>("/plans").then(setPlans).catch((e: Error) => onError(e.message)).finally(() => setLoading(false)); }, [onError]);
  async function buy(planId: string) { try { const key = orderIdempotencyKey(planId, sessionStorage, () => crypto.randomUUID()); const order = await api<Order>("/orders", { method: "POST", body: JSON.stringify({ planId, idempotencyKey: key }) }); alert(`${t.exact}: ${rial(order.payableAmountRial, locale)}\n${order.recipientCardMasked}`); } catch (e) { onError((e as Error).message); } }
  if (loading) return <Panel title={t.plans}><p>{t.loading}</p></Panel>;
  return <Panel title={t.plans}><div className="grid">{plans.map((plan) => <article className="card" key={plan.id}><span className="protocol">{plan.protocol}</span><h2>{locale === "fa" ? plan.nameFa : plan.nameEn}</h2><p>{plan.durationDays} {locale === "fa" ? "روز" : "days"} · {plan.deviceLimit} {locale === "fa" ? "دستگاه" : "devices"}</p><strong className="price">{rial(plan.priceRial, locale)}</strong><button onClick={() => void buy(plan.id)}>{t.buy}</button></article>)}</div>{!plans.length && <p>{t.empty}</p>}</Panel>;
}

function Orders({ locale, onError }: { locale: Locale; onError: (message: string) => void }) {
  const [orders, setOrders] = useState<Order[]>([]); const [refresh, setRefresh] = useState(0); const t = words[locale];
  useEffect(() => { api<Order[]>("/orders").then(setOrders).catch((e: Error) => onError(e.message)); }, [onError, refresh]);
  async function receipt(order: Order, file?: File) { if (!file) return; if (!isAcceptedReceiptFile(file)) { onError(locale === "fa" ? "فایل رسید قابل قبول نیست." : "The receipt file is not accepted."); return; } try { await uploadReceipt(order.id, file); setRefresh((x) => x + 1); } catch (e) { onError((e as Error).message); } }
  return <Panel title={t.orders}>{orders.map((order) => <article className="row-card" key={order.id}><div><h3>{locale === "fa" ? order.planNameFa : order.planNameEn}</h3><Status value={order.status} /><p>{t.exact}: <b>{rial(order.payableAmountRial, locale)}</b> · {order.recipientCardMasked}</p><small>{t.expires}: {date(order.reservationExpires, locale)}</small></div>{["awaiting_receipt", "rejected"].includes(order.status) && <label className="upload">{t.upload}<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(event) => void receipt(order, event.target.files?.[0])} /></label>}</article>)}{!orders.length && <p>{t.empty}</p>}</Panel>;
}

function Services({ locale, onError }: { locale: Locale; onError: (message: string) => void }) {
  const [items, setItems] = useState<Subscription[]>([]); const [links, setLinks] = useState<Record<string, string[]>>({}); const t = words[locale];
  useEffect(() => { api<Subscription[]>("/subscriptions").then(setItems).catch((e: Error) => onError(e.message)); }, [onError]);
  async function reveal(id: string) { try { const data = await api<{ links: string[] }>(`/subscriptions/${id}/configs`); setLinks((value) => ({ ...value, [id]: data.links })); } catch (e) { onError((e as Error).message); } }
  return <Panel title={t.services}>{items.map((item) => <article className="row-card service" key={item.id}><div><Status value={item.status} /><p>{t.expires}: {date(item.expiresAt, locale)}</p><meter min="0" max={Number(item.trafficBytes)} value={Number(item.trafficUsedBytes)} /></div>{item.configsAvailable && <button onClick={() => void reveal(item.id)}>{t.configs}</button>}{links[item.id]?.map((link, index) => <div className="config" key={link}><code>{link}</code><button className="ghost" onClick={() => void navigator.clipboard.writeText(link)}>Copy</button><img src={`/api/v1/subscriptions/${item.id}/configs/${index}/qr`} alt={`QR ${index + 1}`} /></div>)}</article>)}{!items.length && <p>{t.empty}</p>}</Panel>;
}

function Reviews({ locale, onError }: { locale: Locale; onError: (message: string) => void }) {
  const [items, setItems] = useState<Array<{ id: string; planNameFa: string; planNameEn: string; payableAmountRial: string; receipt: null | { id: string; revision: number; duplicateCount: number; downloadUrl: string } }>>([]); const [refresh, setRefresh] = useState(0); const t = words[locale];
  useEffect(() => { api<typeof items>("/admin/reviews").then(setItems).catch((e: Error) => onError(e.message)); }, [onError, refresh]);
  async function review(id: string, approved: boolean) { const reason = prompt(locale === "fa" ? "دلیل تصمیم" : "Decision reason"); if (!reason) return; try { await api(`/admin/orders/${id}/review`, { method: "POST", body: JSON.stringify({ approved, reason }) }); setRefresh((x) => x + 1); } catch (e) { onError((e as Error).message); } }
  return <Panel title={t.reviews}>{items.map((item) => <article className="review" key={item.id}><iframe title="Receipt" src={item.receipt?.downloadUrl} /><div><h3>{locale === "fa" ? item.planNameFa : item.planNameEn}</h3><p>{rial(item.payableAmountRial, locale)}</p><p>Revision {item.receipt?.revision} · duplicates {item.receipt?.duplicateCount}</p><button onClick={() => void review(item.id, true)}>Approve</button><button className="danger" onClick={() => void review(item.id, false)}>Reject</button></div></article>)}{!items.length && <p>{t.empty}</p>}</Panel>;
}

interface SystemSettings {
  customerOrderMode?: "disabled" | "owner_test" | "enabled";
  panelMutationsEnabled?: boolean;
  supportContact?: string;
  termsVersion?: string;
}

function System({ locale, me, onError }: { locale: Locale; me: Me; onError: (message: string) => void }) {
  const [cards, setCards] = useState<unknown[]>([]); const [plans, setPlans] = useState<Plan[]>([]); const [panels, setPanels] = useState<unknown[]>([]); const [settings, setSettings] = useState<SystemSettings>({}); const [jobs, setJobs] = useState<unknown[]>([]); const t = words[locale];
  async function load() { try { const allowedSettings = me.role === "owner" || me.role === "admin" || me.role === "auditor"; const values = await Promise.all([api<unknown[]>("/admin/cards").catch(() => []), api<Plan[]>("/admin/plans"), api<unknown[]>("/admin/panels"), allowedSettings ? api<SystemSettings>("/admin/settings") : Promise.resolve({}), api<unknown[]>("/admin/provisioning")]); setCards(values[0]); setPlans(values[1]); setPanels(values[2]); setSettings(values[3]); setJobs(values[4]); } catch (e) { onError((e as Error).message); } }
  useEffect(() => { void load(); }, []);
  async function saveSettings(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api("/admin/settings", { method: "PATCH", body: JSON.stringify({ customerOrderMode: form.get("mode"), panelMutationsEnabled: form.get("mutations") === "on", supportContact: form.get("support"), termsVersion: form.get("terms"), confirmation: "APPLY SAFETY SETTINGS" }) }); await load(); } catch (e) { onError((e as Error).message); } }
  return <Panel title={t.system}><div className="stats"><Stat label="Cards" value={cards.length} /><Stat label="Plans" value={plans.length} /><Stat label="Panels" value={panels.length} /><Stat label="Jobs" value={jobs.length} /></div>{me.role === "owner" && <form className="settings" onSubmit={(e) => void saveSettings(e)}><label>Order mode<select name="mode" defaultValue={settings.customerOrderMode ?? "disabled"}><option value="disabled">Disabled</option><option value="owner_test">Owner test</option><option value="enabled">Enabled</option></select></label><label>Support<input name="support" defaultValue={settings.supportContact ?? ""} /></label><label>Terms version<input name="terms" defaultValue={settings.termsVersion ?? "1"} /></label><label className="check"><input name="mutations" type="checkbox" defaultChecked={settings.panelMutationsEnabled === true} /> Panel mutations</label><button>{t.save}</button></form>}<details><summary>Plans</summary><pre>{JSON.stringify(plans, null, 2)}</pre></details><details><summary>Panels</summary><pre>{JSON.stringify(panels, null, 2)}</pre></details><details><summary>Provisioning</summary><pre>{JSON.stringify(jobs, null, 2)}</pre></details></Panel>;
}

function Operators({ locale, onError }: { locale: Locale; onError: (message: string) => void }) { const [items, setItems] = useState<Array<{ id: string; telegramId: string; firstName: string | null; username: string | null; role: string | null; disabledAt: string | null }>>([]); const load = () => api<typeof items>("/admin/operators").then(setItems).catch((e: Error) => onError(e.message)); useEffect(() => { void load(); }, [onError]); async function change(id: string, role: string) { try { await api(`/admin/operators/${id}`, { method: "PATCH", body: JSON.stringify({ role: role || null, disabled: false, confirmation: "UPDATE OPERATOR" }) }); await load(); } catch (e) { onError((e as Error).message); } } return <Panel title={words[locale].operators}>{items.map((item) => <article className="row-card" key={item.id}><div><b>{item.firstName || item.username || item.telegramId}</b><p>{item.role || "customer"}</p></div><select value={item.role || ""} onChange={(e) => void change(item.id, e.target.value)}><option value="">Customer</option>{["owner", "admin", "finance", "support", "server_operator", "marketing", "auditor"].map((role) => <option key={role}>{role}</option>)}</select></article>)}</Panel>; }

function Audit({ locale, onError }: { locale: Locale; onError: (message: string) => void }) { const [items, setItems] = useState<Array<{ id: string; action: string; subjectType: string; createdAt: string; correlationId: string }>>([]); useEffect(() => { api<typeof items>("/admin/audit").then(setItems).catch((e: Error) => onError(e.message)); }, [onError]); return <Panel title={words[locale].audit}><div className="timeline">{items.map((item) => <article key={item.id}><b>{item.action}</b><span>{item.subjectType}</span><small>{date(item.createdAt, locale)} · {item.correlationId}</small></article>)}</div></Panel>; }
function Panel({ title, children }: { title: string; children: React.ReactNode }) { return <section className="panel"><h2>{title}</h2>{children}</section>; }
function Status({ value }: { value: string }) { return <span className={`status status-${value}`}>{value.replaceAll("_", " ")}</span>; }
function Stat({ label, value }: { label: string; value: number }) { return <div><strong>{value}</strong><span>{label}</span></div>; }
function rial(value: string, locale: Locale) { return `${new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-US").format(BigInt(value))} ${locale === "fa" ? "ریال" : "IRR"}`; }
function date(value: string, locale: Locale) { return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
