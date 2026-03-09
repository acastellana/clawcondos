#!/usr/bin/env python3
"""
Extract structured data from Amazon invoice PDFs using pdftotext + OpenAI API.
Uses gpt-4o-mini for fast, cheap extraction.
Cost: ~$0.001 per invoice (very cheap)
"""

import os
import sys
import json
import time
import re
import subprocess
from pathlib import Path
from datetime import datetime
from openai import OpenAI

# Configuration
DATA_DIR = Path(__file__).parent.parent / "data"
PDFS_DIR = DATA_DIR / "pdfs"
OUTPUT_DIR = DATA_DIR / "extracted"
RESULTS_FILE = OUTPUT_DIR / "all_invoices.json"
ERRORS_FILE = OUTPUT_DIR / "errors.json"

# Rate limiting - gpt-4o-mini allows very high rates
# API calls themselves take ~3-4s, so minimal delay needed
REQUESTS_PER_MINUTE = 120
DELAY_BETWEEN_REQUESTS = 0.2  # Just prevent burst

client = OpenAI()  # Uses OPENAI_API_KEY from env

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
    match = re.match(r'^(\d{8})_', filename)
    if match:
        return match.group(1)
    return "19700101"

def extract_with_openai(text, filename):
    """Use OpenAI API to structure the extracted text."""
    try:
        truncated_text = text[:6000]  # gpt-4o-mini has good context
        
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "Extract invoice data and return JSON only. Use null for missing fields. Prices as numbers."},
                {"role": "user", "content": f"""Extract from this Amazon invoice:

{truncated_text}

Return JSON:
{{"order_id": "XXX-XXXXXXX-XXXXXXX", "invoice_number": "...", "invoice_date": "YYYY-MM-DD", "order_date": "YYYY-MM-DD", "seller": {{"name": "...", "tax_id": "...", "address": "..."}}, "buyer": {{"name": "...", "tax_id": "...", "address": "..."}}, "items": [{{"description": "...", "asin": "...", "quantity": 1, "unit_price_net": 0.00, "vat_rate": 21, "vat_amount": 0.00, "total_gross": 0.00}}], "subtotal_net": 0.00, "shipping_net": 0.00, "total_vat": 0.00, "total_gross": 0.00, "is_official_invoice": true, "document_type": "invoice"}}"""}
            ],
            max_tokens=1500,
            temperature=0
        )
        
        content = response.choices[0].message.content
        data = json.loads(content)
        data['_source_file'] = filename
        data['_extracted_at'] = datetime.now().isoformat()
        data['_extractor'] = 'openai-gpt4o-mini'
        return data, None
        
    except json.JSONDecodeError as e:
        return None, f"JSON parse error: {str(e)[:100]}"
    except Exception as e:
        return None, f"OpenAI error: {str(e)[:200]}"

def load_existing_results():
    """Load existing results and errors."""
    results = {}
    errors = {}
    
    if RESULTS_FILE.exists():
        with open(RESULTS_FILE) as f:
            results = json.load(f)
    
    if ERRORS_FILE.exists():
        with open(ERRORS_FILE) as f:
            err_data = json.load(f)
            # Handle both list and dict formats
            if isinstance(err_data, list):
                for e in err_data:
                    key = e.get('order_id') or e.get('file', str(len(errors)))
                    errors[key] = e
            else:
                errors = err_data
    
    return results, errors

def save_results(results, errors):
    """Save results and errors atomically."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    with open(RESULTS_FILE, 'w') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    
    with open(ERRORS_FILE, 'w') as f:
        json.dump(errors, f, indent=2, ensure_ascii=False)

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--resume', action='store_true', help='Resume from existing progress')
    parser.add_argument('--limit', type=int, help='Limit number of files to process')
    args = parser.parse_args()
    
    # Get all PDF files sorted by date (newest first)
    pdf_files = sorted(PDFS_DIR.glob('*.pdf'), key=lambda x: extract_date_from_filename(x.name), reverse=True)
    print(f"Found {len(pdf_files)} PDF files")
    
    # Load existing results if resuming
    results, errors = load_existing_results() if args.resume else ({}, {})
    print(f"Loaded {len(results)} existing results, {len(errors)} errors")
    
    # Test OpenAI API
    print("Testing OpenAI API...")
    try:
        test = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "Say OK"}],
            max_tokens=5
        )
        print(f"✅ OpenAI API ready")
    except Exception as e:
        print(f"❌ OpenAI API error: {e}")
        sys.exit(1)
    
    # Filter to unprocessed files
    processed_ids = set(results.keys()) | set(errors.keys())
    remaining = []
    for pdf in pdf_files:
        order_id = extract_order_id_from_filename(pdf.name)
        if order_id and order_id not in processed_ids:
            remaining.append(pdf)
    
    print(f"Resuming: {len(remaining)} files remaining")
    
    if args.limit:
        remaining = remaining[:args.limit]
    
    print(f"Processing {len(remaining)} files...")
    print(f"Rate: ~{REQUESTS_PER_MINUTE}/min, ETA: {len(remaining) / REQUESTS_PER_MINUTE:.1f} minutes")
    print()
    
    start_time = time.time()
    processed_count = 0
    
    for i, pdf_path in enumerate(remaining, 1):
        filename = pdf_path.name
        order_id = extract_order_id_from_filename(filename) or filename
        
        # Extract text
        text, error = extract_text_from_pdf(pdf_path)
        if error:
            print(f"[{i}/{len(remaining)}] {filename} ❌ {error}")
            errors[order_id] = {'file': filename, 'error': error, 'stage': 'pdftotext'}
            continue
        
        # Extract with OpenAI
        data, error = extract_with_openai(text, filename)
        
        if error:
            print(f"[{i}/{len(remaining)}] {filename} ❌ {error[:60]}")
            errors[order_id] = {'file': filename, 'error': error, 'stage': 'openai'}
        else:
            print(f"[{i}/{len(remaining)}] {filename} ✅ {data.get('order_id', 'N/A')}")
            results[order_id] = data
        
        processed_count += 1
        
        # Save every 10 files
        if processed_count % 10 == 0:
            save_results(results, errors)
            elapsed = time.time() - start_time
            rate = processed_count / (elapsed / 60) if elapsed > 0 else 0
            print(f"    📊 Saved. Rate: {rate:.1f}/min")
        
        # Rate limiting
        time.sleep(DELAY_BETWEEN_REQUESTS)
    
    # Final save
    save_results(results, errors)
    
    elapsed = time.time() - start_time
    print(f"\n✅ Done! Processed {processed_count} files in {elapsed/60:.1f} minutes")
    print(f"Total: {len(results)} extracted, {len(errors)} errors")

if __name__ == '__main__':
    main()
