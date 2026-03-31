#!/usr/bin/env python3
"""
Validate Amazon invoice PDFs against CSV data using Gemini Vision.
Compares extracted PDF data with the imported CSV to find discrepancies.
"""

import os
import sys
import json
import glob
from pathlib import Path
from datetime import datetime

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

import google.generativeai as genai
from pdf2image import convert_from_path
from PIL import Image
import io

# Configuration
DATA_DIR = Path(__file__).parent.parent / "data"
INVOICES_JSON = DATA_DIR / "invoices.json"
PDFS_DIR = DATA_DIR / "pdfs"
RESULTS_DIR = DATA_DIR / "validation_results"

# Gemini setup - uses GEMINI_API_KEY or GOOGLE_API_KEY env var
def setup_gemini():
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable")
    genai.configure(api_key=api_key)
    # Use Flash for speed/cost, Pro for accuracy
    return genai.GenerativeModel("gemini-2.0-flash")

def load_csv_data():
    """Load the imported invoice data from JSON."""
    with open(INVOICES_JSON, 'r', encoding='utf-8') as f:
        data = json.load(f)
    # Convert to dict keyed by order_id for fast lookup
    invoices = {}
    for key, invoice in data.items():
        if isinstance(invoice, dict) and 'order_id' in invoice:
            invoices[invoice['order_id']] = invoice
    return invoices

def pdf_to_images(pdf_path, dpi=150):
    """Convert PDF pages to PIL Images."""
    try:
        images = convert_from_path(pdf_path, dpi=dpi)
        return images
    except Exception as e:
        print(f"Error converting {pdf_path}: {e}")
        return []

def extract_invoice_data_gemini(model, images):
    """Use Gemini to extract invoice data from images."""
    if not images:
        return None
    
    prompt = """Analyze this Amazon invoice image and extract the following data in JSON format:
{
    "order_id": "the order number (formato: XXX-XXXXXXX-XXXXXXX)",
    "invoice_date": "fecha de la factura (YYYY-MM-DD)",
    "items": [
        {
            "description": "product name/description",
            "quantity": number,
            "unit_price": number (without VAT),
            "vat_rate": number (percentage, e.g. 21),
            "total_with_vat": number
        }
    ],
    "subtotal": number (total without VAT),
    "total_vat": number (total VAT amount),
    "total": number (total with VAT),
    "seller": "seller/vendor name if visible"
}

IMPORTANT:
- Extract ALL items listed
- Prices should be numbers (no currency symbols)
- If a field is not visible, use null
- Order ID format is typically XXX-XXXXXXX-XXXXXXX
- Return ONLY valid JSON, no markdown or explanation"""

    try:
        # Send first page (most invoices are single page)
        response = model.generate_content([prompt, images[0]])
        text = response.text.strip()
        
        # Clean up response (remove markdown if present)
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        text = text.strip()
        
        return json.loads(text)
    except json.JSONDecodeError as e:
        print(f"JSON parse error: {e}")
        print(f"Raw response: {response.text[:500]}")
        return None
    except Exception as e:
        print(f"Gemini error: {e}")
        return None

def compare_data(csv_data, pdf_data):
    """Compare CSV data with PDF extracted data."""
    discrepancies = []
    
    if not pdf_data:
        return [{"type": "extraction_failed", "message": "Could not extract data from PDF"}]
    
    # Compare totals
    csv_total = csv_data.get('total', 0)
    pdf_total = pdf_data.get('total')
    
    if pdf_total is not None:
        diff = abs(float(csv_total) - float(pdf_total))
        if diff > 0.02:  # Allow 2 cent tolerance
            discrepancies.append({
                "type": "total_mismatch",
                "csv_value": csv_total,
                "pdf_value": pdf_total,
                "difference": round(diff, 2)
            })
    
    # Compare item count
    csv_items = len(csv_data.get('items', []))
    pdf_items = len(pdf_data.get('items', []))
    
    if csv_items != pdf_items:
        discrepancies.append({
            "type": "item_count_mismatch",
            "csv_count": csv_items,
            "pdf_count": pdf_items
        })
    
    # Compare order ID
    csv_order = csv_data.get('order_id', '')
    pdf_order = pdf_data.get('order_id', '')
    
    if pdf_order and csv_order != pdf_order:
        discrepancies.append({
            "type": "order_id_mismatch",
            "csv_value": csv_order,
            "pdf_value": pdf_order
        })
    
    return discrepancies

