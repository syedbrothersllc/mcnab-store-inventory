// State Store
let state = {
  items: [],
  categories: [],
  brands: [],
  activeCategory: 'ALL',
  activeBrand: 'ALL',
  searchQuery: '',
  showLowStockOnly: false,
  scannedItem: null,
  scannedBarcode: '',
  scannedMatchType: 'unit',
  sharedSelectedType: 'unit', // 'unit' or 'pack'
  html5QrCode: null,
  posDiffData: null,
  auditCounts: {}
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  loadItems();
  loadLogs();
});

// Tab Switching
function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

  const activeContent = document.getElementById(tabId);
  const activeBtn = document.getElementById(`tab-btn-${tabId}`);

  if (activeContent) activeContent.classList.remove('hidden');
  if (activeBtn) activeBtn.classList.add('active');

  if (tabId === 'audit-tab') renderAuditList();
  if (tabId === 'sheets-tab') loadLogs();
}

// ------------------------------------------------------------------
// 1. INVENTORY CATALOG & FILTERS
// ------------------------------------------------------------------

async function loadItems() {
  try {
    const params = new URLSearchParams();
    if (state.activeCategory !== 'ALL') params.append('category', state.activeCategory);
    if (state.activeBrand !== 'ALL') params.append('brand', state.activeBrand);
    if (state.searchQuery) params.append('search', state.searchQuery);
    
    const lowStockCheckbox = document.getElementById('low-stock-checkbox');
    if (lowStockCheckbox && lowStockCheckbox.checked) params.append('low_stock', 'true');

    const res = await fetch(`/api/items?${params.toString()}`);
    const data = await res.json();

    if (data.success) {
      state.items = data.items;
      state.categories = data.categories;
      state.brands = data.brands;

      updateStats(data.stats);
      renderCategoryPills();
      renderBrandPills();
      renderItemsGrid();
      updateAuditCategoryDropdown();
    }
  } catch (err) {
    console.error('Error loading items:', err);
  }
}

function updateStats(stats) {
  if (!stats) return;
  document.getElementById('stat-skus').innerText = stats.total_skus || 0;
  document.getElementById('stat-units').innerText = stats.total_units || 0;
  document.getElementById('stat-low').innerText = stats.low_stock_count || 0;

  document.getElementById('mobile-stat-skus').innerText = stats.total_skus || 0;
  document.getElementById('mobile-stat-units').innerText = stats.total_units || 0;
  document.getElementById('mobile-stat-low').innerText = stats.low_stock_count || 0;
}

function renderCategoryPills() {
  const container = document.getElementById('category-pills');
  if (!container) return;

  let html = `
    <button onclick="selectCategory('ALL')" class="pill-btn ${state.activeCategory === 'ALL' ? 'active' : ''}">
      All Items
    </button>
  `;

  state.categories.forEach(c => {
    const isActive = state.activeCategory === c.category;
    html += `
      <button onclick="selectCategory('${c.category}')" class="pill-btn ${isActive ? 'active' : ''}">
        ${c.category} <span class="opacity-70 text-[10px] ml-1">(${c.count})</span>
      </button>
    `;
  });

  container.innerHTML = html;
}

function selectCategory(cat) {
  state.activeCategory = cat;
  state.activeBrand = 'ALL'; // Reset brand sub-filter when category changes
  
  const brandWrapper = document.getElementById('brand-filter-wrapper');
  if (cat !== 'ALL') {
    brandWrapper.classList.remove('hidden');
  } else {
    brandWrapper.classList.add('hidden');
  }

  loadItems();
}

function renderBrandPills() {
  const container = document.getElementById('brand-pills');
  if (!container) return;

  // Filter brands that belong to the active category
  let relevantBrands = state.brands;
  if (state.activeCategory !== 'ALL') {
    const categoryBrands = state.items.map(i => i.brand);
    relevantBrands = Array.from(new Set(categoryBrands)).sort();
  }

  let html = `
    <button onclick="selectBrand('ALL')" class="pill-btn ${state.activeBrand === 'ALL' ? 'active' : ''}">
      All Brands
    </button>
  `;

  relevantBrands.forEach(b => {
    const isActive = state.activeBrand === b;
    html += `
      <button onclick="selectBrand('${b}')" class="pill-btn ${isActive ? 'active' : ''}">
        ${b}
      </button>
    `;
  });

  container.innerHTML = html;
}

