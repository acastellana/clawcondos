const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3850;
const DATA_DIR = path.join(__dirname, 'data');
const INVOICES_FILE = path.join(DATA_DIR, 'invoices.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize empty invoices if not exists
if (!fs.existsSync(INVOICES_FILE)) {
  fs.writeFileSync(INVOICES_FILE, '[]');
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

// No-cache headers for dynamic data
function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

const PDFS_DIR = path.join(DATA_DIR, 'pdfs');

// Auto-categorization keywords
const CATEGORY_KEYWORDS = {
  comida: ['café', 'coffee', 'atún', 'tuna', 'comida', 'food', 'aceite', 'oliva', 'pack3', 'alimenta', 'galleta', 'leche', 'agua', 'bebida'],
  hogar: ['hogar', 'home', 'limpi', 'clean', 'detergent', 'lenor', 'suavizante', 'ropa', 'baul', 'resina', 'barbacoa', 'bbq', 'grill', 'jardín', 'garden', 'autonomía', 'aspirador', 'mueble', 'cocina', 'baño', 'cama', 'almohada', 'sábana', 'toalla', 'cortina'],
  tech: ['tech', 'pantalla', 'screen', 'led', 'cámara', 'camera', 'ipad', 'tablet', 'usb', 'cable', 'nooie', 'ir,', 'audio', 'bidireccional', 'wifi', 'bluetooth', 'smart', 'alexa', 'echo', 'kindle', 'ordenador', 'laptop', 'ratón', 'teclado', 'monitor', 'cargador', 'batería', 'auricular', 'altavoz', 'hdmi'],
  personal: ['personal', 'peluquería', 'hair', 'belleza', 'beauty', 'bebé', 'baby', 'huella', 'cuadro', 'regalo', 'maquillaje', 'perfume', 'crema', 'champú', 'gel', 'desodorante', 'cepillo', 'pañal', 'juguete', 'cachimba'],
  oficina: ['oficina', 'office', 'papel', 'paper', 'printer', 'impresora', 'bolígrafo', 'pen', 'carpeta', 'archivador', 'grapadora', 'clip', 'sobre', 'etiqueta', 'calculadora', 'agenda', 'cuaderno'],
};

function autoCategorize(invoice) {
  const text = [
    invoice.vendor || '',
    ...(invoice.items || []).map(i => i.description || '')
  ].join(' ').toLowerCase();
  
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        return category;
      }
    }
  }
  return 'otros';
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  // Strip /amazon-invoices prefix if present (for reverse proxy)
  let url = req.url;
  if (url.startsWith('/amazon-invoices')) {
    url = url.slice('/amazon-invoices'.length) || '/';
  }
  
  const [pathname, query] = url.split('?');

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Routes
  if (pathname === '/api/health') {
    return sendJson(res, { status: 'ok', invoices: getInvoiceCount() });
  }

  if (pathname === '/api/invoices') {
    if (req.method === 'GET') {
      const invoices = JSON.parse(fs.readFileSync(INVOICES_FILE, 'utf-8'));
      return sendJson(res, invoices);
    }
    
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const newInvoices = JSON.parse(body);
          const existing = JSON.parse(fs.readFileSync(INVOICES_FILE, 'utf-8'));
          
          // Merge by invoice_number (avoid duplicates)
          const existingNumbers = new Set(existing.map(i => i.invoice_number));
          const toAdd = newInvoices
            .filter(i => !existingNumbers.has(i.invoice_number))
            .map(inv => ({
              ...inv,
              category: inv.category || autoCategorize(inv),
              reviewed: inv.reviewed || false
            }));
          
          const merged = [...existing, ...toAdd];
          fs.writeFileSync(INVOICES_FILE, JSON.stringify(merged, null, 2));
          
          sendJson(res, { 
            added: toAdd.length, 
            skipped: newInvoices.length - toAdd.length,
            total: merged.length 
          });
        } catch (e) {
          sendJson(res, { error: e.message }, 400);
        }
      });
      return;
    }
  }

  if (pathname === '/api/invoices/clear' && req.method === 'POST') {
    fs.writeFileSync(INVOICES_FILE, '[]');
    return sendJson(res, { cleared: true });
  }

  // Save all invoices (with categories/status)
  if (pathname === '/api/invoices/save' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!Array.isArray(data)) throw new Error('Expected array');
        fs.writeFileSync(INVOICES_FILE, JSON.stringify(data, null, 2));
        sendJson(res, { saved: data.length });
      } catch (e) {
        sendJson(res, { error: e.message }, 400);
      }
    });
    return;
  }

  // Serve PDF files
  if (pathname.startsWith('/pdf/')) {
    const pdfName = decodeURIComponent(pathname.slice(5));
    const pdfPath = path.join(PDFS_DIR, pdfName);
    
    // Security: ensure file is within PDFS_DIR
    if (!pdfPath.startsWith(PDFS_DIR) || !fs.existsSync(pdfPath)) {
      res.writeHead(404);
      res.end('PDF not found');
      return;
    }
    
    const stat = fs.statSync(pdfPath);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${pdfName}"`,
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self' https://homebase.tail5e5154.ts.net http://localhost:*",
    });
    fs.createReadStream(pdfPath).pipe(res);
    return;
  }

  // List available PDFs
  if (pathname === '/api/pdfs') {
    try {
      const pdfs = fs.readdirSync(PDFS_DIR).filter(f => f.endsWith('.pdf'));
      return sendJson(res, pdfs);
    } catch {
      return sendJson(res, []);
    }
  }

  // Static files
  if (pathname === '/' || pathname === '/index.html') {
    return sendFile(res, path.join(__dirname, 'public', 'index.html'));
  }

  // Try serving from public directory
  const publicPath = path.join(__dirname, 'public', pathname);
  if (fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
    return sendFile(res, publicPath);
  }

  res.writeHead(404);
  res.end('Not found');
});

function getInvoiceCount() {
  try {
    return JSON.parse(fs.readFileSync(INVOICES_FILE, 'utf-8')).length;
  } catch {
    return 0;
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Amazon Invoices Dashboard running on http://127.0.0.1:${PORT}`);
});
