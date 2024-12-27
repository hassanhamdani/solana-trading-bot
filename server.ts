import express, { Request, Response } from 'express';
import { Server } from 'socket.io';
import http from 'http';
import path from 'path';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve the dashboard
app.get('/', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.DASHBOARD_PORT || 3000;
server.listen(PORT, () => {
    console.log(`Dashboard available at http://localhost:${PORT}`);
});

export const emitLog = (level: string, message: string, data?: any) => {
    io.emit('log', {
        timestamp: new Date().toISOString(),
        level,
        message,
        data
    });
}; 