function selectBrand(brand) {
  state.activeBrand = brand;
  loadItems();
}

let searchTimer;
function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.searchQuery = document.getElementById('search-input').value.trim();
    loadItems();
  }, 250);
}

function filterLowStock() {
  switchTab('inventory-tab');
  const lowStockCheckbox = document.getElementById('low-stock-checkbox');
  if (lowStockCheckbox) {
    lowStockCheckbox.checked = true;
    loadItems();
  }
}

function resetFilters() {
  state.activeCategory = 'ALL';
  state.activeBrand = 'ALL';
  state.searchQuery = '';
  document.getElementById('search-input').value = '';
  document.getElementById('low-stock-checkbox').checked = false;
  document.getElementById('brand-filter-wrapper').classList.add('hidden');
  loadItems();
}

function renderItemsGrid() {
  const container = document.getElementById('items-container');
  if (!container) return;

  if (state.items.length === 0) {
    container.innerHTML = `
      <div class="col-span-full bg-slate-800 p-8 rounded-xl border border-slate-700 text-center text-slate-400">
        <i class="fa-solid fa-box-open text-4xl mb-3 text-slate-600"></i>
        <p class="text-sm font-medium">No inventory items found matching your filters.</p>
        <button onclick="resetFilters()" class="mt-3 text-xs bg-blue-600 text-white px-4 py-2 rounded-lg">Reset Filters</button>
      </div>
    `;
    return;
  }

  let html = '';
  state.items.forEach(item => {
    const isLow = item.current_stock <= item.reorder_level;
    const isOut = item.current_stock === 0;

    let badgeClass = 'badge-stock-ok';
    let badgeText = `${item.current_stock} in stock`;

    if (isOut) {
      badgeClass = 'badge-stock-out';
      badgeText = 'OUT OF STOCK';
    } else if (isLow) {
      badgeClass = 'badge-stock-low';
      badgeText = `LOW STOCK (${item.current_stock})`;
    }

    html += `
      <div class="bg-slate-800 p-4 rounded-xl border border-slate-700/80 shadow-md flex flex-col justify-between hover:border-slate-600 transition">
        <div>
          <!-- Header: Category & Stock Badge -->
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">${item.category} &bull; ${item.brand}</span>
            <span class="text-[11px] px-2 py-0.5 rounded font-bold ${badgeClass}">${badgeText}</span>
          </div>

          <!-- Item Name & Flavor -->
          <h3 class="font-bold text-base text-white leading-snug mb-1">${item.name}</h3>

          <!-- Details & Barcodes -->
          <div class="text-xs text-slate-400 space-y-0.5 mb-3">
            <p>SKU: <span class="text-slate-300 font-mono">${item.sku}</span></p>
            ${item.unit_barcode ? `<p>Unit UPC: <span class="text-slate-300 font-mono">${item.unit_barcode}</span></p>` : ''}
            ${item.case_barcode ? `<p>Case UPC: <span class="text-slate-300 font-mono">${item.case_barcode}</span> (Pack Qty: ${item.pack_size})</p>` : ''}
            ${item.is_shared_barcode ? `<p class="text-amber-400 font-semibold"><i class="fa-solid fa-clone mr-1"></i>Shared Barcode (Unit/Pack)</p>` : ''}
            <p class="pt-1 text-slate-300">Cash: <span class="font-bold text-emerald-400">$${item.retail_price.toFixed(2)}</span> &bull; Card (+4%): <span class="font-bold text-indigo-300">$${(item.retail_price * 1.04).toFixed(2)}</span></p>
            <p class="text-[11px] text-slate-400">Unit Cost: $${item.cost_price.toFixed(2)}</p>
          </div>
        </div>

        <!-- Quick Stock Adjust Controls -->
        <div class="pt-3 border-t border-slate-700/80 flex items-center justify-between">
          <div class="flex items-center space-x-1.5 bg-slate-900 p-1 rounded-lg border border-slate-700">
            <button onclick="adjustStock(${item.id}, -1)" class="w-7 h-7 bg-slate-800 hover:bg-slate-700 text-white rounded font-bold text-sm flex items-center justify-center transition">
              -
            </button>
            <span class="w-10 text-center font-bold text-sm text-blue-400">${item.current_stock}</span>
            <button onclick="adjustStock(${item.id}, 1)" class="w-7 h-7 bg-slate-800 hover:bg-slate-700 text-white rounded font-bold text-sm flex items-center justify-center transition">
              +
            </button>
          </div>

          <div class="flex space-x-1.5">
            <button onclick="quickReceiveModal(${item.id})" title="Receive Delivery" class="bg-emerald-950/80 hover:bg-emerald-900 text-emerald-400 border border-emerald-800 text-xs px-2.5 py-1.5 rounded-lg font-medium transition">
              <i class="fa-solid fa-truck-ramp-box mr-1"></i>Receive
            </button>
            <button onclick="openEditModal(${item.id})" title="Edit Item" class="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs px-2 py-1.5 rounded-lg transition">
              <i class="fa-solid fa-pen"></i>
            </button>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

async function adjustStock(id, change) {
  try {
    const res = await fetch(`/api/items/${id}/stock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ change })
    });
    const data = await res.json();
    if (data.success) {
      loadItems();
    }
  } catch (err) {
    console.error('Error adjusting stock:', err);
  }
}