def find_pdf_for_order(order_id):
    """Find PDF file for a given order ID."""
    # Try different naming patterns
    patterns = [
        f"*{order_id}*.pdf",
        f"*{order_id.replace('-', '')}*.pdf",
    ]
    
    for pattern in patterns:
        matches = list(PDFS_DIR.glob(pattern))
        if matches:
            return matches[0]
    
    # Also check subdirectories
    for pattern in patterns:
        matches = list(PDFS_DIR.glob(f"**/{pattern}"))
        if matches:
            return matches[0]
    
    return None

def validate_sample(model, csv_invoices, sample_size=10, order_ids=None):
    """Validate a sample of invoices."""
    results = []
    
    if order_ids:
        orders_to_check = order_ids
    else:
        # Get orders that have PDFs
        orders_with_pdfs = []
        for order_id in csv_invoices.keys():
            if find_pdf_for_order(order_id):
                orders_with_pdfs.append(order_id)
        
        # Sample
        import random
        orders_to_check = random.sample(orders_with_pdfs, min(sample_size, len(orders_with_pdfs)))
    
    print(f"Validating {len(orders_to_check)} invoices...")
    
    for i, order_id in enumerate(orders_to_check):
        print(f"\n[{i+1}/{len(orders_to_check)}] Processing {order_id}...")
        
        csv_data = csv_invoices.get(order_id)
        if not csv_data:
            results.append({
                "order_id": order_id,
                "status": "error",
                "message": "Order not found in CSV"
            })
            continue
        
        pdf_path = find_pdf_for_order(order_id)
        if not pdf_path:
            results.append({
                "order_id": order_id,
                "status": "no_pdf",
                "csv_total": csv_data.get('total')
            })
            continue
        
        # Convert PDF to images
        images = pdf_to_images(pdf_path)
        if not images:
            results.append({
                "order_id": order_id,
                "status": "pdf_error",
                "message": "Could not convert PDF to image"
            })
            continue
        
        # Extract data with Gemini
        pdf_data = extract_invoice_data_gemini(model, images)
        
        # Compare
        discrepancies = compare_data(csv_data, pdf_data)
        
        result = {
            "order_id": order_id,
            "pdf_path": str(pdf_path),
            "csv_total": csv_data.get('total'),
            "pdf_total": pdf_data.get('total') if pdf_data else None,
            "csv_items": len(csv_data.get('items', [])),
            "pdf_items": len(pdf_data.get('items', [])) if pdf_data else 0,
            "status": "match" if not discrepancies else "discrepancy",
            "discrepancies": discrepancies
        }
        results.append(result)
        
        # Print progress
        if discrepancies:
            print(f"  ⚠️  Discrepancies found: {len(discrepancies)}")
            for d in discrepancies:
                print(f"     - {d['type']}: {d}")
        else:
            print(f"  ✅ Match! (Total: €{csv_data.get('total')})")
    
    return results

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Validate Amazon invoices PDF vs CSV")
    parser.add_argument("--sample", type=int, default=10, help="Number of invoices to validate")
    parser.add_argument("--order", type=str, help="Validate specific order ID")
    parser.add_argument("--all", action="store_true", help="Validate all invoices with PDFs")
    args = parser.parse_args()
    
    # Setup
    print("Setting up Gemini...")
    model = setup_gemini()
    
    print("Loading CSV data...")
    csv_invoices = load_csv_data()
    print(f"Loaded {len(csv_invoices)} invoices from CSV")
    
    # Create results dir
    RESULTS_DIR.mkdir(exist_ok=True)
    
    # Validate
    if args.order:
        results = validate_sample(model, csv_invoices, order_ids=[args.order])
    elif args.all:
        results = validate_sample(model, csv_invoices, sample_size=len(csv_invoices))
    else:
        results = validate_sample(model, csv_invoices, sample_size=args.sample)
    
    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_file = RESULTS_DIR / f"validation_{timestamp}.json"
    with open(results_file, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    
    # Summary
    print("\n" + "="*50)
    print("VALIDATION SUMMARY")
    print("="*50)
    
    matches = sum(1 for r in results if r.get('status') == 'match')
    discrepancies = sum(1 for r in results if r.get('status') == 'discrepancy')
    no_pdf = sum(1 for r in results if r.get('status') == 'no_pdf')
    errors = sum(1 for r in results if r.get('status') in ['error', 'pdf_error'])
    
    print(f"✅ Matches: {matches}")
    print(f"⚠️  Discrepancies: {discrepancies}")
    print(f"📄 No PDF: {no_pdf}")
    print(f"❌ Errors: {errors}")
    print(f"\nResults saved to: {results_file}")
    
    return 0 if discrepancies == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
