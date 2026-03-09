#!/usr/bin/env python3
"""
Extract structured data from Amazon invoice PDFs using pdftotext + Codex CLI.
Codex CLI is FREE with ChatGPT Plus subscription.
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

# Rate limiting - Codex is slower due to startup overhead
REQUESTS_PER_MINUTE = 15
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
    """Use Codex CLI to structure the extracted text."""
    try:
        import tempfile
        # Truncate text for context limits
        truncated_text = text[:4000]
        
        prompt = f'''Extract invoice data from text below. Return ONLY a JSON object (no explanation, no markdown):

TEXT:
{truncated_text}

Return this exact JSON structure:
{{"order_id": "XXX-XXXXXXX-XXXXXXX", "invoice_number": "...", "invoice_date": "YYYY-MM-DD", "order_date": "YYYY-MM-DD", "seller": {{"name": "...", "tax_id": "...", "address": "..."}}, "buyer": {{"name": "...", "tax_id": "...", "address": "..."}}, "items": [{{"description": "...", "asin": "...", "quantity": 1, "unit_price_net": 0.00, "vat_rate": 21, "vat_amount": 0.00, "total_gross": 0.00}}], "subtotal_net": 0.00, "shipping_net": 0.00, "total_vat": 0.00, "total_gross": 0.00, "is_official_invoice": true, "document_type": "invoice"}}

Use null for missing fields. Prices as numbers. Do NOT run any commands, just output JSON.'''

        # Write prompt to temp file to avoid shell quoting issues
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write(prompt)
            prompt_file = f.name
        
        try:
            # Use shell with cat and pipe to avoid argument parsing issues
            result = subprocess.run(
                f'cat "{prompt_file}" | codex exec --full-auto -',
                shell=True,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=str(Path.home() / 'clawd')
            )
        finally:
            os.unlink(prompt_file)
        
        output = result.stdout + result.stderr
        
        if result.returncode != 0 and 'HELLO' not in output and '{' not in output:
            return None, f"Codex error (code {result.returncode}): {output[:200]}"
        
        # Find JSON in output - look for complete JSON object with balanced braces
        # Find start of JSON
        json_start = output.find('{"order_id"')
        if json_start < 0:
            json_start = output.find('{')
        
        if json_start < 0:
            return None, f"No JSON found in output: {output[-300:]}"
        
        # Find matching closing brace
        brace_count = 0
        json_end = json_start
        for i, c in enumerate(output[json_start:]):
            if c == '{':
                brace_count += 1
            elif c == '}':
                brace_count -= 1
                if brace_count == 0:
                    json_end = json_start + i + 1
                    break
        
        response = output[json_start:json_end].strip()
        
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
    parser = argparse.ArgumentParser(description="Extract data from Amazon invoice PDFs using Codex CLI")
    parser.add_argument("--limit", type=int, help="Limit number of PDFs to process")
    parser.add_argument("--resume", action="store_true", help="Resume from last position")
    parser.add_argument("--test", type=str, help="Test with a single file")
    args = parser.parse_args()
    
    OUTPUT_DIR.mkdir(exist_ok=True)
    
    # Sort by date, newest first
    pdf_files = sorted(
        [f for f in os.listdir(PDFS_DIR) if f.endswith('.pdf')],
        key=lambda f: extract_date_from_filename(f),
        reverse=True
    )
    print(f"Found {len(pdf_files)} PDF files")
    
    # Test mode
    if args.test:
        matches = [f for f in pdf_files if args.test in f]
        if not matches:
            print(f"No files matching: {args.test}")
            return 1
        filename = matches[0]
        print(f"Testing: {filename}")
        text, err = extract_text_from_pdf(PDFS_DIR / filename)
        if err:
            print(f"Text extraction error: {err}")
            return 1
        print(f"Extracted {len(text)} chars")
        data, err = extract_with_codex(text, filename)
        if err:
            print(f"Codex error: {err}")
            return 1
        print(json.dumps(data, indent=2))
        return 0
    
    progress = load_progress()
    results = load_results()
    errors = load_errors()
    
    print(f"Loaded {len(results)} existing results, {len(errors)} errors")
    
    # Verify Codex CLI
    print("Testing Codex CLI...")
    test = subprocess.run(['codex', '--version'], capture_output=True, text=True)
    if test.returncode != 0:
        print("❌ Codex CLI not working")
        return 1
    print(f"✅ Codex CLI ready: {test.stdout.strip()}")
    
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
        if (i + 1) % 5 == 0:
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
