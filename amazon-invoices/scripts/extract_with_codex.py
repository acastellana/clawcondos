#!/usr/bin/env python3
"""
Extract structured data from Amazon invoice PDFs using pdftotext + Codex CLI.
Fork of extract_all_invoices.py that uses OpenAI Codex instead of Gemini.
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

# Rate limiting - Codex is faster, can do more
REQUESTS_PER_MINUTE = 30
DELAY_BETWEEN_REQUESTS = 60 / REQUESTS_PER_MINUTE

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

def extract_with_codex(text, filename):
    """Use Oracle CLI (OpenAI-backed) to structure the extracted text."""
    try:
        prompt = f'''Extract from this Amazon invoice text. Return ONLY valid JSON (no markdown, no explanation):

{text[:5000]}

JSON structure:
{{"order_id": "XXX-XXXXXXX-XXXXXXX", "invoice_number": "...", "invoice_date": "YYYY-MM-DD", "order_date": "YYYY-MM-DD",
"seller": {{"name": "...", "tax_id": "...", "address": "..."}},
"buyer": {{"name": "...", "tax_id": "...", "address": "..."}},
"items": [{{"description": "...", "asin": "...", "quantity": 1, "unit_price_net": 0.00, "vat_rate": 21, "vat_amount": 0.00, "total_gross": 0.00}}],
"subtotal_net": 0.00, "shipping_net": 0.00, "total_vat": 0.00, "total_gross": 0.00,
"is_official_invoice": true, "document_type": "invoice"}}
Use null for missing fields. All prices as numbers.'''
        
        # Use oracle CLI with gpt-5.1-pro, --wait to block, write output to temp file
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as tf:
            temp_path = tf.name
        
        result = subprocess.run(
            ['oracle', '-m', 'gpt-5.1-pro', '--wait', '--write-output', temp_path, '-p', prompt],
            capture_output=True,
            text=True,
            timeout=180  # Pro can take longer
        )
        
        # Read output from temp file
        try:
            with open(temp_path, 'r') as f:
                response = f.read().strip()
            os.unlink(temp_path)
        except:
            response = result.stdout.strip() if result.stdout else ""
        
        if result.returncode != 0:
            error_msg = result.stderr or result.stdout
            return None, f"Oracle error (code {result.returncode}): {error_msg[:200]}"
        
        # Clean markdown wrapper if present
        if "```json" in response:
            start = response.find("```json") + 7
            end = response.find("```", start)
            if end > start:
                response = response[start:end].strip()
        elif "```" in response:
            start = response.find("```") + 3
            end = response.find("```", start)
            if end > start:
                response = response[start:end].strip()
        
        # Find JSON in response
        json_start = response.find('{')
        json_end = response.rfind('}') + 1
        if json_start >= 0 and json_end > json_start:
            response = response[json_start:json_end]
        
        data = json.loads(response)
        data['_source_file'] = filename
        data['_extracted_at'] = datetime.now().isoformat()
        data['_extractor'] = 'codex'
        return data, None
        
    except json.JSONDecodeError as e:
        return None, f"JSON parse error: {str(e)[:100]}"
    except subprocess.TimeoutExpired:
        return None, "Timeout (120s)"
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

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Extract data from Amazon invoice PDFs using Codex")
    parser.add_argument("--limit", type=int, help="Limit number of PDFs to process")
    parser.add_argument("--resume", action="store_true", help="Resume from last position")
    args = parser.parse_args()
    
    OUTPUT_DIR.mkdir(exist_ok=True)
    
    # Sort by date, newest first
    pdf_files = sorted(
        [f for f in os.listdir(PDFS_DIR) if f.endswith('.pdf')],
        key=lambda f: extract_date_from_filename(f),
        reverse=True
    )
    print(f"Found {len(pdf_files)} PDF files")
    
    progress = load_progress()
    results = load_results()
    errors = load_errors()
    
    print(f"Loaded {len(results)} existing results, {len(errors)} errors")
    
    # Verify Oracle CLI
    print("Testing Oracle CLI...")
    test = subprocess.run(['oracle', '--version'], capture_output=True, text=True)
    if test.returncode != 0:
        print("❌ Oracle CLI not working")
        return 1
    print(f"✅ Oracle CLI ready: {test.stdout.strip()}")
    
    # Determine files to process
    if args.resume:
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
        
        # Structure with Codex
        data, extraction_error = extract_with_codex(text, filename)
        
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
            # Use order_id from data or filename
            result_order_id = data.get('order_id') or order_id or filename
            results[result_order_id] = data
            total = data.get('total_gross')
            items = len(data.get('items') or [])
            doc_type = "INV" if data.get('is_official_invoice') else "ORD"
            print(f"✅ €{total} | {items} items | {doc_type}")
            processed_count += 1
        
        # Update progress
        progress['processed'].append(filename)
        progress['last_index'] = i + 1
        
        # Save periodically
        if (i + 1) % 10 == 0:
            save_results(results)
            save_progress(progress)
            save_errors(errors)
            elapsed = time.time() - start_time
            rate = processed_count / (elapsed / 60) if elapsed > 0 else 0
            print(f"    📊 Saved. Rate: {rate:.1f}/min")
        
        # Rate limit
        time.sleep(DELAY_BETWEEN_REQUESTS)
    
    # Final save
    save_results(results)
    save_progress(progress)
    save_errors(errors)
    
    elapsed = time.time() - start_time
    print(f"\n✅ Done! Processed {processed_count}, errors {error_count}")
    print(f"⏱️  Time: {elapsed/60:.1f} minutes")
    print(f"📁 Results: {RESULTS_FILE}")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
