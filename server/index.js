const express = require('express');
const path    = require('path');
const cors    = require('cors');
const fs      = require('fs');
const http    = require('http');

const app        = express();
const PORT       = parseInt(process.env.PORT)       || 3000;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT) || 3443;
const SSL_KEY    = process.env.SSL_KEY;
const SSL_CERT   = process.env.SSL_CERT;
const useHttps   = SSL_KEY && SSL_CERT && fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT);

app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Static frontend
app.use(express.static(path.join(__dirname, '../public')));

// API routes
app.use('/api', require('./routes'));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

function onError(port) {
  return (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} already in use. Change PORT or HTTPS_PORT env var.`);
    } else {
      console.error('Server error:', err);
    }
    process.exit(1);
  };
}

// HTTP server (always started)
const httpServer = http.createServer(app);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🗺  NetMap running → http://0.0.0.0:${PORT}`);
  console.log(`   DB  : ${path.join(__dirname, '../db/netmap.db')}`);
  console.log(`   API : http://0.0.0.0:${PORT}/api`);
});
httpServer.on('error', onError(PORT));

// HTTPS server (started only when SSL certs are available)
if (useHttps) {
  const https = require('https');
  const tlsOptions = {
    key:  fs.readFileSync(SSL_KEY),
    cert: fs.readFileSync(SSL_CERT),
  };
  const httpsServer = https.createServer(tlsOptions, app);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`   SSL : https://0.0.0.0:${HTTPS_PORT}\n`);
  });
  httpsServer.on('error', onError(HTTPS_PORT));
} else {
  console.log('   SSL : désactivé (SSL_KEY/SSL_CERT non configurés)\n');
}
