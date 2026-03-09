#!/usr/bin/env python3
"""Parse Amazon invoice PDFs and output JSON"""

import sys
import json
import subprocess
import re
from pathlib import Path
from datetime import datetime

SPANISH_MONTHS = {
    'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4,
    'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8,
    'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
}

def parse_spanish_date(text):
    """Parse dates like '14 diciembre 2023'"""
    match = re.search(r'(\d{1,2})\s+(\w+)\s+(\d{4})', text)
    if match:
        day, month_str, year = match.groups()
        month = SPANISH_MONTHS.get(month_str.lower())
        if month:
            return f"{year}-{month:02d}-{int(day):02d}"
    # Try DD/MM/YYYY format
    match = re.search(r'(\d{1,2})/(\d{1,2})/(\d{4})', text)
    if match:
        day, month, year = match.groups()
        return f"{year}-{int(month):02d}-{int(day):02d}"
    return None

def parse_amount(text):
    """Parse amount like '18,00 €' or '18.00'"""
    match = re.search(r'(\d+)[.,](\d{2})', text)
    if match:
        return float(f"{match.group(1)}.{match.group(2)}")
    return 0.0

def extract_pdf_text(pdf_path):
    """Extract text from PDF using pdftotext"""
    result = subprocess.run(
        ['pdftotext', '-layout', str(pdf_path), '-'],
        capture_output=True, text=True
    )
    return result.stdout

def parse_invoice(pdf_path):
    """Parse a single invoice PDF"""
    text = extract_pdf_text(pdf_path)
    pdf_path = Path(pdf_path)
    
    invoice = {
        'invoice_number': pdf_path.stem,
        'order_number': pdf_path.parent.name,
        'date': None,
        'total': 0.0,
        'vat_amount': 0.0,
        'subtotal_net': 0.0,
        'vendor': '',
        'items': [],
        'source_file': str(pdf_path)
    }
    
    lines = text.split('\n')
    
    for i, line in enumerate(lines):
        # Date - "Fecha de la factura" or "de la entrega"
        if 'Fecha de la factura' in line or 'de la entrega' in line:
            # Date might be on same line or next line
            date = parse_spanish_date(line)
            if not date and i + 1 < len(lines):
                date = parse_spanish_date(lines[i + 1])
            if date:
                invoice['date'] = date
        
        # Vendor - "Vendido por"
        if 'Vendido por' in line:
            match = re.search(r'Vendido por\s+(.+?)(?:\s{2,}|$)', line)
            if match:
                invoice['vendor'] = match.group(1).strip()
        
        # Total - multiple patterns
        if 'Total' in line and '€' in line:
            amount = parse_amount(line)
            if amount > invoice['total']:
                invoice['total'] = amount
        
        if 'Total pendiente' in line:
            invoice['total'] = parse_amount(line)
        
        # VAT - look for IVA amount
        if re.search(r'IVA\s*\d+%', line) or ('IVA' in line and '€' in line):
            # Look for the amount at the end
            amounts = re.findall(r'(\d+[.,]\d{2})\s*€?', line)
            if amounts:
                vat = parse_amount(amounts[-1])
                if vat > 0 and vat < invoice['total']:
                    invoice['vat_amount'] = vat
        
        # Product descriptions - look for ASIN pattern
        if 'ASIN:' in line and i > 0:
            # Product description is on previous line
            desc_line = lines[i - 1].strip()
            # Extract just the description part
            desc = re.sub(r'\d+[.,]\d{2}\s*€?\s*\d*%?', '', desc_line).strip()
            if desc and len(desc) > 10:
                invoice['items'].append({
                    'description': desc[:200],
                    'quantity': 1,
                    'total_gross': invoice['total']
                })
    
    # Calculate net from total - VAT
    invoice['subtotal_net'] = round(invoice['total'] - invoice['vat_amount'], 2)
    
    # If no items found, add generic one
    if not invoice['items']:
        invoice['items'].append({
            'description': 'Item from invoice',
            'quantity': 1,
            'total_gross': invoice['total']
        })
    
    return invoice

def main():
    if len(sys.argv) < 2:
        print("Usage: parse-invoice.py <pdf_or_directory>", file=sys.stderr)
        sys.exit(1)
    
    path = Path(sys.argv[1])
    invoices = []
    
    if path.is_file():
        invoices.append(parse_invoice(path))
    else:
        # Find all INV-*.pdf files
        for pdf in path.rglob('INV-*.pdf'):
            try:
                invoices.append(parse_invoice(pdf))
            except Exception as e:
                print(f"Error parsing {pdf}: {e}", file=sys.stderr)
    
    print(json.dumps(invoices, indent=2, ensure_ascii=False))

if __name__ == '__main__':
    main()
