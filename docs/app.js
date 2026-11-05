// Pinned to an exact version so a new release can't change the app's behaviour
// without a deliberate update here.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.8/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js"; 

// Read what brought the user here BEFORE supabase-js starts and cleans the URL.
// A password-reset email link arrives as  ...#access_token=...&type=recovery
// and a used/expired one as              ...#error=access_denied&error_description=...
const linkParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
const linkQuery = new URLSearchParams(window.location.search);
const openedFromRecoveryLink = linkParams.get("type") === "recovery";
const linkError = linkParams.get("error_description") || linkQuery.get("error_description");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- App state ----
const state = {
  screen: "auth",        // which screen is showing (auth, dashboard, warehouses, ...)
  view: "inventory",     // which tab is open inside a warehouse
  recovering: openedFromRecoveryLink, // true while the user is choosing a new password
  user: null,
  warehouses: [],       // [ sistimata_id, role, name ]
  currentWarehouse: null, //  id, role, name 
  categories: [],        // [ id, name ]
  products: [],          // items of the current warehouse
  invFilter: "all",      // all | soon | expired
  alerts: [],            // expired / expiring items across all warehouses
  announcements: [],
  announcementsError: false,
  warehousesError: false, // true when the last attempt to load warehouses failed
  dashFilter: "all",     // all | urgent | posts
};

const ALERT_DAYS = 30;        // items expiring within this many days count as "soon"
const DONE_VISIBLE_DAYS = 7;  // completed announcements stay listed this long
const MAX_QUANTITY = 100000;  // keep in step with supabase/hardening.sql

// ---- DOM shortcuts ----
const $ = (id) => document.getElementById(id);

const authSection = $("auth-section");
const warehouseSection = $("warehouse-section");
const appSection = $("app-section");
const userBar = $("user-bar");

// ---- Toasts: short messages at the bottom of the screen ----
let toastTimer = null;
function showToast(message, isError = false) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 6000 : 3500);
}

// Log the technical details for debugging and tell the user in plain words.
function reportError(userMessage, error) {
  console.error(userMessage, error);
  showToast(userMessage, true);
}

// Run a form's submit handler one at a time: the submit button stays disabled
// until the handler finishes, so a double tap can't save things twice.
function onSubmitOnce(formId, handler) {
  $(formId).addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      await handler(e);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

window.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.name === "AbortError") return;
  console.error(e.reason);
  showToast("Something went wrong. Please try again.", true);
});

// Only one screen is visible at a time; the floating nav follows the screen.
const screens = {
  auth: authSection,
  dashboard: $("dashboard-section"),
  post: $("post-section"),
  warehouses: warehouseSection,
  superadmin: $("super-admin-section"),
  app: appSection,
};

function showScreen(name) {
  state.screen = name;
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle("hidden", key !== name);
  }
  $("main-nav").classList.toggle("hidden", name !== "dashboard" && name !== "warehouses");
  $("warehouse-nav").classList.toggle("hidden", name !== "app");
  $("main-home").classList.toggle("active", name === "dashboard");
  $("main-warehouses").classList.toggle("active", name === "warehouses");
  window.scrollTo(0, 0);
}

// ============================================================
// AUTH
// ============================================================


function switchAuthTab(which) {
  $("login-form").classList.toggle("hidden", which !== "login");
  $("forgot-password-form").classList.toggle("hidden", which !=="forgot");
  $("show-forgot-password").classList.toggle("hidden", which !== "login");
  setStatus("auth-status", "");
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  setStatus("auth-status", "");
  showLoading();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  submitBtn.disabled = false;
  if (error) {
    hideLoading(false);
    return setStatus("auth-status", error.message, true);
  }
});

$("logout-btn").addEventListener("click", async () => {
  await supabase.auth.signOut();
});

// ---- Forgot password ----

$("show-forgot-password").addEventListener("click", () => {
  $("login-form").classList.add("hidden");
  $("forgot-password-form").classList.remove("hidden");
  $("show-forgot-password").classList.add("hidden");
  setStatus("auth-status", "");
});

$("cancel-forgot-password").addEventListener("click", () => {
  switchAuthTab("login");   
});

$("forgot-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("forgot-email").value.trim();
  setStatus("auth-status", "Sending reset link...");
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  if (error) return setStatus("auth-status", error.message, true);

  $("forgot-password-form").classList.add("hidden");
  $("forgot-password-form").reset();
  $("login-form").classList.remove("hidden");
  //$("tab-login").classList.add("active");
  setStatus("auth-status", "Check your email for a password reset link.", false, true);
});

// After the user clicks the reset link in their email, Supabase opens this
// app again and fires a PASSWORD_RECOVERY event with a temporary session -
// show the "set new password" form instead of going straight into the app.
function showRecoveryForm() {
  state.recovering = true;
  userBar.classList.add("hidden");
  showScreen("auth");
  $("login-form").classList.add("hidden");
  $("show-forgot-password").classList.add("hidden");
  $("signup-form").classList.add("hidden");
  $("forgot-password-form").classList.add("hidden");
  $("new-password-form").classList.remove("hidden");
  setStatus("auth-status", "Enter a new password below.");
}

$("new-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("new-password").value;
  setStatus("auth-status", "Updating password...");
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return setStatus("auth-status", error.message, true);

  // Done: leave recovery mode and go into the app with the session we have.
  state.recovering = false;
  $("new-password-form").classList.add("hidden");
  $("new-password-form").reset();
  setStatus("auth-status", "");
  const { data } = await supabase.auth.getSession();
  state.user = data.session?.user ?? null;
  if (state.user) {
    userBar.classList.remove("hidden");
    $("user-email").textContent = state.user.email;
    authSection.classList.add("hidden");
    showDashboard();
  } else {
    switchAuthTab("login");
    showScreen("auth");
    setStatus("auth-status", "Password updated - please log in.", false, true);
  }
});

// The link in the email was already used or has expired: say so instead of
// silently showing the login page.
if (linkError && !openedFromRecoveryLink) {
  history.replaceState(null, "", window.location.pathname + window.location.search);
  setStatus(
    "auth-status",
    "This link is invalid or has expired. Use \"Forgot password?\" to get a new one.",
    true
  );
}

