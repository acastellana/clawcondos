import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = '/home/albert/clawd/apps/amazon-invoices/data';
const PDFS_DIR = join(DATA_DIR, 'pdfs');
const INVOICES_FILE = join(DATA_DIR, 'invoices.json');

// Category keywords
const CATEGORY_KEYWORDS = {
  mascotas: ['perro', 'gato', 'mascota', 'pet', 'cachorro', 'puppy', 'kitten', 'pienso', 'eukanuba', 'royal canin', 'acana', 'orijen', 'dog', 'cat', 'collar', 'correa', 'comedero', 'rascador', 'arenero', 'chuches perro', 'snack perro', 'hueso', 'juguete perro', 'cama perro', 'transportín'],
  comida: ['café', 'coffee', 'atún', 'tuna', 'aceite', 'oliva', 'alimenta', 'galleta', 'leche', 'agua mineral', 'bebida', 'chocolate', 'snack', 'frutos secos', 'pasta', 'arroz', 'conserva', 'mermelada', 'miel', 'azúcar', 'sal', 'especias', 'té', 'infusión', 'zumo', 'refresco', 'cerveza', 'vino', 'cacao', 'cereales'],
  hogar: ['hogar', 'limpi', 'clean', 'detergent', 'lenor', 'suavizante', 'baul', 'resina', 'barbacoa', 'bbq', 'grill', 'jardín', 'garden', 'aspirador', 'mueble', 'cocina', 'baño', 'cama', 'almohada', 'sábana', 'toalla', 'cortina', 'alfombra', 'lámpara', 'bombilla', 'enchufe', 'estantería', 'organizador', 'caja', 'papelera', 'escoba', 'fregona', 'cubo', 'bolsa basura', 'ambientador', 'vela', 'planta', 'maceta', 'riego'],
  tech: ['pantalla', 'screen', 'led', 'cámara', 'camera', 'ipad', 'tablet', 'usb', 'cable', 'wifi', 'bluetooth', 'smart', 'alexa', 'echo', 'kindle', 'ordenador', 'laptop', 'ratón', 'teclado', 'monitor', 'cargador', 'batería', 'auricular', 'altavoz', 'hdmi', 'adaptador', 'hub', 'ssd', 'disco', 'memoria', 'tarjeta sd', 'powerbank', 'funda', 'protector', 'soporte', 'trípode', 'micrófono', 'webcam', 'router', 'switch'],
  personal: ['peluquería', 'hair', 'belleza', 'beauty', 'bebé', 'baby', 'pañal', 'maquillaje', 'perfume', 'crema', 'champú', 'gel', 'desodorante', 'cepillo dientes', 'pasta dientes', 'afeitado', 'depilación', 'uñas', 'labios', 'ojos', 'facial', 'corporal', 'protector solar', 'after sun'],
  oficina: ['oficina', 'office', 'papel', 'impresora', 'tinta', 'toner', 'bolígrafo', 'carpeta', 'archivador', 'grapadora', 'clip', 'sobre', 'etiqueta', 'calculadora', 'agenda', 'cuaderno', 'post-it', 'rotulador', 'tijeras', 'cutter', 'pegamento', 'celo'],
  ropa: ['camiseta', 'pantalón', 'vestido', 'falda', 'chaqueta', 'abrigo', 'jersey', 'sudadera', 'calcetines', 'ropa interior', 'pijama', 'bañador', 'bikini', 'zapatos', 'zapatillas', 'botas', 'sandalias', 'bolso', 'mochila', 'cinturón', 'gorra', 'sombrero', 'guantes', 'bufanda'],
};

function categorize(text) {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return category;
      }
    }
  }
  return 'otros';
}

// Load invoices
const invoices = JSON.parse(readFileSync(INVOICES_FILE, 'utf-8'));

let updated = 0;
let categorized = { mascotas: 0, comida: 0, hogar: 0, tech: 0, personal: 0, oficina: 0, ropa: 0, otros: 0 };

for (const inv of invoices) {
  const pdfPath = join(PDFS_DIR, `${inv.invoice_number}.pdf`);
  
  try {
    const text = execSync(`pdftotext "${pdfPath}" - 2>/dev/null`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    
    // Extract item descriptions
    const descMatch = text.match(/Descripción[\s\S]*?(?=Cant\.|Cantidad|$)/gi);
    const itemsText = descMatch ? descMatch.join(' ') : '';
    
    // Also get full text for categorization
    const fullText = text + ' ' + (inv.vendor || '');
    
    // Try to extract better vendor name if current is "Factura" or "Amazon (direct)"
    if (inv.vendor === 'Factura' || inv.vendor === 'Amazon (direct)') {
      const vendorMatch = text.match(/Vendido por\s+([A-Za-z0-9 .,&'-]+(?:S\.?L\.?U?\.?|GmbH|Inc\.?|Ltd\.?|S\.?A\.?)?)/i);
      if (vendorMatch && vendorMatch[1].trim() !== 'Amazon') {
        inv.vendor = vendorMatch[1].trim();
      } else {
        inv.vendor = 'Amazon EU';
      }
    }
    
    // Extract items if not present
    if (!inv.items || inv.items.length === 0) {
      const itemMatches = text.matchAll(/([A-Za-zÀ-ÿ0-9 ,.'()-]+)\s+(\d+)\s+[\d,]+\s*€\s+\d+%/g);
      inv.items = [];
      for (const m of itemMatches) {
        if (m[1].length > 10 && !m[1].match(/^(Total|Envío|IVA|Precio)/i)) {
          inv.items.push({ description: m[1].trim(), quantity: parseInt(m[2]) });
        }
      }
    }
    
    // Categorize based on full text
    const newCategory = categorize(fullText + ' ' + itemsText + ' ' + inv.items.map(i => i.description || '').join(' '));
    
    if (inv.category === 'otros' && newCategory !== 'otros') {
      inv.category = newCategory;
      updated++;
      console.log(`${inv.invoice_number}: ${inv.vendor} → ${newCategory}`);
    }
    
    categorized[inv.category]++;
    
  } catch (err) {
    categorized[inv.category]++;
  }
}

writeFileSync(INVOICES_FILE, JSON.stringify(invoices, null, 2));

console.log(`\nUpdated ${updated} invoices`);
console.log('\nCategory breakdown:');
for (const [cat, count] of Object.entries(categorized)) {
  if (count > 0) console.log(`  ${cat}: ${count}`);
}
