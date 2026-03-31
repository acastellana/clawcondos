#!/usr/bin/env python3
"""
Verify a sample of invoice extractions using Gemini CLI.
Compares PDF text against what we extracted to find discrepancies.
"""

import json
import subprocess
import random
import os
import sys
from pathlib import Path
from datetime import datetime

DATA_DIR = Path(__file__).parent.parent / "data"
INVOICES_JSON = DATA_DIR / "invoices.json"
PDFS_DIR = DATA_DIR / "pdfs"
REVIEW_DIR = DATA_DIR / "review"

def extract_text_from_pdf(pdf_path):
    """Extract text from PDF using pdftotext."""
    try:
        result = subprocess.run(
            ['pdftotext', '-layout', str(pdf_path), '-'],
            capture_output=True,
            text=True,
            timeout=30
        )
        return result.stdout.strip() if result.returncode == 0 else None
    except:
        return None

def verify_with_gemini(pdf_text, extracted_data):
    """Ask Gemini to verify the extraction."""
    prompt = f'''Compare this invoice extraction against the original PDF text.

EXTRACTED DATA:
- Order ID: {extracted_data.get('order_id')}
- Date: {extracted_data.get('date')}
- Vendor: {extracted_data.get('vendor')}
- Subtotal: {extracted_data.get('subtotal')}
- Tax: {extracted_data.get('tax')}
- Total: {extracted_data.get('total')}
- Items: {json.dumps(extracted_data.get('items', []), ensure_ascii=False)[:500]}

ORIGINAL PDF TEXT:
{pdf_text[:3000]}

Return JSON with:
{{"match": true/false, "issues": ["list of discrepancies if any"], "correct_total": number_or_null, "missing_items": ["items in PDF not in extraction"]}}

Only JSON, no markdown.'''

    try:
        result = subprocess.run(
            ['gemini', '-p', prompt],
            input="",
            capture_output=True,
            text=True,
            timeout=90
        )
        
        if result.returncode != 0:
            return None, f"CLI error: {result.stderr[:100]}"
        
        response = result.stdout.strip()
        
        # Clean markdown
        if response.startswith("```"):
            lines = response.split('\n')
            response = '\n'.join(lines[1:-1] if lines[-1].strip() == '```' else lines[1:])
        if response.startswith("json"):
            response = response[4:].strip()
        
        # Find JSON
        start = response.find('{')
        end = response.rfind('}') + 1
        if start >= 0 and end > start:
            response = response[start:end]
        
        return json.loads(response), None
    except json.JSONDecodeError as e:
        return None, f"JSON error: {str(e)[:50]}"
    except Exception as e:
        return None, str(e)[:100]

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int, default=10, help="Number of invoices to verify")
    parser.add_argument("--order", type=str, help="Verify specific order ID")
    args = parser.parse_args()
    
    # Load invoices
    with open(INVOICES_JSON, 'r') as f:
        invoices = json.load(f)
    
    # Filter to those with PDFs
    invoices_with_pdf = [inv for inv in invoices if inv.get('pdfPath')]
    print(f"Loaded {len(invoices)} invoices, {len(invoices_with_pdf)} with PDFs")
    
    # Select sample
    if args.order:
        sample = [inv for inv in invoices_with_pdf if args.order in inv.get('order_id', '')]
    else:
        sample = random.sample(invoices_with_pdf, min(args.sample, len(invoices_with_pdf)))
    
    print(f"Verifying {len(sample)} invoices...\n")
    
    results = []
    for i, inv in enumerate(sample):
        order_id = inv.get('order_id', 'unknown')
        pdf_rel = inv.get('pdfPath', '')
        pdf_path = DATA_DIR / pdf_rel
        
        print(f"[{i+1}/{len(sample)}] {order_id}", end=" ", flush=True)
        
        if not pdf_path.exists():
            print(f"❌ PDF not found: {pdf_rel}")
            results.append({"order_id": order_id, "status": "pdf_missing"})
            continue
        
        # Extract text
        pdf_text = extract_text_from_pdf(pdf_path)
        if not pdf_text or len(pdf_text) < 50:
            print(f"❌ No text in PDF")
            results.append({"order_id": order_id, "status": "no_text"})
            continue
        
        # Verify with Gemini
        verification, error = verify_with_gemini(pdf_text, inv)
        
        if error:
            print(f"⚠️ {error}")
            results.append({"order_id": order_id, "status": "error", "error": error})
        elif verification:
            is_match = verification.get('match', False)
            issues = verification.get('issues', [])
            
            if is_match:
                print(f"✅ Match")
                results.append({"order_id": order_id, "status": "match", "extracted_total": inv.get('total')})
            else:
                print(f"⚠️ Issues: {issues}")
                results.append({
                    "order_id": order_id, 
                    "status": "mismatch",
                    "issues": issues,
                    "extracted_total": inv.get('total'),
                    "correct_total": verification.get('correct_total'),
                    "missing_items": verification.get('missing_items')
                })
        else:
            print("❌ No verification result")
            results.append({"order_id": order_id, "status": "no_result"})
    
    # Save results
    REVIEW_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_file = REVIEW_DIR / f"verification_{timestamp}.json"
    with open(results_file, 'w') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    
    # Summary
    print("\n" + "="*50)
    print("VERIFICATION SUMMARY")
    print("="*50)
    
    matches = sum(1 for r in results if r.get('status') == 'match')
    mismatches = sum(1 for r in results if r.get('status') == 'mismatch')
    errors = sum(1 for r in results if r.get('status') in ['error', 'no_result', 'pdf_missing', 'no_text'])
    
    print(f"✅ Matches: {matches}")
    print(f"⚠️ Mismatches: {mismatches}")
    print(f"❌ Errors: {errors}")
    print(f"\nResults saved to: {results_file}")
    
    # Show mismatches
    if mismatches > 0:
        print("\nMismatches found:")
        for r in results:
            if r.get('status') == 'mismatch':
                print(f"  {r['order_id']}: {r.get('issues', [])}")

if __name__ == "__main__":
    main()
