import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = '/home/albert/clawd/apps/amazon-invoices/data';
const PDFS_DIR = join(DATA_DIR, 'pdfs');
const INVOICES_FILE = join(DATA_DIR, 'invoices.json');

// Category keywords - order matters (more specific first)
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
    // Use -layout for better table structure
    const text = execSync(`pdftotext -layout "${pdfPath}" - 2>/dev/null`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    
    const items = [];
    const lines = text.split('\n');
    
    // Find item lines - they typically have a price pattern like "XX,XX €"
    // and appear after "Descripción" header
    let inItemsSection = false;
    let currentDesc = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.includes('Descripción') && line.includes('Cant.')) {
        inItemsSection = true;
        continue;
      }
      
      if (inItemsSection) {
        // Look for line with price pattern: number €
        const priceMatch = line.match(/(\d+[.,]\d{2})\s*€\s+(\d+[.,]\d{2})\s*€\s*$/);
        if (priceMatch) {
          // Extract description - everything before the first number sequence
          const descMatch = line.match(/^\s*(.+?)\s+\d+\s+[\d.,]+\s*€/);
          let desc = descMatch ? descMatch[1].trim() : '';
          
          // If description is too short, it might be continuation of previous line
          if (desc.length < 10 && currentDesc) {
            desc = currentDesc + ' ' + desc;
          }
          
          // Clean up description
          desc = desc.replace(/\s+/g, ' ').trim();
          
          if (desc.length > 5) {
            const total = parseFloat(priceMatch[2].replace(',', '.'));
            items.push({
              description: desc,
              total: total,
              category: categorizeItem(desc)
            });
          }
          currentDesc = '';
        } else if (line.trim().length > 10 && !line.includes('IVA') && !line.includes('Total') && !line.includes('Envío')) {
          // Accumulate multi-line description
          currentDesc += ' ' + line.trim();
        }
        
        // Stop at page break or totals section
        if (line.includes('Total') && line.includes('€') && !line.includes('Precio total')) {
          inItemsSection = false;
        }
      }
    }
    
    // Also try to extract using ASIN markers
    const asinPattern = /([A-Za-zÀ-ÿ0-9 ,.'()\-\/]+?)\s*\nASIN:\s*[A-Z0-9]+/g;
    let match;
    while ((match = asinPattern.exec(text)) !== null) {
      const desc = match[1].trim();
      // Check if we already have this item
      if (desc.length > 10 && !items.find(i => i.description.includes(desc.substring(0, 20)))) {
        // Try to find the price for this item
        const priceMatch = text.match(new RegExp(desc.substring(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?(\\d+[.,]\\d{2})\\s*€\\s+(\\d+[.,]\\d{2})\\s*€', 'i'));
        if (priceMatch) {
          items.push({
            description: desc,
            total: parseFloat(priceMatch[2].replace(',', '.')),
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
    
    // Extract total from invoice
    const totalMatch = text.match(/Total\s+pendiente\s+([\d.,]+)\s*€/i) || text.match(/Total[:\s]+([\d.,]+)\s*€/i);
    const invoiceTotal = totalMatch ? parseFloat(totalMatch[1].replace(',', '.')) : 0;
    
    // Extract order number
    const orderMatch = text.match(/(\d{3}-\d{7}-\d{7})/);
    const orderNumber = orderMatch ? orderMatch[1] : '';
    
    return { items, vendor, date, orderNumber, invoiceTotal };
  } catch (err) {
    return { items: [], vendor: 'Unknown', date: '', orderNumber: '', invoiceTotal: 0 };
  }
}

// Load existing invoices
const invoices = JSON.parse(readFileSync(INVOICES_FILE, 'utf-8'));

let totalItemsParsed = 0;
let invoicesUpdated = 0;
let multiItemInvoices = 0;

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
      multiItemInvoices++;
      console.log(`\n${inv.invoice_number}: ${parsed.items.length} items (€${inv.total})`);
      for (const item of parsed.items) {
        console.log(`  [${item.category.padEnd(8)}] €${(item.total || 0).toFixed(2).padStart(6)}: ${item.description?.substring(0, 55)}...`);
      }
    }
  }
}

writeFileSync(INVOICES_FILE, JSON.stringify(invoices, null, 2));

console.log(`\n${'='.repeat(50)}`);
console.log(`Invoices with items: ${invoicesUpdated}`);
console.log(`Multi-item invoices: ${multiItemInvoices}`);
console.log(`Total items parsed: ${totalItemsParsed}`);

// Calculate overall category breakdown
const categoryTotals = {};
for (const inv of invoices) {
  if (inv.category_breakdown) {
    for (const [cat, amount] of Object.entries(inv.category_breakdown)) {
      categoryTotals[cat] = (categoryTotals[cat] || 0) + amount;
    }
  } else {
    categoryTotals[inv.category] = (categoryTotals[inv.category] || 0) + (inv.total || 0);
  }
}

console.log(`\nSpending by category (item-level):`);
const sorted = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);
for (const [cat, total] of sorted) {
  console.log(`  ${cat.padEnd(10)}: €${total.toFixed(2)}`);
}
console.log(`  ${'─'.repeat(20)}`);
console.log(`  TOTAL     : €${sorted.reduce((s, [_, v]) => s + v, 0).toFixed(2)}`);
