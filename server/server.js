const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files from client folder
app.use(express.static(path.join(__dirname, '..', 'client')));

// Multer setup for CSV file uploads
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// -------------------------------------------------------------
// REST API ENDPOINTS
// -------------------------------------------------------------

// 1. Get Items List (with filters for Category, Brand, Search, Low Stock)
app.get('/api/items', (req, res) => {
  try {
    const { category, brand, search, low_stock } = req.query;
    let sql = 'SELECT * FROM items WHERE 1=1';
    const params = [];

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (brand) {
      sql += ' AND brand = ?';
      params.push(brand);
    }
    if (search) {
      const cleanSearch = search.trim();
      const noZeroSearch = cleanSearch.replace(/^0+/, '');
      sql += ' AND (name LIKE ? OR brand LIKE ? OR unit_barcode LIKE ? OR LTRIM(unit_barcode, \'0\') LIKE ? OR case_barcode LIKE ? OR LTRIM(case_barcode, \'0\') LIKE ? OR sku LIKE ?)';
      const term = `%${cleanSearch}%`;
      const noZeroTerm = `%${noZeroSearch}%`;
      params.push(term, term, term, noZeroTerm, term, noZeroTerm, term);
    }
    if (low_stock === 'true') {
      sql += ' AND current_stock <= reorder_level';
    }

    sql += ' ORDER BY category ASC, brand ASC, name ASC';

    const stmt = db.prepare(sql);
    const items = stmt.all(...params);

    // Fetch categories and brand breakdown for filter UI
    const catStmt = db.prepare('SELECT category, COUNT(*) as count FROM items GROUP BY category ORDER BY category ASC');
    const categories = catStmt.all();

    const brandStmt = db.prepare('SELECT DISTINCT brand FROM items ORDER BY brand ASC');
    const brands = brandStmt.all().map(b => b.brand);

    // Fetch total summary stats
    const statsStmt = db.prepare(`
      SELECT 
        COUNT(*) as total_skus,
        SUM(current_stock) as total_units,
        SUM(CASE WHEN current_stock <= reorder_level THEN 1 ELSE 0 END) as low_stock_count,
        SUM(current_stock * cost_price) as inventory_value
      FROM items
    `);
    const stats = statsStmt.get();

    res.json({
      success: true,
      items,
      categories,
      brands,
      stats
    });
  } catch (error) {
    console.error('Error fetching items:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Add or Update Item
app.post('/api/items', (req, res) => {
  try {
    const {
      id, sku, category, brand, name, unit_barcode, case_barcode,
      is_shared_barcode, pack_size, current_stock, reorder_level,
      cost_price, retail_price
    } = req.body;

    const now = new Date().toISOString();

    if (id) {
      // Update existing item
      const stmt = db.prepare(`
        UPDATE items SET
          sku = ?, category = ?, brand = ?, name = ?, unit_barcode = ?, case_barcode = ?,
          is_shared_barcode = ?, pack_size = ?, current_stock = ?, reorder_level = ?,
          cost_price = ?, retail_price = ?, updated_at = ?
        WHERE id = ?
      `);
      stmt.run(
        sku, category, brand, name, unit_barcode || '', case_barcode || '',
        is_shared_barcode ? 1 : 0, Number(pack_size) || 1, Number(current_stock) || 0,
        Number(reorder_level) || 5, Number(cost_price) || 0, Number(retail_price) || 0,
        now, id
      );
      res.json({ success: true, message: 'Item updated successfully' });
    } else {
      // Create new item
      const generatedSku = sku || `SKU-${category.substring(0, 2).toUpperCase()}-${Date.now().toString().slice(-4)}`;
      const stmt = db.prepare(`
        INSERT INTO items
        (sku, category, brand, name, unit_barcode, case_barcode, is_shared_barcode, pack_size, current_stock, reorder_level, cost_price, retail_price, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(
        generatedSku, category, brand, name, unit_barcode || '', case_barcode || '',
        is_shared_barcode ? 1 : 0, Number(pack_size) || 1, Number(current_stock) || 0,
        Number(reorder_level) || 5, Number(cost_price) || 0, Number(retail_price) || 0,
        now
      );
      res.json({ success: true, id: info.lastInsertRowid, message: 'Item created successfully' });
    }
  } catch (error) {
    console.error('Error saving item:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Quick Stock Adjustment (+1 / -1 / set)
app.post('/api/items/:id/stock', (req, res) => {
  try {
    const { id } = req.params;
    const { change, new_stock } = req.body;
    const now = new Date().toISOString();

    if (new_stock !== undefined) {
      const stmt = db.prepare('UPDATE items SET current_stock = ?, updated_at = ? WHERE id = ?');
      stmt.run(Number(new_stock), now, id);
    } else if (change !== undefined) {
      const stmt = db.prepare('UPDATE items SET current_stock = MAX(0, current_stock + ?), updated_at = ? WHERE id = ?');
      stmt.run(Number(change), now, id);
    }

    const updatedItem = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    res.json({ success: true, item: updatedItem });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete Item
app.delete('/api/items/:id', (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM items WHERE id = ?');
    stmt.run(req.params.id);
    res.json({ success: true, message: 'Item deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Scan & Lookup Item (Handles Unit UPC, Case UPC, Shared UPC & Leading Zero stripping)
app.post('/api/scan', (req, res) => {
  try {
    const { barcode } = req.body;
    if (!barcode) {
      return res.status(400).json({ success: false, error: 'Barcode required' });
    }

    const cleanBarcode = barcode.trim();
    const noZeroBarcode = cleanBarcode.replace(/^0+/, '');

    // 1. Try Unit Barcode match (exact or stripped leading zeros)
    let stmt = db.prepare("SELECT * FROM items WHERE unit_barcode = ? OR (unit_barcode != '' AND LTRIM(unit_barcode, '0') = ?)");
    let item = stmt.get(cleanBarcode, noZeroBarcode);
    let matchType = 'unit';

    // 2. Try Case Barcode match if no unit barcode match
    if (!item) {
      stmt = db.prepare("SELECT * FROM items WHERE case_barcode = ? OR (case_barcode != '' AND LTRIM(case_barcode, '0') = ?)");
      item = stmt.get(cleanBarcode, noZeroBarcode);
      matchType = 'case';
    }

    // 3. Try partial SKU or Name fallback search if exact barcode match fails
    if (!item) {
      stmt = db.prepare('SELECT * FROM items WHERE sku = ? OR name LIKE ? LIMIT 1');
      item = stmt.get(cleanBarcode, `%${cleanBarcode}%`);
      matchType = 'search';
    }

    if (!item) {
      return res.json({
        success: false,
        found: false,
        barcode: cleanBarcode,
        message: `No item found matching barcode '${cleanBarcode}'.`
      });
    }

    res.json({
      success: true,
      found: true,
      match_type: matchType,
      is_case_match: matchType === 'case',
      is_shared_barcode: item.is_shared_barcode === 1,
      item
    });
  } catch (error) {
    console.error('Error processing scan:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Process Delivery Intake (Case & Shared Barcode Multipliers)
app.post('/api/delivery', (req, res) => {
  try {
    const { item_id, barcode_scanned, is_case_scan, cases_received, pack_multiplier, units_added } = req.body;

    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(item_id);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }

    const qtyToAdd = Number(units_added) || (Number(cases_received) * (Number(pack_multiplier) || item.pack_size));
    const now = new Date().toISOString();

    // Update item stock
    const updateStmt = db.prepare('UPDATE items SET current_stock = current_stock + ?, updated_at = ? WHERE id = ?');
    updateStmt.run(qtyToAdd, now, item_id);

    // Record delivery log
    const logStmt = db.prepare(`
      INSERT INTO deliveries (item_id, item_name, barcode_scanned, is_case_scan, cases_received, units_added, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    logStmt.run(item_id, item.name, barcode_scanned || '', is_case_scan ? 1 : 0, Number(cases_received) || 0, qtyToAdd, now);

    const updatedItem = db.prepare('SELECT * FROM items WHERE id = ?').get(item_id);

    res.json({
      success: true,
      message: `Added +${qtyToAdd} units to ${item.name}. New total stock: ${updatedItem.current_stock}`,
      item: updatedItem
    });
  } catch (error) {
    console.error('Error processing delivery:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. POS CSV Upload & Diff Preview Generation
app.post('/api/pos/upload-preview', upload.single('pos_file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No CSV file uploaded' });
    }

    const filePath = req.file.path;
    const fileContent = fs.readFileSync(filePath, 'utf8');

    // Parse CSV lines
    const lines = fileContent.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length < 2) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ success: false, error: 'CSV file is empty or missing header' });
    }

    // Helper to parse CSV line respecting quotes
    const parseCSVLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    };

    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, ''));
    
    // Helper to find column index cleanly (Exact match first, then partial match excluding ignore keywords)
    const findColumnIndex = (headers, candidateNames, ignoreKeywords = ['store', 'register', 'department', 'vendor', 'customer']) => {
      const cleanHeaders = headers.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
      
      // 1. Try exact match first
      for (const cand of candidateNames) {
        const cleanCand = cand.toLowerCase().replace(/[^a-z0-9]/g, '');
        const exactIdx = cleanHeaders.findIndex(h => h === cleanCand);
        if (exactIdx !== -1) return exactIdx;
      }
      
      // 2. Try partial match excluding ignore keywords
      for (const cand of candidateNames) {
        const cleanCand = cand.toLowerCase().replace(/[^a-z0-9]/g, '');
        const partialIdx = cleanHeaders.findIndex(h => {
          if (ignoreKeywords.some(kw => h.includes(kw))) return false;
          return h.includes(cleanCand);
        });
        if (partialIdx !== -1) return partialIdx;
      }

      return -1;
    };

    const barcodeIdx = findColumnIndex(headers, ['sku', 'upc', 'barcode', 'itemcode', 'code']);
    const nameIdx = findColumnIndex(headers, ['name', 'itemname', 'productname', 'title', 'item', 'description']);
    const qtyIdx = findColumnIndex(headers, ['quantitysoldintransaction', 'quantitysold', 'qtysold', 'quantity', 'qty', 'sold']);
    const priceIdx = findColumnIndex(headers, ['actualunitprice', 'normalunitretailprice', 'unitprice', 'retailprice', 'price', 'retail']);
    const deptIdx = findColumnIndex(headers, ['departmentname', 'department', 'category'], []);

    const allItems = db.prepare('SELECT * FROM items').all();
    const barcodeMap = new Map();
    const nameMap = new Map();

    allItems.forEach(item => {
      if (item.unit_barcode) barcodeMap.set(item.unit_barcode.trim(), item);
      if (item.case_barcode) barcodeMap.set(item.case_barcode.trim(), item);
      nameMap.set(item.name.toLowerCase().trim(), item);
    });

    // Aggregate rows from POS CSV by SKU/Barcode or Item Name
    const aggregatedSalesMap = new Map();

    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVLine(lines[i]);
      if (!row || row.length === 0) continue;

      const barcodeVal = barcodeIdx !== -1 && row[barcodeIdx] ? row[barcodeIdx].replace(/['"]/g, '').trim() : '';
      const nameVal = nameIdx !== -1 && row[nameIdx] ? row[nameIdx].replace(/['"]/g, '').trim() : '';
      const rawQtyStr = qtyIdx !== -1 && row[qtyIdx] ? row[qtyIdx].replace(/['"]/g, '').trim() : '0';
      const qtyVal = parseFloat(rawQtyStr) || 0;
      const rawPriceStr = priceIdx !== -1 && row[priceIdx] ? row[priceIdx].replace(/[\$,'"]/g, '').trim() : '0';
      const priceVal = parseFloat(rawPriceStr) || 0;
      const deptVal = deptIdx !== -1 && row[deptIdx] ? row[deptIdx].replace(/['"]/g, '').trim() : '';

      if (!barcodeVal && !nameVal) continue;

      const key = barcodeVal || nameVal.toLowerCase();

      if (!aggregatedSalesMap.has(key)) {
        aggregatedSalesMap.set(key, {
          barcode: barcodeVal,
          name: nameVal,
          qty_sold: 0,
          price: priceVal,
          department: deptVal
        });
      }

      const existing = aggregatedSalesMap.get(key);
      existing.qty_sold += qtyVal;
      if (priceVal > 0) existing.price = priceVal;
      if (!existing.name && nameVal) existing.name = nameVal;
      if (!existing.department && deptVal) existing.department = deptVal;
    }

    const sales_deductions = [];
    const price_updates = [];
    const new_items = [];

    for (const [key, record] of aggregatedSalesMap.entries()) {
      const { barcode, name, qty_sold, price, department } = record;

      // Find matching item in DB
      let matchedItem = barcodeMap.get(barcode);
      if (!matchedItem && name) {
        matchedItem = nameMap.get(name.toLowerCase());
      }

      if (matchedItem) {
        // Matched Existing Item
        if (qty_sold !== 0) {
          sales_deductions.push({
            item_id: matchedItem.id,
            sku: matchedItem.sku,
            brand: matchedItem.brand,
            name: matchedItem.name,
            current_stock: matchedItem.current_stock,
            qty_sold: qty_sold,
            new_stock: Math.max(0, matchedItem.current_stock - qty_sold)
          });
        }

        if (price > 0 && Math.abs(price - matchedItem.retail_price) > 0.01) {
          price_updates.push({
            item_id: matchedItem.id,
            sku: matchedItem.sku,
            brand: matchedItem.brand,
            name: matchedItem.name,
            current_price: matchedItem.retail_price,
            new_price: price
          });
        }
      } else {
        // Unmatched New Item from POS
        new_items.push({
          barcode: barcode,
          name: name || `POS Product (${barcode})`,
          price: price,
          qty_sold: qty_sold,
          category: department || 'Other'
        });
      }
    }

    fs.unlinkSync(filePath); // Clean up uploaded file

    res.json({
      success: true,
      filename: req.file.originalname,
      diff: {
        sales_deductions,
        price_updates,
        new_items
      }
    });
  } catch (error) {
    console.error('Error parsing POS CSV:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Commit Approved POS Import Changes
app.post('/api/pos/commit', (req, res) => {
  try {
    const { filename, sales_deductions, price_updates, new_items } = req.body;
    const now = new Date().toISOString();

    let salesCount = 0;
    let priceCount = 0;
    let newCount = 0;

    // Apply sales deductions
    if (Array.isArray(sales_deductions)) {
      const stmt = db.prepare('UPDATE items SET current_stock = MAX(0, current_stock - ?), updated_at = ? WHERE id = ?');
      sales_deductions.forEach(item => {
        stmt.run(Number(item.qty_sold), now, item.item_id);
        salesCount += Number(item.qty_sold);
      });
    }

    // Apply price updates
    if (Array.isArray(price_updates)) {
      const stmt = db.prepare('UPDATE items SET retail_price = ?, updated_at = ? WHERE id = ?');
      price_updates.forEach(item => {
        stmt.run(Number(item.new_price), now, item.item_id);
        priceCount++;
      });
    }

    // Apply new items
    if (Array.isArray(new_items)) {
      const stmt = db.prepare(`
        INSERT INTO items (sku, category, brand, name, unit_barcode, retail_price, current_stock, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `);
      new_items.forEach(item => {
        const sku = `SKU-POS-${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 100)}`;
        stmt.run(sku, item.category || 'Other', 'POS Import', item.name, item.barcode || '', Number(item.price) || 0, now);
        newCount++;
      });
    }

    // Record import log
    const logStmt = db.prepare(`
      INSERT INTO pos_imports (filename, total_sales_deducted, prices_updated, new_items_added, imported_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    logStmt.run(filename || 'POS_Export.csv', salesCount, priceCount, newCount, now);

    res.json({
      success: true,
      message: `POS Sync Complete! Deducted ${salesCount} sold items, updated ${priceCount} prices, added ${newCount} new items.`
    });
  } catch (error) {
    console.error('Error committing POS import:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Commit Physical Stock Audit
app.post('/api/audit/commit', (req, res) => {
  try {
    const { audit_counts } = req.body; // Array of { item_id, counted_stock }
    if (!Array.isArray(audit_counts) || audit_counts.length === 0) {
      return res.status(400).json({ success: false, error: 'Audit counts array required' });
    }

    const now = new Date().toISOString();
    let totalAdjusted = 0;

    const updateItemStmt = db.prepare('UPDATE items SET current_stock = ?, updated_at = ? WHERE id = ?');
    const logAuditStmt = db.prepare(`
      INSERT INTO audit_logs (item_id, item_name, system_stock, counted_stock, variance, audited_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    audit_counts.forEach(entry => {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(entry.item_id);
      if (item) {
        const counted = Number(entry.counted_stock);
        const variance = counted - item.current_stock;

        updateItemStmt.run(counted, now, item.item_id);
        logAuditStmt.run(item.item_id, item.name, item.current_stock, counted, variance, now);
        totalAdjusted++;
      }
    });

    res.json({
      success: true,
      message: `Audit committed successfully! Reconciled physical stock for ${totalAdjusted} items.`
    });
  } catch (error) {
    console.error('Error committing audit:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Upload & Import Full Pricebook CSV directly
app.post('/api/pricebook/upload', upload.single('pricebook_file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No CSV file uploaded' });
    }

    const filePath = req.file.path;
    const fileContent = fs.readFileSync(filePath, 'utf8');
    
    // Save as pricebook.csv
    fs.writeFileSync(path.join(__dirname, 'pricebook.csv'), fileContent, 'utf8');
    fs.unlinkSync(filePath);

    // Import into DB
    const { importFromContent } = require('./import_pricebook');
    const result = importFromContent(fileContent);

    if (result.success) {
      res.json({
        success: true,
        message: `Successfully imported ${result.count} items from your Pricebook CSV!`
      });
    } else {
      res.status(400).json({ success: false, error: result.error || 'Failed to import Pricebook' });
    }
  } catch (error) {
    console.error('Error importing pricebook CSV:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. Fetch Logs (Deliveries, Audits, POS Imports)
app.get('/api/logs', (req, res) => {
  try {
    const deliveries = db.prepare('SELECT * FROM deliveries ORDER BY id DESC LIMIT 50').all();
    const audits = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50').all();
    const posImports = db.prepare('SELECT * FROM pos_imports ORDER BY id DESC LIMIT 50').all();

    res.json({
      success: true,
      deliveries,
      audits,
      pos_imports: posImports
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. Export Inventory CSV for Google Sheets
app.get('/api/export/csv', (req, res) => {
  try {
    const items = db.prepare('SELECT * FROM items ORDER BY category ASC, brand ASC, name ASC').all();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="Convenience_Store_Inventory.csv"');

    const headers = [
      'ID', 'SKU', 'Category', 'Brand', 'Item Name', 'Unit Barcode (UPC)',
      'Case Barcode (Master UPC)', 'Is Shared Barcode', 'Pack Size', 'Current Stock',
      'Reorder Level', 'Cost Price ($)', 'Retail Price ($)', 'Last Updated'
    ];

    let csvContent = headers.join(',') + '\n';

    items.forEach(item => {
      const row = [
        item.id,
        `"${item.sku}"`,
        `"${item.category}"`,
        `"${item.brand}"`,
        `"${item.name.replace(/"/g, '""')}"`,
        `"${item.unit_barcode || ''}"`,
        `"${item.case_barcode || ''}"`,
        item.is_shared_barcode ? 'YES' : 'NO',
        item.pack_size,
        item.current_stock,
        item.reorder_level,
        item.cost_price.toFixed(2),
        item.retail_price.toFixed(2),
        `"${item.updated_at}"`
      ];
      csvContent += row.join(',') + '\n';
    });

    res.send(csvContent);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 10. Export Pricebook CSV formatted in exact POS upload layout
app.get('/api/export/pos-pricebook', (req, res) => {
  try {
    const items = db.prepare('SELECT * FROM items ORDER BY id ASC').all();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="POS_Pricebook_Export.csv"');

    const headers = [
      '"Product ID"', '"Name"', '"UPC/PLU"', '"Modifier"', '"Department"',
      '"Department Code"', '"Retail Price"', '"Unit Cost"', '"In Stock"',
      '"Taxable Override"', '"Foodstampable Override"', '"Fractional Override"',
      '"Tags"', '"Price Level 1"', '"Price Level 2"', '"Price Level 3"',
      '"Price Level 4"', '"Price Level 5"', '"Price Level 6"', '"Price Level 7"',
      '"Price Level 8"', '"Price Level 9"', '"Linked Product"'
    ];

    let csvContent = headers.join(',') + '\n';

    items.forEach(item => {
      const cleanProdId = item.sku.replace(/^SKU-/, '') || item.id;
      const cleanName = item.name.replace(/"/g, '""');
      const cleanUpc = item.unit_barcode || '';
      const modifier = item.is_shared_barcode ? '1' : '0';
      const dept = item.category || 'General Store';
      const retailStr = `$${item.retail_price.toFixed(2)}`;
      const costStr = item.cost_price > 0 ? `$${item.cost_price.toFixed(2)}` : '';
      const stockStr = item.current_stock.toString();
      const tagsStr = item.brand || '';

      const row = [
        `"${cleanProdId}"`,
        `"${cleanName}"`,
        `"${cleanUpc}"`,
        `"${modifier}"`,
        `"${dept}"`,
        `"0"`,
        `"${retailStr}"`,
        costStr ? `"${costStr}"` : '""',
        `"${stockStr}"`,
        '""','""','""',
        tagsStr ? `"${tagsStr}"` : '""',
        '""','""','""','""','""','""','""','""','""','""'
      ];

      csvContent += row.join(',') + '\n';
    });

    res.send(csvContent);
  } catch (error) {
    console.error('Error exporting POS pricebook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`Convenience Store Inventory Server is running!`);
  console.log(`Local Access:   http://localhost:${PORT}`);
  console.log(`====================================================`);
});
