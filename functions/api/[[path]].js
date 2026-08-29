// Cloudflare Worker API Router using Cloudflare D1 & Worker Assets

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // Handle CORS Preflight
    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      const db = env.DB;
      if (!db) {
        return jsonResponse({ success: false, error: "Database binding DB not found. Ensure D1 binding is configured." }, 500);
      }

      // Auto-initialize D1 tables safely
      await initD1Database(db);

      // -------------------------------------------------------------
      // 1. GET /api/items (With category, brand, search, low_stock filters)
      // -------------------------------------------------------------
      if (pathname === "/api/items" && method === "GET") {
        const category = url.searchParams.get("category");
        const brand = url.searchParams.get("brand");
        const search = url.searchParams.get("search");
        const low_stock = url.searchParams.get("low_stock");

        let sql = "SELECT * FROM items WHERE 1=1";
        const params = [];

        if (category) {
          sql += " AND category = ?";
          params.push(category);
        }
        if (brand) {
          sql += " AND brand = ?";
          params.push(brand);
        }
        if (search) {
          const cleanSearch = search.trim();
          const noZeroSearch = cleanSearch.replace(/^0+/, "");
          sql += " AND (name LIKE ? OR brand LIKE ? OR unit_barcode LIKE ? OR unit_barcode LIKE ? OR case_barcode LIKE ? OR case_barcode LIKE ? OR sku LIKE ?)";
          const term = `%${cleanSearch}%`;
          const noZeroTerm = `%${noZeroSearch}%`;
          params.push(term, term, term, noZeroTerm, term, noZeroTerm, term);
        }
        if (low_stock === "true") {
          sql += " AND current_stock <= reorder_level";
        }

        sql += " ORDER BY category ASC, brand ASC, name ASC";

        const itemsRes = await db.prepare(sql).bind(...params).all();
        const items = itemsRes.results || [];

        const catRes = await db.prepare("SELECT category, COUNT(*) as count FROM items GROUP BY category ORDER BY category ASC").all();
        const categories = catRes.results || [];

        const brandRes = await db.prepare("SELECT DISTINCT brand FROM items ORDER BY brand ASC").all();
        const brands = (brandRes.results || []).map((b) => b.brand).filter(Boolean);

        const statsRes = await db.prepare(`
          SELECT 
            COUNT(*) as total_skus,
            COALESCE(SUM(current_stock), 0) as total_units,
            COALESCE(SUM(CASE WHEN current_stock <= reorder_level THEN 1 ELSE 0 END), 0) as low_stock_count,
            COALESCE(SUM(current_stock * cost_price), 0) as inventory_value
          FROM items
        `).first();

        return jsonResponse({
          success: true,
          items,
          categories,
          brands,
          stats: statsRes || { total_skus: 0, total_units: 0, low_stock_count: 0, inventory_value: 0 }
        });
      }

      // -------------------------------------------------------------
      // 2. POST /api/items (Add or Update Item)
      // -------------------------------------------------------------
      if (pathname === "/api/items" && method === "POST") {
        const body = await request.json();
        const {
          id, sku, category, brand, name, unit_barcode, case_barcode,
          is_shared_barcode, pack_size, current_stock, reorder_level,
          cost_price, retail_price
        } = body;

        const now = new Date().toISOString();

        if (id) {
          await db.prepare(`
            UPDATE items SET
              sku = ?, category = ?, brand = ?, name = ?, unit_barcode = ?, case_barcode = ?,
              is_shared_barcode = ?, pack_size = ?, current_stock = ?, reorder_level = ?,
              cost_price = ?, retail_price = ?, updated_at = ?
            WHERE id = ?
          `).bind(
            sku, category, brand, name, unit_barcode || "", case_barcode || "",
            is_shared_barcode ? 1 : 0, Number(pack_size) || 1, Number(current_stock) || 0,
            Number(reorder_level) || 5, Number(cost_price) || 0, Number(retail_price) || 0,
            now, id
          ).run();

          return jsonResponse({ success: true, message: "Item updated successfully" });
        } else {
          const generatedSku = sku || `SKU-${(category || "GS").substring(0, 2).toUpperCase()}-${Date.now().toString().slice(-4)}`;
          const insertRes = await db.prepare(`
            INSERT INTO items
            (sku, category, brand, name, unit_barcode, case_barcode, is_shared_barcode, pack_size, current_stock, reorder_level, cost_price, retail_price, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            generatedSku, category, brand, name, unit_barcode || "", case_barcode || "",
            is_shared_barcode ? 1 : 0, Number(pack_size) || 1, Number(current_stock) || 0,
            Number(reorder_level) || 5, Number(cost_price) || 0, Number(retail_price) || 0,
            now
          ).run();

          return jsonResponse({ success: true, id: insertRes.meta.last_row_id, message: "Item created successfully" });
        }
      }

      // -------------------------------------------------------------
      // 3. POST /api/items/:id/stock (Stock Adjustment)
      // -------------------------------------------------------------
      const stockMatch = pathname.match(/^\/api\/items\/(\d+)\/stock$/);
      if (stockMatch && method === "POST") {
        const id = stockMatch[1];
        const body = await request.json();
        const { change, new_stock } = body;
        const now = new Date().toISOString();

        if (new_stock !== undefined) {
          await db.prepare("UPDATE items SET current_stock = ?, updated_at = ? WHERE id = ?")
            .bind(Number(new_stock), now, id).run();
        } else if (change !== undefined) {
          await db.prepare("UPDATE items SET current_stock = MAX(0, current_stock + ?), updated_at = ? WHERE id = ?")
            .bind(Number(change), now, id).run();
        }

        const updatedItem = await db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first();
        return jsonResponse({ success: true, item: updatedItem });
      }

      // -------------------------------------------------------------
      // 4. DELETE /api/items/:id (Delete Item)
      // -------------------------------------------------------------
      const deleteMatch = pathname.match(/^\/api\/items\/(\d+)$/);
      if (deleteMatch && method === "DELETE") {
        const id = deleteMatch[1];
        await db.prepare("DELETE FROM items WHERE id = ?").bind(id).run();
        return jsonResponse({ success: true, message: "Item deleted successfully" });
      }

      // -------------------------------------------------------------
      // 5. POST /api/scan (Scan & Lookup Unit or Case Barcode)
      // -------------------------------------------------------------
      if (pathname === "/api/scan" && method === "POST") {
        const body = await request.json();
        const barcode = body.barcode;
        if (!barcode) {
          return jsonResponse({ success: false, error: "Barcode required" }, 400);
        }

        const cleanBarcode = barcode.trim();
        const noZeroBarcode = cleanBarcode.replace(/^0+/, "");

        let item = await db.prepare(
          "SELECT * FROM items WHERE unit_barcode = ? OR (unit_barcode != '' AND unit_barcode LIKE ?)"
        ).bind(cleanBarcode, `%${noZeroBarcode}`).first();
        let matchType = "unit";

        if (!item) {
          item = await db.prepare(
            "SELECT * FROM items WHERE case_barcode = ? OR (case_barcode != '' AND case_barcode LIKE ?)"
          ).bind(cleanBarcode, `%${noZeroBarcode}`).first();
          matchType = "case";
        }

        if (!item) {
          item = await db.prepare("SELECT * FROM items WHERE sku = ? OR name LIKE ? LIMIT 1")
            .bind(cleanBarcode, `%${cleanBarcode}%`).first();
          matchType = "search";
        }

        if (!item) {
          return jsonResponse({
            success: false,
            found: false,
            barcode: cleanBarcode,
            message: `No item found matching barcode '${cleanBarcode}'.`
          });
        }

        return jsonResponse({
          success: true,
          found: true,
          match_type: matchType,
          is_case_match: matchType === "case",
          is_shared_barcode: item.is_shared_barcode === 1,
          item
        });
      }

      // -------------------------------------------------------------
      // 6. POST /api/delivery (Delivery Intake)
      // -------------------------------------------------------------
      if (pathname === "/api/delivery" && method === "POST") {
        const body = await request.json();
        const { item_id, barcode_scanned, is_case_scan, cases_received, pack_multiplier, units_added } = body;

        const item = await db.prepare("SELECT * FROM items WHERE id = ?").bind(item_id).first();
        if (!item) {
          return jsonResponse({ success: false, error: "Item not found" }, 404);
        }

        const qtyToAdd = Number(units_added) || (Number(cases_received) * (Number(pack_multiplier) || item.pack_size));
        const now = new Date().toISOString();

        await db.prepare("UPDATE items SET current_stock = current_stock + ?, updated_at = ? WHERE id = ?")
          .bind(qtyToAdd, now, item_id).run();

        await db.prepare(`
          INSERT INTO deliveries (item_id, item_name, barcode_scanned, is_case_scan, cases_received, units_added, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(item_id, item.name, barcode_scanned || "", is_case_scan ? 1 : 0, Number(cases_received) || 0, qtyToAdd, now).run();

        const updatedItem = await db.prepare("SELECT * FROM items WHERE id = ?").bind(item_id).first();

        return jsonResponse({
          success: true,
          message: `Added +${qtyToAdd} units to ${item.name}. New total stock: ${updatedItem.current_stock}`,
          item: updatedItem
        });
      }

      // -------------------------------------------------------------
      // 7. POST /api/pos/upload-preview (Parse POS CSV text)
      // -------------------------------------------------------------
      if (pathname === "/api/pos/upload-preview" && method === "POST") {
        const body = await request.json();
        const csvText = body.csv_text || "";
        const filename = body.filename || "POS_Export.csv";

        if (!csvText || csvText.trim().length === 0) {
          return jsonResponse({ success: false, error: "No CSV content provided" }, 400);
        }

        const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
        if (lines.length < 2) {
          return jsonResponse({ success: false, error: "CSV file is empty or missing header" }, 400);
        }

        const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9_]/g, ""));

        const findIdx = (names) => {
          for (const n of names) {
            const idx = headers.findIndex((h) => h.includes(n));
            if (idx !== -1) return idx;
          }
          return -1;
        };

        const barcodeIdx = findIdx(["sku", "upc", "barcode", "code"]);
        const nameIdx = findIdx(["name", "itemname", "productname", "item", "description"]);
        const qtyIdx = findIdx(["quantitysoldintransaction", "quantitysold", "quantity", "qty", "sold"]);
        const priceIdx = findIdx(["actualunitprice", "normalunitretailprice", "unitprice", "retailprice", "price"]);
        const deptIdx = findIdx(["departmentname", "department", "category"]);

        const allItemsRes = await db.prepare("SELECT * FROM items").all();
        const allItems = allItemsRes.results || [];

        const barcodeMap = new Map();
        const nameMap = new Map();
        allItems.forEach((item) => {
          if (item.unit_barcode) barcodeMap.set(item.unit_barcode.trim(), item);
          if (item.case_barcode) barcodeMap.set(item.case_barcode.trim(), item);
          nameMap.set(item.name.toLowerCase().trim(), item);
        });

        const aggMap = new Map();
        for (let i = 1; i < lines.length; i++) {
          const row = parseCSVLine(lines[i]);
          if (!row || row.length === 0) continue;

          const barcodeVal = barcodeIdx !== -1 && row[barcodeIdx] ? row[barcodeIdx].replace(/['"]/g, "").trim() : "";
          const nameVal = nameIdx !== -1 && row[nameIdx] ? row[nameIdx].replace(/['"]/g, "").trim() : "";
          const qtyVal = parseFloat(row[qtyIdx] ? row[qtyIdx].replace(/['"]/g, "").trim() : "0") || 0;
          const priceVal = parseFloat(row[priceIdx] ? row[priceIdx].replace(/[\$,'"]/g, "").trim() : "0") || 0;
          const deptVal = deptIdx !== -1 && row[deptIdx] ? row[deptIdx].replace(/['"]/g, "").trim() : "";

          if (!barcodeVal && !nameVal) continue;
          const key = barcodeVal || nameVal.toLowerCase();

          if (!aggMap.has(key)) {
            aggMap.set(key, { barcode: barcodeVal, name: nameVal, qty_sold: 0, price: priceVal, department: deptVal });
          }
          const ex = aggMap.get(key);
          ex.qty_sold += qtyVal;
          if (priceVal > 0) ex.price = priceVal;
          if (!ex.name && nameVal) ex.name = nameVal;
          if (!ex.department && deptVal) ex.department = deptVal;
        }

        const sales_deductions = [];
        const price_updates = [];
        const new_items = [];

        for (const [key, record] of aggMap.entries()) {
          const { barcode, name, qty_sold, price, department } = record;
          let matched = barcodeMap.get(barcode);
          if (!matched && name) matched = nameMap.get(name.toLowerCase());

          if (matched) {
            if (qty_sold !== 0) {
              sales_deductions.push({
                item_id: matched.id,
                sku: matched.sku,
                brand: matched.brand,
                name: matched.name,
                current_stock: matched.current_stock,
                qty_sold,
                new_stock: Math.max(0, matched.current_stock - qty_sold)
              });
            }
            if (price > 0 && Math.abs(price - matched.retail_price) > 0.01) {
              price_updates.push({
                item_id: matched.id,
                sku: matched.sku,
                brand: matched.brand,
                name: matched.name,
                current_price: matched.retail_price,
                new_price: price
              });
            }
          } else {
            new_items.push({
              barcode,
              name: name || `POS Product (${barcode})`,
              price,
              qty_sold,
              category: department || "Other"
            });
          }
        }

        return jsonResponse({
          success: true,
          filename,
          diff: { sales_deductions, price_updates, new_items }
        });
      }

      // -------------------------------------------------------------
      // 8. POST /api/pos/commit (Commit POS Sync)
      // -------------------------------------------------------------
      if (pathname === "/api/pos/commit" && method === "POST") {
        const body = await request.json();
        const { filename, sales_deductions, price_updates, new_items } = body;
        const now = new Date().toISOString();

        let salesCount = 0;
        let priceCount = 0;
        let newCount = 0;

        if (Array.isArray(sales_deductions)) {
          for (const item of sales_deductions) {
            await db.prepare("UPDATE items SET current_stock = MAX(0, current_stock - ?), updated_at = ? WHERE id = ?")
              .bind(Number(item.qty_sold), now, item.item_id).run();
            salesCount += Number(item.qty_sold);
          }
        }

        if (Array.isArray(price_updates)) {
          for (const item of price_updates) {
            await db.prepare("UPDATE items SET retail_price = ?, updated_at = ? WHERE id = ?")
              .bind(Number(item.new_price), now, item.item_id).run();
            priceCount++;
          }
        }

        if (Array.isArray(new_items)) {
          for (const item of new_items) {
            const sku = `SKU-POS-${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 100)}`;
            await db.prepare(`
              INSERT INTO items (sku, category, brand, name, unit_barcode, retail_price, current_stock, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            `).bind(sku, item.category || "Other", "POS Import", item.name, item.barcode || "", Number(item.price) || 0, now).run();
            newCount++;
          }
        }

        await db.prepare(`
          INSERT INTO pos_imports (filename, total_sales_deducted, prices_updated, new_items_added, imported_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(filename || "POS_Export.csv", salesCount, priceCount, newCount, now).run();

        return jsonResponse({
          success: true,
          message: `POS Sync Complete! Deducted ${salesCount} sold items, updated ${priceCount} prices, added ${newCount} new items.`
        });
      }

      // -------------------------------------------------------------
      // 9. POST /api/audit/commit (Commit Stock Audit)
      // -------------------------------------------------------------
      if (pathname === "/api/audit/commit" && method === "POST") {
        const body = await request.json();
        const audit_counts = body.audit_counts || [];
        const now = new Date().toISOString();
        let totalAdjusted = 0;

        for (const entry of audit_counts) {
          const item = await db.prepare("SELECT * FROM items WHERE id = ?").bind(entry.item_id).first();
          if (item) {
            const counted = Number(entry.counted_stock);
            const variance = counted - item.current_stock;
            await db.prepare("UPDATE items SET current_stock = ?, updated_at = ? WHERE id = ?")
              .bind(counted, now, entry.item_id).run();
            await db.prepare(`
              INSERT INTO audit_logs (item_id, item_name, system_stock, counted_stock, variance, audited_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).bind(entry.item_id, item.name, item.current_stock, counted, variance, now).run();
            totalAdjusted++;
          }
        }

        return jsonResponse({
          success: true,
          message: `Audit committed successfully! Reconciled physical stock for ${totalAdjusted} items.`
        });
      }

      // -------------------------------------------------------------
      // 10. GET /api/logs (Fetch Logs)
      // -------------------------------------------------------------
      if (pathname === "/api/logs" && method === "GET") {
        const deliveries = (await db.prepare("SELECT * FROM deliveries ORDER BY id DESC LIMIT 50").all()).results || [];
        const audits = (await db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50").all()).results || [];
        const posImports = (await db.prepare("SELECT * FROM pos_imports ORDER BY id DESC LIMIT 50").all()).results || [];

        return jsonResponse({
          success: true,
          deliveries,
          audits,
          pos_imports: posImports
        });
      }

      // -------------------------------------------------------------
      // 11. GET /api/export/csv (Export Master Inventory CSV)
      // -------------------------------------------------------------
      if (pathname === "/api/export/csv" && method === "GET") {
        const itemsRes = await db.prepare("SELECT * FROM items ORDER BY category ASC, brand ASC, name ASC").all();
        const items = itemsRes.results || [];

        const headers = [
          "ID", "SKU", "Category", "Brand", "Item Name", "Unit Barcode (UPC)",
          "Case Barcode (Master UPC)", "Is Shared Barcode", "Pack Size", "Current Stock",
          "Reorder Level", "Cost Price ($)", "Retail Price ($)", "Last Updated"
        ];

        let csvContent = headers.join(",") + "\n";
        items.forEach((item) => {
          const row = [
            item.id,
            `"${item.sku}"`,
            `"${item.category}"`,
            `"${item.brand}"`,
            `"${(item.name || "").replace(/"/g, '""')}"`,
            `"${item.unit_barcode || ""}"`,
            `"${item.case_barcode || ""}"`,
            item.is_shared_barcode ? "YES" : "NO",
            item.pack_size,
            item.current_stock,
            item.reorder_level,
            Number(item.cost_price || 0).toFixed(2),
            Number(item.retail_price || 0).toFixed(2),
            `"${item.updated_at}"`
          ];
          csvContent += row.join(",") + "\n";
        });

        return new Response(csvContent, {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": 'attachment; filename="Convenience_Store_Inventory.csv"',
            ...corsHeaders()
          }
        });
      }

      // Fallback: If not an /api route, let Cloudflare serve static asset
      return new Response(null, { status: 404 });

    } catch (err) {
      console.error("Cloudflare Worker API Error:", err);
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }
};

// -------------------------------------------------------------
// HELPER FUNCTIONS
// -------------------------------------------------------------

async function initD1Database(db) {
  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT UNIQUE NOT NULL, category TEXT NOT NULL, brand TEXT NOT NULL, name TEXT NOT NULL, unit_barcode TEXT, case_barcode TEXT, is_shared_barcode INTEGER DEFAULT 0, pack_size INTEGER DEFAULT 1, current_stock INTEGER DEFAULT 0, reorder_level INTEGER DEFAULT 5, cost_price REAL DEFAULT 0.00, retail_price REAL DEFAULT 0.00, updated_at TEXT)").run();
    await db.prepare("CREATE TABLE IF NOT EXISTS deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, item_name TEXT, barcode_scanned TEXT, is_case_scan INTEGER, cases_received INTEGER, units_added INTEGER, received_at TEXT)").run();
    await db.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, item_name TEXT, system_stock INTEGER, counted_stock INTEGER, variance INTEGER, audited_at TEXT)").run();
    await db.prepare("CREATE TABLE IF NOT EXISTS pos_imports (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT, total_sales_deducted INTEGER, prices_updated INTEGER, new_items_added INTEGER, imported_at TEXT)").run();
  } catch (e) {
    console.log("Table init notice:", e.message);
  }
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}