// Opened from a reset email: go straight to the new-password form so the login
// form never flashes, whatever order supabase-js fires its events in.
if (openedFromRecoveryLink) showRecoveryForm();

supabase.auth.onAuthStateChange((event, session) => {
  console.debug("[auth]", event, session ? "session" : "no session");
  if (event === "PASSWORD_RECOVERY") {
    showRecoveryForm();
    return;
  }
  // While choosing a new password, other events (INITIAL_SESSION, SIGNED_IN on
  // tab refocus, TOKEN_REFRESHED...) must not hide the form or open the app.
  if (state.recovering && session) return;
  const wasRecovering = state.recovering;
  state.recovering = false;

  const previousId = state.user ?. id ?? null;
  state.user = session?.user ?? null;
  if (state.user) {
    userBar.classList.remove("hidden");
    $("user-email").textContent = state.user.email;
    authSection.classList.add("hidden");
    if (state.user.id !== previousId) showDashboard();
  } else {
    hideLoading();
    userBar.classList.add("hidden");
    showScreen("auth");
    // Put the login form back (a reset may have hidden it) without clearing
    // any message that is already showing.
    $("new-password-form").classList.add("hidden");
    $("forgot-password-form").classList.add("hidden");
    $("login-form").classList.remove("hidden");
    $("show-forgot-password").classList.remove("hidden");
    if (wasRecovering) {
      setStatus("auth-status", "This reset link is invalid or has expired. Use \"Forgot password?\" to get a new one.", true);
    }
  }
});

// ============================================================
// WAREHOUSE PICKER
// ============================================================

async function showWarehousePicker() {
  showScreen("warehouses");
  try {
    await refreshWarehouses();
  } finally {
    hideLoading();
  }
}

async function refreshWarehouses() {
  await loadWarehouses();
  await loadAlerts();
  renderWarehouseList();
}

async function loadWarehouses() {
  state.warehousesError = false;
  const { data, error } = await supabase
    .from("user_sistimata")
    .select("role, sistimata_id, sistimata ( id, name )")
    .eq("user_id", state.user.id);

  if (error) {
    state.warehousesError = true;
    return reportError("Couldn't load your warehouses. Check your connection and try again.", error);
  }

  state.warehouses = (data || []).map((row) => ({
    id: row.sistimata.id,
    name: row.sistimata.name,
    role: row.role,
  }));

  // Super admins can see every warehouse, not just ones they're explicitly
  // a member of - top up the list with anything RLS lets them see that
  // isn't already there.
  const { data: isSuper } = await supabase.rpc("is_super_admin");
  state.isSuperAdmin = !!isSuper;
  $("open-super-admin").classList.toggle("hidden", !state.isSuperAdmin);

  if (isSuper) {
    const knownIds = new Set(state.warehouses.map((w) => w.id));
    const { data: allWarehouses } = await supabase.from("sistimata").select("id, name");
    for (const wh of allWarehouses || []) {
      if (!knownIds.has(wh.id)) {
        state.warehouses.push({ id: wh.id, name: wh.name, role: "admin (super)" });
      }
    }
  }

}

function renderWarehouseList() {
  const list = $("warehouse-list");
  list.innerHTML = "";

  if (state.warehouses.length === 0) {
    list.innerHTML = state.warehousesError
      ? `<li class="list-item"><span class="meta expired">Couldn't load your warehouses. Check your connection and try again.</span></li>`
      : `<li class="list-item"><span class="meta">No warehouses yet - create one below.</span></li>`;
  }

  for (const wh of state.warehouses) {
    const mine = state.alerts.filter((a) => a.sistimata_id === wh.id);
    const expired = mine.filter((a) => a.expired).length;
    const soon = mine.length - expired;
    let status = `<span class="meta ok">All good</span>`;
    let tone = "ok";
    if (expired) {
      status = `<span class="meta expired">${expired} expired${soon ? ` · ${soon} expiring soon` : ""}</span>`;
      tone = "expired";
    } else if (soon) {
      status = `<span class="meta soon">${soon} expiring soon</span>`;
      tone = "soon";
    }

    const li = document.createElement("li");
    li.className = "list-item wh-card";
    li.innerHTML = `
      <div class="ic ${tone}"><i class="ti ti-building-warehouse" aria-hidden="true"></i></div>
      <div class="info">
        <span class="name">${escapeHtml(wh.name)}</span>
        ${status}
        <span class="meta">${escapeHtml(wh.role)}</span>
      </div>
      <i class="ti ti-chevron-right" aria-hidden="true"></i>
    `;
    li.addEventListener("click", () => selectWarehouse(wh));
    list.appendChild(li);
  }
}

onSubmitOnce("create-warehouse-form", async () => {
  const name = $("new-warehouse-name").value.trim();
  if (!name) return;
  setStatus("warehouse-status", "Creating...");
  const { error } = await supabase.from("sistimata").insert({ name });
  if (error) return setStatus("warehouse-status", error.message, true);
  $("new-warehouse-name").value = "";
  setStatus("warehouse-status", "");
  await refreshWarehouses();
});

// ============================================================
// SUPER ADMIN: GLOBAL "ALL PARTICIPANTS" DASHBOARD
// ============================================================

