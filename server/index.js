const express = require('express');
const path    = require('path');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Static frontend
app.use(express.static(path.join(__dirname, '../public')));

// API routes
app.use('/api', require('./routes'));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🗺  NetMap running → http://0.0.0.0:${PORT}`);
  console.log(`   DB  : ${path.join(__dirname, '../db/netmap.db')}`);
  console.log(`   API : http://0.0.0.0:${PORT}/api\n`);
});
