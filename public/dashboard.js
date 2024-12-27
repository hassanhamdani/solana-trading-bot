const socket = io();
const logsContainer = document.getElementById('logs');
const tradesList = document.getElementById('trades-list');
let totalSwaps = 0;
let successfulSwaps = 0;

socket.on('log', (logEntry) => {
    const entry = document.createElement('div');
    entry.className = `log-entry ${logEntry.level.toLowerCase()}`;
    
    const timestamp = document.createElement('span');
    timestamp.className = 'timestamp';
    timestamp.textContent = new Date(logEntry.timestamp).toLocaleTimeString();
    
    const message = document.createElement('span');
    message.className = 'message';
    message.textContent = logEntry.message;
    
    entry.appendChild(timestamp);
    entry.appendChild(message);
    
    if (logEntry.data) {
        const data = document.createElement('pre');
        data.className = 'data';
        data.textContent = JSON.stringify(logEntry.data, null, 2);
        entry.appendChild(data);
    }
    
    logsContainer.appendChild(entry);
    logsContainer.scrollTop = logsContainer.scrollHeight;
    
    // Update stats
    if (logEntry.message.includes('Successfully copied trade')) {
        totalSwaps++;
        successfulSwaps++;
        updateStats();
    } else if (logEntry.message.includes('Failed to execute swap')) {
        totalSwaps++;
        updateStats();
    }
});

function updateStats() {
    document.getElementById('totalSwaps').textContent = totalSwaps;
    const rate = totalSwaps > 0 ? ((successfulSwaps / totalSwaps) * 100).toFixed(1) : 0;
    document.getElementById('successRate').textContent = `${rate}%`;
} 