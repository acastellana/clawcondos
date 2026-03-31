import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const DATA_DIR = '/home/albert/clawd/apps/amazon-invoices/data';
const PDFS_DIR = join(DATA_DIR, 'pdfs');
const INVOICES_FILE = join(DATA_DIR, 'invoices.json');

// Category keywords
const CATEGORY_KEYWORDS = {
  mascotas: ['perro', 'gato', 'mascota', 'pet', 'cachorro', 'puppy', 'kitten', 'pienso', 'eukanuba', 'royal canin', 'acana', 'orijen', 'whiskas', 'purina', 'friskies', 'felix', 'sheba', 'advance', 'hill\'s', 'dog food', 'cat food', 'collar perro', 'correa', 'comedero', 'rascador', 'arenero', 'arena gato', 'hueso perro', 'juguete perro', 'cama perro', 'transportín', 'antiparasit', 'pipeta', 'desparasit', 'alimento perro', 'alimento gato', 'snack perro', 'premio perro', 'empapador', 'nutribest dog', 'nutribest cat', 'ultima medium', 'ultima mini', 'arquivet', 'appettys', 'nature dogs'],
  juguetes: ['juguete', 'lego', 'playmobil', 'barbie', 'muñeca', 'puzzle', 'rompecabezas', 'juego mesa', 'cartas', 'peluche', 'nerf', 'hot wheels', 'paw patrol', 'peppa', 'frozen', 'disney', 'marvel', 'nintendo', 'playstation', 'xbox', 'videojuego', 'consola', 'mando', 'educativo niño', 'bebé juguete', 'sonajero', 'mordedor', 'nene toys', 'robot codificación', 'matatalab', 'slime', 'tarjetas flash'],
  tech: ['usb', 'cable', 'hdmi', 'cargador', 'batería', 'power bank', 'auricular', 'altavoz', 'speaker', 'bluetooth', 'wifi', 'router', 'adaptador', 'hub', 'ssd', 'disco duro', 'memoria', 'tarjeta sd', 'microsd', 'pendrive', 'webcam', 'micrófono', 'ratón', 'mouse', 'teclado', 'keyboard', 'monitor', 'pantalla', 'tablet', 'ipad', 'kindle', 'ebook', 'smartphone', 'funda móvil', 'protector pantalla', 'soporte móvil', 'trípode', 'led', 'bombilla smart', 'alexa', 'echo', 'google home', 'cámara seguridad', 'ring', 'nest', 'smart home', 'lenovo tab', 'epson', 'impresora', 'ecotank', 'tinta', 'lápiz capacitivo', 'xiaomi', 'smart band'],
  hogar: ['limpia', 'clean', 'detergent', 'jabón', 'lenor', 'suavizante', 'fairy', 'mistol', 'fregona', 'escoba', 'cubo', 'bayeta', 'estropajo', 'lejía', 'amoniaco', 'lavavajillas', 'quitagrasa', 'desinfectant', 'ambientador', 'vela aromática', 'incienso', 'aspirador', 'roomba', 'mopa', 'bolsa basura', 'papelera', 'organizador', 'caja almacen', 'estantería', 'mueble', 'lámpara', 'bombilla', 'enchufe', 'regleta', 'alargador', 'cortina', 'alfombra', 'toalla', 'sábana', 'almohada', 'edredón', 'colchón', 'cojín', 'mantel', 'servilleta', 'planta', 'maceta', 'riego', 'jardín', 'herramienta', 'barbacoa', 'piscina', 'cocina', 'sartén', 'olla', 'cafetera', 'tostador', 'batidora', 'robot cocina', 'microondas', 'horno', 'nevera', 'congelador', 'mesa', 'taburete', 'banco', 'silla', 'escalera', 'baul', 'vajilla', 'copas', 'flautas champán', 'cristalería', 'villeroy', 'vileda', 'scottex', 'papel cocina', 'ecover', 'colon', 'vanish', 'finish', 'fertilizante', 'biofertilizante', 'krok wood', 'insecticida', 'glassware', 'elixir', 'cachimba', 'shisha'],
  bebidas: ['cognac', 'whisky', 'whiskey', 'ron', 'vodka', 'ginebra', 'gin', 'tequila', 'licor', 'vino', 'champagne', 'cava', 'cerveza', 'sidra', 'cider', 'marques de riscal', 'reserva', 'rioja', 'bumbu', 'rémy martin', 'ferrand', 'brockman'],
  comida: ['café', 'coffee', 'nespresso', 'dolce gusto', 'cápsula café', 'té', 'infusión', 'leche', 'agua mineral', 'bebida', 'zumo', 'refresco', 'coca cola', 'aceite oliva', 'vinagre', 'sal', 'azúcar', 'especias', 'pimienta', 'orégano', 'pasta', 'arroz', 'legumbres', 'conserva', 'atún', 'tomate', 'mermelada', 'miel', 'nutella', 'chocolate', 'galleta', 'cereales', 'pan', 'harina', 'frutos secos', 'snack', 'patatas fritas', 'chips', 'palomitas', 'chicle', 'caramelo', 'protein', 'suplemento', 'vitamina', 'starbucks', 'calvo', 'puleva', 'central lechera', 'yerba mate', 'mate'],
  personal: ['champú', 'shampoo', 'gel ducha', 'jabón manos', 'body milk', 'crema hidratante', 'desodorante', 'perfume', 'colonia', 'agua de tocador', 'maquillaje', 'pintalabios', 'rímel', 'sombra ojos', 'base maquillaje', 'corrector', 'cepillo dientes', 'pasta dientes', 'colgate', 'oral-b', 'hilo dental', 'enjuague bucal', 'irrigador', 'waterpik', 'afeitado', 'cuchilla', 'gillette', 'espuma afeitar', 'after shave', 'depilación', 'cera depilatoria', 'uñas', 'esmalte', 'protector solar', 'after sun', 'pañuelo', 'kleenex', 'papel higiénico', 'compresa', 'tampón', 'pañal', 'dodot', 'toallita', 'cuna', 'bebé', 'kit maquillaje', 'green tea gel', 'elizabeth arden', 'issey miyake', 'mascarilla facial', 'kelo cote', 'cicatriz', 'crema celulitis', 'biorepair', 'bach rescue', 'dsinco', 'crema reafirmante', 'adelgazante', 'celulitis'],
  oficina: ['papel a4', 'folio', 'bolígrafo', 'bic', 'pilot', 'rotulador', 'marcador', 'subrayador', 'lápiz', 'goma borrar', 'sacapuntas', 'regla', 'compás', 'tijeras', 'cutter', 'pegamento', 'celo', 'cinta adhesiva', 'post-it', 'nota adhesiva', 'libreta', 'cuaderno', 'agenda', 'carpeta', 'archivador', 'clasificador', 'funda plástico', 'sobre', 'etiqueta', 'grapadora', 'grapa', 'clip', 'chincheta', 'libro', 'gramática'],
  ropa: ['camiseta', 'camisa', 'polo', 'pantalón', 'vaquero', 'jean', 'vestido', 'falda', 'chaqueta', 'abrigo', 'cazadora', 'jersey', 'sudadera', 'hoodie', 'chaleco', 'traje', 'blazer', 'calcetín', 'media', 'ropa interior', 'calzoncillo', 'braga', 'sujetador', 'pijama', 'bata', 'bañador', 'bikini', 'zapato', 'zapatilla', 'deportiva', 'bota', 'sandalia', 'chancla', 'bolso', 'mochila', 'maleta', 'cinturón', 'corbata', 'bufanda', 'guante', 'gorro', 'gorra', 'chándal', 'reloj', 'casio', 'gioseppo'],
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
    const text = execSync(`pdftotext -layout "${pdfPath}" - 2>/dev/null`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    
    const items = [];
    const lines = text.split('\n');
    
    // Pattern to match item lines with prices
    // Format: Description | Qty | Net Price € | VAT% | Gross Price € | Total €
    const itemPattern = /^\s*(.{10,60}?)\s+(\d+)\s+([\d.,]+)\s*€\s+(\d+)%\s+([\d.,]+)\s*€\s+([\d.,]+)\s*€\s*$/;
    
    // Simpler pattern for lines with just prices at end
    const simplePattern = /^\s*(.{15,}?)\s+(\d+)\s+([\d.,]+)\s*€\s+([\d.,]+)\s*€\s*$/;
    
    let currentDescription = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Skip header and footer lines
      if (line.includes('Descripción') || line.includes('IVA excluido') || 
          line.includes('ASIN:') || line.includes('Envío') || 
          line.includes('Total') && !line.match(/\d{2,}.*€.*€/)) {
        continue;
      }
      
      // Try detailed pattern first
      let match = line.match(itemPattern);
      if (match) {
        const desc = (currentDescription + ' ' + match[1]).trim().replace(/\s+/g, ' ');
        const qty = parseInt(match[2]);
        const netPrice = parseFloat(match[3].replace(',', '.'));
        const vatRate = parseInt(match[4]);
        const grossPrice = parseFloat(match[5].replace(',', '.'));
        const totalGross = parseFloat(match[6].replace(',', '.'));
        
        if (desc.length > 5 && totalGross > 0) {
          items.push({
            description: desc,
            quantity: qty,
            unit_price_net: netPrice,
            vat_rate: vatRate,
            unit_price_gross: grossPrice,
            total_gross: totalGross,  // This includes VAT
            vat_amount: totalGross - (netPrice * qty),
            category: categorizeItem(desc)
          });
        }
        currentDescription = '';
        continue;
      }
      
      // Try simpler pattern
      match = line.match(simplePattern);
      if (match) {
        const desc = (currentDescription + ' ' + match[1]).trim().replace(/\s+/g, ' ');
        const qty = parseInt(match[2]);
        const price1 = parseFloat(match[3].replace(',', '.'));
        const price2 = parseFloat(match[4].replace(',', '.'));
        
        // price2 is usually the total with VAT
        if (desc.length > 5 && price2 > 0) {
          items.push({
            description: desc,
            quantity: qty,
            total_gross: price2,
            category: categorizeItem(desc)
          });
        }
        currentDescription = '';
        continue;
      }
      
      // Accumulate multi-line descriptions (non-empty text lines without prices)
      if (line.trim().length > 5 && !line.match(/[\d.,]+\s*€/) && !line.match(/^\s*\d+\s*$/)) {
        currentDescription += ' ' + line.trim();
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
    
    // Extract invoice total (with VAT)
    const totalMatch = text.match(/Total\s+pendiente\s+([\d.,]+)\s*€/i) || text.match(/Total[:\s]+([\d.,]+)\s*€/i);
    const invoiceTotal = totalMatch ? parseFloat(totalMatch[1].replace(',', '.')) : 0;
    
    // Extract total VAT
    const vatTotalMatch = text.match(/Total\s+([\d.,]+)\s*€\s+([\d.,]+)\s*€\s*$/m);
    const totalVat = vatTotalMatch ? parseFloat(vatTotalMatch[2].replace(',', '.')) : 0;
    
    // Extract order number
    const orderMatch = text.match(/(\d{3}-\d{7}-\d{7})/);
    const orderNumber = orderMatch ? orderMatch[1] : '';
    
    return { items, vendor, date, orderNumber, invoiceTotal, totalVat };
  } catch (err) {
    return { items: [], vendor: 'Unknown', date: '', orderNumber: '', invoiceTotal: 0, totalVat: 0 };
  }
}

// Load existing invoices
const invoices = JSON.parse(readFileSync(INVOICES_FILE, 'utf-8'));

let totalItemsParsed = 0;
let invoicesUpdated = 0;

for (const inv of invoices) {
  const pdfPath = join(PDFS_DIR, `${inv.invoice_number}.pdf`);
  
  if (!existsSync(pdfPath)) continue;
  
  const parsed = parseItemsFromPDF(pdfPath);
  
  // Filter out items with no value
  const validItems = parsed.items.filter(item => (item.total_gross || 0) > 0);
  
  if (validItems.length > 0) {
    inv.items = validItems;
    inv.vendor = parsed.vendor || inv.vendor;
    if (parsed.date) inv.date = parsed.date;
    if (parsed.orderNumber) inv.order_number = parsed.orderNumber;
    if (parsed.totalVat) inv.vat_amount = parsed.totalVat;
    
    // Calculate category breakdown (with VAT included)
    inv.category_breakdown = {};
    for (const item of inv.items) {
      const cat = item.category;
      const amount = item.total_gross || 0;
      inv.category_breakdown[cat] = (inv.category_breakdown[cat] || 0) + amount;
    }
    
    // Set primary category as the one with highest spend
    const sortedCats = Object.entries(inv.category_breakdown).sort((a, b) => b[1] - a[1]);
    inv.category = sortedCats[0]?.[0] || 'otros';
    
    // Recalculate total from items if we have good item data
    const itemsTotal = validItems.reduce((s, i) => s + (i.total_gross || 0), 0);
    if (itemsTotal > 0 && Math.abs(itemsTotal - inv.total) < 1) {
      inv.total = itemsTotal;
    }
    
    totalItemsParsed += validItems.length;
    invoicesUpdated++;
  } else if (inv.total > 0) {
    // No items parsed, use invoice-level category
    inv.category_breakdown = { [inv.category || 'otros']: inv.total };
  }
}

writeFileSync(INVOICES_FILE, JSON.stringify(invoices, null, 2));

// Calculate final stats
const categoryTotals = {};
let grandTotal = 0;
let totalVat = 0;

for (const inv of invoices) {
  if (inv.category_breakdown) {
    for (const [cat, amount] of Object.entries(inv.category_breakdown)) {
      categoryTotals[cat] = (categoryTotals[cat] || 0) + amount;
      grandTotal += amount;
    }
  }
  totalVat += inv.vat_amount || 0;
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Invoices processed: ${invoicesUpdated}`);
console.log(`Total items (with value): ${totalItemsParsed}`);
console.log(`\nSpending by category (VAT included):`);

const sorted = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);
for (const [cat, total] of sorted) {
  console.log(`  ${cat.padEnd(10)}: €${total.toFixed(2)}`);
}
console.log(`  ${'─'.repeat(20)}`);
console.log(`  TOTAL     : €${grandTotal.toFixed(2)}`);
console.log(`  VAT       : €${totalVat.toFixed(2)}`);