// ------------------------------------------------------------------
// 2. SCAN & RECEIVE MODE (Camera Scanner & Case Barcodes)
// ------------------------------------------------------------------

function startScanner() {
  const placeholder = document.getElementById('scanner-placeholder');
  const controls = document.getElementById('scanner-controls');

  if (placeholder) placeholder.classList.add('hidden');
  if (controls) controls.classList.remove('hidden');

  if (!state.html5QrCode) {
    state.html5QrCode = new Html5Qrcode("reader");
  }

  const config = { fps: 10, qrbox: { width: 250, height: 150 } };

  state.html5QrCode.start(
    { facingMode: "environment" },
    config,
    (decodedText) => {
      // Barcode scanned successfully!
      handleScannedBarcode(decodedText);
      stopScanner();
    },
    (errorMessage) => {
      // Ignore scan error logs
    }
  ).catch(err => {
    console.error('Camera access error:', err);
    alert('Could not access phone camera. Please check camera permissions or use manual entry below.');
    stopScanner();
  });
}

function stopScanner() {
  if (state.html5QrCode && state.html5QrCode.isScanning) {
    state.html5QrCode.stop().then(() => {
      document.getElementById('scanner-placeholder').classList.remove('hidden');
      document.getElementById('scanner-controls').classList.add('hidden');
    });
  }
}

function lookupManualBarcode() {
  const barcode = document.getElementById('manual-barcode-input').value.trim();
  if (barcode) {
    handleScannedBarcode(barcode);
  }
}

async function handleScannedBarcode(barcode) {
  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode })
    });
    const data = await res.json();

    if (data.success && data.found) {
      renderScanResult(data);
    } else {
      alert(`No matching item found for barcode '${barcode}'. You can add a new SKU with this barcode.`);
      openModal('add-item-modal');
      document.getElementById('form-unit-barcode').value = barcode;
    }
  } catch (err) {
    console.error('Error scanning barcode:', err);
  }
}

