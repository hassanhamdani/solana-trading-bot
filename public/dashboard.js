const socket = io();
const logsDiv = document.getElementById('logs');
const totalSwapsSpan = document.getElementById('totalSwaps');
const successRateSpan = document.getElementById('successRate');

let currentLogGroup = null;
let totalSwaps = 0;
let successfulSwaps = 0;

function updateStats() {
    totalSwapsSpan.textContent = totalSwaps;
    const rate = totalSwaps === 0 ? 0 : (successfulSwaps / totalSwaps) * 100;
    successRateSpan.textContent = `${rate.toFixed(1)}%`;
}

function createLogGroup(signature, timestamp, message) {
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';

    const header = document.createElement('div');
    header.className = 'log-header';

    const title = document.createElement('div');
    title.className = 'log-title';
    
    const chevron = document.createElement('i');
    chevron.className = 'fas fa-chevron-down chevron';
    
    // Determine if it's a buy or sell
    const isBuy = message.includes('So11111111111111111111111111111111111111112') && 
                 message.includes('📉 Sent:') && 
                 message.includes('So11111111111111111111111111111111111111112');
    
    const isSell = message.includes('So11111111111111111111111111111111111111112') && 
                  message.includes('📈 Received:') && 
                  message.includes('So11111111111111111111111111111111111111112');

    const typeSpan = document.createElement('span');
    typeSpan.className = `trade-type ${isBuy ? 'buy' : 'sell'}`;
    typeSpan.textContent = isBuy ? '[BUY]' : '[SELL]';
    
    const signatureSpan = document.createElement('span');
    signatureSpan.className = `signature ${isBuy ? 'buy' : 'sell'}`;
    signatureSpan.textContent = signature;
    
    const timestampSpan = document.createElement('span');
    timestampSpan.className = 'timestamp';
    timestampSpan.textContent = new Date(timestamp).toLocaleTimeString();

    title.appendChild(chevron);
    title.appendChild(typeSpan);
    title.appendChild(signatureSpan);
    title.appendChild(timestampSpan);
    header.appendChild(title);

    const content = document.createElement('div');
    content.className = 'log-content';

    header.addEventListener('click', () => {
        chevron.classList.toggle('expanded');
        content.classList.toggle('expanded');
    });

    logEntry.appendChild(header);
    logEntry.appendChild(content);
    logsDiv.insertBefore(logEntry, logsDiv.firstChild);

    return content;
}

socket.on('log', (data) => {
    const message = data.message;
    const timestamp = new Date(data.timestamp);

    // Check if this is a new signature
    const signatureMatch = message.match(/Signature: ([a-zA-Z0-9]+)/);
    if (signatureMatch) {
        currentLogGroup = createLogGroup(signatureMatch[1], timestamp, message);
        totalSwaps++;
    }

    // Check for successful swap
    if (message.includes('✅ Successfully copied trade!')) {
        successfulSwaps++;
    }

    if (currentLogGroup) {
        const logMessage = document.createElement('div');
        logMessage.className = 'log-message';
        logMessage.textContent = message;
        currentLogGroup.appendChild(logMessage);
    }

    updateStats();
}); 