// Fill the "Add someone to a warehouse" dropdown, keeping the current choice
// if that warehouse still exists.
function fillGlobalWarehouseSelect() {
  const wSelect = $("global-member-warehouse");
  const previous = wSelect.value;
  wSelect.innerHTML = state.warehouses
    .map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`)
    .join("");
  if ([...wSelect.options].some((o) => o.value === previous)) wSelect.value = previous;
}

$("open-super-admin").addEventListener("click", async () => {
  showScreen("superadmin");
  fillGlobalWarehouseSelect();
  renderAllWarehousesList();
  await loadAllMembers();
});

$("back-from-super-admin").addEventListener("click", showWarehousePicker);

function renderAllWarehousesList() {
  const list = $("all-warehouses-list");
  list.innerHTML = "";

  for (const wh of state.warehouses) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <div class="info">
        <span class="name">${escapeHtml(wh.name)}</span>
      </div>
      <div class="row-actions">
        <button class="btn-danger" data-action="start-delete">Delete</button>
      </div>
    `;

    const rightSide = li.querySelector(".row-actions");

    li.querySelector('[data-action="start-delete"]').addEventListener("click", () => {
      rightSide.innerHTML = `
        <input type="text" placeholder="Type name to confirm" style="width:150px" />
        <button class="btn-danger" disabled>Confirm</button>
        <button class="btn-ghost" type="button">Cancel</button>
      `;
      const [input, confirmBtn, cancelBtn] = rightSide.children;

      input.addEventListener("input", () => {
        confirmBtn.disabled = input.value !== wh.name;
      });

      cancelBtn.addEventListener("click", () => renderAllWarehousesList());

      confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        const { error } = await supabase.from("sistimata").delete().eq("id", wh.id);
        if (error) {
          confirmBtn.disabled = false;
          return alert(error.message);
        }
        await loadWarehouses();
        renderAllWarehousesList();
        fillGlobalWarehouseSelect();   // the deleted warehouse must leave the dropdown too
        await loadAllMembers();        // ...and its members from the list
      });
    });

    list.appendChild(li);
  }
}

async function loadAllMembers() {
  const { data, error } = await supabase.rpc("list_all_members");
  if (error) return reportError("Couldn't load the participants list. Please try again.", error);

  const list = $("all-members-list");
  list.innerHTML = "";

  for (const m of data || []) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <div class="info">
        <span class="name">${escapeHtml(m.email)}</span>
        <span class="meta">${escapeHtml(m.sistimata_name)} · ${escapeHtml(m.role)}</span>
      </div>
      <button class="btn-danger" data-action="remove">Remove</button>
    `;
    li.querySelector('[data-action="remove"]').addEventListener("click", async () => {
      const { error: removeError } = await supabase.rpc("remove_member", {
        target_sistimata_id: m.sistimata_id,
        target_user_id: m.member_user_id,
      });
      if (removeError) return alert(removeError.message);
      await loadAllMembers();
    });
    list.appendChild(li);
  }
}

onSubmitOnce("global-add-member-form", async (e) => {
  const warehouseId = $("global-member-warehouse").value;
  const email = $("global-member-email").value.trim();
  const role = $("global-member-role").value;

  setStatus("global-member-status", "Adding...");
  const { error } = await supabase.rpc("add_member", {
    target_sistimata_id: warehouseId,
    member_email: email,
    member_role: role,
  });
  if (error) return setStatus("global-member-status", error.message, true);

  setStatus("global-member-status", `Added ${email}`, false, true);
  e.target.reset();
  await loadAllMembers();
});

// ============================================================
// DASHBOARD: ALERTS + ANNOUNCEMENTS
// ============================================================

async function showDashboard() {
  showScreen("dashboard");
  $("dash-date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short",
  });
  try {
    await loadWarehouses();
    await Promise.all([loadAlerts(), loadAnnouncements()]);
    renderDashboard();
  } finally {
    hideLoading();
  }
}

// Items that are expired or expire within ALERT_DAYS, across every warehouse
// the user can see. Computed live from the inventory, nothing extra is stored.
async function loadAlerts() {
  state.alerts = [];
  const ids = state.warehouses.map((w) => w.id);
  if (ids.length === 0) return;

  const limit = isoDate(addDays(new Date(), ALERT_DAYS));
  const { data, error } = await supabase
    .from("iliko")
    .select("id, name, quantity, expiration_date, sistimata_id")
    .in("sistimata_id", ids)
    .not("expiration_date", "is", null)
    .lte("expiration_date", limit)
    .order("expiration_date");
  if (error) return reportError("Couldn't check for expiring items. Please try again.", error);

  const today = isoDate(new Date());
  state.alerts = (data || []).map((p) => ({ ...p, expired: p.expiration_date <= today }));
}

async function loadAnnouncements() {
  state.announcements = [];
  state.announcementsError = false;
  const ids = state.warehouses.map((w) => w.id);
  if (ids.length === 0) return;

  const { data, error } = await supabase
    .from("announcements")
    .select("*")
    .in("sistimata_id", ids)
    .order("created_at", { ascending: false });
  if (error) {
    console.error(error);
    state.announcementsError = true;
    return;
  }
  state.announcements = data || [];
}

function warehouseById(id) {
  return state.warehouses.find((w) => w.id === id);
}

function isAdminOf(warehouseId) {
  return !!warehouseById(warehouseId)?.role.startsWith("admin");
}

function canDeleteAnnouncement(a) {
  return a.author_id === state.user?.id || isAdminOf(a.sistimata_id);
}

function isAnnouncementVisible(a) {
  const today = isoDate(new Date());
  if (a.expires_at && a.expires_at < today) return false;
  if (a.completed_at) {
    const ageDays = (Date.now() - new Date(a.completed_at).getTime()) / 86400000;
    if (ageDays > DONE_VISIBLE_DAYS) return false;
  }
  return true;
}

$("dash-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  state.dashFilter = btn.dataset.filter;
  setSegment("dash-filter", state.dashFilter);
  renderDashboard();
});

$("dash-new-post").addEventListener("click", showPostForm);

function renderDashboard() {
  const feed = $("dash-feed");
  feed.innerHTML = "";
  const f = state.dashFilter;

  // A failed load is not the same as having no warehouses: don't invite the
  // user to create one when the real problem is the connection.
  if (state.warehousesError) {
    feed.innerHTML = `
      <div class="empty">
        <div class="ic expired"><i class="ti ti-wifi-off" aria-hidden="true"></i></div>
        <b>Couldn't load your data</b>
        Check your connection and try again.
        <div><button class="btn-primary" id="retry-load">Try again</button></div>
      </div>`;
    $("retry-load").addEventListener("click", showDashboard);
    return;
  }

  if (state.warehouses.length === 0) {
    feed.innerHTML = `
      <div class="empty">
        <div class="ic"><i class="ti ti-building-warehouse" aria-hidden="true"></i></div>
        <b>Create your first warehouse</b>
        Set one up to start tracking inventory and posting announcements.
        <div><button class="btn-primary" id="empty-create">Create warehouse</button></div>
      </div>`;
    $("empty-create").addEventListener("click", showWarehousePicker);
    return;
  }

  if (state.announcementsError) {
    feed.innerHTML = `<div class="notice">Announcements aren't set up yet. Ask an admin to run the announcements SQL in Supabase.</div>`;
  }

  const visible = state.announcements.filter(isAnnouncementVisible);
  const open = visible.filter((a) => !a.completed_at);
  const pinned = open.filter((a) => a.pinned);
  const rest = open.filter((a) => !a.pinned);
  const done = visible.filter((a) => a.completed_at);

  let rendered = 0;
  const section = (title, items, build, className = "feed") => {
    if (items.length === 0) return;
    rendered += items.length;
    if (title) feed.insertAdjacentHTML("beforeend", `<div class="feed-title">${title}</div>`);
    const wrap = document.createElement("div");
    wrap.className = className;
    items.forEach((item) => wrap.appendChild(build(item)));
    feed.appendChild(wrap);
  };

  if (f !== "urgent") section("", pinned, buildAnnouncement);
  if (f !== "posts") {
    const sorted = [...state.alerts].sort((a, b) => Number(b.expired) - Number(a.expired));
    section("Urgent", sorted, buildAlert);
  }
  if (f !== "urgent") section(pinned.length || state.alerts.length ? "Announcements" : "", rest, buildAnnouncement);

  if (f !== "urgent" && done.length) {
    rendered += done.length;
    const details = document.createElement("details");
    details.className = "completed";
    details.innerHTML = `<summary>Completed (${done.length})</summary><div class="feed"></div>`;
    done.forEach((a) => details.querySelector(".feed").appendChild(buildAnnouncement(a)));
    feed.appendChild(details);
  }

  if (rendered === 0) {
    feed.insertAdjacentHTML("beforeend", `
      <div class="empty">
        <div class="ic ok"><i class="ti ti-circle-check" aria-hidden="true"></i></div>
        <b>All clear</b>
        ${f === "posts" ? "No announcements right now." : "Nothing needs attention right now."}
      </div>`);
  }
}

