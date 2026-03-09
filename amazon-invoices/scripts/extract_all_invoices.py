#!/usr/bin/env python3
"""
Extract structured data from ALL Amazon invoice PDFs using pdftotext + Gemini CLI.
Uses text extraction (fast) not vision. Saves progress incrementally.
"""

import os
import sys
import json
import time
import re
import subprocess
from pathlib import Path
from datetime import datetime

# Configuration
DATA_DIR = Path(__file__).parent.parent / "data"
PDFS_DIR = DATA_DIR / "pdfs"
OUTPUT_DIR = DATA_DIR / "extracted"
PROGRESS_FILE = OUTPUT_DIR / "progress.json"
RESULTS_FILE = OUTPUT_DIR / "all_invoices.json"
ERRORS_FILE = OUTPUT_DIR / "errors.json"

# Rate limiting - slower to avoid overloading API
REQUESTS_PER_MINUTE = 20  # ~3 seconds between requests
DELAY_BETWEEN_REQUESTS = 60 / REQUESTS_PER_MINUTE

EXTRACTION_PROMPT = '''Analyze this Amazon invoice/order text and extract the data into JSON.

Return ONLY valid JSON (no markdown, no explanation) with this structure:
{
    "order_id": "XXX-XXXXXXX-XXXXXXX format",
    "invoice_number": "factura number if shown (e.g. ES6CQGOAEUI)",
    "invoice_date": "YYYY-MM-DD",
    "order_date": "YYYY-MM-DD",
    "seller": {
        "name": "seller/vendor name",
        "tax_id": "CIF/NIF/VAT (e.g. ESW0184081H)",
        "address": "seller address"
    },
    "buyer": {
        "name": "LAYERONE SLU or buyer name",
        "tax_id": "ESB67716035 or buyer VAT",
        "address": "buyer address"
    },
    "items": [
        {
            "description": "full product description",
            "asin": "ASIN code if shown",
            "quantity": 1,
            "unit_price_net": 10.00,
            "vat_rate": 21,
            "vat_amount": 2.10,
            "total_gross": 12.10
        }
    ],
    "subtotal_net": 0.00,
    "shipping_net": 0.00,
    "shipping_vat": 0.00,
    "total_vat": 0.00,
    "total_gross": 0.00,
    "payment_method": "Visa/Mastercard/etc if shown",
    "delivery_address": "shipping address",
    "is_official_invoice": true,
    "document_type": "invoice|order_details",
    "notes": null
}

RULES:
1. Extract ALL line items with their prices
2. All prices as numbers (no € symbols)
3. Use null for fields not visible
4. order_id format: XXX-XXXXXXX-XXXXXXX
5. is_official_invoice=true if it says "Factura" with invoice number, false for order pages
6. Return ONLY the JSON object

TEXT TO ANALYZE:
'''

def extract_text_from_pdf(pdf_path):
    """Extract text from PDF using pdftotext."""
    try:
        result = subprocess.run(
            ['pdftotext', '-layout', str(pdf_path), '-'],
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode != 0:
            return None, f"pdftotext error: {result.stderr[:100]}"
        
        text = result.stdout.strip()
        if len(text) < 50:
            return None, "Too little text extracted"
        return text, None
    except Exception as e:
        return None, str(e)

def extract_order_id_from_filename(filename):
    """Extract order ID from PDF filename."""
    match = re.search(r'([0-9A-Z]{3}-[0-9]{7}-[0-9]{7})', filename)
    return match.group(1) if match else None

def extract_date_from_filename(filename):
    """Extract date from PDF filename for sorting (newest first)."""
    # Official invoices: 20260131_Tax Invoice_408-xxx.pdf
    match = re.match(r'^(\d{8})_', filename)
    if match:
        return match.group(1)
    # Browser captures: just order ID, use a default old date
    return "19700101"

def extract_with_gemini_cli(text, filename):
    """Use Gemini CLI to structure the extracted text."""
    try:
        prompt = '''Extract from invoice text above. Order ID format is XXX-XXXXXXX-XXXXXXX.
Return ONLY JSON (no markdown): {"order_id": "...", "invoice_number": "...", "invoice_date": "YYYY-MM-DD", "order_date": "YYYY-MM-DD",
"seller": {"name": "...", "tax_id": "...", "address": "..."},
"buyer": {"name": "...", "tax_id": "...", "address": "..."},
"items": [{"description": "...", "asin": "...", "quantity": 1, "unit_price_net": 0.00, "vat_rate": 21, "vat_amount": 0.00, "total_gross": 0.00}],
"subtotal_net": 0.00, "shipping_net": 0.00, "total_vat": 0.00, "total_gross": 0.00,
"is_official_invoice": true, "document_type": "invoice"}
Use null for missing fields. All prices as numbers.'''
        
        result = subprocess.run(
            ['gemini', '-m', 'gemini-2.0-flash', '-p', prompt],
            input=text[:6000],
            capture_output=True,
            text=True,
            timeout=90
        )
        
        if result.returncode != 0:
            error_msg = result.stderr or result.stdout
            return None, f"CLI error (code {result.returncode}): {error_msg[:200]}"
        
        response = result.stdout.strip()
        
        # Clean markdown wrapper if present
        if response.startswith("```"):
            lines = response.split('\n')
            response = '\n'.join(lines[1:-1] if lines[-1].strip() == '```' else lines[1:])
            response = response.strip()
        if response.startswith("json"):
            response = response[4:].strip()
        
        # Find JSON in response
        json_start = response.find('{')
        json_end = response.rfind('}') + 1
        if json_start >= 0 and json_end > json_start:
            response = response[json_start:json_end]
        
        data = json.loads(response)
        data['_source_file'] = filename
        data['_extracted_at'] = datetime.now().isoformat()
        return data, None
        
    except json.JSONDecodeError as e:
        return None, f"JSON parse error: {str(e)[:100]}"
    except subprocess.TimeoutExpired:
        return None, "Timeout (60s)"
    except Exception as e:
        return None, f"Error: {str(e)[:200]}"

def load_progress():
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE, 'r') as f:
            return json.load(f)
    return {"processed": [], "last_index": 0}