function renderScanResult(data) {
  state.scannedItem = data.item;
  state.scannedBarcode = data.barcode || data.item.unit_barcode;
  state.scannedMatchType = data.match_type;
  state.sharedSelectedType = 'unit';

  const card = document.getElementById('scan-result-card');
  card.classList.remove('hidden');

  document.getElementById('scan-item-name').innerText = data.item.name;
  document.getElementById('scan-item-brand').innerText = `${data.item.category} • ${data.item.brand}`;
  document.getElementById('scan-item-stock').innerText = data.item.current_stock;

  // Populate Cash, Card (+4%), and Cost Prices
  const retailPrice = data.item.retail_price || 0;
  const cardPrice = retailPrice * 1.04;
  const costPrice = data.item.cost_price || 0;

  const cashEl = document.getElementById('scan-cash-price');
  const cardEl = document.getElementById('scan-card-price');
  const costEl = document.getElementById('scan-cost-price');

  if (cashEl) cashEl.innerText = `$${retailPrice.toFixed(2)}`;
  if (cardEl) cardEl.innerText = `$${cardPrice.toFixed(2)}`;
  if (costEl) costEl.innerText = `$${costPrice.toFixed(2)}`;

  const matchBadge = document.getElementById('scan-match-badge');
  const sharedSelector = document.getElementById('shared-barcode-selector');
  const caseInfo = document.getElementById('case-barcode-info');
  const qtyTypeLabel = document.getElementById('label-qty-type');

  // Reset displays
  sharedSelector.classList.add('hidden');
  caseInfo.classList.add('hidden');

  if (data.is_shared_barcode) {
    // Shared Barcode Detected (Single vs Pack)
    sharedSelector.classList.remove('hidden');
    document.getElementById('shared-pack-qty-label').innerText = data.item.pack_size;
    matchBadge.innerText = 'Shared Barcode Item';
    matchBadge.className = 'bg-amber-900/60 text-amber-300 text-xs px-2 py-0.5 rounded border border-amber-700 uppercase font-semibold';
    selectSharedType('unit');
  } else if (data.is_case_match) {
    // Wholesale Case Barcode Detected
    caseInfo.classList.remove('hidden');
    document.getElementById('case-pack-size').innerText = data.item.pack_size;
    matchBadge.innerText = 'Wholesale Case Barcode';
    matchBadge.className = 'bg-blue-900/60 text-blue-300 text-xs px-2 py-0.5 rounded border border-blue-700 uppercase font-semibold';
    qtyTypeLabel.innerText = 'Cases Received:';
  } else {
    // Regular Unit UPC Barcode
    matchBadge.innerText = 'Unit Barcode';
    matchBadge.className = 'bg-emerald-900/60 text-emerald-300 text-xs px-2 py-0.5 rounded border border-emerald-700 uppercase font-semibold';
    qtyTypeLabel.innerText = 'Units Received:';
  }

  document.getElementById('input-cases-received').value = 1;
  calculateTotalIntake();
  card.scrollIntoView({ behavior: 'smooth' });
}

function selectSharedType(type) {
  state.sharedSelectedType = type;

  const btnUnit = document.getElementById('btn-shared-unit');
  const btnPack = document.getElementById('btn-shared-pack');
  const qtyTypeLabel = document.getElementById('label-qty-type');

  if (type === 'unit') {
    btnUnit.className = 'bg-amber-600 text-white text-xs py-2 rounded font-bold border border-amber-500 shadow';
    btnPack.className = 'bg-slate-700 text-slate-300 text-xs py-2 rounded font-medium border border-slate-600';
    qtyTypeLabel.innerText = 'Units Received:';
  } else {
    btnPack.className = 'bg-amber-600 text-white text-xs py-2 rounded font-bold border border-amber-500 shadow';
    btnUnit.className = 'bg-slate-700 text-slate-300 text-xs py-2 rounded font-medium border border-slate-600';
    qtyTypeLabel.innerText = `Packs (${state.scannedItem.pack_size}-Pks) Received:`;
  }

  calculateTotalIntake();
}

function calculateTotalIntake() {
  if (!state.scannedItem) return;

  const inputCases = parseFloat(document.getElementById('input-cases-received').value) || 0;
  let totalUnitsAdded = 0;

  if (state.scannedItem.is_shared_barcode) {
    if (state.sharedSelectedType === 'pack') {
      totalUnitsAdded = inputCases * state.scannedItem.pack_size;
    } else {
      totalUnitsAdded = inputCases;
    }
  } else if (state.scannedMatchType === 'case') {
    totalUnitsAdded = inputCases * state.scannedItem.pack_size;
  } else {
    totalUnitsAdded = inputCases;
  }

  document.getElementById('calculated-units-display').innerText = `+${totalUnitsAdded} units`;
}

