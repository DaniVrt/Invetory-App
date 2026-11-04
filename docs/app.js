import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js"; 

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- App state ---- 
const state = {
  user: null,
  warehouses: [],       // [ sistimata_id, role, name ]
  currentWarehouse: null, //  id, role, name 
  categories: [],        // [ id, name ]
  products: [],          // items of the current warehouse
  invFilter: "all",      // all | soon | expired
  alerts: [],            // expired / expiring items across all warehouses
  announcements: [],
  announcementsError: false,
  dashFilter: "all",     // all | urgent | posts
};

const ALERT_DAYS = 30;        // items expiring within this many days count as "soon"
const DONE_VISIBLE_DAYS = 7;  // completed announcements stay listed this long

// ---- DOM shortcuts ----
const $ = (id) => document.getElementById(id);

const authSection = $("auth-section");
const warehouseSection = $("warehouse-section");
const appSection = $("app-section");
const userBar = $("user-bar");

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
$("new-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("new-password").value;
  setStatus("auth-status", "Updating password...");
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return setStatus("auth-status", error.message, true);

  $("new-password-form").classList.add("hidden");
  $("new-password-form").reset();
  //authSection.classList.add("hidden");
  //showWarehousePicker();
  setStatus("auth-status", "Password updated - you're logged in.", false, true);
});

supabase.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    userBar.classList.add("hidden");
    showScreen("auth");
    $("login-form").classList.add("hidden");
    $("show-forgot-password").classList.add("hidden");
    $("signup-form").classList.add("hidden");
    $("forgot-password-form").classList.add("hidden");
    $("new-password-form").classList.remove("hidden");
    setStatus("warehouse-status", "Enter a new password below.");
    return;
  }
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
  const { data, error } = await supabase
    .from("user_sistimata")
    .select("role, sistimata_id, sistimata ( id, name )")
    .eq("user_id", state.user.id);

  if (error) return setStatus("warehouse-status", error.message, true);

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
    list.innerHTML = `<li class="list-item"><span class="meta">No warehouses yet - create one below.</span></li>`;
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

$("create-warehouse-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("new-warehouse-name").value.trim();
  if (!name) return;
  setStatus("warehouse-status", "Creating...");
  const { error } = await supabase.from("sistimata").insert({ name });
  if (error) return setStatus("Not allowed to create Warehouse as a member", true); //("warehouse-status", error.message, true)
  $("new-warehouse-name").value = "";
  setStatus("warehouse-status", "");
  await refreshWarehouses();
});

// ============================================================
// SUPER ADMIN: GLOBAL "ALL PARTICIPANTS" DASHBOARD
// ============================================================

