#!/usr/bin/env python3
"""
Parallel extraction using OpenAI API with asyncio.
Target: 20-30 requests/second with gpt-4o-mini
"""

import os
import sys
import json
import asyncio
import re
import subprocess
from pathlib import Path
from datetime import datetime
from openai import AsyncOpenAI
import aiofiles

# Configuration
DATA_DIR = Path(__file__).parent.parent / "data"
PDFS_DIR = DATA_DIR / "pdfs"
OUTPUT_DIR = DATA_DIR / "extracted"
RESULTS_FILE = OUTPUT_DIR / "all_invoices.json"
ERRORS_FILE = OUTPUT_DIR / "errors.json"

# Parallelism - gpt-4o-mini allows high concurrency
MAX_CONCURRENT = 25  # 25 parallel requests
SAVE_EVERY = 50

client = AsyncOpenAI()

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
    match = re.search(r'([0-9A-Z]{3}-[0-9]{7}-[0-9]{7})', filename)
    return match.group(1) if match else None

def extract_date_from_filename(filename):
    match = re.match(r'^(\d{8})_', filename)
    return match.group(1) if match else "19700101"

async def extract_with_openai(text, filename, semaphore):
    """Use OpenAI API to structure the extracted text."""
    async with semaphore:
        try:
            truncated_text = text[:6000]
            
            response = await client.chat.completions.create(
                model="gpt-4o-mini",
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": "Extract invoice data and return JSON only. Use null for missing fields. Prices as numbers."},
                    {"role": "user", "content": f"""Extract from this Amazon invoice:

{truncated_text}

Return JSON:
{{"order_id": "XXX-XXXXXXX-XXXXXXX", "invoice_number": "...", "invoice_date": "YYYY-MM-DD", "order_date": "YYYY-MM-DD", "seller": {{"name": "...", "tax_id": "...", "address": "..."}}, "buyer": {{"name": "...", "tax_id": "...", "address": "..."}}, "items": [{{"description": "...", "quantity": 1, "unit_price_net": 0.00, "vat_rate": 21, "vat_amount": 0.00, "total_gross": 0.00}}], "subtotal_net": 0.00, "total_vat": 0.00, "total_gross": 0.00, "is_official_invoice": true}}"""}
                ],
                max_tokens=1500,
                temperature=0
            )
            
            content = response.choices[0].message.content
            data = json.loads(content)
            data['_source_file'] = filename
            data['_extracted_at'] = datetime.now().isoformat()
            return data, None
            
        except json.JSONDecodeError as e:
            return None, f"JSON parse error: {str(e)[:100]}"
        except Exception as e:
            return None, f"OpenAI error: {str(e)[:200]}"

async def process_file(pdf_path, semaphore, results, errors, lock):
    """Process a single PDF file."""
    filename = pdf_path.name
    
    # Extract text (sync, fast)
    text, error = extract_text_from_pdf(pdf_path)
    if error:
        async with lock:
            errors[filename] = {'file': filename, 'error': error, 'stage': 'pdftotext'}
        return False, filename, error
    
    # Extract with OpenAI (async)
    data, error = await extract_with_openai(text, filename, semaphore)
    
    async with lock:
        if error:
            errors[filename] = {'file': filename, 'error': error, 'stage': 'openai'}
            return False, filename, error
        else:
            results[filename] = data
            return True, filename, data.get('order_id', 'N/A')

def load_existing():
    results = {}
    errors = {}
    processed_files = set()
    
    if RESULTS_FILE.exists():
        with open(RESULTS_FILE) as f:
            results = json.load(f)
        # Track processed files by filename
        for r in results.values():
            if '_source_file' in r:
                processed_files.add(r['_source_file'])
    
    if ERRORS_FILE.exists():
        with open(ERRORS_FILE) as f:
            err_data = json.load(f)
            if isinstance(err_data, list):
                for e in err_data:
                    key = e.get('order_id') or e.get('file', str(len(errors)))
                    errors[key] = e
                    if 'file' in e:
                        processed_files.add(e['file'])
            else:
                errors = err_data
                for e in errors.values():
                    if 'file' in e:
                        processed_files.add(e['file'])
    
    return results, errors, processed_files

def save_results(results, errors):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(RESULTS_FILE, 'w') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    with open(ERRORS_FILE, 'w') as f:
        json.dump(errors, f, indent=2, ensure_ascii=False)

async def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--limit', type=int)
    parser.add_argument('--workers', type=int, default=MAX_CONCURRENT)
    args = parser.parse_args()
    
    pdf_files = sorted(PDFS_DIR.glob('*.pdf'), key=lambda x: extract_date_from_filename(x.name), reverse=True)
    print(f"Found {len(pdf_files)} PDF files")
    
    results, errors, processed_files = load_existing() if args.resume else ({}, {}, set())
    print(f"Loaded {len(results)} existing results, {len(errors)} errors, {len(processed_files)} processed files")
    
    # Filter unprocessed - use filename, not order_id
    remaining = [p for p in pdf_files if p.name not in processed_files]
    
    if args.limit:
        remaining = remaining[:args.limit]
    
    print(f"Processing {len(remaining)} files with {args.workers} workers")
    print(f"Target: ~{args.workers * 15}/min")
    print()
    
    semaphore = asyncio.Semaphore(args.workers)
    lock = asyncio.Lock()
    
    start_time = asyncio.get_event_loop().time()
    completed = 0
    
    # Process in batches
    batch_size = SAVE_EVERY
    for batch_start in range(0, len(remaining), batch_size):
        batch = remaining[batch_start:batch_start + batch_size]
        tasks = [process_file(p, semaphore, results, errors, lock) for p in batch]
        
        for coro in asyncio.as_completed(tasks):
            success, filename, info = await coro
            completed += 1
            status = "✅" if success else "❌"
            print(f"[{completed}/{len(remaining)}] {filename[:50]} {status} {str(info)[:30]}")
        
        # Save after each batch
        save_results(results, errors)
        elapsed = asyncio.get_event_loop().time() - start_time
        rate = completed / (elapsed / 60) if elapsed > 0 else 0
        print(f"    📊 Saved. Rate: {rate:.1f}/min, Total: {len(results)} extracted")
    
    print(f"\n✅ Done! {len(results)} extracted, {len(errors)} errors")

if __name__ == '__main__':
    asyncio.run(main())
