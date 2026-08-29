const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, 'inventory.db');
const db = new DatabaseSync(dbPath);

// Initialize Tables
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL,
      brand TEXT NOT NULL,
      name TEXT NOT NULL,
      unit_barcode TEXT,
      case_barcode TEXT,
      is_shared_barcode INTEGER DEFAULT 0,
      pack_size INTEGER DEFAULT 1,
      current_stock INTEGER DEFAULT 0,
      reorder_level INTEGER DEFAULT 5,
      cost_price REAL DEFAULT 0.00,
      retail_price REAL DEFAULT 0.00,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      item_name TEXT,
      barcode_scanned TEXT,
      is_case_scan INTEGER,
      cases_received INTEGER,
      units_added INTEGER,
      received_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      item_name TEXT,
      system_stock INTEGER,
      counted_stock INTEGER,
      variance INTEGER,
      audited_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pos_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT,
      total_sales_deducted INTEGER,
      prices_updated INTEGER,
      new_items_added INTEGER,
      imported_at TEXT
    );
  `);

  // Check if items table is empty; if so, seed sample convenience store inventory
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM items');
  const result = countStmt.get();
  if (result.count === 0) {
    seedDatabase();
  }
}

function seedDatabase() {
  const insertStmt = db.prepare(`
    INSERT INTO items 
    (sku, category, brand, name, unit_barcode, case_barcode, is_shared_barcode, pack_size, current_stock, reorder_level, cost_price, retail_price, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const sampleItems = [
    // Vapes
    ['SKU-VP-001', 'Vapes', 'ElfBar', 'BC5000 Watermelon Ice 50mg', '840011122201', '840011122200', 0, 10, 35, 8, 9.50, 19.99, now],
    ['SKU-VP-002', 'Vapes', 'ElfBar', 'BC5000 Blue Razz Ice 50mg', '840011122202', '840011122200', 0, 10, 18, 8, 9.50, 19.99, now],
    ['SKU-VP-003', 'Vapes', 'Lost Mary', 'OS5000 Peach Mango 50mg', '840011122301', '840011122300', 0, 10, 24, 8, 10.00, 21.99, now],
    ['SKU-VP-004', 'Vapes', 'Lost Mary', 'OS5000 Strawberry Ice 50mg', '840011122302', '840011122300', 0, 10, 4, 8, 10.00, 21.99, now], // Low stock!
    ['SKU-VP-005', 'Vapes', 'Breeze', 'Pro Cherry Lemon 5%0mg', '840011122401', '840011122400', 0, 10, 15, 6, 8.50, 17.99, now],

    // Cigarettes & Tobacco
    ['SKU-CG-001', 'Cigarettes', 'Marlboro', 'Red Box (King Size)', '028200001008', '028200001010', 0, 10, 45, 15, 7.20, 10.50, now],
    ['SKU-CG-002', 'Cigarettes', 'Marlboro', 'Gold Box (Lights)', '028200001009', '028200001010', 0, 10, 30, 10, 7.20, 10.50, now],
    ['SKU-CG-003', 'Cigarettes', 'Newport', 'Menthol Box 100s', '010000002005', '010000002010', 0, 10, 28, 10, 7.80, 11.25, now],

    // Beer (with Shared Barcode example)
    ['SKU-BR-001', 'Beer', 'Coors', 'Coors Light 12oz Can', '071990000012', '071990000024', 0, 24, 72, 24, 0.75, 1.75, now],
    ['SKU-BR-002', 'Beer', 'Bud Light', 'Bud Light 12oz Can (Single/6-Pk Shared)', '018200000016', '', 1, 6, 48, 12, 0.80, 1.85, now], // Shared barcode!
    ['SKU-BR-003', 'Beer', 'Corona', 'Corona Extra 12oz Bottle', '080660956156', '080660956248', 0, 24, 36, 12, 1.10, 2.50, now],

    // Drinks & Juices
    ['SKU-DR-001', 'Drinks', 'Coca-Cola', 'Classic 20oz Bottle', '049000000443', '049000002443', 0, 24, 60, 20, 0.90, 2.29, now],
    ['SKU-DR-002', 'Drinks', 'Monster', 'Energy Original 16oz Can', '070847012400', '070847012424', 0, 24, 40, 15, 1.30, 3.19, now],
    ['SKU-DR-003', 'Juices', 'Simply', 'Orange Juice 52oz', '025000044030', '025000044060', 0, 6, 14, 5, 2.40, 4.79, now],

    // Chips & Snacks
    ['SKU-CH-001', 'Chips', 'Lay\'s', 'Classic Potato Chips 2.75oz', '028400040112', '028400040240', 0, 64, 50, 15, 1.10, 2.49, now],
    ['SKU-CH-002', 'Chips', 'Doritos', 'Nacho Cheese 2.75oz', '028400040120', '028400040240', 0, 64, 32, 15, 1.10, 2.49, now],
    ['SKU-SN-001', 'Chocolates', 'Snickers', 'Single Bar 1.86oz', '040000000424', '040000000488', 0, 48, 80, 20, 0.65, 1.69, now]
  ];

  for (const item of sampleItems) {
    insertStmt.run(...item);
  }
  console.log('Seeded database with initial convenience store items.');
}

initDatabase();

module.exports = db;