$("open-super-admin").addEventListener("click", async () => {
  showScreen("superadmin");

  const wSelect = $("global-member-warehouse");
  wSelect.innerHTML = state.warehouses
    .map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`)
    .join("");

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
        const { error } = await supabase.from("sistimata").delete().eq("id", wh.id);
        if (error) return alert(error.message);
        await loadWarehouses();
        renderAllWarehousesList();
      });
    });

    list.appendChild(li);
  }
}

async function loadAllMembers() {
  const { data, error } = await supabase.rpc("list_all_members");
  if (error) return console.error(error);

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

$("global-add-member-form").addEventListener("submit", async (e) => {
  e.preventDefault();
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
  if (error) return console.error(error);

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

$("post-form").addEventListener("submit", async (e) => {
  e.preventDefault();
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
  for (const n of ["inventory", "add", "admin"]) {
    $(`view-${n}`).classList.toggle("hidden", n !== name);
    $(`nav-${n}`).classList.toggle("active", n === name);
  }
}

// ============================================================
// CATEGORIES
// ============================================================

async function loadCategories() {
  const { data, error } = await supabase
    .from("categories")
    .select("id, name")
    .eq("sistimata_id", state.currentWarehouse.id)
    .order("name");

  if (error) return console.error(error);
  state.categories = data || [];

  const filter = $("category-filter");
  filter.innerHTML = `<option value="">All categories</option>`;
  const datalist = $("category-options");
  datalist.innerHTML = "";

  for (const cat of state.categories) {
    filter.innerHTML += `<option value="${cat.id}">${escapeHtml(cat.name)}</option>`;
    datalist.innerHTML += `<option value="${escapeHtml(cat.name)}"></option>`;
  }
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

  if (error) throw error;
  state.categories.push(data);
  return data.id;
}

// ============================================================
// PRODUCTS (iliko)
// ============================================================

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
async function loadProducts(animate = true) {
  if (typeof animate !== "boolean") animate = true;
  const { data, error } = await supabase
    .from("iliko")
    .select("id, name, quantity, expiration_date, category_id, categories ( name )")
    .eq("sistimata_id", state.currentWarehouse.id)
    .order("name");
  if (error) return console.error(error);

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
  const products = state.products.filter((p) => {
    if (categoryId && String(p.category_id) !== categoryId) return false;
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
      <div class="info">
        <span class="name">${escapeHtml(p.name)}</span>
        <span class="meta ${tone}">${escapeHtml(catName)}${p.expiration_date ? ` · ${escapeHtml(expiryText(e, p.expiration_date))}` : ""}</span>
      </div>
      <div class="qty-controls">
        <button data-action="dec" aria-label="Decrease">−</button>
        <span class="${p.id === changedProductId ? "pop" : ""}">${p.quantity}</span>
        <button data-action="inc" aria-label="Increase">+</button>
        <button class="del" data-action="delete" aria-label="Delete ${escapeHtml(p.name)}"><i class="ti ti-trash" aria-hidden="true"></i></button>
      </div>
    `;
    li.querySelector('[data-action="inc"]').addEventListener("click", () => changeQuantity(p.id, p.quantity + 1));
    li.querySelector('[data-action="dec"]').addEventListener("click", () => changeQuantity(p.id, Math.max(0, p.quantity - 1)));
    li.querySelector('[data-action="delete"]').addEventListener("click", () => deleteProduct(p.id, li));
    list.appendChild(li);
  }
  changedProductId = null;
}

async function changeQuantity(id, newQty) {
  const { error } = await supabase.from("iliko").update({ quantity: newQty }).eq("id", id);
  if (error) return console.error(error);
  changedProductId = id;
  await loadProducts(false);
}

async function deleteProduct(id, li) {
  li?.classList.add("removing");
  const [{ error }] = await Promise.all([
    supabase.from("iliko").delete().eq("id", id),
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]);
  if (error) {
    li?.classList.remove("removing");
    return console.error(error);
  }
  await loadProducts(false);
}

$("product-has-expiration").addEventListener("change", (e) => {
  $("expiration-field").classList.toggle("hidden", !e.target.checked);
});

$("add-product-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("product-name").value.trim();
  const categoryName = $("product-category").value.trim();
  const quantity = parseInt($("product-quantity").value, 10) || 0;
  const hasExpiration = $("product-has-expiration").checked;
  const expiration = hasExpiration ? $("product-expiration").value || null : null;

  setStatus("add-status", "Saving...");
  try {
    const categoryId = await getOrCreateCategory(categoryName);
    const { error } = await supabase.from("iliko").insert({
      sistimata_id: state.currentWarehouse.id,
      category_id: categoryId,
      name,
      quantity,
      expiration_date: expiration,
    });
    if (error) throw error;

    setStatus("add-status", `Added "${name}"`, false, true);
    e.target.reset();
    $("expiration-field").classList.add("hidden");
    await loadCategories();
  } catch (err) {
    setStatus("add-status", err.message, true);
  }
});

// ============================================================
// ADMIN: MEMBERS
// ============================================================

$("add-member-form").addEventListener("submit", async (e) => {
  e.preventDefault();
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
  if (error) return console.error(error);

  const list = $("member-list");
  list.innerHTML = "";
  for (const m of data || []) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <div class="info">
        <span class="name">${escapeHtml(m.email)}</span>
      </div>
      <span class="badge">${m.role}</span>
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
