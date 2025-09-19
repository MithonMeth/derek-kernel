const http = require('http');
const fs = require('fs');
const path = require('path');

// Maintain in‑memory vote counts for each charity. Keys correspond to the
// data-id attributes used on the front end. If you wish to add more
// charities, simply add additional properties here.
const votes = {
    rainforest: 0,
    whales: 0,
    ocean: 0,
    bears: 0,
};

// Track IP addresses that have already submitted a vote. This is a very
// rudimentary anti‑duplication mechanism and should not be considered
// foolproof. In a production application you would likely implement
// sessions, cookies or on‑chain identity checks.
const voters = new Set();

// Mapping of file extensions to appropriate MIME types. Extend this table
// as needed if you add more file types to your project. Unknown types
// default to `application/octet-stream`.
const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
};

/**
 * Reads a file from disk and writes it to the response with the correct
 * content type. If the file cannot be read the function ends the
 * response with a 404 status.
 *
 * @param {string} filePath Absolute path to the file on disk
 * @param {http.ServerResponse} res Response object
 */
function serveFile(filePath, res) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            // Could not locate file on disk – respond with 404
            res.statusCode = 404;
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.statusCode = 200;
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        res.end(data);
    });
}

/**
 * Handles incoming requests. Routes API calls under `/api` and falls
 * back to serving static files for all other paths.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function requestHandler(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // Handle API endpoints
    if (req.method === 'GET' && pathname === '/api/votes') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(votes));
        return;
    }

    if (req.method === 'POST' && pathname === '/api/vote') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const option = data.option;
                const ip = req.socket.remoteAddress;
                if (!option || !Object.prototype.hasOwnProperty.call(votes, option)) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.end(JSON.stringify({ error: 'Invalid option' }));
                    return;
                }
                if (voters.has(ip)) {
                    // Prevent duplicate votes from the same IP
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.end(JSON.stringify({ error: 'You have already voted' }));
                    return;
                }
                votes[option] += 1;
                voters.add(ip);
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify(votes));
            } catch (e) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: 'Bad request' }));
            }
        });
        return;
    }

    // Serve static files or fall back to index.html for SPA routing
    // Map the URL to a file in the same directory as this script.
    let filePath = path.join(__dirname, pathname);
    // Root requests and directory requests should resolve to index.html
    if (pathname === '/' || pathname === '') {
        filePath = path.join(__dirname, 'index.html');
    }
    // Ensure that resolved path stays within our directory to avoid path traversal
    if (!filePath.startsWith(__dirname)) {
        res.statusCode = 400;
        res.end('Invalid path');
        return;
    }
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            // For any non‑existent file, serve index.html to support SPA behaviour
            const fallback = path.join(__dirname, 'index.html');
            serveFile(fallback, res);
        } else {
            serveFile(filePath, res);
        }
    });
}

// Create the HTTP server and start listening on the configured port
const port = process.env.PORT || 3000;
const server = http.createServer(requestHandler);
server.listen(port, () => {
    console.log('listening on ' + port);
});