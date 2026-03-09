#!/usr/bin/env node

/**
 * Import Amazon Business CSV report into invoices.json
 * Maps Amazon categories to simplified spending categories with VAT
 */

import { readFileSync, writeFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

const CSV_PATH = './data/amazon-cleaned.csv';
const OUTPUT_PATH = './data/invoices.json';

// Category mapping from Amazon SEGMENTO to our simplified categories
const CATEGORY_MAP = {
  'Ropa, Maletas y Productos de Aseo Personal': { emoji: '👕', name: 'Ropa/Calzado' },
  'Alimentos, Bebidas y Tabaco': { emoji: '🍕', name: 'Alimentación' },
  'Artículos Domésticos, Suministros y Productos Electrónicos de Consumo': { emoji: '🏠', name: 'Hogar' },
  'Material Vivo Vegetal y Animal, Accesorios y Suministros': { emoji: '🐕', name: 'Mascotas/Plantas' },
  'Instrumentos Musicales, Juegos, Juguetes, Artes, Artesanías y Equipo educativo, Materiales, Accesorios y Suministros': { emoji: '🧸', name: 'Juguetes' },
  'Equipos de Limpieza y Suministros': { emoji: '🧹', name: 'Limpieza' },
  'Muebles, Mobiliario y Decoración': { emoji: '🛋️', name: 'Muebles' },
  'Difusión de Tecnologías de Información y Telecomunicaciones': { emoji: '💻', name: 'Tecnología' },
  'Equipos de Oficina, Accesorios y Suministros': { emoji: '📎', name: 'Oficina' },
  'Componentes, Accesorios y Suministros de Sistemas Eléctricos y de Iluminación': { emoji: '💡', name: 'Electricidad' },
  'Materiales y Productos de Papel': { emoji: '📦', name: 'Papel/Embalaje' },
  'Maquinaria y Accesorios para Generación y Distribución de Energía': { emoji: '⚡', name: 'Energía' },
  'Equipos y Suministros para Impresión, Fotografia y Audiovisuales': { emoji: '📷', name: 'Fotografía' },
  'Equipos, Suministros y Accesorios para Deportes y Recreación': { emoji: '⚽', name: 'Deportes' },
  'Componentes y Suministros para Estructuras, Edificación, Construcción y Obras Civiles': { emoji: '🔨', name: 'Bricolaje' },
  'Maquinaria, Equipo y Suministros para la Industria de Servicios de Alimentos y Bebidas': { emoji: '🍳', name: 'Cocina' },
  'Equipos y Suministros de Defensa, Orden Publico, Proteccion, Vigilancia y Seguridad': { emoji: '🔒', name: 'Seguridad' },
  'Equipo Médico, Accesorios y Suministros': { emoji: '💊', name: 'Salud' },
  'Instrumentos, productos, contratos y acuerdos financieros': { emoji: '💳', name: 'Servicios' },
  'Publicaciones Impresas, Publicaciones Electrónicas y Accesorios': { emoji: '📚', name: 'Libros' },
  'Herramientas y Maquinaria General': { emoji: '🔧', name: 'Herramientas' },
};

function getCategory(segmento) {
  // Try exact match first
  for (const [key, value] of Object.entries(CATEGORY_MAP)) {
    if (segmento.startsWith(key.substring(0, 30))) {
      return value;
    }
  }
  return { emoji: '📦', name: 'Otros' };
}

function parseAmount(str) {
  if (!str || str === 'N/A') return 0;
  return parseFloat(str.replace(/"/g, '').replace(',', '.').trim()) || 0;
}

function parseVatRate(str) {
  if (!str) return 0;
  const match = str.match(/(\d+)%/);
  return match ? parseInt(match[1]) : 0;
}

async function main() {
  console.log('Reading CSV...');
  const csvContent = readFileSync(CSV_PATH, 'utf-8');
  
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  
  console.log(`Parsed ${records.length} rows`);
  
  // Group by order number
  const orderMap = new Map();
  
  for (const row of records) {
    const orderNo = row['Número de pedido'];
    const orderDate = row['Fecha del pedido'];
    
    if (!orderNo || !orderDate) continue;
    
    // Parse date (DD/MM/YYYY -> YYYY-MM-DD)
    const [day, month, year] = orderDate.split('/');
    const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    
    const segmento = row['SEGMENTO'] || '';
    const categoria = getCategory(segmento);
    const title = row['Título'] || 'Unknown item';
    const subtotal = parseAmount(row['Subtotal de artículo']);
    const tax = parseAmount(row['Impuesto de artículo']);
    const total = parseAmount(row['Total neto del artículo']);
    const quantity = parseInt(row['Cantidad de artículos']) || 1;
    const vatRate = parseVatRate(row['Tasa de IVA del subtotal de artículo']);
    const seller = row['Nombre del vendedor'] || 'Amazon';
    const asin = row['ASIN'] || '';
    
    if (!orderMap.has(orderNo)) {
      orderMap.set(orderNo, {
        order_id: orderNo,
        date: isoDate,
        vendor: seller.includes('Amazon') ? 'Amazon EU' : seller,
        items: [],
        subtotal: 0,
        tax: 0,
        total: 0,
        category_breakdown: {},
      });
    }
    
    const order = orderMap.get(orderNo);
    
    // Add item
    order.items.push({
      name: title.substring(0, 100),
      quantity,
      unit_price: subtotal / quantity,
      total: total,
      vat_rate: vatRate,
      vat_amount: tax,
      category: categoria.name,
      category_emoji: categoria.emoji,
      asin,
    });
    
    // Update totals
    order.subtotal += subtotal;
    order.tax += tax;
    order.total += total;
    
    // Update category breakdown
    const catKey = `${categoria.emoji} ${categoria.name}`;
    order.category_breakdown[catKey] = (order.category_breakdown[catKey] || 0) + total;
  }
  
  // Convert to array and sort by date
  const invoices = Array.from(orderMap.values())
    .sort((a, b) => b.date.localeCompare(a.date));
  
  // Round all amounts
  for (const inv of invoices) {
    inv.subtotal = Math.round(inv.subtotal * 100) / 100;
    inv.tax = Math.round(inv.tax * 100) / 100;
    inv.total = Math.round(inv.total * 100) / 100;
    for (const cat of Object.keys(inv.category_breakdown)) {
      inv.category_breakdown[cat] = Math.round(inv.category_breakdown[cat] * 100) / 100;
    }
  }
  
  // Calculate summary stats
  const totalSpend = invoices.reduce((sum, inv) => sum + inv.total, 0);
  const totalItems = invoices.reduce((sum, inv) => sum + inv.items.length, 0);
  
  // Aggregate category totals
  const categoryTotals = {};
  for (const inv of invoices) {
    for (const [cat, amount] of Object.entries(inv.category_breakdown)) {
      categoryTotals[cat] = (categoryTotals[cat] || 0) + amount;
    }
  }
  
  console.log(`\n=== Import Summary ===`);
  console.log(`Orders: ${invoices.length}`);
  console.log(`Items: ${totalItems}`);
  console.log(`Total: €${totalSpend.toFixed(2)}`);
  console.log(`\nCategory Breakdown:`);
  
  const sortedCats = Object.entries(categoryTotals)
    .sort((a, b) => b[1] - a[1]);
  for (const [cat, amount] of sortedCats) {
    console.log(`  ${cat}: €${amount.toFixed(2)}`);
  }
  
  // Write output
  writeFileSync(OUTPUT_PATH, JSON.stringify(invoices, null, 2));
  console.log(`\nWritten to ${OUTPUT_PATH}`);
}

main().catch(console.error);
