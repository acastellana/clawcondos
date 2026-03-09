import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = '/home/albert/clawd/apps/amazon-invoices/data';
const PDFS_DIR = join(DATA_DIR, 'pdfs');
const INVOICES_FILE = join(DATA_DIR, 'invoices.json');

// Category keywords - more specific first
const CATEGORY_KEYWORDS = {
  mascotas: ['perro', 'gato', 'mascota', 'pet', 'cachorro', 'puppy', 'kitten', 'pienso', 'eukanuba', 'royal canin', 'acana', 'orijen', 'whiskas', 'purina', 'friskies', 'felix', 'sheba', 'advance', 'hills', 'dog food', 'cat food', 'collar', 'correa', 'comedero', 'rascador', 'arenero', 'arena gato', 'hueso', 'juguete perro', 'cama perro', 'transportín', 'antiparasit', 'pipeta', 'desparasit'],
  tech: ['usb', 'cable', 'hdmi', 'cargador', 'batería', 'power bank', 'auricular', 'altavoz', 'speaker', 'bluetooth', 'wifi', 'router', 'adaptador', 'hub', 'ssd', 'disco duro', 'memoria', 'tarjeta sd', 'microsd', 'pendrive', 'webcam', 'micrófono', 'ratón', 'mouse', 'teclado', 'keyboard', 'monitor', 'pantalla', 'tablet', 'ipad', 'kindle', 'ebook', 'smartphone', 'funda', 'protector', 'soporte', 'trípode', 'led', 'bombilla smart', 'alexa', 'echo', 'google home', 'cámara', 'ring', 'nest'],
  hogar: ['limpia', 'clean', 'detergent', 'jabón', 'lenor', 'suavizante', 'fairy', 'mistol', 'fregona', 'escoba', 'cubo', 'bayeta', 'estropajo', 'lejía', 'amoniaco', 'lavavajillas', 'quitagrasa', 'desinfectant', 'ambientador', 'vela', 'incienso', 'aspirador', 'roomba', 'mopa', 'bolsa basura', 'papelera', 'organizador', 'caja almacen', 'estantería', 'mueble', 'lámpara', 'bombilla', 'enchufe', 'regleta', 'alargador', 'cortina', 'alfombra', 'toalla', 'sábana', 'almohada', 'edredón', 'colchón', 'cojín', 'mantel', 'servilleta', 'planta', 'maceta', 'riego', 'jardín', 'herramienta', 'barbacoa', 'bbq', 'piscina'],
  comida: ['café', 'coffee', 'nespresso', 'dolce gusto', 'cápsula', 'té', 'infusión', 'leche', 'agua', 'bebida', 'zumo', 'refresco', 'coca cola', 'cerveza', 'vino', 'aceite', 'oliva', 'vinagre', 'sal', 'azúcar', 'especias', 'pimienta', 'orégano', 'pasta', 'arroz', 'legumbres', 'conserva', 'atún', 'tomate', 'mermelada', 'miel', 'nutella', 'chocolate', 'galleta', 'cereales', 'pan', 'harina', 'frutos secos', 'snack', 'patatas', 'chips', 'palomitas', 'chicle', 'caramelo'],
  personal: ['champú', 'shampoo', 'gel', 'jabón manos', 'body', 'crema', 'hidratante', 'desodorante', 'perfume', 'colonia', 'maquillaje', 'pintalabios', 'rímel', 'sombra', 'base', 'corrector', 'cepillo dientes', 'pasta dientes', 'colgate', 'oral-b', 'hilo dental', 'enjuague', 'afeitado', 'cuchilla', 'gillette', 'espuma afeitar', 'after shave', 'depilación', 'cera', 'uñas', 'esmalte', 'protector solar', 'after sun', 'pañuelo', 'kleenex', 'papel higién', 'compresa', 'tampón', 'pañal', 'dodot', 'bebé', 'baby'],
  oficina: ['papel', 'folio', 'impresora', 'tinta', 'toner', 'cartucho', 'bolígrafo', 'bic', 'pilot', 'rotulador', 'marcador', 'subrayador', 'lápiz', 'goma', 'sacapuntas', 'regla', 'compás', 'tijeras', 'cutter', 'pegamento', 'celo', 'cinta adhesiva', 'post-it', 'nota adhesiva', 'libreta', 'cuaderno', 'agenda', 'carpeta', 'archivador', 'clasificador', 'funda plástico', 'sobre', 'etiqueta', 'grapadora', 'grapa', 'clip', 'chincheta', 'goma elástica', 'calculadora', 'sello', 'tampón tinta'],
  ropa: ['camiseta', 'camisa', 'polo', 'pantalón', 'vaquero', 'jean', 'vestido', 'falda', 'chaqueta', 'abrigo', 'cazadora', 'jersey', 'sudadera', 'hoodie', 'chaleco', 'traje', 'blazer', 'calcetín', 'media', 'ropa interior', 'calzoncillo', 'braga', 'sujetador', 'pijama', 'bata', 'bañador', 'bikini', 'zapato', 'zapatilla', 'deportiva', 'bota', 'sandalia', 'chancla', 'bolso', 'mochila', 'maleta', 'cinturón', 'corbata', 'pañuelo cuello', 'bufanda', 'guante', 'gorro', 'gorra', 'sombrero'],
};

function categorizeItem(description) {
  const lower = (description || '').toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return category;
      }
    }
  }
  return 'otros';
}