def save_progress(progress):
    with open(PROGRESS_FILE, 'w') as f:
        json.dump(progress, f)

def load_results():
    if RESULTS_FILE.exists():
        with open(RESULTS_FILE, 'r') as f:
            return json.load(f)
    return {}

def save_results(results):
    with open(RESULTS_FILE, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

def load_errors():
    if ERRORS_FILE.exists():
        with open(ERRORS_FILE, 'r') as f:
            return json.load(f)
    return []

def save_errors(errors):
    with open(ERRORS_FILE, 'w', encoding='utf-8') as f:
        json.dump(errors, f, indent=2, ensure_ascii=False)

def export_to_csv(results, output_path):
    """Export results to CSV for easy review."""
    import csv
    
    rows = []
    for order_id, data in results.items():
        if not isinstance(data, dict):
            continue
            
        items = data.get('items', []) or []
        if not items:
            items = [{}]
            
        for idx, item in enumerate(items):
            row = {
                'order_id': order_id,
                'item_index': idx + 1,
                'invoice_number': data.get('invoice_number'),
                'invoice_date': data.get('invoice_date'),
                'order_date': data.get('order_date'),
                'seller_name': (data.get('seller') or {}).get('name'),
                'seller_tax_id': (data.get('seller') or {}).get('tax_id'),
                'buyer_name': (data.get('buyer') or {}).get('name'),
                'buyer_tax_id': (data.get('buyer') or {}).get('tax_id'),
                'item_description': item.get('description'),
                'item_asin': item.get('asin'),
                'item_qty': item.get('quantity'),
                'item_unit_price_net': item.get('unit_price_net'),
                'item_vat_rate': item.get('vat_rate'),
                'item_vat_amount': item.get('vat_amount'),
                'item_total_gross': item.get('total_gross'),
                'subtotal_net': data.get('subtotal_net'),
                'shipping_net': data.get('shipping_net'),
                'total_vat': data.get('total_vat'),
                'total_gross': data.get('total_gross'),
                'is_official_invoice': data.get('is_official_invoice'),
                'document_type': data.get('document_type'),
                'source_file': data.get('_source_file'),
            }
            rows.append(row)
    
    if rows:
        with open(output_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)
        return len(rows)
    return 0

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Extract data from all Amazon invoice PDFs")
    parser.add_argument("--limit", type=int, help="Limit number of PDFs to process")
    parser.add_argument("--resume", action="store_true", help="Resume from last position")
    parser.add_argument("--reprocess", type=str, help="Reprocess specific order ID")
    parser.add_argument("--export-csv", action="store_true", help="Export results to CSV")
    parser.add_argument("--dry-run", action="store_true", help="List files without processing")
    parser.add_argument("--test-text", type=str, help="Test text extraction on one file")
    args = parser.parse_args()
    
    OUTPUT_DIR.mkdir(exist_ok=True)
    
    # Sort by date, newest first
    pdf_files = sorted(
        [f for f in os.listdir(PDFS_DIR) if f.endswith('.pdf')],
        key=lambda f: extract_date_from_filename(f),
        reverse=True  # Newest first
    )
    print(f"Found {len(pdf_files)} PDF files")
    
    if args.test_text:
        pdf_path = PDFS_DIR / args.test_text
        if not pdf_path.exists():
            # Try to find it
            matches = [f for f in pdf_files if args.test_text in f]
            if matches:
                pdf_path = PDFS_DIR / matches[0]
        text, err = extract_text_from_pdf(pdf_path)
        if err:
            print(f"Error: {err}")
        else:
            print(f"Extracted {len(text)} chars:\n{text[:2000]}")
        return 0
    
    if args.dry_run:
        print("\n--- DRY RUN ---")
        for i, f in enumerate(pdf_files[:20]):
            order_id = extract_order_id_from_filename(f)
            print(f"  {i+1}. {f} → {order_id}")
        print(f"  ... and {len(pdf_files) - 20} more")
        return 0
    
    progress = load_progress()
    results = load_results()
    errors = load_errors()
    
    print(f"Loaded {len(results)} existing results, {len(errors)} errors")
    
    if args.export_csv:
        csv_path = OUTPUT_DIR / "all_invoices.csv"
        count = export_to_csv(results, csv_path)
        print(f"Exported {count} rows to {csv_path}")
        return 0
    
    # Verify Gemini CLI
    print("Testing Gemini CLI...")
    test = subprocess.run(['gemini', '--version'], capture_output=True, text=True)
    if test.returncode != 0:
        print("❌ Gemini CLI not working")
        return 1
    print("✅ Gemini CLI ready")
    
    # Determine files to process
    if args.reprocess:
        files_to_process = [f for f in pdf_files if args.reprocess in f]
        if not files_to_process:
            print(f"No files found matching: {args.reprocess}")
            return 1
    elif args.resume:
        processed_set = set(progress.get('processed', []))
        files_to_process = [f for f in pdf_files if f not in processed_set]
        print(f"Resuming: {len(files_to_process)} files remaining")
    else:
        files_to_process = pdf_files
    
    if args.limit:
        files_to_process = files_to_process[:args.limit]
    
    print(f"Processing {len(files_to_process)} files...")
    print(f"Rate: ~{REQUESTS_PER_MINUTE}/min, ETA: {len(files_to_process) / REQUESTS_PER_MINUTE:.1f} minutes\n")
    
    start_time = time.time()
    processed_count = 0
    error_count = 0
    
    for i, filename in enumerate(files_to_process):
        pdf_path = PDFS_DIR / filename
        order_id = extract_order_id_from_filename(filename)
        
        print(f"[{i+1}/{len(files_to_process)}] {filename}", end=" ", flush=True)
        
        # Extract text
        text, text_error = extract_text_from_pdf(pdf_path)
        if text_error:
            print(f"❌ {text_error}")
            errors.append({
                "file": filename,
                "order_id": order_id,
                "error": text_error,
                "timestamp": datetime.now().isoformat()
            })
            error_count += 1
            continue
        
        # Structure with Gemini
        data, extraction_error = extract_with_gemini_cli(text, filename)
        
        if extraction_error:
            print(f"❌ {extraction_error}")
            errors.append({
                "file": filename,
                "order_id": order_id,
                "error": extraction_error,
                "timestamp": datetime.now().isoformat()
            })
            error_count += 1
        else:
            result_order_id = data.get('order_id') or order_id or filename
            results[result_order_id] = data
            progress['processed'].append(filename)
            processed_count += 1
            
            total = data.get('total_gross', '?')
            items_count = len(data.get('items', []) or [])
            doc_type = 'INV' if data.get('is_official_invoice') else 'ORD'
            print(f"✅ €{total} | {items_count} items | {doc_type}")
        
        # Save progress every 10 files
        if (i + 1) % 10 == 0:
            save_progress(progress)
            save_results(results)
            save_errors(errors)
            elapsed = time.time() - start_time
            rate = processed_count / (elapsed / 60) if elapsed > 0 else 0
            print(f"    📊 Saved. Rate: {rate:.1f}/min")
        
        time.sleep(DELAY_BETWEEN_REQUESTS)
    
    # Final save
    save_progress(progress)
    save_results(results)
    save_errors(errors)
    
    csv_path = OUTPUT_DIR / "all_invoices.csv"
    csv_rows = export_to_csv(results, csv_path)
    
    elapsed = time.time() - start_time
    print("\n" + "="*60)
    print("EXTRACTION COMPLETE")
    print("="*60)
    print(f"✅ Processed: {processed_count}")
    print(f"❌ Errors: {error_count}")
    print(f"📊 Total results: {len(results)}")
    print(f"⏱️  Time: {elapsed/60:.1f} minutes")
    print(f"\nOutput files:")
    print(f"  • {RESULTS_FILE}")
    print(f"  • {csv_path} ({csv_rows} rows)")
    if errors:
        print(f"  • {ERRORS_FILE} ({len(errors)} errors)")
    
    return 0 if error_count == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
