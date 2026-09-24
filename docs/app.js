import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js"; 

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- App state ---- 
const state = {
  user: null,
  warehouses: [],       // [{ sistimata_id, role, name }]
  currentWarehouse: null, // { id, role, name }
  categories: [],        // [{ id, name }]
};

// ---- DOM shortcuts ----
const $ = (id) => document.getElementById(id);

const authSection = $("auth-section");
const warehouseSection = $("warehouse-section");
const appSection = $("app-section");
const userBar = $("user-bar");

// ============================================================
// AUTH
// ============================================================

$("tab-login").addEventListener("click", () => switchAuthTab("login"));
$("tab-signup").addEventListener("click", () => switchAuthTab("signup"));

function switchAuthTab(which) {
  $("tab-login").classList.toggle("active", which === "login");
  $("tab-signup").classList.toggle("active", which === "signup");
  $("login-form").classList.toggle("hidden", which !== "login");
  $("signup-form").classList.toggle("hidden", which !== "signup");
  $("forgot-password-form").classList.toggle("hidden", which !=="forgot")
  $("show-forgot-password").classList.toggle("active", which!=="forgot");
  setStatus("auth-status", "");
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  setStatus("auth-status", "Logging in...");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return setStatus("auth-status", error.message, true);
  setStatus("auth-status", "");
});

$("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("signup-email").value.trim();
  const password = $("signup-password").value;
  setStatus("auth-status", "Creating account...");
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return setStatus("auth-status", error.message, true);
  if (!data.session) {
    setStatus("auth-status", "Account created! Check your email to confirm, then log in.", false, true);
  }
});

$("logout-btn").addEventListener("click", async () => {
  await supabase.auth.signOut();
});

// ---- Forgot password ----

$("show-forgot-password").addEventListener("click", () => {
  $("login-form").classList.add("hidden");
  $("signup-form").classList.add("hidden");
  $("tab-login").classList.add("hidden");
  $("tab-signup").classList.add("hidden");
  $("forgot-password-form").classList.remove("hidden");
  $("show-forgot-password").classList.add("hidden");
  setStatus("auth-status", "");
});

$("cancel-forgot-password").addEventListener("click", () => {
  $("forgot-password-form").classList.add("hidden");
  $("show-forgot-password").classList.remove("hidden");      
  $("tab-signup").classList.remove("hidden");    
  $("tab-login").classList.remove("hidden");    
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
  $("tab-login").classList.add("active");
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
  setStatus("auth-status", "Password updated - you're logged in.", false, true);
});

supabase.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    userBar.classList.add("hidden");
    authSection.classList.remove("hidden");
    warehouseSection.classList.add("hidden");
    appSection.classList.add("hidden");
    $("login-form").classList.add("hidden");
    $("signup-form").classList.add("hidden");
    $("forgot-password-form").classList.add("hidden");
    $("new-password-form").classList.remove("hidden");
    setStatus("auth-status", "Enter a new password below.");
    return;
  }

  state.user = session?.user ?? null;
  if (state.user) {
    userBar.classList.remove("hidden");
    $("user-email").textContent = state.user.email;
    authSection.classList.add("hidden");
    showWarehousePicker();
  } else {
    userBar.classList.add("hidden");
    authSection.classList.remove("hidden");
    warehouseSection.classList.add("hidden");
    appSection.classList.add("hidden");
  }
});

// ============================================================
// WAREHOUSE PICKER
// ============================================================

async function showWarehousePicker() {
  warehouseSection.classList.remove("hidden");
  appSection.classList.add("hidden");
  await loadWarehouses();
}

