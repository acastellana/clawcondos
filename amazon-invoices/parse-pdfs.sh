#!/bin/bash
# Parse Amazon invoice PDFs and output JSON
# Usage: ./parse-pdfs.sh <zip_file_or_directory>

set -e

INPUT="$1"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

if [ -z "$INPUT" ]; then
    echo "Usage: $0 <zip_file_or_directory>" >&2
    exit 1
fi

# Extract if zip
if [[ "$INPUT" == *.zip ]]; then
    unzip -q "$INPUT" -d "$TMPDIR/extracted"
    SEARCHDIR="$TMPDIR/extracted"
else
    SEARCHDIR="$INPUT"
fi

# Find all INV-*.pdf files (actual invoices, not order summaries)
INVOICES=$(find "$SEARCHDIR" -name "INV-*.pdf" -type f)

if [ -z "$INVOICES" ]; then
    echo "No invoice PDFs found (looking for INV-*.pdf)" >&2
    exit 1
fi

echo "["
FIRST=true
for pdf in $INVOICES; do
    if [ "$FIRST" = true ]; then
        FIRST=false
    else
        echo ","
    fi
    
    # Extract text
    TEXT=$(pdftotext -layout "$pdf" - 2>/dev/null)
    
    # Parse invoice number from filename
    INVOICE_NUM=$(basename "$pdf" .pdf)
    
    # Parse order number from directory name
    ORDER_NUM=$(basename "$(dirname "$pdf")")
    
    # Extract date (look for "Fecha de la factura:" or invoice date pattern)
    DATE=$(echo "$TEXT" | grep -oP '(?<=Fecha de la factura:)\s*\d{1,2}/\d{1,2}/\d{4}' | head -1 | tr -d ' ' || true)
    if [ -z "$DATE" ]; then
        DATE=$(echo "$TEXT" | grep -oP '\d{1,2}/\d{1,2}/\d{4}' | head -1 || true)
    fi
    # Convert DD/MM/YYYY to YYYY-MM-DD
    if [ -n "$DATE" ]; then
        DATE=$(echo "$DATE" | awk -F'/' '{printf "%s-%02d-%02d", $3, $2, $1}')
    fi
    
    # Extract total (look for "Total EUR" or similar)
    TOTAL=$(echo "$TEXT" | grep -oP '(?i)total\s*(eur|€)?\s*[:\s]*(\d+[.,]\d{2})' | grep -oP '\d+[.,]\d{2}' | tail -1 | tr ',' '.' || echo "0")
    
    # Extract VAT
    VAT=$(echo "$TEXT" | grep -oP '(?i)(iva|impuestos?)\s*[:\s]*(\d+[.,]\d{2})' | grep -oP '\d+[.,]\d{2}' | head -1 | tr ',' '.' || echo "0")
    
    # Extract vendor (from "Vendido por:" line)
    VENDOR=$(echo "$TEXT" | grep -oP '(?<=Vendido por:).*' | head -1 | sed 's/^ *//' | cut -d'(' -f1 | sed 's/ *$//' || true)
    if [ -z "$VENDOR" ]; then
        VENDOR=$(echo "$TEXT" | grep -A1 'Vendedor' | tail -1 | sed 's/^ *//' || true)
    fi
    
    # Extract first product description
    PRODUCT=$(echo "$TEXT" | grep -oP '\d+\s+de:\s+.*' | head -1 | sed 's/[0-9]* de: //' || true)
    if [ -z "$PRODUCT" ]; then
        PRODUCT="Unknown product"
    fi
    
    # Calculate net from total - VAT
    NET=$(echo "$TOTAL - $VAT" | bc 2>/dev/null || echo "0")
    
    cat <<EOF
{
  "invoice_number": "$INVOICE_NUM",
  "order_number": "$ORDER_NUM",
  "date": "$DATE",
  "total": $TOTAL,
  "vat_amount": $VAT,
  "subtotal_net": $NET,
  "vendor": "$VENDOR",
  "items": [
    {
      "description": "$PRODUCT",
      "quantity": 1,
      "total_gross": $TOTAL
    }
  ],
  "source_file": "$pdf"
}
EOF
done
echo ""
echo "]"