function parseItemsFromPDF(pdfPath) {
  try {
    const text = execSync(`pdftotext "${pdfPath}" - 2>/dev/null`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    
    const items = [];
    
    // Pattern 1: Spanish Amazon format - Description, Qty, Unit Price, VAT%, Unit Price (inc VAT), Total
    // Example: "Eukanuba Alimento seco...  1  35,45 €  10%  38,99 €  38,99 €"
    const pattern1 = /([A-Za-zÀ-ÿ0-9 ,.'()\-\/]+?)\s+(\d+)\s+([\d.,]+)\s*€\s+(\d+)%\s+([\d.,]+)\s*€\s+([\d.,]+)\s*€/g;
    
    // Pattern 2: Simpler format - Description, Qty, Price
    const pattern2 = /^([A-Za-zÀ-ÿ0-9 ,.'()\-\/]{15,80})\s+(\d+)\s+([\d.,]+)\s*€/gm;
    
    // Pattern 3: ASIN-based items
    const pattern3 = /([A-Za-zÀ-ÿ0-9 ,.'()\-\/]+?)\nASIN:\s*([A-Z0-9]+)/g;
    
    let match;
    
    // Try pattern 1 first (most detailed)
    while ((match = pattern1.exec(text)) !== null) {
      const desc = match[1].trim();
      if (desc.length > 10 && !desc.match(/^(Total|Envío|IVA|Precio|Subtotal|Importe|Descuento)/i)) {
        items.push({
          description: desc,
          quantity: parseInt(match[2]),
          unit_price_net: parseFloat(match[3].replace(',', '.')),
          vat_rate: parseInt(match[4]),
          unit_price_gross: parseFloat(match[5].replace(',', '.')),
          total: parseFloat(match[6].replace(',', '.')),
          category: categorizeItem(desc)
        });
      }
    }
    
    // If no items found, try pattern 2
    if (items.length === 0) {
      while ((match = pattern2.exec(text)) !== null) {
        const desc = match[1].trim();
        if (desc.length > 10 && !desc.match(/^(Total|Envío|IVA|Precio|Subtotal|Importe|Descuento)/i)) {
          items.push({
            description: desc,
            quantity: parseInt(match[2]),
            total: parseFloat(match[3].replace(',', '.')),
            category: categorizeItem(desc)
          });
        }
      }
    }
    
    // Extract vendor
    let vendor = 'Unknown';
    const vendorMatch = text.match(/Vendido por\s+([A-Za-z0-9 .,&'()-]+?)(?:\n|IVA|NIF)/i);
    if (vendorMatch) {
      vendor = vendorMatch[1].trim();
      if (vendor.includes('Amazon EU')) vendor = 'Amazon EU';
    }
    
    // Extract date
    let date = '';
    const dateMatch = text.match(/(\d{1,2})\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+(\d{4})/i);
    if (dateMatch) {
      const months = {enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',julio:'07',agosto:'08',septiembre:'09',octubre:'10',noviembre:'11',diciembre:'12'};
      date = `${dateMatch[3]}-${months[dateMatch[2].toLowerCase()]}-${dateMatch[1].padStart(2,'0')}`;
    }
    
    // Extract order number
    const orderMatch = text.match(/(\d{3}-\d{7}-\d{7})/);
    const orderNumber = orderMatch ? orderMatch[1] : '';
    
    return { items, vendor, date, orderNumber, rawText: text };
  } catch (err) {
    return { items: [], vendor: 'Unknown', date: '', orderNumber: '', rawText: '' };
  }
}

// Load existing invoices
const invoices = JSON.parse(readFileSync(INVOICES_FILE, 'utf-8'));

let totalItemsParsed = 0;
let invoicesUpdated = 0;

for (const inv of invoices) {
  const pdfPath = join(PDFS_DIR, `${inv.invoice_number}.pdf`);
  
  const parsed = parseItemsFromPDF(pdfPath);
  
  if (parsed.items.length > 0) {
    inv.items = parsed.items;
    inv.vendor = parsed.vendor || inv.vendor;
    if (parsed.date) inv.date = parsed.date;
    if (parsed.orderNumber) inv.order_number = parsed.orderNumber;
    
    // Calculate category breakdown for this invoice
    inv.category_breakdown = {};
    for (const item of inv.items) {
      const cat = item.category;
      inv.category_breakdown[cat] = (inv.category_breakdown[cat] || 0) + (item.total || 0);
    }
    
    // Set primary category as the one with highest spend
    const sortedCats = Object.entries(inv.category_breakdown).sort((a, b) => b[1] - a[1]);
    inv.category = sortedCats[0]?.[0] || 'otros';
    
    totalItemsParsed += parsed.items.length;
    invoicesUpdated++;
    
    if (parsed.items.length > 1) {
      console.log(`${inv.invoice_number}: ${parsed.items.length} items`);
      for (const item of parsed.items) {
        console.log(`  - [${item.category}] €${item.total?.toFixed(2) || '?'}: ${item.description?.substring(0, 50)}...`);
      }
    }
  }
}

writeFileSync(INVOICES_FILE, JSON.stringify(invoices, null, 2));

console.log(`\n=== Summary ===`);
console.log(`Invoices updated: ${invoicesUpdated}`);
console.log(`Total items parsed: ${totalItemsParsed}`);

// Calculate overall category breakdown
const categoryTotals = {};
for (const inv of invoices) {
  if (inv.category_breakdown) {
    for (const [cat, amount] of Object.entries(inv.category_breakdown)) {
      categoryTotals[cat] = (categoryTotals[cat] || 0) + amount;
    }
  } else {
    categoryTotals[inv.category] = (categoryTotals[inv.category] || 0) + inv.total;
  }
}

console.log(`\nSpending by category:`);
const sorted = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);
for (const [cat, total] of sorted) {
  console.log(`  ${cat}: €${total.toFixed(2)}`);
}
console.log(`  TOTAL: €${sorted.reduce((s, [_, v]) => s + v, 0).toFixed(2)}`);