async function loadWarehouses() {
  const { data, error } = await supabase
    .from("user_sistimata")
    .select("role, sistimata_id, sistimata ( id, name )");

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

  const list = $("warehouse-list");
  list.innerHTML = "";

  if (state.warehouses.length === 0) {
    list.innerHTML = `<li class="list-item"><span class="meta">No warehouses yet - create one below.</span></li>`;
  }

  for (const wh of state.warehouses) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.style.cursor = "pointer";
    li.innerHTML = `
      <div class="info">
        <span class="name">${escapeHtml(wh.name)}</span>
        <span class="meta">${wh.role}</span>
      </div>
      <span>→</span>
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
  if (error) return setStatus("warehouse-status", error.message, true);
  $("new-warehouse-name").value = "";
  setStatus("warehouse-status", "");
  await loadWarehouses();
});

// ============================================================
// SUPER ADMIN: GLOBAL "ALL PARTICIPANTS" DASHBOARD
// ============================================================

$("open-super-admin").addEventListener("click", async () => {
  warehouseSection.classList.add("hidden");
  $("super-admin-section").classList.remove("hidden");

  const wSelect = $("global-member-warehouse");
  wSelect.innerHTML = state.warehouses
    .map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`)
    .join("");

  renderAllWarehousesList();
  await loadAllMembers();
});

$("back-from-super-admin").addEventListener("click", () => {
  $("super-admin-section").classList.add("hidden");
  warehouseSection.classList.remove("hidden");
});

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
// SELECTING A WAREHOUSE / MAIN APP SHELL
// ============================================================

async function selectWarehouse(wh) {
  state.currentWarehouse = wh;
  warehouseSection.classList.add("hidden");
  appSection.classList.remove("hidden");

  $("current-warehouse-name").textContent = wh.name;
  $("current-role").textContent = wh.role;
  $("nav-admin").classList.toggle("hidden", !wh.role.startsWith("admin"));

  showView("inventory");
  await loadCategories();
  await loadProducts();
}

$("back-to-warehouses").addEventListener("click", showWarehousePicker);

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

$("category-filter").addEventListener("change", loadProducts);
$("expired-only").addEventListener("change", loadProducts);
$("expired-as-of").addEventListener("change", loadProducts);

// Default the date picker to today so "show expired" works immediately
// without the user having to pick a date first.
$("expired-as-of").value = new Date().toISOString().slice(0, 10);

async function loadProducts() {
  let query = supabase
    .from("iliko")
    .select("id, name, quantity, expiration_date, category_id, categories ( name )")
    .eq("sistimata_id", state.currentWarehouse.id)
    .order("name");

  const categoryId = $("category-filter").value;
  if (categoryId) query = query.eq("category_id", categoryId);

  if ($("expired-only").checked) {
    const asOf = $("expired-as-of").value || new Date().toISOString().slice(0, 10);
    query = query.not("expiration_date", "is", null).lte("expiration_date", asOf);
  }

  const { data, error } = await query;
  if (error) return console.error(error);

  renderProducts(data || []);
}

function renderProducts(products) {
  const list = $("product-list");
  list.innerHTML = "";

  if (products.length === 0) {
    list.innerHTML = `<li class="list-item"><span class="meta">No items found.</span></li>`;
    return;
  }

  const asOf = $("expired-as-of").value || new Date().toISOString().slice(0, 10);

  for (const p of products) {
    const isExpired = p.expiration_date && p.expiration_date <= asOf;
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <div class="info">
        <span class="name">${escapeHtml(p.name)}</span>
        <span class="meta">${escapeHtml(p.categories?.name ?? "Uncategorized")}
          ${p.expiration_date ? ` · ${isExpired ? "⚠️ EXPIRED " : "exp. "}${p.expiration_date}` : ""}
        </span>
      </div>
      <div class="qty-controls">
        <button data-action="dec">−</button>
        <span>${p.quantity}</span>
        <button data-action="inc">+</button>
        <button class="btn-danger" data-action="delete">Delete</button>
      </div>
    `;
    li.querySelector('[data-action="inc"]').addEventListener("click", () => changeQuantity(p.id, p.quantity + 1));
    li.querySelector('[data-action="dec"]').addEventListener("click", () => changeQuantity(p.id, Math.max(0, p.quantity - 1)));
    li.querySelector('[data-action="delete"]').addEventListener("click", () => deleteProduct(p.id));
    list.appendChild(li);
  }
}

async function changeQuantity(id, newQty) {
  const { error } = await supabase.from("iliko").update({ quantity: newQty }).eq("id", id);
  if (error) return console.error(error);
  await loadProducts();
}

async function deleteProduct(id) {
  const { error } = await supabase.from("iliko").delete().eq("id", id);
  if (error) return console.error(error);
  await loadProducts();
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
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.toggle("success", isSuccess);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
