#!/usr/bin/env python3
"""
Import Amazon Business CSV report into invoices.json
Maps Amazon categories to simplified spending categories with VAT
"""

import csv
import json
import re
from collections import defaultdict
from pathlib import Path

CSV_PATH = Path('./data/amazon-business-report-12m.csv')
OUTPUT_PATH = Path('./data/invoices.json')

# Category mapping from Amazon SEGMENTO to our simplified categories
CATEGORY_MAP = {
    'Ropa': ('👕', 'Ropa/Calzado'),
    'Maletas': ('👕', 'Ropa/Calzado'),
    'Aseo Personal': ('🧴', 'Higiene'),
    'Alimentos': ('🍕', 'Alimentación'),
    'Bebidas': ('🍷', 'Bebidas'),
    'Tabaco': ('🚬', 'Otros'),
    'Artículos Domésticos': ('🏠', 'Hogar'),
    'Electrónicos de Consumo': ('📱', 'Electrónica'),
    'Material Vivo Vegetal': ('🌱', 'Plantas'),
    'Material Vivo Animal': ('🐕', 'Mascotas'),
    'Juegos': ('🎮', 'Juegos'),
    'Juguetes': ('🧸', 'Juguetes'),
    'Artes': ('🎨', 'Arte'),
    'Limpieza': ('🧹', 'Limpieza'),
    'Muebles': ('🛋️', 'Muebles'),
    'Decoración': ('🖼️', 'Decoración'),
    'Tecnologías de Información': ('💻', 'Tecnología'),
    'Telecomunicaciones': ('📞', 'Telecom'),
    'Oficina': ('📎', 'Oficina'),
    'Eléctricos': ('💡', 'Electricidad'),
    'Iluminación': ('💡', 'Electricidad'),
    'Papel': ('📦', 'Papel'),
    'Energía': ('⚡', 'Energía'),
    'Fotografía': ('📷', 'Fotografía'),
    'Audiovisual': ('🎬', 'Audiovisual'),
    'Deportes': ('⚽', 'Deportes'),
    'Recreación': ('🎯', 'Ocio'),
    'Construcción': ('🔨', 'Bricolaje'),
    'Herramienta': ('🔧', 'Herramientas'),
    'Alimentos y Bebidas': ('🍳', 'Cocina'),
    'Servicios de Alimentos': ('🍳', 'Cocina'),
    'Seguridad': ('🔒', 'Seguridad'),
    'Médico': ('💊', 'Salud'),
    'financieros': ('💳', 'Servicios'),
    'Publicaciones': ('📚', 'Libros'),
}

def get_category(segmento):
    """Map Amazon segment to simplified category"""
    if not segmento:
        return ('📦', 'Otros')
    
    for keyword, (emoji, name) in CATEGORY_MAP.items():
        if keyword.lower() in segmento.lower():
            return (emoji, name)
    
    return ('📦', 'Otros')

def parse_amount(s):
    """Parse Spanish-format amount (comma decimal) to float"""
    if not s or s == 'N/A' or s == '':
        return 0.0
    # Remove quotes and handle Spanish number format
    s = s.replace('"', '').replace('=', '').strip()
    # Replace comma with dot for decimal
    s = s.replace(',', '.')
    try:
        return float(s)
    except:
        return 0.0

def parse_vat_rate(s):
    """Extract VAT percentage from string like '10%' or '21%'"""
    if not s:
        return 0
    match = re.search(r'(\d+)%', str(s))
    return int(match.group(1)) if match else 0

def main():
    print('Reading CSV...')
    
    orders = defaultdict(lambda: {
        'items': [],
        'subtotal': 0,
        'tax': 0,
        'total': 0,
        'category_breakdown': defaultdict(float),
    })
    
    with open(CSV_PATH, 'r', encoding='utf-8-sig') as f:  # utf-8-sig handles BOM
        # Read first line to get headers
        reader = csv.DictReader(f)
        
        for row in reader:
            order_no = row.get('Número de pedido', '')
            order_date = row.get('Fecha del pedido', '')
            
            if not order_no or not order_date:
                continue
            
            # Parse date (DD/MM/YYYY -> YYYY-MM-DD)
            try:
                day, month, year = order_date.split('/')
                iso_date = f'{year}-{month.zfill(2)}-{day.zfill(2)}'
            except:
                continue
            
            segmento = row.get('SEGMENTO', '')
            emoji, cat_name = get_category(segmento)
            
            title = row.get('Título', 'Unknown item')[:100]
            subtotal = parse_amount(row.get('Subtotal de artículo', '0'))
            tax = parse_amount(row.get('Impuesto de artículo', '0'))
            total = parse_amount(row.get('Total neto del artículo', '0'))
            quantity = int(row.get('Cantidad de artículos', '1') or '1')
            vat_rate = parse_vat_rate(row.get('Tasa de IVA del subtotal de artículo', ''))
            seller = row.get('Nombre del vendedor', 'Amazon')
            asin = row.get('ASIN', '')
            
            order = orders[order_no]
            order['order_id'] = order_no
            order['date'] = iso_date
            order['vendor'] = 'Amazon EU' if 'Amazon' in seller else seller
            
            # Add item
            order['items'].append({
                'name': title,
                'quantity': quantity,
                'unit_price': round(subtotal / max(quantity, 1), 2),
                'total': round(total, 2),
                'vat_rate': vat_rate,
                'vat_amount': round(tax, 2),
                'category': cat_name,
                'category_emoji': emoji,
                'asin': asin,
            })
            
            # Update totals
            order['subtotal'] += subtotal
            order['tax'] += tax
            order['total'] += total
            
            # Update category breakdown
            cat_key = f'{emoji} {cat_name}'
            order['category_breakdown'][cat_key] += total
    
    # Convert to list and format
    invoices = []
    for order in orders.values():
        # Round amounts
        order['subtotal'] = round(order['subtotal'], 2)
        order['tax'] = round(order['tax'], 2)
        order['total'] = round(order['total'], 2)
        
        # Convert category breakdown to regular dict with rounded values
        order['category_breakdown'] = {
            k: round(v, 2) for k, v in order['category_breakdown'].items()
        }
        
        invoices.append(order)
    
    # Sort by date descending
    invoices.sort(key=lambda x: x['date'], reverse=True)
    
    # Calculate summary
    total_spend = sum(inv['total'] for inv in invoices)
    total_items = sum(len(inv['items']) for inv in invoices)
    
    # Aggregate category totals
    category_totals = defaultdict(float)
    for inv in invoices:
        for cat, amount in inv['category_breakdown'].items():
            category_totals[cat] += amount
    
    print(f'\n=== Import Summary ===')
    print(f'Orders: {len(invoices)}')
    print(f'Items: {total_items}')
    print(f'Total: €{total_spend:,.2f}')
    print(f'\nCategory Breakdown:')
    
    for cat, amount in sorted(category_totals.items(), key=lambda x: -x[1]):
        print(f'  {cat}: €{amount:,.2f}')
    
    # Write output
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(invoices, f, indent=2, ensure_ascii=False)
    
    print(f'\nWritten {len(invoices)} invoices to {OUTPUT_PATH}')

if __name__ == '__main__':
    main()
