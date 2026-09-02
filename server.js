const http = require("http");
const express = require("express");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static directory
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);

// WebSocket Server for Ultra-Low Latency Local LAN Sync
const wss = new WebSocket.Server({ server });

let clients = new Set();

wss.on("connection", (ws, req) => {
    clients.add(ws);
    console.log(`[WS] Client connected. Total active clients: ${clients.size}`);

    ws.on("message", (message) => {
        try {
            const dataStr = message.toString();
            // Broadcast to all other connected clients
            for (const client of clients) {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(dataStr);
                }
            }
        } catch (err) {
            console.error("[WS] Broadcast error:", err);
        }
    });

    ws.on("close", () => {
        clients.delete(ws);
        console.log(`[WS] Client disconnected. Total active clients: ${clients.size}`);
    });

    ws.on("error", (err) => {
        console.error("[WS] Client error:", err);
        clients.delete(ws);
    });

    // Send welcome ping
    ws.send(JSON.stringify({ type: "SYSTEM_HELLO", timestamp: Date.now() }));
});

// Helper: Get local network IPv4 address
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) {
                return iface.address;
            }
        }
    }
    return "localhost";
}

server.listen(PORT, "0.0.0.0", () => {
    const localIp = getLocalIpAddress();
    console.log("\n========================================================");
    console.log("🚑 AMBULANCE GPS TRACKER SERVER RUNNING");
    console.log("========================================================");
    console.log(`💻 Laptop Access (Localhost) : http://localhost:${PORT}`);
    console.log(`📱 Mobile Access (Same Wi-Fi) : http://${localIp}:${PORT}`);
    console.log("========================================================");
    console.log("💡 Tip: You can also use free Cloud Relay (no server required)!");
    console.log("========================================================\n");
});
