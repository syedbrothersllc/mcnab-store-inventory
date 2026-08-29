const path = require('path');
const dbPath = path.join(__dirname, 'inventory.db');

let db;

try {
  const Database = require('better-sqlite3');
  db = new Database(dbPath);
} catch (e) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath);
  } catch (err) {
    console.error('Failed to initialize SQLite database:', err);
    throw err;
  }
}

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
}

initDatabase();

module.exports = db;