function buildAlert(a) {
  const wh = warehouseById(a.sistimata_id);
  const e = expiryOf(a);
  const el = document.createElement("article");
  el.className = "ann";
  el.innerHTML = `
    <div class="ic ${e.status}"><i class="ti ti-${a.expired ? "alert-circle" : "clock"}" aria-hidden="true"></i></div>
    <div class="body">
      <div class="title">${escapeHtml(a.name)} ${a.expired ? "expired" : "expiring"}</div>
      <div class="tag ${e.status}">${escapeHtml(expiryText(e, a.expiration_date))} · ${escapeHtml(wh?.name ?? "")}</div>
    </div>
    <div class="side">
      ${a.expired
        ? `<button class="mini-btn" data-act="remove">Remove</button>`
        : `<button class="mini-btn" data-act="open">Open</button>`}
    </div>`;
  el.querySelector("[data-act]").addEventListener("click", async (ev) => {
    if (ev.currentTarget.dataset.act === "open") return selectWarehouse(wh);
    if (!confirm(`Remove "${a.name}" from ${wh?.name ?? "the warehouse"}?`)) return;
    el.classList.add("removing");
    const { error } = await supabase.from("iliko").delete().eq("id", a.id);
    if (error) {
      el.classList.remove("removing");
      return alert(error.message);
    }
    await loadAlerts();
    renderDashboard();
  });
  return el;
}

function buildAnnouncement(a) {
  const wh = warehouseById(a.sistimata_id);
  const done = !!a.completed_at;
  const author = shortName(a.author_email);
  const where = state.warehouses.length > 1 ? ` · ${wh?.name ?? ""}` : "";
  const tag = done
    ? `Done by ${shortName(a.completed_by_email)} · ${timeAgo(a.completed_at)}`
    : `${author}${where} · ${timeAgo(a.created_at)}`;

  const el = document.createElement("article");
  el.className = `ann${a.pinned && !done ? " pinned" : ""}${done ? " done" : ""}`;
  el.innerHTML = `
    <div class="ic"><i class="ti ti-${a.pinned && !done ? "pin" : done ? "circle-check" : "speakerphone"}" aria-hidden="true"></i></div>
    <div class="body">
      <div class="title">${escapeHtml(a.title)}</div>
      ${a.message ? `<div class="msg">${escapeHtml(a.message)}</div>` : ""}
      <div class="tag">${escapeHtml(tag)}</div>
    </div>
    <div class="side">
      <button class="mini-btn" data-act="toggle">${done ? "Undo" : "Done"}</button>
      ${canDeleteAnnouncement(a) ? `<button class="del" data-act="delete" aria-label="Delete announcement"><i class="ti ti-trash" aria-hidden="true"></i></button>` : ""}
    </div>`;

  el.querySelector('[data-act="toggle"]').addEventListener("click", async () => {
    const { error } = await supabase.rpc("set_announcement_done", { ann_id: a.id, done: !done });
    if (error) return alert(error.message);
    await loadAnnouncements();
    renderDashboard();
  });
  el.querySelector('[data-act="delete"]')?.addEventListener("click", async () => {
    if (!confirm(`Delete "${a.title}"?`)) return;
    el.classList.add("removing");
    const { error } = await supabase.from("announcements").delete().eq("id", a.id);
    if (error) {
      el.classList.remove("removing");
      return alert(error.message);
    }
    await loadAnnouncements();
    renderDashboard();
  });
  return el;
}

// ---- Posting ----

function showPostForm() {
  showScreen("post");
  setStatus("post-status", "");
  $("post-form").reset();

  const preselect = state.currentWarehouse?.id ?? state.warehouses[0]?.id;
  const box = $("post-targets");
  box.innerHTML = "";
  for (const wh of state.warehouses) {
    const chip = document.createElement("label");
    chip.className = "chip";
    chip.innerHTML = `<input type="checkbox" value="${wh.id}" ${wh.id === preselect ? "checked" : ""} />${escapeHtml(wh.name)}`;
    chip.querySelector("input").addEventListener("change", updatePinRow);
    box.appendChild(chip);
  }
  updatePinRow();
}

