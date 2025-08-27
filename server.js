const express = require('express');
const path = require('path');
const app = express();

// serve /assets/... as static
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '1y' }));

// serve index.html at / and as SPA fallback
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('listening on ' + port));