async function commitDeliveryReceive() {
  if (!state.scannedItem) return;

  const inputCases = parseFloat(document.getElementById('input-cases-received').value) || 0;
  let totalUnitsAdded = 0;

  if (state.scannedItem.is_shared_barcode) {
    totalUnitsAdded = state.sharedSelectedType === 'pack' ? inputCases * state.scannedItem.pack_size : inputCases;
  } else if (state.scannedMatchType === 'case') {
    totalUnitsAdded = inputCases * state.scannedItem.pack_size;
  } else {
    totalUnitsAdded = inputCases;
  }

  try {
    const res = await fetch('/api/delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_id: state.scannedItem.id,
        barcode_scanned: state.scannedBarcode,
        is_case_scan: state.scannedMatchType === 'case',
        cases_received: inputCases,
        units_added: totalUnitsAdded
      })
    });
    const data = await res.json();

    if (data.success) {
      alert(`Success! ${data.message}`);
      document.getElementById('scan-result-card').classList.add('hidden');
      state.scannedItem = null;
      loadItems();
    }
  } catch (err) {
    console.error('Error committing delivery:', err);
  }
}

function quickReceiveModal(itemId) {
  const item = state.items.find(i => i.id === itemId);
  if (item) {
    switchTab('scan-tab');
    renderScanResult({
      item,
      barcode: item.case_barcode || item.unit_barcode,
      match_type: item.case_barcode ? 'case' : 'unit',
      is_case_match: !!item.case_barcode,
      is_shared_barcode: item.is_shared_barcode === 1
    });
  }
}

// ------------------------------------------------------------------
// 3. POS SALES CSV IMPORT & DIFF REVIEW
// ------------------------------------------------------------------

async function handlePOSFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('pos_file', file);

  try {
    const res = await fetch('/api/pos/upload-preview', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.success) {
      state.posDiffData = data;
      renderPOSDiffReview(data);
    } else {
      alert(`Error parsing POS CSV: ${data.error}`);
    }
  } catch (err) {
    console.error('Error uploading POS file:', err);
  }
}

function renderPOSDiffReview(data) {
  const container = document.getElementById('pos-diff-container');
  container.classList.remove('hidden');
  document.getElementById('pos-filename-display').innerText = `File: ${data.filename}`;

  const { sales_deductions, price_updates, new_items } = data.diff;

  // 1. Sales Deductions
  document.getElementById('count-sales-deductions').innerText = sales_deductions.length;
  const salesTbody = document.getElementById('pos-sales-tbody');
  let salesHtml = '';
  sales_deductions.forEach(item => {
    salesHtml += `
      <tr>
        <td class="p-2 font-medium text-white">${item.name} <span class="text-[10px] text-slate-400 block">${item.brand}</span></td>
        <td class="p-2 text-center text-slate-300">${item.current_stock}</td>
        <td class="p-2 text-center text-rose-400 font-bold">-${item.qty_sold}</td>
        <td class="p-2 text-center text-emerald-400 font-bold">${item.new_stock}</td>
      </tr>
    `;
  });
  salesTbody.innerHTML = salesHtml || '<tr><td colspan="4" class="p-3 text-center text-slate-500">No matching sales deductions found.</td></tr>';

  // 2. Price Updates (Yellow Highlight)
  document.getElementById('count-price-updates').innerText = price_updates.length;
  const pricesTbody = document.getElementById('pos-prices-tbody');
  let pricesHtml = '';
  price_updates.forEach((item, idx) => {
    pricesHtml += `
      <tr class="bg-amber-950/30">
        <td class="p-2 text-center">
          <input type="checkbox" checked id="pos-price-check-${idx}" data-idx="${idx}" class="pos-price-checkbox rounded text-amber-500 bg-slate-900 border-amber-700">
        </td>
        <td class="p-2 font-medium text-amber-100">${item.name}</td>
        <td class="p-2 text-center text-slate-400">$${item.current_price.toFixed(2)}</td>
        <td class="p-2 text-center text-amber-300 font-bold">$${item.new_price.toFixed(2)}</td>
      </tr>
    `;
  });
  pricesTbody.innerHTML = pricesHtml || '<tr><td colspan="4" class="p-3 text-center text-slate-500">No price updates detected.</td></tr>';

  // 3. New Items Found (Green Highlight)
  document.getElementById('count-new-items').innerText = new_items.length;
  const newTbody = document.getElementById('pos-new-tbody');
  let newHtml = '';
  new_items.forEach((item, idx) => {
    newHtml += `
      <tr class="bg-emerald-950/30">
        <td class="p-2 text-center">
          <input type="checkbox" checked id="pos-new-check-${idx}" data-idx="${idx}" class="pos-new-checkbox rounded text-emerald-500 bg-slate-900 border-emerald-700">
        </td>
        <td class="p-2 font-medium text-emerald-100">${item.name}</td>
        <td class="p-2 text-slate-300 font-mono text-[10px]">${item.barcode || 'N/A'}</td>
        <td class="p-2 text-right font-bold text-emerald-300">$${item.price.toFixed(2)}</td>
      </tr>
    `;
  });
  newTbody.innerHTML = newHtml || '<tr><td colspan="4" class="p-3 text-center text-slate-500">No new items found in POS file.</td></tr>';

  container.scrollIntoView({ behavior: 'smooth' });
}