function selectedTargets() {
  return [...$("post-targets").querySelectorAll("input:checked")].map((i) => i.value);
}

// Only admins can pin, so the switch appears when at least one chosen
// warehouse is one they administer.
function updatePinRow() {
  const canPin = selectedTargets().some(isAdminOf);
  $("post-pin-row").classList.toggle("hidden", !canPin);
  if (!canPin) $("post-pinned").checked = false;
}

$("post-close").addEventListener("click", showDashboard);

onSubmitOnce("post-form", async () => {
  const title = $("post-title").value.trim();
  const message = $("post-message").value.trim();
  const targets = selectedTargets();
  if (targets.length === 0) return setStatus("post-status", "Choose at least one warehouse.", true);

  const wantsPin = $("post-pinned").checked;
  const expires = $("post-expires").value || null;
  const rows = targets.map((id) => ({
    sistimata_id: id,
    title,
    message: message || null,
    pinned: wantsPin && isAdminOf(id),
    expires_at: expires,
  }));

  setStatus("post-status", "Posting...");
  const { error } = await supabase.from("announcements").insert(rows);
  if (error) return setStatus("post-status", error.message, true);

  await showDashboard();
});

// ============================================================
// SELECTING A WAREHOUSE / MAIN APP SHELL
// ============================================================

async function selectWarehouse(wh) {
  state.currentWarehouse = wh;
  state.invFilter = "all";
  setSegment("inv-filter", "all");
  showScreen("app");

  $("current-warehouse-name").textContent = wh.name;
  $("current-role").textContent = wh.role;
  $("nav-admin").classList.toggle("hidden", !wh.role.startsWith("admin"));

  showView("inventory");
  await loadCategories();
  await loadProducts();
}

$("back-to-warehouses").addEventListener("click", showWarehousePicker);

$("main-home").addEventListener("click", showDashboard);
$("main-warehouses").addEventListener("click", showWarehousePicker);
$("main-post").addEventListener("click", showPostForm);
$("nav-home").addEventListener("click", showDashboard);

$("nav-inventory").addEventListener("click", () => { showView("inventory"); loadProducts(); });
$("nav-add").addEventListener("click", () => showView("add"));
$("nav-admin").addEventListener("click", () => { showView("admin"); loadMembers(); });

function showView(name) {
  state.view = name;
  for (const n of ["inventory", "add", "admin"]) {
    $(`view-${n}`).classList.toggle("hidden", n !== name);
    $(`nav-${n}`).classList.toggle("active", n === name);
  }
}

// ============================================================
// CATEGORIES
// ============================================================

// Each load gets a number; if a newer load has started by the time the answer
// arrives (e.g. the user opened another warehouse), the old answer is dropped.
let categoriesRequest = 0;

async function loadCategories() {
  const requestId = ++categoriesRequest;
  const { data, error } = await supabase
    .from("categories")
    .select("id, name")
    .eq("sistimata_id", state.currentWarehouse.id)
    .order("name");

  if (requestId !== categoriesRequest) return;
  if (error) return reportError("Couldn't load the categories. Please try again.", error);
  state.categories = data || [];

  const filter = $("category-filter");
  const previousFilter = filter.value;
  filter.innerHTML = `<option value="">All categories</option>`;
  const datalist = $("category-options");
  datalist.innerHTML = "";

  for (const cat of state.categories) {
    filter.innerHTML += `<option value="${escapeHtml(cat.id)}">${escapeHtml(cat.name)}</option>`;
    datalist.innerHTML += `<option value="${escapeHtml(cat.name)}"></option>`;
  }
  // Keep the selected category if it still exists (it's gone when it became
  // empty and was removed); otherwise fall back to "All categories".
  if (state.categories.some((c) => String(c.id) === previousFilter)) filter.value = previousFilter;
}

async function getOrCreateCategory(name) {
  const existing = state.categories.find(
    (c) => c.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from("categories")
    .insert({ sistimata_id: state.currentWarehouse.id, name })
    .select("id, name")
    .single();

  if (error) {
    // Someone created the same category a moment ago (unique violation):
    // reload and use theirs instead of failing.
    if (error.code === "23505") {
      await loadCategories();
      const again = state.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (again) return again.id;
    }
    throw error;
  }
  state.categories.push(data);
  return data.id;
}

// ============================================================
// PRODUCTS (iliko)
// ============================================================

// ---- Tags ----
// An item can carry any of these tags. They are stored as a list of keys and
// shown in Greek capitals: ΑΓΕΛΗ = yellow, ΟΜΑΔΑ = green, ΚΟΙΝΟΤΗΤΑ = red.
const TAGS = [
  { key: "agelh", label: "ΑΓΕΛΗ" },
  { key: "omada", label: "ΟΜΑΔΑ" },
  { key: "koinotita", label: "ΚΟΙΝΟΤΗΤΑ" },
];
const tagByKey = Object.fromEntries(TAGS.map((t) => [t.key, t]));

// Turns off every tag control when the database has no "tags" column yet.
let tagsSupported = true;
function setTagsSupported(ok) {
  tagsSupported = ok;
  document.body.classList.toggle("no-tags", !ok);
}

function renderTagChips(container, selected = []) {
  container.innerHTML = "";
  for (const t of TAGS) {
    const chip = document.createElement("label");
    chip.className = `chip tag-chip tag-${t.key}`;
    chip.innerHTML = `<input type="checkbox" value="${t.key}" ${selected.includes(t.key) ? "checked" : ""} />${escapeHtml(t.label)}`;
    container.appendChild(chip);
  }
}

function readTagChips(container) {
  return [...container.querySelectorAll("input:checked")].map((i) => i.value);
}

function tagPills(tags) {
  return (tags || [])
    .filter((key) => tagByKey[key])
    .map((key) => `<span class="tag-pill tag-${key}">${escapeHtml(tagByKey[key].label)}</span>`)
    .join("");
}

for (const t of TAGS) {
  $("tag-filter").insertAdjacentHTML("beforeend", `<option value="${t.key}">${escapeHtml(t.label)}</option>`);
}
renderTagChips($("product-tags"));
$("tag-filter").addEventListener("change", () => renderProducts(true));

$("category-filter").addEventListener("change", () => renderProducts(true));

$("inv-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  state.invFilter = btn.dataset.filter;
  setSegment("inv-filter", state.invFilter);
  renderProducts(true);
});

