#!/bin/bash
# Parse all vendor invoice PDFs and extract invoice data
# Outputs JSON array of invoices

DATA_DIR="/home/albert/clawd/apps/amazon-invoices/data"
PDFS_DIR="$DATA_DIR/pdfs"

echo "["
first=true

for pdf in "$PDFS_DIR"/INV-*.pdf "$PDFS_DIR"/ES*.pdf; do
  [ -f "$pdf" ] || continue
  
  filename=$(basename "$pdf")
  text=$(pdftotext "$pdf" - 2>/dev/null)
  
  # Extract vendor name (usually first substantial line after header)
  vendor=$(echo "$text" | grep -E "^[A-Z][A-Za-z0-9 .,&-]{3,50}$" | head -1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  
  # Extract total amount - look for patterns like "123,45 €" or "€ 123.45" or "Total: 123,45"
  total=$(echo "$text" | grep -oE '([0-9]{1,3}[.,][0-9]{2})\s*€|€\s*([0-9]{1,3}[.,][0-9]{2})|Total[^0-9]*([0-9]{1,3}[.,][0-9]{2})' | tail -1 | grep -oE '[0-9]{1,3}[.,][0-9]{2}' | tail -1 | tr ',' '.')
  
  # Extract date - DD/MM/YYYY or DD.MM.YYYY or YYYY-MM-DD
  date=$(echo "$text" | grep -oE '[0-9]{1,2}[/.-][0-9]{1,2}[/.-][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)
  
  # Extract invoice number from filename
  inv_num=$(echo "$filename" | sed 's/\.pdf$//')
  
  if [ -n "$vendor" ] && [ -n "$total" ]; then
    [ "$first" = true ] && first=false || echo ","
    printf '  {"id": "%s", "vendor": "%s", "amount": %s, "date": "%s", "pdf": "%s", "category": "otros"}' \
      "$inv_num" "$vendor" "$total" "$date" "$filename"
  fi
done

echo ""
echo "]"
