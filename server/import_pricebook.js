const fs = require('fs');
const path = require('path');
const db = require('./db');

// Brand detection keywords mapping
const brandMap = [
  { name: 'ElfBar', keywords: ['elfbar', 'elf bar', 'bc5000'] },
  { name: 'Geek Bar', keywords: ['geek bar', 'geekbar'] },
  { name: 'Raz', keywords: ['raz ', 'raz:', 'razdew', 'raz vue'] },
  { name: 'Lost Mary', keywords: ['lost mary', 'os5000'] },
  { name: 'Fume', keywords: ['fume', 'wefume'] },
  { name: 'HQD', keywords: ['hqd', 'cuvie'] },
  { name: 'Fifty Bar', keywords: ['fifty bar'] },
  { name: 'Nexa', keywords: ['nexa'] },
  { name: 'Marlboro', keywords: ['marlboro', 'malboro'] },
  { name: 'Newport', keywords: ['newport'] },
  { name: 'Winston', keywords: ['winston'] },
  { name: 'Camel', keywords: ['camel'] },
  { name: 'Salem', keywords: ['salem'] },
  { name: 'Swisher', keywords: ['swisher', 'swish '] },
  { name: 'Dutch', keywords: ['dutch', 'dutch master'] },
  { name: 'Black & Mild', keywords: ['black & mild', 'black and mild', 'blk '] },
  { name: 'Backwoods', keywords: ['backwoods'] },
  { name: 'Game', keywords: ['game leaf', 'game '] },
  { name: 'Coors', keywords: ['coors'] },
  { name: 'Bud Light', keywords: ['bud light'] },
  { name: 'Budweiser', keywords: ['budweiser'] },
  { name: 'Corona', keywords: ['corona'] },
  { name: 'Heineken', keywords: ['heineken'] },
  { name: 'Modelo', keywords: ['modelo'] },
  { name: 'Miller', keywords: ['miller'] },
  { name: 'Stella Artois', keywords: ['stella'] },
  { name: 'Yuengling', keywords: ['yuengling'] },
  { name: 'Red Bull', keywords: ['red bull', 'redbull'] },
  { name: 'Monster', keywords: ['monster'] },
  { name: 'Arizona', keywords: ['arizona', 'az '] },
  { name: 'Gatorade', keywords: ['gatorade', 'gat '] },
  { name: 'Coca-Cola', keywords: ['coca-cola', 'coca cola', 'coke'] },
  { name: 'Pepsi', keywords: ['pepsi'] },
  { name: '7Up', keywords: ['7up', '7-up'] },
  { name: 'Sprite', keywords: ['sprite'] },
  { name: 'Celsius', keywords: ['celsius', 'celcius'] },
  { name: 'C4', keywords: ['c4 '] },
  { name: 'Electrolit', keywords: ['electrolit'] },
  { name: 'Lay\'s', keywords: ['lays', 'lay\'s'] },
  { name: 'Doritos', keywords: ['doritos', 'dorito'] },
  { name: 'Cheetos', keywords: ['cheetos', 'cheetohs'] },
  { name: 'Ruffles', keywords: ['ruffles'] },
  { name: 'Takis', keywords: ['takis'] },
  { name: 'Wise', keywords: ['wise'] },
  { name: 'Herr\'s', keywords: ['herr\'s', 'herrs'] },
  { name: 'Pringles', keywords: ['pringles'] },
  { name: 'Snickers', keywords: ['snickers'] },
  { name: 'Reese\'s', keywords: ['reeses', 'reese'] },
  { name: 'Hershey\'s', keywords: ['hershey'] },
  { name: 'Kinder', keywords: ['kinder'] },
  { name: 'Tic Tac', keywords: ['tic tac'] },
  { name: 'Trolli', keywords: ['trolli'] },
  { name: 'Haribo', keywords: ['haribo'] },
  { name: 'Zyn', keywords: ['zyn'] },
  { name: 'Velo', keywords: ['velo'] },
  { name: 'Sutter Home', keywords: ['sutter home', 'sutterhome'] },
  { name: 'Yellow Tail', keywords: ['yellow tail'] },
  { name: 'Smirnoff', keywords: ['smirnoff'] },
  { name: 'BeatBox', keywords: ['beatbox', 'beat box'] },
  { name: 'Four Loko', keywords: ['four loko'] }
];

function detectBrand(name, tags) {
  const text = `${name} ${tags}`.toLowerCase();
  for (const b of brandMap) {
    if (b.keywords.some(kw => text.includes(kw))) {
      return b.name;
    }
  }
  if (tags && tags.trim().length > 0 && !tags.includes('Club')) {
    return tags.split(',')[0].trim();
  }
  const firstWord = name.split(' ')[0].replace(/[^a-zA-Z0-9]/g, '');
  return firstWord.length > 2 ? firstWord : 'General Store';
}

