const express = require('express');
const path    = require('path');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

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

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🗺  NetMap running → http://0.0.0.0:${PORT}`);
  console.log(`   DB  : ${path.join(__dirname, '../db/netmap.db')}`);
  console.log(`   API : http://0.0.0.0:${PORT}/api\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT env var to use a different port.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
