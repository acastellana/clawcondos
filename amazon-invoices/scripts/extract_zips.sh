#!/bin/bash
# Extract Amazon invoice ZIPs and organize PDFs

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data"
ZIPS_DIR="$DATA_DIR/zips"
PDFS_DIR="$DATA_DIR/pdfs"
TEMP_DIR="$DATA_DIR/temp_extract"

mkdir -p "$ZIPS_DIR" "$PDFS_DIR" "$TEMP_DIR"

echo "=== Amazon Invoice ZIP Extractor ==="
echo "ZIPs dir: $ZIPS_DIR"
echo "PDFs dir: $PDFS_DIR"
echo ""

# Check for ZIPs
ZIP_COUNT=$(find "$ZIPS_DIR" -name "*.zip" 2>/dev/null | wc -l)
if [ "$ZIP_COUNT" -eq 0 ]; then
    echo "No ZIP files found in $ZIPS_DIR"
    echo ""
    echo "Please copy the downloaded Amazon ZIP files to:"
    echo "  $ZIPS_DIR"
    echo ""
    echo "Or provide a path as argument:"
    echo "  $0 /path/to/downloads"
    
    # If argument provided, copy from there
    if [ -n "$1" ] && [ -d "$1" ]; then
        echo ""
        echo "Copying ZIPs from $1..."
        find "$1" -name "*.zip" -exec cp {} "$ZIPS_DIR/" \;
        ZIP_COUNT=$(find "$ZIPS_DIR" -name "*.zip" | wc -l)
        echo "Copied $ZIP_COUNT ZIP files"
    else
        exit 1
    fi
fi

echo "Found $ZIP_COUNT ZIP files"
echo ""

# Extract each ZIP
PDF_TOTAL=0
for zip_file in "$ZIPS_DIR"/*.zip; do
    [ -f "$zip_file" ] || continue
    
    zip_name=$(basename "$zip_file")
    echo "Extracting: $zip_name"
    
    # Clean temp dir
    rm -rf "$TEMP_DIR"/*
    
    # Extract
    unzip -q -o "$zip_file" -d "$TEMP_DIR" 2>/dev/null
    
    # Find and move PDFs
    pdf_count=0
    while IFS= read -r -d '' pdf; do
        pdf_name=$(basename "$pdf")
        
        # Skip if already exists
        if [ -f "$PDFS_DIR/$pdf_name" ]; then
            echo "  Skip (exists): $pdf_name"
        else
            cp "$pdf" "$PDFS_DIR/"
            ((pdf_count++))
        fi
    done < <(find "$TEMP_DIR" -name "*.pdf" -print0)
    
    echo "  Extracted $pdf_count new PDFs"
    PDF_TOTAL=$((PDF_TOTAL + pdf_count))
done

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "=== Summary ==="
echo "New PDFs extracted: $PDF_TOTAL"
echo "Total PDFs in folder: $(find "$PDFS_DIR" -name "*.pdf" | wc -l)"
echo ""

# List PDFs by year
echo "PDFs by year:"
for year in 2021 2022 2023 2024 2025 2026; do
    count=$(find "$PDFS_DIR" -name "*$year*.pdf" 2>/dev/null | wc -l)
    [ "$count" -gt 0 ] && echo "  $year: $count PDFs"
done