function cancelPOSReview() {
  document.getElementById('pos-diff-container').classList.add('hidden');
  document.getElementById('pos-file-input').value = '';
  state.posDiffData = null;
}

async function commitPOSImport() {
  if (!state.posDiffData) return;

  const { sales_deductions, price_updates, new_items } = state.posDiffData.diff;

  // Filter price updates approved by checkboxes
  const approvedPrices = price_updates.filter((_, idx) => {
    const el = document.getElementById(`pos-price-check-${idx}`);
    return el && el.checked;
  });

  // Filter new items approved by checkboxes
  const approvedNewItems = new_items.filter((_, idx) => {
    const el = document.getElementById(`pos-new-check-${idx}`);
    return el && el.checked;
  });

  try {
    const res = await fetch('/api/pos/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: state.posDiffData.filename,
        sales_deductions,
        price_updates: approvedPrices,
        new_items: approvedNewItems
      })
    });
    const data = await res.json();

    if (data.success) {
      alert(`POS Import Complete! ${data.message}`);
      cancelPOSReview();
      loadItems();
    }
  } catch (err) {
    console.error('Error committing POS import:', err);
  }
}

// ------------------------------------------------------------------
// 4. STOCK AUDIT MODE
// ------------------------------------------------------------------

function updateAuditCategoryDropdown() {
  const select = document.getElementById('audit-category-select');
  if (!select) return;

  let html = '<option value="ALL">All Categories</option>';
  state.categories.forEach(c => {
    html += `<option value="${c.category}">${c.category}</option>`;
  });
  select.innerHTML = html;
}

