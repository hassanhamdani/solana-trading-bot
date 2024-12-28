const socket = io();
const logsDiv = document.getElementById('logs');
const totalSwapsSpan = document.getElementById('totalSwaps');
const successRateSpan = document.getElementById('successRate');

let currentLogGroup = null;
let totalSwaps = 0;
let successfulSwaps = 0;
let pendingMessages = [];
let currentSwapType = 'unknown';
let currentSignature = null;

function updateStats() {
    totalSwapsSpan.textContent = totalSwaps;
    const rate = totalSwaps === 0 ? 0 : (successfulSwaps / totalSwaps) * 100;
    successRateSpan.textContent = `${rate.toFixed(1)}%`;
}

function createLogGroup(signature, timestamp, swapType) {
    // Clear any pending messages that don't belong to this signature
    pendingMessages = pendingMessages.filter(msg => !msg.includes('Signature:') || msg.includes(signature));
    
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';

    const header = document.createElement('div');
    header.className = 'log-header';

    const title = document.createElement('div');
    title.className = 'log-title';
    
    const chevron = document.createElement('i');
    chevron.className = 'fas fa-chevron-down chevron';
    
    const typeSpan = document.createElement('span');
    typeSpan.className = `trade-type ${swapType}`;
    typeSpan.textContent = swapType === 'buy' ? '[BUY]' : swapType === 'sell' ? '[SELL]' : '[SWAP]';
    
    const signatureSpan = document.createElement('span');
    signatureSpan.className = `signature ${swapType}`;
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

    // Add pending messages
    pendingMessages.forEach(msg => {
        const logMessage = document.createElement('div');
        logMessage.className = 'log-message';
        logMessage.textContent = msg;
        content.appendChild(logMessage);
    });
    pendingMessages = []; // Clear pending messages after adding them

    return content;
}

socket.on('log', (data) => {
    const message = data.message;
    const timestamp = new Date(data.timestamp);

    // Check for new signature first
    const signatureMatch = message.match(/Signature: ([a-zA-Z0-9]+)/);
    if (signatureMatch) {
        const newSignature = signatureMatch[1];
        if (newSignature !== currentSignature) {
            // Clear pending messages when we detect a new signature
            pendingMessages = [];
            currentSignature = newSignature;
        }
    }

    // Check for swap type
    const swapTypeMatch = message.match(/Swap Type: (BUY|SELL)/);
    if (swapTypeMatch) {
        currentSwapType = swapTypeMatch[1].toLowerCase();
    }

    // Store message for later display
    pendingMessages.push(message);

    // Create new log group if this is a signature message
    if (signatureMatch) {
        currentLogGroup = createLogGroup(signatureMatch[1], timestamp, currentSwapType);
        totalSwaps++;
        currentSwapType = 'unknown'; // Reset for next group
        return;
    }

    // Check for successful swap
    if (message.includes('✅ Successfully copied trade!')) {
        successfulSwaps++;
    }

    // If we have an active log group but no signature match, append to current group
    if (currentLogGroup && !signatureMatch) {
        const logMessage = document.createElement('div');
        logMessage.className = 'log-message';
        logMessage.textContent = message;
        currentLogGroup.appendChild(logMessage);
    }

    updateStats();
}); 