let changedProductId = null;

// Fetches every item in the warehouse; the category / expiry filters are
// applied on the client so the "Needs attention" card always sees everything.
let productsRequest = 0;

<<<<<<< HEAD
async function loadProducts(animate = true) {
  if (typeof animate !== "boolean") animate = true;
  const requestId = ++productsRequest;
  const { data, error } = await supabase
=======
const ITEM_COLUMNS = "id, name, quantity, expiration_date, category_id, categories ( name )";

function fetchItems(columns) {
  return supabase
>>>>>>> dev
    .from("iliko")
    .select(columns)
    .eq("sistimata_id", state.currentWarehouse.id)
    .order("name");
<<<<<<< HEAD
=======
}

async function loadProducts(animate = true) {
  if (typeof animate !== "boolean") animate = true;
  const requestId = ++productsRequest;
  let { data, error } = await fetchItems(tagsSupported ? `${ITEM_COLUMNS}, tags` : ITEM_COLUMNS);
  // 42703 = "column does not exist": the database hasn't been updated for tags
  // yet (supabase/tags-and-cleanup.sql). Carry on without tags instead of
  // leaving the whole list empty.
  if (error?.code === "42703" && tagsSupported) {
    setTagsSupported(false);
    showToast("Tags aren't available yet: the database needs the update in supabase/tags-and-cleanup.sql", true);
    ({ data, error } = await fetchItems(ITEM_COLUMNS));
  }
>>>>>>> dev
  if (requestId !== productsRequest) return;   // a newer load started; this answer is stale
  if (error) return reportError("Couldn't load the items. Please try again.", error);

  state.products = data || [];
  renderProducts(animate);
}

function expiryOf(p) {
  if (!p.expiration_date) return { status: "none", days: null };
  const days = daysBetween(isoDate(new Date()), p.expiration_date);
  if (days <= 0) return { status: "expired", days };
  if (days <= ALERT_DAYS) return { status: "soon", days };
  return { status: "ok", days };
}

function expiryText({ status, days }, date) {
  if (status === "expired") return days === 0 ? "Expires today" : `Expired ${date}`;
  if (status === "soon") return days === 1 ? "Expires tomorrow" : `Expires in ${days} days`;
  return `Exp. ${date}`;
}

function iconFor(categoryName = "") {
  const c = categoryName.toLowerCase();
  if (/pharm|med|aid|φαρμ/.test(c)) return "pill";
  if (/tent|σκην/.test(c)) return "tent";
  if (/food|kitchen|φαγ|κουζ/.test(c)) return "tools-kitchen-2";
  if (/tool|εργαλ/.test(c)) return "tools";
  return "package";
}

function renderAttention() {
  const card = $("attention-card");
  const flagged = state.products
    .map((p) => ({ p, e: expiryOf(p) }))
    .filter(({ e }) => e.status === "expired" || e.status === "soon")
    .sort((a, b) => a.p.expiration_date.localeCompare(b.p.expiration_date));

  card.classList.toggle("hidden", flagged.length === 0);
  if (flagged.length === 0) return;

  const shown = flagged.slice(0, 3);
  card.innerHTML = `
    <div class="head"><span><i class="ti ti-alert-triangle" aria-hidden="true"></i> Needs attention</span>
      <span class="dim">${flagged.length} item${flagged.length === 1 ? "" : "s"}</span></div>
    ${shown.map(({ p, e }) => `
      <div class="row">
        <div><b>${escapeHtml(p.name)}</b><div class="${e.status === "expired" ? "dim expired" : "dim"}" style="color:var(--${e.status === "expired" ? "danger" : "warn"})">${escapeHtml(expiryText(e, p.expiration_date))}</div></div>
        ${e.status === "expired" ? `<button class="mini-btn" data-remove="${p.id}">Remove</button>` : ""}
      </div>`).join("")}
    ${flagged.length > shown.length ? `<div class="more">+ ${flagged.length - shown.length} more in the list below</div>` : ""}
  `;
  card.querySelectorAll("[data-remove]").forEach((btn) =>
    btn.addEventListener("click", () => deleteProduct(btn.dataset.remove, null))
  );
}

function renderProducts(animate = true) {
  renderAttention();

  const list = $("product-list");
  list.innerHTML = "";
  list.classList.toggle("no-anim", !animate);

  const categoryId = $("category-filter").value;
  const tagKey = tagsSupported ? $("tag-filter").value : "";
  const products = state.products.filter((p) => {
    if (categoryId && String(p.category_id) !== categoryId) return false;
    if (tagKey && !(p.tags || []).includes(tagKey)) return false;
    const { status } = expiryOf(p);
    if (state.invFilter === "expired") return status === "expired";
    if (state.invFilter === "soon") return status === "soon";
    return true;
  });

  if (products.length === 0) {
    list.innerHTML = `<li class="list-item"><span class="meta">No items found.</span></li>`;
    return;
  }

  for (const p of products) {
    const e = expiryOf(p);
    const catName = p.categories?.name ?? "Uncategorized";
    const tone = e.status === "expired" || e.status === "soon" ? e.status : "";
    const li = document.createElement("li");
    li.className = "list-item item";
    li.innerHTML = `
      <div class="ic ${tone}"><i class="ti ti-${iconFor(catName)}" aria-hidden="true"></i></div>
      <div class="info" role="button" tabindex="0" aria-label="Edit ${escapeHtml(p.name)}">
        <span class="name">${escapeHtml(p.name)} <i class="ti ti-pencil edit-hint" aria-hidden="true"></i></span>
        <span class="meta ${tone}">${escapeHtml(catName)}${p.expiration_date ? ` · ${escapeHtml(expiryText(e, p.expiration_date))}` : ""}</span>
        ${tagsSupported && (p.tags || []).length ? `<span class="tags">${tagPills(p.tags)}</span>` : ""}
      </div>
      <div class="qty-controls">
        <button data-action="dec" aria-label="Decrease">−</button>
        <input class="qty-input${p.id === changedProductId ? " pop" : ""}" type="number" inputmode="numeric" min="0" max="${MAX_QUANTITY}" step="1" value="${p.quantity}" aria-label="Quantity of ${escapeHtml(p.name)}" />
        <button data-action="inc" aria-label="Increase">+</button>
        <button class="del" data-action="delete" aria-label="Delete ${escapeHtml(p.name)}"><i class="ti ti-trash" aria-hidden="true"></i></button>
      </div>
    `;
    li.querySelector('[data-action="inc"]').addEventListener("click", () => changeQuantity(p, Math.min(MAX_QUANTITY, p.quantity + 1)));
    li.querySelector('[data-action="dec"]').addEventListener("click", () => changeQuantity(p, Math.max(0, p.quantity - 1)));
    li.querySelector('[data-action="delete"]').addEventListener("click", () => deleteProduct(p.id, li));

    // Type the amount directly: Enter or tapping away saves it, Escape cancels.
    const qty = li.querySelector(".qty-input");
    qty.addEventListener("focus", () => qty.select());
    qty.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") qty.blur();
      if (ev.key === "Escape") { qty.value = p.quantity; qty.blur(); }
    });
    qty.addEventListener("change", () => {
      const typed = parseInt(qty.value, 10);
      if (Number.isNaN(typed)) { qty.value = p.quantity; return; }
      const amount = Math.min(MAX_QUANTITY, Math.max(0, typed));
      qty.value = amount;
      changeQuantity(p, amount);
    });

    // Tap the name to rename the item or change its tags.
    const info = li.querySelector(".info");
    info.addEventListener("click", () => openEditSheet(p));
    info.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openEditSheet(p); }
    });
    list.appendChild(li);
  }
  changedProductId = null;
}