function detectPackSize(name, category) {
  const lower = name.toLowerCase();
  if (lower.includes('24/12') || lower.includes('24pk') || lower.includes('24 pack') || lower.includes('24 fl oz x 12')) return 24;
  if (lower.includes('18pk') || lower.includes('18 pack')) return 18;
  if (lower.includes('12pk') || lower.includes('12 pack') || lower.includes('12/')) return 12;
  if (lower.includes('6pk') || lower.includes('6 pack') || lower.includes('6-pack') || lower.includes('6/')) return 6;
  if (lower.includes('5pk') || lower.includes('pack of 5') || lower.includes('5 ct') || lower.includes('5-pack')) return 5;
  if (lower.includes('4pk') || lower.includes('4 pack') || lower.includes('4-pack')) return 4;

  const catLower = (category || '').toLowerCase();
  if (catLower.includes('vape') || catLower.includes('tobacco')) return 10;
  if (catLower.includes('alcohol') || catLower.includes('beer') || catLower.includes('soda') || catLower.includes('drinks')) return 24;

  return 1;
}

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

function importFromContent(fileContent) {
  const lines = fileContent.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) {
    return { success: false, error: 'File is empty' };
  }

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));

  const productIdIdx = headers.indexOf('productid');
  const nameIdx = headers.indexOf('name');
  const upcIdx = headers.indexOf('upcplu');
  const modifierIdx = headers.indexOf('modifier');
  const deptIdx = headers.indexOf('department');
  const retailPriceIdx = headers.indexOf('retailprice');
  const unitCostIdx = headers.indexOf('unitcost');
  const stockIdx = headers.indexOf('instock');
  const tagsIdx = headers.indexOf('tags');

  // Clear existing items in DB to load fresh pricebook
  db.exec('DELETE FROM items');

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO items 
    (sku, category, brand, name, unit_barcode, case_barcode, is_shared_barcode, pack_size, current_stock, reorder_level, cost_price, retail_price, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const now = new Date().toISOString();

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (!row || row.length < 3) continue;

    const prodId = row[productIdIdx] ? row[productIdIdx].trim() : `${i}`;
    const rawName = row[nameIdx] ? row[nameIdx].trim() : `Item #${prodId}`;
    const rawUpc = row[upcIdx] ? row[upcIdx].replace(/['"]/g, '').trim() : '';
    const modifier = row[modifierIdx] ? row[modifierIdx].trim() : '0';
    const dept = row[deptIdx] ? row[deptIdx].trim() : 'General Store';
    const rawRetail = row[retailPriceIdx] ? row[retailPriceIdx].replace(/[\$,]/g, '').trim() : '0.00';
    const rawCost = row[unitCostIdx] ? row[unitCostIdx].replace(/[\$,]/g, '').trim() : '';
    const rawStock = row[stockIdx] ? row[stockIdx].replace(/['"]/g, '').trim() : '0';
    const tags = row[tagsIdx] ? row[tagsIdx].trim() : '';

    const sku = `SKU-${prodId}`;
    const category = dept || 'General Store';
    const brand = detectBrand(rawName, tags);
    const isShared = modifier === '1' ? 1 : 0;
    const retailPrice = parseFloat(rawRetail) || 0.00;
    const costPrice = rawCost ? parseFloat(rawCost) || 0.00 : parseFloat((retailPrice * 0.6).toFixed(2));
    
    const parsedStock = parseInt(rawStock) || 0;
    const currentStock = Math.max(0, parsedStock);
    const packSize = detectPackSize(rawName, category);

    insertStmt.run(
      sku, category, brand, rawName, rawUpc, '', isShared, packSize,
      currentStock, 5, costPrice, retailPrice, now
    );

    count++;
  }

  return { success: true, count };
}

// Run directly if invoked via node import_pricebook.js
if (require.main === module) {
  const dataDir = process.env.DATA_DIR || __dirname;
  const pricebookPath = path.join(dataDir, 'pricebook.csv');
  const fallbackPath = path.join(__dirname, 'pricebook.csv');
  const targetPath = fs.existsSync(pricebookPath) ? pricebookPath : fallbackPath;

  if (fs.existsSync(targetPath)) {
    const fileContent = fs.readFileSync(targetPath, 'utf8');
    const result = importFromContent(fileContent);
    console.log(`Imported ${result.count} items into database.`);
  }
}

module.exports = { importFromContent };
