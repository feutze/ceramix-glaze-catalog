const state = {
  products: [], filtered: [], visible: 48, view: "all", search: "", sort: "name",
  filters: { manufacturer: "", line: "", type: "", cone: "", color: "", movement: "", retailer: "", size: "", minPrice: "", maxPrice: "" },
  favorites: new Set(JSON.parse(localStorage.getItem("ceramix-favorites") || "[]")),
};

const swatches = {
  "Black": "#22242b", "White/Cream": "#eee8dc", "Blue": "#2d63b8", "Green": "#3f8b68",
  "Red": "#b94539", "Orange": "#d66d32", "Yellow/Gold": "#d5aa29", "Purple": "#765293",
  "Pink": "#ce7898", "Brown/Tan": "#805b47", "Gray": "#7c8491", "Clear": "#b7dbe1",
  "Blue-Green": "#2b9b9c", "Multicolor/Effect": "#6f6a82", "Other/Mixed": "#6f6a82",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#039;",'"':"&quot;"}[char]));
const money = value => value == null ? "Price unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const safeUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch { return ""; }
};

const LIVE_SHEET = {
  id: "1HOWdQncHs3MXwd46bnF8ZyW8FgJS4eOMkHvcfwwnoVI",
  gid: "1013062471",
};

function textList(value) {
  return String(value || "").split(/\r?\n|\s*;\s*/).map(item => item.trim()).filter(Boolean);
}

function movementFor(notes) {
  const value = notes.join(" ").trim();
  if (/^stable\b/i.test(value)) return "Stable";
  if (/^runny\b/i.test(value)) return "Runny";
  if (/\bstable\b/i.test(value) && !/\b(movement|flowing|flux|fluid|runny)\b/i.test(value)) return "Stable";
  if (/\b(movement|flowing|flux|fluid|runny)\b/i.test(value)) return "Runny";
  return "";
}

function loadLiveSheet(timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const callback = `__ceramixSheet_${Date.now()}`;
    const script = document.createElement("script");
    const timer = setTimeout(() => finish(new Error("Live sheet timed out")), timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      script.remove();
      delete window[callback];
      error ? reject(error) : resolve(value);
    };
    window[callback] = response => response?.status === "error"
      ? finish(new Error("Live sheet is unavailable"))
      : finish(null, response);
    script.onerror = () => finish(new Error("Live sheet could not be loaded"));
    const query = new URLSearchParams({ gid: LIVE_SHEET.gid, headers: "1", tqx: `out:json;responseHandler:${callback}` });
    script.src = `https://docs.google.com/spreadsheets/d/${LIVE_SHEET.id}/gviz/tq?${query}`;
    document.head.append(script);
  });
}