const quantityBusy = new Set();   // items with a quantity change in flight

async function changeQuantity(p, newQty) {
  if (newQty === p.quantity || quantityBusy.has(p.id)) return;
  quantityBusy.add(p.id);
  try {
    // Only apply the change if nobody else changed the quantity since we
    // loaded it; otherwise two people pressing + at once would overwrite each
    // other and one press would be lost without anyone noticing.
    const { data, error } = await supabase
      .from("iliko")
      .update({ quantity: newQty })
      .eq("id", p.id)
      .eq("quantity", p.quantity)
      .select("id");
    if (error) return reportError("Couldn't change the quantity. Please try again.", error);
    if (!data || data.length === 0) {
      showToast("This item was just changed by someone else - showing the latest amount.", true);
    } else {
      changedProductId = p.id;
    }
    await loadProducts(false);
  } finally {
    quantityBusy.delete(p.id);
  }
}

async function deleteProduct(id, li) {
  const product = state.products.find((p) => String(p.id) === String(id));
  if (!confirm(`Delete "${product?.name ?? "this item"}"? This can't be undone.`)) return;
  li?.classList.add("removing");
  const [{ error }] = await Promise.all([
    supabase.from("iliko").delete().eq("id", id),
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]);
  if (error) {
    li?.classList.remove("removing");
    return reportError("Couldn't delete the item. Please try again.", error);
  }
  await loadProducts(false);
  // The database removes a category once its last item is gone: reload the
  // category list so it disappears from the filter and the suggestions too.
  await loadCategories();
  renderProducts(false);
}

$("product-has-expiration").addEventListener("change", (e) => {
  $("expiration-field").classList.toggle("hidden", !e.target.checked);
});

onSubmitOnce("add-product-form", async (e) => {
  const name = $("product-name").value.trim();
  const categoryName = $("product-category").value.trim();
  const quantity = Math.min(MAX_QUANTITY, Math.max(0, parseInt($("product-quantity").value, 10) || 0));
  const hasExpiration = $("product-has-expiration").checked;
  const expiration = hasExpiration ? $("product-expiration").value || null : null;

  if (!name || !categoryName) {
    return setStatus("add-status", "Please fill in the name and the category.", true);
  }
  // Ticking the box without a date would save the item with no expiry at all,
  // so it would never show up in the expiry alerts.
  if (hasExpiration && !expiration) {
    return setStatus("add-status", "Pick an expiration date, or untick the box.", true);
  }

<<<<<<< HEAD
=======
  const tags = tagsSupported ? readTagChips($("product-tags")) : [];

>>>>>>> dev
  setStatus("add-status", "Saving...");
  try {
    const row = {
      sistimata_id: state.currentWarehouse.id,
      name,
      quantity,
      expiration_date: expiration,
    };
    if (tags.length) row.tags = tags;   // only sent when used, so adding items works even before the database update

    let categoryId = await getOrCreateCategory(categoryName);
    let { error } = await supabase.from("iliko").insert({ ...row, category_id: categoryId });
    if (error?.code === "23503") {
      // The category was removed a moment ago (it had become empty): make it again.
      await loadCategories();
      categoryId = await getOrCreateCategory(categoryName);
      ({ error } = await supabase.from("iliko").insert({ ...row, category_id: categoryId }));
    }
    if (error) throw error;

    setStatus("add-status", `Added "${name}"`, false, true);
    e.target.reset();
    $("expiration-field").classList.add("hidden");
    await loadCategories();
  } catch (err) {
    setStatus("add-status", err.message, true);
  }
});

// ---- Edit an item: rename it and change its tags ----

let editingProduct = null;
let editReturnFocus = null;

function openEditSheet(p) {
  editingProduct = p;
  editReturnFocus = document.activeElement;
  $("edit-name").value = p.name;
  renderTagChips($("edit-tags"), p.tags || []);
  setStatus("edit-status", "");
  $("edit-sheet").classList.remove("hidden");
  $("edit-name").focus();
  $("edit-name").select();
}

function closeEditSheet() {
  $("edit-sheet").classList.add("hidden");
  editingProduct = null;
  editReturnFocus?.focus?.();
}

