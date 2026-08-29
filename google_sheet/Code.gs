/**
 * StoreStock - Google Apps Script Integration
 * Paste this script into Extensions -> Apps Script inside your Google Sheet.
 */

const APP_URL = "http://YOUR_SERVER_IP:3000"; // Replace with your store server URL / Tunnel URL

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 StoreStock Sync')
    .addItem('⬇️ Pull Inventory from App', 'fetchInventoryFromApp')
    .addItem('⬆️ Push Sheet Updates to App', 'pushSheetToApp')
    .addToUi();
}

/**
 * Pull latest inventory data from the web app into Google Sheet
 */
function fetchInventoryFromApp() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  
  try {
    const response = UrlFetchApp.fetch(APP_URL + "/api/export/csv");
    const csvData = Utilities.parseCsv(response.getContentText());
    
    sheet.clear();
    sheet.getRange(1, 1, csvData.length, csvData[0].length).setValues(csvData);
    sheet.getRange(1, 1, 1, csvData[0].length).setFontWeight("bold").setBackground("#1e293b").setFontColor("#ffffff");
    sheet.autoResizeColumns(1, csvData[0].length);

    SpreadsheetApp.getUi().alert("Sync Success! Downloaded latest inventory stock and prices into Google Sheets.");
  } catch (e) {
    SpreadsheetApp.getUi().alert("Sync Error: " + e.toString() + "\nMake sure your server URL is accessible.");
  }
}
