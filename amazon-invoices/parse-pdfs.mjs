import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const DATA_DIR = '/home/albert/clawd/apps/amazon-invoices/data';
const PDFS_DIR = join(DATA_DIR, 'pdfs');
const INVOICES_FILE = join(DATA_DIR, 'invoices.json');

// Load existing invoices
const existing = JSON.parse(readFileSync(INVOICES_FILE, 'utf-8'));
const existingIds = new Set(existing.map(i => i.invoice_number));

// Get all vendor invoice PDFs (INV-* and ES* patterns)
const pdfs = readdirSync(PDFS_DIR).filter(f => 
  (f.startsWith('INV-') || f.startsWith('ES')) && f.endsWith('.pdf')
);

console.log(`Found ${pdfs.length} vendor invoice PDFs`);
console.log(`Existing invoices: ${existing.length}`);

const newInvoices = [];

for (const pdf of pdfs) {
  const invNum = pdf.replace('.pdf', '');
  if (existingIds.has(invNum)) continue;
  
  const pdfPath = join(PDFS_DIR, pdf);
  
  try {
    const text = execSync(`pdftotext "${pdfPath}" -`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    
    // Extract vendor - usually a company name near top
    const vendorMatch = text.match(/(?:^|\n)([A-Z][A-Za-z0-9 .,&'-]{5,60}(?:S\.?L\.?U?\.?|GmbH|Inc\.?|Ltd\.?|S\.?A\.?)?)\s*\n/m);
    const vendor = vendorMatch ? vendorMatch[1].trim() : 'Unknown';
    
    // Extract total - look for final amount patterns
    const amountPatterns = [
      /Total[:\s]+[€]?\s*([0-9]+[.,][0-9]{2})\s*€?/i,
      /Importe total[:\s]+[€]?\s*([0-9]+[.,][0-9]{2})/i,
      /TOTAL[:\s]+[€]?\s*([0-9]+[.,][0-9]{2})/,
      /([0-9]+[.,][0-9]{2})\s*€\s*$/m,
      /Brutto[:\s]+[€]?\s*([0-9]+[.,][0-9]{2})/i,
    ];
    
    let total = 0;
    for (const pattern of amountPatterns) {
      const match = text.match(pattern);
      if (match) {
        total = parseFloat(match[1].replace(',', '.'));
        break;
      }
    }
    
    // Extract date
    const datePatterns = [
      /(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/,
      /(\d{4})-(\d{2})-(\d{2})/,
    ];
    
    let date = '';
    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match) {
        if (match[0].includes('-') && match[1].length === 4) {
          date = match[0]; // YYYY-MM-DD format
        } else {
          // Convert DD/MM/YYYY to YYYY-MM-DD
          const d = match[1].padStart(2, '0');
          const m = match[2].padStart(2, '0');
          const y = match[3];
          date = `${y}-${m}-${d}`;
        }
        break;
      }
    }
    
    // Extract order number from text
    const orderMatch = text.match(/(\d{3}-\d{7}-\d{7})/);
    const orderNumber = orderMatch ? orderMatch[1] : '';
    
    // Extract VAT info
    const vatMatch = text.match(/IVA[:\s]+([0-9]+[.,][0-9]{2})|VAT[:\s]+([0-9]+[.,][0-9]{2})/i);
    const vatAmount = vatMatch ? parseFloat((vatMatch[1] || vatMatch[2]).replace(',', '.')) : 0;
    
    if (total > 0) {
      const invoice = {
        invoice_number: invNum,
        order_number: orderNumber,
        date: date,
        total: total,
        vat_amount: vatAmount,
        subtotal_net: total - vatAmount,
        vendor: vendor,
        source_file: pdfPath,
        category: 'otros'
      };
      
      newInvoices.push(invoice);
      console.log(`✓ ${invNum}: ${vendor} - €${total.toFixed(2)}`);
    } else {
      console.log(`⚠ ${invNum}: Could not extract total`);
    }
    
  } catch (err) {
    console.error(`✗ ${pdf}: ${err.message}`);
  }
}

console.log(`\nExtracted ${newInvoices.length} new invoices`);

if (newInvoices.length > 0) {
  const merged = [...existing, ...newInvoices];
  writeFileSync(INVOICES_FILE, JSON.stringify(merged, null, 2));
  console.log(`Total invoices: ${merged.length}`);
  console.log(`New total: €${merged.reduce((s, i) => s + i.total, 0).toFixed(2)}`);
}
