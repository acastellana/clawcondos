#!/bin/bash
# Check extraction progress

cd ~/clawd/apps/amazon-invoices/data/extracted

echo "=== Extraction Progress ==="
echo ""

# Count results
if [ -f all_invoices.json ]; then
    count=$(jq 'keys | length' all_invoices.json 2>/dev/null || echo "0")
    echo "✅ Extracted: $count / 4049"
fi

# Count errors
if [ -f errors.json ]; then
    errors=$(jq 'length' errors.json 2>/dev/null || echo "0")
    echo "❌ Errors: $errors"
fi

# Check if still running
if pgrep -f "extract_all_invoices" > /dev/null; then
    echo "🔄 Status: RUNNING"
else
    echo "⏸️  Status: STOPPED"
fi

echo ""
echo "=== Recent log ==="
tail -10 extraction.log 2>/dev/null || echo "(no log yet)"