$("edit-cancel").addEventListener("click", closeEditSheet);
$("edit-sheet").addEventListener("click", (e) => {
  if (e.target === $("edit-sheet")) closeEditSheet();   // tap outside the card
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("edit-sheet").classList.contains("hidden")) closeEditSheet();
});

onSubmitOnce("edit-form", async () => {
  const p = editingProduct;
  if (!p) return;
  const name = $("edit-name").value.trim();
  if (!name) return setStatus("edit-status", "The name can't be empty.", true);

  const tags = readTagChips($("edit-tags"));
  const patch = {};
  if (name !== p.name) patch.name = name;
  if (tagsSupported && [...tags].sort().join() !== [...(p.tags || [])].sort().join()) patch.tags = tags;
  if (Object.keys(patch).length === 0) return closeEditSheet();   // nothing changed

  setStatus("edit-status", "Saving...");
  const { data, error } = await supabase.from("iliko").update(patch).eq("id", p.id).select("id");
  if (error) return setStatus("edit-status", error.message, true);
  if (!data || data.length === 0) {
    return setStatus("edit-status", "Couldn't save: the item may have been deleted, or you may not have permission.", true);
  }
  closeEditSheet();
  showToast("Saved");
  await loadProducts(false);
});

// ============================================================
// REFRESH BUTTON (top bar)
// Reloads whatever is on screen (dashboard, warehouse list, items, members)
// without reloading the page.
// ============================================================

let refreshing = false;

async function refreshCurrentScreen() {
  if (refreshing || !state.user) return;
  refreshing = true;
  const btn = $("refresh-btn");
  btn.disabled = true;
  btn.classList.add("spinning");
  const startedAt = Date.now();
  try {
    switch (state.screen) {
      case "dashboard":
        await loadWarehouses();
        await Promise.all([loadAlerts(), loadAnnouncements()]);
        renderDashboard();
        break;
      case "warehouses":
        await refreshWarehouses();
        break;
      case "superadmin":
        await loadWarehouses();
        fillGlobalWarehouseSelect();
        renderAllWarehousesList();
        await loadAllMembers();
        break;
      case "app":
        if (state.view === "admin") {
          await loadMembers();
        } else {
          await loadCategories();
          await loadProducts(false);
        }
        break;
    }
  } finally {
    // keep the spinner visible long enough to notice that something happened
    await new Promise((r) => setTimeout(r, Math.max(0, 500 - (Date.now() - startedAt))));
    refreshing = false;
    btn.disabled = false;
    btn.classList.remove("spinning");
  }
}

$("refresh-btn").addEventListener("click", refreshCurrentScreen);

// ============================================================
// ADMIN: MEMBERS
// ============================================================

onSubmitOnce("add-member-form", async (e) => {
  const email = $("member-email").value.trim();
  const role = $("member-role").value;

  setStatus("member-status", "Adding...");
  const { error } = await supabase.rpc("add_member", {
    target_sistimata_id: state.currentWarehouse.id,
    member_email: email,
    member_role: role,
  });
  if (error) return setStatus("member-status", error.message, true);

  setStatus("member-status", `Added ${email}`, false, true);
  e.target.reset();
  await loadMembers();
});

async function loadMembers() {
  const { data, error } = await supabase.rpc("list_members", {
    target_sistimata_id: state.currentWarehouse.id,
  });
  if (error) return reportError("Couldn't load the members. Please try again.", error);

  const list = $("member-list");
  list.innerHTML = "";
  for (const m of data || []) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <div class="info">
        <span class="name">${escapeHtml(m.email)}</span>
      </div>
      <span class="badge">${escapeHtml(m.role)}</span>
    `;
    list.appendChild(li);
  }
}

// ============================================================
// HELPERS
// ============================================================

function setStatus(elId, message, isError = false, isSuccess = false) {
  const el = $(elId);
  el.classList.remove("error", "success");
  void el.offsetWidth; // restart the CSS animation when the same message type repeats
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.toggle("success", isSuccess);
}

const loadingOverlay = $("loading-overlay");
let loadingTimer = null;
let loadingSafetyTimer = null;

let hidingLoading = false;
let loadingShownAt = 0;
const MIN_LOADING_MS = 1500; // shortest time a successful login keeps the loading screen up

function showLoading(text = "Loading your inventory…") {
  clearTimeout(loadingTimer);
  clearTimeout(loadingSafetyTimer);
  hidingLoading = false;
  loadingShownAt = Date.now();
  $("loading-text").textContent = text;
  loadingOverlay.classList.remove("fade-out", "done", "hidden");
  // Never leave the user stuck behind the overlay if something never resolves.
  loadingSafetyTimer = setTimeout(() => hideLoading(false), 15000);
}

// complete=true: let the bar fill to 100% before fading out (successful load).
function hideLoading(complete = true) {
  clearTimeout(loadingSafetyTimer);
  if (hidingLoading || loadingOverlay.classList.contains("hidden")) return;
  hidingLoading = true;
  const fadeOut = () => {
    loadingOverlay.classList.add("fade-out");
    loadingTimer = setTimeout(() => {
      loadingOverlay.classList.add("hidden");
      loadingOverlay.classList.remove("fade-out", "done");
      hidingLoading = false;
    }, 250);
  };
  if (complete) {
    const wait = Math.max(0, MIN_LOADING_MS - (Date.now() - loadingShownAt));
    loadingTimer = setTimeout(() => {
      loadingOverlay.classList.add("done");
      loadingTimer = setTimeout(fadeOut, 250);
    }, wait);
  } else {
    fadeOut();
  }
}

// Local-time YYYY-MM-DD (toISOString would shift the date near midnight).
function isoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

// Whole days from one YYYY-MM-DD date to another (negative if `to` is earlier).
function daysBetween(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

function setSegment(id, value) {
  $(id).querySelectorAll("button[data-filter]").forEach((b) =>
    b.classList.toggle("on", b.dataset.filter === value)
  );
}

function shortName(email) {
  return email ? email.split("@")[0] : "Someone";
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// Safe for both element text and attribute values (e.g. aria-label="...").
// Quotes must be escaped too, otherwise a name containing " can break out of
// an attribute and inject its own attributes such as onmouseover=....
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}