function productsFromSheet(response) {
  const table = response?.table;
  if (!table?.cols || !table?.rows) throw new Error("Live sheet returned no inventory");
  const headers = table.cols.map(column => String(column.label || column.id || "").trim());
  const valueOf = cell => cell == null ? "" : (cell.v ?? cell.f ?? "");
  const records = table.rows.map(row => Object.fromEntries(headers.map((header, index) => [header, valueOf(row.c?.[index])])));
  const groups = new Map();

  records.forEach(record => {
    const manufacturer = String(record.Manufacturer || "").trim();
    const number = String(record["Glaze Number"] || "").trim();
    const name = String(record["Glaze Name"] || "").trim();
    if (!manufacturer || !number || !name) return;
    const key = `${manufacturer.toUpperCase()}::${number.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
    const price = Number(record["$18.00"]);
    const inventory = Number(record.Inventory);
    const notes = textList(record.Notes);
    const glazeNotes = textList(record["Glaze Notes"]);
    const candidate = {
      id: key, manufacturer, number, name,
      line: String(record["Glaze Line"] || "Line not listed").trim(),
      type: String(record["Type of Glaze"] || "Type not listed").trim(),
      cone: String(record["Cone 5–6"] || "Cone not listed").trim(),
      size: String(record.Pint || "Size not listed").trim(),
      color: String(record["Other/Mixed"] || "Other/Mixed").trim(),
      inventory: Number.isFinite(inventory) ? inventory : 0,
      inventoryLevel: null, notes, glazeNotes,
      movement: movementFor(glazeNotes), offers: [], minPrice: null,
      preferred: /^(true|yes|1)$/i.test(String(record["Show Unique"])),
    };
    const retailer = String(record.Company || "").trim();
    const url = String(record["Website Used for Sourcing"] || "").trim();
    if (retailer && (Number.isFinite(price) || safeUrl(url))) candidate.offers.push({ retailer, price: Number.isFinite(price) ? price : null, size: candidate.size, url });

    const current = groups.get(key);
    if (!current) { groups.set(key, candidate); return; }
    const currentScore = Object.values(current).filter(Boolean).length + (current.preferred ? 20 : 0);
    const candidateScore = Object.values(candidate).filter(Boolean).length + (candidate.preferred ? 20 : 0);
    const primary = candidateScore > currentScore ? candidate : current;
    const secondary = primary === candidate ? current : candidate;
    primary.offers = [...current.offers, ...candidate.offers].filter((offer, index, all) => index === all.findIndex(item => item.retailer === offer.retailer && item.url === offer.url && item.price === offer.price));
    primary.inventory = Math.max(current.inventory || 0, candidate.inventory || 0);
    primary.notes = [...new Set([...current.notes, ...candidate.notes])];
    primary.glazeNotes = [...new Set([...current.glazeNotes, ...candidate.glazeNotes])];
    primary.movement ||= secondary.movement || movementFor(primary.glazeNotes);
    groups.set(key, primary);
  });

  return [...groups.values()].map(product => {
    delete product.preferred;
    product.minPrice = product.offers.reduce((minimum, offer) => offer.price == null ? minimum : Math.min(minimum, offer.price), Infinity);
    if (!Number.isFinite(product.minPrice)) product.minPrice = null;
    return product;
  });
}

function colorFor(value) {
  if (swatches[value]) return swatches[value];
  const key = Object.keys(swatches).find(item => value?.toLowerCase().includes(item.toLowerCase()));
  return swatches[key] || swatches["Other/Mixed"];
}

function optionsFor(field) {
  const values = new Set();
  state.products.forEach(product => {
    if (field === "retailer") product.offers.forEach(offer => values.add(offer.retailer));
    else if (product[field]) values.add(product[field]);
  });
  return [...values].sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
}

function buildFilters() {
  const fields = [
    ["manufacturer", "Manufacturer"], ["line", "Glaze line"], ["type", "Type"], ["cone", "Firing cone"],
    ["color", "Color family"], ["movement", "Movement"], ["retailer", "Retailer"], ["size", "Size"],
  ];
  $("#filterFields").innerHTML = fields.map(([field,label]) => `
    <div class="filter-group"><label for="filter-${field}">${label}</label>
      <select id="filter-${field}" data-filter="${field}"><option value="">All</option>
        ${optionsFor(field).map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}
      </select>
    </div>`).join("") + `
    <div class="filter-group"><label>Price range</label><div class="price-fields">
      <input type="number" min="0" step="1" inputmode="decimal" data-filter="minPrice" placeholder="Min $" aria-label="Minimum price" />
      <input type="number" min="0" step="1" inputmode="decimal" data-filter="maxPrice" placeholder="Max $" aria-label="Maximum price" />
    </div></div>`;
  $$('[data-filter]').forEach(control => control.addEventListener("change", event => {
    state.filters[event.target.dataset.filter] = event.target.value;
    state.visible = 48;
    applyFilters();
  }));
}

function applyFilters() {
  const query = state.search.trim().toLowerCase();
  const f = state.filters;
  let products = state.products.filter(product => {
    const haystack = [product.name, product.number, product.manufacturer, product.line, product.type, product.color, product.movement, ...(product.glazeNotes || [])].join(" ").toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (state.view === "class" && product.inventory <= 0) return false;
    if (state.view === "priced" && product.minPrice == null) return false;
    if (state.view === "favorites" && !state.favorites.has(product.id)) return false;
    if (f.manufacturer && product.manufacturer !== f.manufacturer) return false;
    if (f.line && product.line !== f.line) return false;
    if (f.type && product.type !== f.type) return false;
    if (f.cone && product.cone !== f.cone) return false;
    if (f.color && product.color !== f.color) return false;
    if (f.movement && product.movement !== f.movement) return false;
    if (f.size && product.size !== f.size) return false;
    if (f.retailer && !product.offers.some(offer => offer.retailer === f.retailer)) return false;
    if (f.minPrice && (product.minPrice == null || product.minPrice < Number(f.minPrice))) return false;
    if (f.maxPrice && (product.minPrice == null || product.minPrice > Number(f.maxPrice))) return false;
    return true;
  });
  const sorters = {
    name: (a,b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    manufacturer: (a,b) => a.manufacturer.localeCompare(b.manufacturer) || a.name.localeCompare(b.name),
    "price-low": (a,b) => (a.minPrice ?? Infinity) - (b.minPrice ?? Infinity),
    "price-high": (a,b) => (b.minPrice ?? -1) - (a.minPrice ?? -1),
    inventory: (a,b) => b.inventory - a.inventory || a.name.localeCompare(b.name),
  };
  products.sort(sorters[state.sort]);
  state.filtered = products;
  renderFilters();
  renderCards();
}

function renderFilters() {
  const active = Object.entries(state.filters).filter(([,value]) => value);
  $("#filterCount").hidden = !active.length;
  $("#filterCount").textContent = active.length;
  $("#activeFilters").innerHTML = active.map(([field,value]) => `<button class="active-filter" data-remove="${field}">${escapeHtml(value)} <span>×</span></button>`).join("");
  $$('[data-remove]').forEach(button => button.addEventListener("click", () => {
    const field = button.dataset.remove;
    state.filters[field] = "";
    const control = $(`[data-filter="${field}"]`);
    if (control) control.value = "";
    applyFilters();
  }));
}

function renderCards() {
  const grid = $("#cardGrid");
  grid.innerHTML = "";
  const fragment = document.createDocumentFragment();
  state.filtered.slice(0, state.visible).forEach(product => {
    const card = $("#cardTemplate").content.firstElementChild.cloneNode(true);
    card.style.setProperty("--swatch", colorFor(product.color));
    $(".manufacturer", card).textContent = product.manufacturer;
    $(".number", card).textContent = product.number;
    $(".name", card).textContent = product.name;
    $(".line", card).textContent = product.line;
    $(".cone", card).textContent = product.cone;
    $(".size", card).textContent = product.size;
    $(".price", card).textContent = product.minPrice == null ? "Price unavailable" : `From ${money(product.minPrice)}`;
    $(".offer-count", card).textContent = product.offers.length ? `${product.offers.length} retailer ${product.offers.length === 1 ? "listing" : "listings"}` : "Class inventory only";
    const preferredOffer = product.offers.find(offer => safeUrl(offer.url));
    const buyLink = $(".card-buy", card);
    if (preferredOffer) {
      buyLink.href = safeUrl(preferredOffer.url);
      buyLink.firstChild.textContent = `Shop at ${preferredOffer.retailer} `;
      buyLink.setAttribute("aria-label", `Shop for ${product.name} at ${preferredOffer.retailer} (opens in a new tab)`);
    } else {
      buyLink.hidden = true;
    }
    const stock = $(".stock-badge", card);
    if (product.inventory > 0) { stock.classList.add("visible"); stock.textContent = `${Number(product.inventory).toLocaleString("en-US", { maximumFractionDigits: 2 })} in class`; }
    const movement = $(".movement-badge", card);
    if (product.movement) { movement.classList.add("visible", product.movement.toLowerCase()); movement.textContent = product.movement; }
    const favorite = $(".favorite-card", card);
    updateFavoriteButton(favorite, product);
    favorite.addEventListener("click", () => toggleFavorite(product.id));
    $(".card-open", card).addEventListener("click", () => openDetail(product));
    fragment.append(card);
  });
  grid.append(fragment);
  $("#resultCount").textContent = state.filtered.length.toLocaleString();
  $("#emptyState").hidden = state.filtered.length !== 0;
  $("#loadMore").hidden = state.filtered.length <= state.visible;
  $(".results").setAttribute("aria-busy", "false");
}

function updateFavoriteButton(button, product) {
  const active = state.favorites.has(product.id);
  button.classList.toggle("active", active);
  button.setAttribute("aria-label", `${active ? "Remove" : "Add"} ${product.name} ${active ? "from" : "to"} favorites`);
}

function toggleFavorite(id) {
  state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
  localStorage.setItem("ceramix-favorites", JSON.stringify([...state.favorites]));
  $("#favoriteCount").textContent = state.favorites.size;
  applyFilters();
}

function openDetail(product) {
  const glazeNotes = (product.glazeNotes || []).map(note => `<p>${escapeHtml(note)}</p>`).join("");
  const offers = product.offers.length ? product.offers.map(offer => `
    <div class="offer"><div><strong>${escapeHtml(offer.retailer)}</strong><small>${escapeHtml(offer.size || product.size)}</small></div>
      <div class="offer-right"><span class="offer-price">${money(offer.price)}</span>${safeUrl(offer.url) ? `<a href="${escapeHtml(safeUrl(offer.url))}" target="_blank" rel="noopener" aria-label="Shop for ${escapeHtml(product.name)} at ${escapeHtml(offer.retailer)} (opens in a new tab)">Shop at ${escapeHtml(offer.retailer)} <span aria-hidden="true">↗</span></a>` : ""}</div>
    </div>`).join("") : `<p>No retailer listing is attached to this class glaze.</p>`;
  $("#detailContent").innerHTML = `
    <div class="detail-hero" style="--swatch:${colorFor(product.color)}"><button class="dialog-close" aria-label="Close">×</button><div><p>${escapeHtml(product.manufacturer)} · ${escapeHtml(product.number)}</p><h2>${escapeHtml(product.name)}</h2></div></div>
    <div class="detail-body"><div class="detail-facts">
      <div class="fact"><small>Line</small><strong>${escapeHtml(product.line)}</strong></div>
      <div class="fact"><small>Type</small><strong>${escapeHtml(product.type)}</strong></div>
      <div class="fact"><small>Firing</small><strong>${escapeHtml(product.cone)}</strong></div>
      <div class="fact"><small>Color family</small><strong>${escapeHtml(product.color)}</strong></div>
      <div class="fact"><small>Movement</small><strong>${escapeHtml(product.movement || "Not classified")}</strong></div>
    </div>
    ${glazeNotes ? `<div class="glaze-notes ${product.movement?.toLowerCase() || ""}"><h3>Glaze notes</h3>${glazeNotes}</div>` : ""}
    <div class="inventory-panel"><div><p>${product.inventory > 0 ? `${product.inventory} in Artx548 class stock` : "Not currently in class stock"}</p><span>${product.inventoryLevel ? `${escapeHtml(product.inventoryLevel)} level` : "Based on the September inventory"}</span></div><strong>${escapeHtml(product.size)}</strong></div>
    <h3>Where to buy</h3><div class="offers">${offers}</div></div>`;
  $(".dialog-close", $("#detailContent")).addEventListener("click", () => $("#detailDialog").close());
  $("#detailDialog").showModal();
}

function clearFilters() {
  state.search = "";
  state.view = "all";
  state.filters = Object.fromEntries(Object.keys(state.filters).map(key => [key, ""]));
  $("#searchInput").value = "";
  $$('[data-filter]').forEach(control => control.value = "");
  $$(".chip").forEach(button => button.classList.toggle("active", button.dataset.view === "all"));
  state.visible = 48;
  applyFilters();
}

function bindEvents() {
  let searchTimer;
  $("#searchInput").addEventListener("input", event => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = event.target.value; state.visible = 48; applyFilters(); }, 90);
  });
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#searchInput").focus(); }
    if (event.key === "Escape" && $("#filters").classList.contains("open")) closeFilters();
  });
  $$(".chip").forEach(button => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    $$(".chip").forEach(item => item.classList.toggle("active", item === button));
    state.visible = 48;
    applyFilters();
  }));
  $("#favoritesButton").addEventListener("click", () => $('[data-view="favorites"]').click());
  $("#sortSelect").addEventListener("change", event => { state.sort = event.target.value; applyFilters(); });
  $("#clearFilters").addEventListener("click", clearFilters);
  $("#emptyClear").addEventListener("click", clearFilters);
  $("#loadMore").addEventListener("click", () => { state.visible += 48; renderCards(); });
  $("#filterToggle").addEventListener("click", openFilters);
  $("#closeFilters").addEventListener("click", closeFilters);
  $("#filterScrim").addEventListener("click", closeFilters);
  $("#detailDialog").addEventListener("click", event => { if (event.target === $("#detailDialog")) $("#detailDialog").close(); });
}

function openFilters() { $("#filters").classList.add("open"); $("#filterScrim").classList.add("open"); $("#filterToggle").setAttribute("aria-expanded", "true"); }
function closeFilters() { $("#filters").classList.remove("open"); $("#filterScrim").classList.remove("open"); $("#filterToggle").setAttribute("aria-expanded", "false"); }

function registerWebMCP() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const controller = new AbortController();
  const register = tool => Promise.resolve(context.registerTool(tool, { signal: controller.signal })).catch(() => {});
  register({
    name: "search_glazes",
    title: "Search glazes",
    description: "Search the current Ceramix catalog by glaze name, number, manufacturer, line, type, or color.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute(input) {
      if (!input || typeof input.query !== "string" || !input.query.trim()) throw new Error("query must be a non-empty string");
      const query = input.query.trim().toLowerCase();
      const matches = state.products.filter(product => [product.name, product.number, product.manufacturer, product.line, product.type, product.color, product.movement, ...(product.glazeNotes || [])].join(" ").toLowerCase().includes(query)).slice(0, 20);
      return { count: matches.length, glazes: matches.map(product => ({ id: product.id, name: product.name, number: product.number, manufacturer: product.manufacturer, movement: product.movement, glazeNotes: product.glazeNotes, minPrice: product.minPrice, classInventory: product.inventory })) };
    },
  });
  register({
    name: "set_glaze_favorite",
    title: "Update glaze favorite",
    description: "Add or remove one known glaze from this device's Ceramix favorites.",
    inputSchema: { type: "object", properties: { glazeId: { type: "string" }, favorite: { type: "boolean" } }, required: ["glazeId", "favorite"], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      const product = state.products.find(item => item.id === input?.glazeId);
      if (!product || typeof input.favorite !== "boolean") throw new Error("A valid glazeId and favorite boolean are required");
      input.favorite ? state.favorites.add(product.id) : state.favorites.delete(product.id);
      localStorage.setItem("ceramix-favorites", JSON.stringify([...state.favorites]));
      $("#favoriteCount").textContent = state.favorites.size;
      applyFilters();
      return { glazeId: product.id, name: product.name, favorite: input.favorite };
    },
  });
}

async function init() {
  try {
    let data;
    let live = false;
    try {
      const sheet = await loadLiveSheet();
      data = { products: productsFromSheet(sheet) };
      live = data.products.length > 0;
    } catch (liveError) {
      const response = await fetch("data.json");
      if (!response.ok) throw new Error("Inventory could not be loaded");
      data = await response.json();
    }
    state.products = data.products;
    if (live) {
      $("#updatedText").textContent = "Live inventory from Google Sheets";
    } else if (data.updated) {
      const updated = new Date(`${data.updated}T12:00:00`);
      $("#updatedText").textContent = `Inventory updated ${updated.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
    }
    $("#productTotal").textContent = data.products.length.toLocaleString();
    $("#classCount").textContent = data.products.filter(product => product.inventory > 0).length.toLocaleString();
    $("#favoriteCount").textContent = state.favorites.size;
    buildFilters(); bindEvents(); applyFilters(); registerWebMCP();
  } catch (error) {
    $("#cardGrid").innerHTML = `<div class="empty-state"><h2>Catalog unavailable</h2><p>${escapeHtml(error.message)}</p></div>`;
  }
}

let deferredInstall;
window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); deferredInstall = event; $("#installButton").hidden = false; });
$("#installButton").addEventListener("click", async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $("#installButton").hidden = true; });
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js"));
init();