function renderAuditList() {
  const tbody = document.getElementById('audit-tbody');
  const catFilter = document.getElementById('audit-category-select').value;

  let filtered = state.items;
  if (catFilter !== 'ALL') {
    filtered = state.items.filter(i => i.category === catFilter);
  }

  let html = '';
  filtered.forEach(item => {
    const countedVal = state.auditCounts[item.id] !== undefined ? state.auditCounts[item.id] : item.current_stock;
    const variance = countedVal - item.current_stock;

    let varClass = 'text-slate-400';
    if (variance < 0) varClass = 'text-rose-400 font-bold';
    if (variance > 0) varClass = 'text-emerald-400 font-bold';

    html += `
      <tr>
        <td class="p-3 font-semibold text-slate-300">${item.category} <span class="text-slate-400 text-xs font-normal block">${item.brand}</span></td>
        <td class="p-3 font-medium text-white">${item.name}</td>
        <td class="p-3 text-center text-blue-400 font-bold">${item.current_stock}</td>
        <td class="p-3 text-center">
          <input type="number" value="${countedVal}" min="0" onchange="updateAuditCount(${item.id}, this.value)"
                 class="w-20 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-center text-white font-bold focus:border-purple-500">
        </td>
        <td id="audit-var-${item.id}" class="p-3 text-center ${varClass}">
          ${variance > 0 ? '+' + variance : variance}
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html || '<tr><td colspan="5" class="p-4 text-center text-slate-500">No items to audit.</td></tr>';
}

function updateAuditCount(itemId, val) {
  const count = parseInt(val) || 0;
  state.auditCounts[itemId] = count;

  const item = state.items.find(i => i.id === itemId);
  if (item) {
    const variance = count - item.current_stock;
    const varEl = document.getElementById(`audit-var-${itemId}`);
    if (varEl) {
      let varClass = 'text-slate-400';
      if (variance < 0) varClass = 'text-rose-400 font-bold';
      if (variance > 0) varClass = 'text-emerald-400 font-bold';
      varEl.className = `p-3 text-center ${varClass}`;
      varEl.innerText = variance > 0 ? `+${variance}` : variance;
    }
  }
}

async function commitAuditReconciliation() {
  const auditEntries = Object.keys(state.auditCounts).map(id => ({
    item_id: parseInt(id),
    counted_stock: state.auditCounts[id]
  }));

  if (auditEntries.length === 0) {
    alert('Please enter at least one physical audit count before committing.');
    return;
  }

  try {
    const res = await fetch('/api/audit/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audit_counts: auditEntries })
    });
    const data = await res.json();

    if (data.success) {
      alert(`Audit Complete! ${data.message}`);
      state.auditCounts = {};
      loadItems();
    }
  } catch (err) {
    console.error('Error committing audit:', err);
  }
}

// ------------------------------------------------------------------
// 5. LOGS & SHEETS
// ------------------------------------------------------------------

async function loadLogs() {
  try {
    const res = await fetch('/api/logs');
    const data = await res.json();

    if (data.success) {
      // Deliveries
      const delTbody = document.getElementById('log-deliveries-tbody');
      let delHtml = '';
      data.deliveries.forEach(d => {
        delHtml += `
          <tr>
            <td class="p-2 text-slate-400">${new Date(d.received_at).toLocaleDateString()} ${new Date(d.received_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
            <td class="p-2 font-medium text-white">${d.item_name}</td>
            <td class="p-2 text-center text-slate-300">${d.cases_received}</td>
            <td class="p-2 text-center font-bold text-emerald-400">+${d.units_added}</td>
          </tr>
        `;
      });
      delTbody.innerHTML = delHtml || '<tr><td colspan="4" class="p-3 text-center text-slate-500">No delivery logs recorded yet.</td></tr>';

      // Audits
      const audTbody = document.getElementById('log-audits-tbody');
      let audHtml = '';
      data.audits.forEach(a => {
        const varClass = a.variance < 0 ? 'text-rose-400 font-bold' : (a.variance > 0 ? 'text-emerald-400 font-bold' : 'text-slate-400');
        audHtml += `
          <tr>
            <td class="p-2 text-slate-400">${new Date(a.audited_at).toLocaleDateString()} ${new Date(a.audited_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
            <td class="p-2 font-medium text-white">${a.item_name}</td>
            <td class="p-2 text-center text-slate-300">${a.system_stock}</td>
            <td class="p-2 text-center text-blue-400 font-bold">${a.counted_stock}</td>
            <td class="p-2 text-center ${varClass}">${a.variance > 0 ? '+' + a.variance : a.variance}</td>
          </tr>
        `;
      });
      audTbody.innerHTML = audHtml || '<tr><td colspan="5" class="p-3 text-center text-slate-500">No stock audit logs recorded yet.</td></tr>';
    }
  } catch (err) {
    console.error('Error loading logs:', err);
  }
}

// ------------------------------------------------------------------
// MODAL & ITEM FORM HELPERS
// ------------------------------------------------------------------

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  if (id === 'add-item-modal') {
    document.getElementById('item-form').reset();
    document.getElementById('form-id').value = '';
    document.getElementById('modal-title').innerText = 'Add New Inventory SKU';
  }
}

function openEditModal(itemId) {
  const item = state.items.find(i => i.id === itemId);
  if (!item) return;

  document.getElementById('form-id').value = item.id;
  document.getElementById('form-category').value = item.category;
  document.getElementById('form-brand').value = item.brand;
  document.getElementById('form-name').value = item.name;
  document.getElementById('form-unit-barcode').value = item.unit_barcode || '';
  document.getElementById('form-case-barcode').value = item.case_barcode || '';
  document.getElementById('form-pack-size').value = item.pack_size || 10;
  document.getElementById('form-shared-barcode').checked = item.is_shared_barcode === 1;
  document.getElementById('form-current-stock').value = item.current_stock;
  document.getElementById('form-reorder-level').value = item.reorder_level;
  document.getElementById('form-cost-price').value = item.cost_price;
  document.getElementById('form-retail-price').value = item.retail_price;

  document.getElementById('modal-title').innerText = 'Edit Inventory SKU';
  openModal('add-item-modal');
}

async function saveItem(event) {
  event.preventDefault();

  const id = document.getElementById('form-id').value;
  const payload = {
    id: id ? parseInt(id) : undefined,
    category: document.getElementById('form-category').value.trim(),
    brand: document.getElementById('form-brand').value.trim(),
    name: document.getElementById('form-name').value.trim(),
    unit_barcode: document.getElementById('form-unit-barcode').value.trim(),
    case_barcode: document.getElementById('form-case-barcode').value.trim(),
    pack_size: parseInt(document.getElementById('form-pack-size').value) || 1,
    is_shared_barcode: document.getElementById('form-shared-barcode').checked ? 1 : 0,
    current_stock: parseInt(document.getElementById('form-current-stock').value) || 0,
    reorder_level: parseInt(document.getElementById('form-reorder-level').value) || 5,
    cost_price: parseFloat(document.getElementById('form-cost-price').value) || 0,
    retail_price: parseFloat(document.getElementById('form-retail-price').value) || 0
  };

  try {
    const res = await fetch('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      closeModal('add-item-modal');
      loadItems();
    } else {
      alert(`Error saving item: ${data.error}`);
    }
  } catch (err) {
    console.error('Error saving item:', err);
  }
}

// Upload & Import Full Pricebook CSV
async function uploadFullPricebook(event) {
  const file = event.target.files[0];
  if (!file) return;

  const wrapper = document.getElementById('pricebook-progress-wrapper');
  const spinner = document.getElementById('pricebook-spinner');
  const statusText = document.getElementById('pricebook-status-text');
  const statusSubtext = document.getElementById('pricebook-status-subtext');
  const uploadBtn = document.getElementById('btn-upload-pricebook');

  if (wrapper) wrapper.classList.remove('hidden');
  if (spinner) spinner.classList.remove('hidden');
  if (statusText) {
    statusText.innerText = `Uploading & Processing '${file.name}'...`;
    statusText.className = 'font-bold text-slate-200';
  }
  if (statusSubtext) statusSubtext.innerText = 'Parsing SKUs, barcodes, departments, and prices...';
  if (uploadBtn) uploadBtn.disabled = true;

  const formData = new FormData();
  formData.append('pricebook_file', file);

  try {
    const res = await fetch('/api/pricebook/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.success) {
      if (spinner) spinner.classList.add('hidden');
      if (statusText) {
        statusText.innerText = '✅ Pricebook Import Complete!';
        statusText.className = 'font-bold text-emerald-400';
      }
      if (statusSubtext) statusSubtext.innerText = data.message;
      alert(`🎉 ${data.message}`);
      loadItems();
    } else {
      if (spinner) spinner.classList.add('hidden');
      if (statusText) {
        statusText.innerText = '❌ Import Failed';
        statusText.className = 'font-bold text-rose-400';
      }
      if (statusSubtext) statusSubtext.innerText = data.error || 'Failed to parse file';
      alert(`Error importing Pricebook: ${data.error}`);
    }
  } catch (err) {
    console.error('Error uploading pricebook:', err);
    if (spinner) spinner.classList.add('hidden');
    if (statusText) {
      statusText.innerText = '❌ Upload Error';
      statusText.className = 'font-bold text-rose-400';
    }
    if (statusSubtext) statusSubtext.innerText = 'Network error during upload.';
  } finally {
    if (uploadBtn) uploadBtn.disabled = false;
    document.getElementById('pricebook-file-input').value = '';
  }
}
