/**
 * ====================================================================
 * AMBULANCE ALERT SYSTEM - CORE CONTROLLER & REAL-TIME SYNC ENGINE
 * ====================================================================
 */

(function () {
    "use strict";

    // ====================================================================
    // GLOBAL STATE
    // ====================================================================
    let currentMode = null; // 'ambulance' | 'traffic'
    let currentRoomId = "AMB-SYNC"; // Room code
    let selectedVehicleId = "AMB001";
    let watchId = null;
    let map = null;

    // Maps & Tracking Data
    let markersMap = {};
    let activeVehiclesData = {};

    // GPS quality / movement filtering. GPS can drift even when the phone is stationary.
    const gpsStateMap = {};
    const MIN_GPS_ACCURACY_M = 25;
    const MIN_MOVEMENT_M = 8;
    const STATIONARY_SPEED_KMH = 4;
    const MAX_REASONABLE_JUMP_M = 120;
    const MARKER_ANIMATION_MS = 900;

    let simulatedVehicleActive = false;
    let simulationTimer = null;
    let simLat = 13.0600;
    let simLng = 80.2500;

    // Traffic Signal & Route
    let trafficJunctionLocation = [13.0827, 80.2707]; // Chennai Central default
    let trafficJunctionMarker = null;
    let routePolyline = null;
    let pickJunctionMode = false;
    let autoCenterEnabled = true;
    let lastRoutingTime = 0;

    // Physical traffic-signal controller (ESP32)
    let esp32BaseUrl = "";
    let lastEsp32Update = 0;
    const ESP32_UPDATE_INTERVAL = 3000;
    const APPROACH_DISTANCE_M = 750;


    // Network & Sync Transports
    let totalPacketsTransmitted = 0;
    let lastPingSentTime = 0;
    let pingLatencyMs = null;
    let mqttClient = null;
    let localWs = null;
    let peer = null;
    let activePeerConnections = {};

    // ====================================================================
    // INITIALIZATION (Guaranteed to execute regardless of load order)
    // ====================================================================
    function initApp() {
        console.log("🚑 Initializing Ambulance Tracker System...");
        parseUrlParameters();
        initializeRoomSystem();
        initializeMap();
        setupEventListeners();
        setupSyncTransports();
        checkGeolocationSecurity();

        // Default to Traffic mode if no mode in URL, or show prompt
        const urlParams = new URLSearchParams(window.location.search);
        const modeParam = urlParams.get("mode");
        if (modeParam === "ambulance" || modeParam === "traffic") {
            setMode(modeParam);
        } else {
            // Default to Traffic Mode on desktop to give immediate visual feedback
            setMode("traffic");
        }

        console.log(`✅ System Ready! Room: ${currentRoomId}`);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initApp);
    } else {
        // Document already loaded
        setTimeout(initApp, 10);
    }

    // ====================================================================
    // URL PARAMETERS & ROOM MANAGEMENT
    // ====================================================================
    function parseUrlParameters() {
        const urlParams = new URLSearchParams(window.location.search);

        const roomParam = urlParams.get("room");
        if (roomParam && roomParam.trim()) {
            currentRoomId = roomParam.trim().toUpperCase();
            try { localStorage.setItem("ambulanceTrackerRoom", currentRoomId); } catch (e) {}
        } else {
            try {
                const savedRoom = localStorage.getItem("ambulanceTrackerRoom");
                if (savedRoom) {
                    currentRoomId = savedRoom;
                } else {
                    const randomNum = Math.floor(1000 + Math.random() * 9000);
                    currentRoomId = `AMB-${randomNum}`;
                    localStorage.setItem("ambulanceTrackerRoom", currentRoomId);
                }
            } catch (e) {
                currentRoomId = `AMB-${Math.floor(1000 + Math.random() * 9000)}`;
            }
        }

        const vehicleParam = urlParams.get("vehicle");
        if (vehicleParam && vehicleParam.trim()) {
            selectedVehicleId = vehicleParam.trim().toUpperCase();
        }
    }

    function initializeRoomSystem() {
        const roomDisplay = document.getElementById("currentRoomDisplay");
        if (roomDisplay) roomDisplay.innerText = currentRoomId;

        const emptyRoom = document.getElementById("emptyRoomCode");
        if (emptyRoom) emptyRoom.innerText = currentRoomId;

        const customRoomInput = document.getElementById("customRoomInput");
        if (customRoomInput) customRoomInput.value = currentRoomId;

        const vehicleDisplay = document.getElementById("activeVehicleDisplay");
        if (vehicleDisplay) vehicleDisplay.innerText = selectedVehicleId;
    }

    function checkGeolocationSecurity() {
        const isSecure = window.isSecureContext || 
                         window.location.hostname === "localhost" || 
                         window.location.hostname === "127.0.0.1";
        const alertBox = document.getElementById("insecureOriginAlert");

        if (!isSecure && window.location.protocol === "http:" && alertBox) {
            alertBox.classList.remove("hidden");
        }
    }

    // ====================================================================
    // LEAFLET MAP INITIALIZATION & RESILIENCE
    // ====================================================================
    function initializeMap() {
        const mapContainer = document.getElementById("map");
        if (!mapContainer) return;

        if (typeof L === "undefined") {
            console.warn("Leaflet library not ready yet, retrying in 300ms...");
            setTimeout(initializeMap, 300);
            return;
        }

        if (map) return; // Already initialized

        try {
            map = L.map("map", {
                zoomControl: true,
                preferCanvas: true
            }).setView([13.0827, 80.2707], 14);

            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                maxZoom: 21,
                maxNativeZoom: 19,
                attribution: "&copy; OpenStreetMap contributors"
            }).addTo(map);

            updateTrafficJunctionMarker();

            map.on("zoomstart dragstart", () => {
                autoCenterEnabled = false;
            });

            map.on("click", (e) => {
                if (pickJunctionMode) {
                    trafficJunctionLocation = [e.latlng.lat, e.latlng.lng];
                    pickJunctionMode = false;

                    const btn = document.getElementById("pickJunctionOnMapBtn");
                    if (btn) btn.innerText = "🎯 Pick on Map";

                    const select = document.getElementById("junctionSelect");
                    if (select) select.value = "custom";

                    updateTrafficJunctionMarker();
                    recalculateActiveRoutes();
                    updateTrafficStatus(`📍 Traffic Signal moved to ${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`);
                }
            });

            // Trigger resize after layout rendering
            setTimeout(() => {
                if (map) map.invalidateSize();
            }, 300);

        } catch (e) {
            console.error("Map initialization error:", e);
        }
    }

    // ====================================================================
    // MODE SWITCHING (Ambulance Mobile vs Traffic Control Laptop)
    // ====================================================================
    function setMode(mode) {
        currentMode = mode;

        const ambPanel = document.getElementById("ambulancePanel");
        const trafPanel = document.getElementById("trafficPanel");
        const ambBtn = document.getElementById("ambulanceBtn");
        const trafBtn = document.getElementById("trafficBtn");

        if (ambBtn) ambBtn.classList.toggle("active", mode === "ambulance");
        if (trafBtn) trafBtn.classList.toggle("active", mode === "traffic");

        if (mode === "ambulance") {
            if (ambPanel) ambPanel.classList.remove("hidden");
            if (trafPanel) trafPanel.classList.add("hidden");
            updateModeBanner(`Active Mode: <strong style="color: #c62828;">📱 Ambulance Transmitter (Room: ${currentRoomId})</strong>`);
        } else if (mode === "traffic") {
            if (trafPanel) trafPanel.classList.remove("hidden");
            if (ambPanel) ambPanel.classList.add("hidden");
            updateModeBanner(`Active Mode: <strong style="color: #1565c0;">🚦 Traffic Control Center (Room: ${currentRoomId})</strong>`);
            renderTrafficVehiclesUI();
        }

        // Reconnect PeerJS for new role
        initPeerSync();

        // Invalidate map size to adapt to container layout
        setTimeout(() => {
            if (map) map.invalidateSize();
        }, 150);
    }
    window.setMode = setMode;

    function updateModeBanner(html) {
        const banner = document.getElementById("currentModeBanner");
        const modeSpan = document.getElementById("currentMode");
        if (modeSpan) modeSpan.innerHTML = html;
        if (banner) banner.classList.remove("hidden");
    }

    // ====================================================================
    // EVENT LISTENERS BINDING
    // ====================================================================
    function setupEventListeners() {
        // Mode Buttons
        bindClick("ambulanceBtn", () => setMode("ambulance"));
        bindClick("trafficBtn", () => setMode("traffic"));

        // Transmitter Controls
        bindClick("startTrackingBtn", startTracking);
        bindClick("stopTrackingBtn", stopTracking);
        bindClick("sendTestPingBtn", sendTestPing);
        bindClick("simulateBtn", toggleSimulation);

        // Vehicle Select & Display Name
        const vehicleSelect = document.getElementById("vehicleSelect");
        if (vehicleSelect) {
            vehicleSelect.addEventListener("change", (e) => {
                selectedVehicleId = e.target.value;
                const display = document.getElementById("activeVehicleDisplay");
                if (display) display.innerText = selectedVehicleId;
            });
        }

        bindClick("addCustomVehicleBtn", () => {
            const input = document.getElementById("customVehicleInput");
            if (!input) return;
            const raw = input.value.trim();
            if (!raw) {
                alert("Please enter a Custom Vehicle ID (e.g. RESCUE-99)");
                return;
            }
            const customId = raw.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
            selectedVehicleId = customId;

            if (vehicleSelect) {
                const optExists = Array.from(vehicleSelect.options).some(o => o.value === customId);
                if (!optExists) {
                    const opt = document.createElement("option");
                    opt.value = customId;
                    opt.innerText = `🚑 ${customId} (Custom)`;
                    vehicleSelect.appendChild(opt);
                }
                vehicleSelect.value = customId;
            }

            const display = document.getElementById("activeVehicleDisplay");
            if (display) display.innerText = selectedVehicleId;
            input.value = "";
            updateAmbulanceStatus(`✅ Custom Vehicle ID "${selectedVehicleId}" registered and active!`);
        });

        const nameInput = document.getElementById("deviceDisplayNameInput");
        if (nameInput) {
            try {
                const saved = localStorage.getItem("ambulanceDisplayName");
                if (saved) nameInput.value = saved;
            } catch (e) {}

            nameInput.addEventListener("input", (e) => {
                try { localStorage.setItem("ambulanceDisplayName", e.target.value.trim()); } catch (err) {}
            });
        }

        // Traffic Control Signals & Map Controls
        const junctionSelect = document.getElementById("junctionSelect");
        if (junctionSelect) {
            junctionSelect.addEventListener("change", (e) => {
                if (e.target.value !== "custom") {
                    const parts = e.target.value.split(",");
                    trafficJunctionLocation = [parseFloat(parts[0]), parseFloat(parts[1])];
                    updateTrafficJunctionMarker();
                    recalculateActiveRoutes();
                }
            });
        }

        bindClick("pickJunctionOnMapBtn", () => {
            pickJunctionMode = true;
            const btn = document.getElementById("pickJunctionOnMapBtn");
            if (btn) btn.innerText = "👇 Click map now!";
            updateTrafficStatus("📍 Click anywhere on the map to position the Traffic Signal post.");
        });

        bindClick("recenterMapBtn", () => {
            autoCenterEnabled = true;
            recalculateActiveRoutes();
            updateTrafficStatus("🎯 Map recentered and fitted to active route.");
        });

        bindClick("toggleTrafficSignalsBtn", () => {
            if (!trafficJunctionMarker || !map) return;
            if (map.hasLayer(trafficJunctionMarker)) {
                map.removeLayer(trafficJunctionMarker);
                updateTrafficStatus("Traffic Signal icon hidden.");
            } else {
                map.addLayer(trafficJunctionMarker);
                updateTrafficStatus("Traffic Signal icon shown.");
            }
        });

        // ESP32 Traffic Signal Controller
        const esp32Input = document.getElementById("esp32IpInput");
        if (esp32Input) {
            try {
                const savedEsp32 = localStorage.getItem("ambulanceEsp32Url");
                if (savedEsp32) {
                    esp32Input.value = savedEsp32;
                    esp32BaseUrl = savedEsp32;
                }
            } catch (e) {}
        }

        bindClick("connectEsp32Btn", () => {
            const value = (document.getElementById("esp32IpInput")?.value || "").trim();
            if (!value) {
                updateTrafficStatus("⚠️ Enter the ESP32 IP address first.");
                return;
            }

            esp32BaseUrl = value.replace(/\/+$/, "");
            try { localStorage.setItem("ambulanceEsp32Url", esp32BaseUrl); } catch (e) {}

            const status = document.getElementById("esp32Status");
            if (status) status.innerHTML = "🟢 ESP32 address saved. It will receive updates when the ambulance enters 750 m.";
            updateTrafficStatus("🚦 ESP32 controller connected in the website configuration.");
        });

        // Modals & QR Code
        setupPairingModalEvents();
        setupGpsHelpModalEvents();
    }

    function bindClick(id, handler) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("click", handler);
        }
    }

    // ====================================================================
    // MODAL & QR CODE GENERATION
    // ====================================================================
    function setupPairingModalEvents() {
        const modal = document.getElementById("pairingModal");

        function openModal() {
            if (!modal) return;
            modal.classList.remove("hidden");
            generatePairingQrCode();
        }

        function closeModal() {
            if (modal) modal.classList.add("hidden");
        }

        bindClick("openPairingModalBtn", openModal);
        bindClick("showPairingInTrafficBtn", openModal);
        bindClick("roomPill", openModal);
        bindClick("closePairingModalBtn", closeModal);

        if (modal) {
            modal.addEventListener("click", (e) => {
                if (e.target === modal) closeModal();
            });
        }

        bindClick("copyPairingUrlBtn", () => {
            const urlInput = document.getElementById("pairingUrlInput");
            const copyBtn = document.getElementById("copyPairingUrlBtn");
            if (urlInput) {
                urlInput.select();
                navigator.clipboard.writeText(urlInput.value).then(() => {
                    if (copyBtn) copyBtn.innerText = "✅ Copied!";
                    setTimeout(() => { if (copyBtn) copyBtn.innerText = "📋 Copy"; }, 2000);
                }).catch(() => {
                    document.execCommand("copy");
                    if (copyBtn) copyBtn.innerText = "✅ Copied!";
                    setTimeout(() => { if (copyBtn) copyBtn.innerText = "📋 Copy"; }, 2000);
                });
            }
        });

        bindClick("applyCustomRoomBtn", () => {
            const input = document.getElementById("customRoomInput");
            if (!input) return;
            const val = input.value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
            if (val) {
                currentRoomId = val;
                try { localStorage.setItem("ambulanceTrackerRoom", currentRoomId); } catch (e) {}
                initializeRoomSystem();
                generatePairingQrCode();
                setupSyncTransports();
                alert(`Room successfully set to "${currentRoomId}"!`);
            }
        });
    }

    function generatePairingQrCode() {
        const qrContainer = document.getElementById("qrcode");
        const urlInput = document.getElementById("pairingUrlInput");
        if (!qrContainer) return;

        qrContainer.innerHTML = "";

        let baseUrl = window.location.href.split("?")[0];
        if (baseUrl.startsWith("file://")) {
            baseUrl = "http://localhost:3000/index.html";
        }

        const pairingUrl = `${baseUrl}?mode=ambulance&room=${encodeURIComponent(currentRoomId)}`;
        if (urlInput) urlInput.value = pairingUrl;

        // Try QRCode.js library
        if (typeof QRCode !== "undefined") {
            try {
                new QRCode(qrContainer, {
                    text: pairingUrl,
                    width: 180,
                    height: 180,
                    colorDark: "#0f172a",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel.M
                });
                return;
            } catch (e) {
                console.warn("QRCode constructor error, falling back to image QR:", e);
            }
        }

        // Resilient Fallback Image QR (Google Chart API & QRServer API)
        const encoded = encodeURIComponent(pairingUrl);
        const qrImg = document.createElement("img");
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encoded}`;
        qrImg.alt = "Pairing QR Code";
        qrImg.style.width = "180px";
        qrImg.style.height = "180px";
        qrImg.style.borderRadius = "8px";
        qrContainer.appendChild(qrImg);
    }

    function setupGpsHelpModalEvents() {
        const modal = document.getElementById("gpsHelpModal");
        bindClick("alertHelpBtn", () => { if (modal) modal.classList.remove("hidden"); });
        bindClick("closeGpsHelpModalBtn", () => { if (modal) modal.classList.add("hidden"); });
        if (modal) {
            modal.addEventListener("click", (e) => {
                if (e.target === modal) modal.classList.add("hidden");
            });
        }
        bindClick("alertSimulateBtn", () => {
            if (currentMode !== "ambulance") setMode("ambulance");
            toggleSimulation();
        });
    }

    // ====================================================================
    // REAL-TIME MULTI-TRANSPORT SYNCHRONIZATION ENGINE
    // ====================================================================
    function setupSyncTransports() {
        initCloudMqttRelay();
        initLocalWebSocket();
        initPeerSync();

        // Heartbeat ping every 4s
        if (!window._heartbeatInterval) {
            window._heartbeatInterval = setInterval(sendHeartbeatPing, 4000);
        }
    }

    // 1. MQTT Cloud Relay
    function initCloudMqttRelay() {
        if (typeof mqtt === "undefined") {
            console.warn("MQTT.js library not detected. Local WebSockets will be used.");
            updateSyncStatus("yellow", "LAN Sync Ready");
            return;
        }

        const brokerUrl = "wss://broker.emqx.io:8084/mqtt";
        const clientId = `amb_${Math.random().toString(16).substring(2, 10)}`;

        try {
            if (mqttClient) {
                try { mqttClient.end(true); } catch (e) {}
            }

            mqttClient = mqtt.connect(brokerUrl, {
                clientId: clientId,
                clean: true,
                connectTimeout: 6000,
                reconnectPeriod: 3000
            });

            mqttClient.on("connect", () => {
                console.log("🟢 Connected to Cloud MQTT Relay:", brokerUrl);
                updateSyncStatus("green", "Cloud Relay Active");

                const topic = `ambulance-tracker/rooms/${currentRoomId}/#`;
                mqttClient.subscribe(topic, (err) => {
                    if (!err) console.log(`📡 Subscribed to MQTT topic: ${topic}`);
                });
            });

            mqttClient.on("message", (topic, message) => {
                try {
                    const payload = JSON.parse(message.toString());
                    handleIncomingTelemetry(payload, "MQTT Cloud Relay");
                } catch (e) {
                    console.error("MQTT message parse error:", e);
                }
            });

            mqttClient.on("error", (err) => {
                console.warn("MQTT Relay notice:", err);
            });

        } catch (e) {
            console.warn("MQTT setup notice:", e);
        }
    }

    // 2. Local Node.js WebSocket Sync
    function initLocalWebSocket() {
        if (window.location.protocol.startsWith("http")) {
            const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            const wsUrl = `${wsProtocol}//${window.location.host}`;

            try {
                if (localWs) {
                    try { localWs.close(); } catch (e) {}
                }

                localWs = new WebSocket(wsUrl);

                localWs.onopen = () => {
                    console.log("🟢 Connected to Local Node.js WebSocket server:", wsUrl);
                    updateSyncStatus("green", "Local LAN WS Active");
                };

                localWs.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data && data.type !== "SYSTEM_HELLO") {
                            handleIncomingTelemetry(data, "Local WebSocket");
                        }
                    } catch (e) {
                        console.error("WS message parse error:", e);
                    }
                };

                localWs.onerror = () => {};
            } catch (e) {}
        }
    }

    // 3. PeerJS WebRTC Sync
    function initPeerSync() {
        if (typeof Peer === "undefined") return;

        try {
            const receiverPeerId = `amb-traffic-${currentRoomId.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

            if (currentMode === "traffic") {
                if (peer) try { peer.destroy(); } catch (e) {}
                peer = new Peer(receiverPeerId);

                peer.on("open", (id) => {
                    console.log("🟢 Traffic Control Peer Receiver ready:", id);
                });

                peer.on("connection", (conn) => {
                    conn.on("data", (data) => {
                        handleIncomingTelemetry(data, "PeerJS WebRTC");
                    });
                });

                peer.on("error", () => {});

            } else if (currentMode === "ambulance") {
                if (peer) try { peer.destroy(); } catch (e) {}
                peer = new Peer();

                peer.on("open", () => {
                    try {
                        const conn = peer.connect(receiverPeerId);
                        conn.on("open", () => {
                            activePeerConnections[receiverPeerId] = conn;
                        });
                        conn.on("error", () => {});
                    } catch (e) {}
                });
            }
        } catch (e) {}
    }

    // Broadcast across all active transports
    function broadcastTelemetry(telemetryData) {
        totalPacketsTransmitted++;
        updatePacketCountDisplay();

        telemetryData.roomId = currentRoomId;
        telemetryData.clientTimestamp = Date.now();

        const payloadString = JSON.stringify(telemetryData);

        // MQTT Cloud Relay
        if (mqttClient && mqttClient.connected) {
            const topic = `ambulance-tracker/rooms/${currentRoomId}/telemetry`;
            mqttClient.publish(topic, payloadString);
        }

        // Local WebSocket
        if (localWs && localWs.readyState === WebSocket.OPEN) {
            localWs.send(payloadString);
        }

        // PeerJS WebRTC
        Object.keys(activePeerConnections).forEach((id) => {
            const conn = activePeerConnections[id];
            if (conn && conn.open) {
                conn.send(telemetryData);
            }
        });
    }

    // Inbound telemetry handler
    function handleIncomingTelemetry(data, sourceChannel) {
        if (!data) return;

        // Ping / Pong Latency
        if (data.type === "PING_HEARTBEAT") {
            if (data.senderMode === "ambulance" && currentMode === "traffic") {
                broadcastTelemetry({
                    type: "PONG_HEARTBEAT",
                    originalTimestamp: data.timestamp,
                    senderMode: "traffic"
                });
            }
            return;
        }

        if (data.type === "PONG_HEARTBEAT") {
            if (data.originalTimestamp) {
                pingLatencyMs = Math.round(Date.now() - data.originalTimestamp);
                const pingEl = document.getElementById("pingMs");
                if (pingEl) pingEl.innerText = pingLatencyMs;
            }
            return;
        }

        if (!data.vehicleId || data.latitude === undefined || data.longitude === undefined) {
            return;
        }

        if (data.roomId && data.roomId !== currentRoomId) {
            return;
        }

        totalPacketsTransmitted++;
        updatePacketCountDisplay();

        const vId = data.vehicleId;
        activeVehiclesData[vId] = data;

        updateVehicleMarkerOnMap(vId, data);
        recalculateActiveRoutes();

        if (currentMode === "traffic") {
            renderTrafficVehiclesUI();
            updateTrafficStatus(`🟢 Live telemetry packet received from ${data.displayName || vId} via ${sourceChannel}`);
        }
    }

    function sendHeartbeatPing() {
        lastPingSentTime = Date.now();
        broadcastTelemetry({
            type: "PING_HEARTBEAT",
            timestamp: lastPingSentTime,
            senderMode: currentMode || "unknown"
        });
    }

    function updateSyncStatus(color, text) {
        const pill = document.getElementById("syncStatusPill");
        const textEl = document.getElementById("syncStatusText");
        if (pill) {
            const dot = pill.querySelector(".sync-dot");
            if (dot) dot.className = `sync-dot ${color}`;
        }
        if (textEl) textEl.innerText = text;
    }

    function updatePacketCountDisplay() {
        const countEl = document.getElementById("packetCount");
        if (countEl) countEl.innerText = totalPacketsTransmitted;
    }

    // ====================================================================
    // GPS TRACKING (MOBILE TRANSMITTER)
    // ====================================================================
    function startTracking() {
        if (!navigator.geolocation) {
            updateAmbulanceStatus("❌ Geolocation is not supported by this browser.");
            return;
        }

        updateAmbulanceStatus("📡 Requesting high-accuracy GPS satellite fix...");

        const startBtn = document.getElementById("startTrackingBtn");
        const stopBtn = document.getElementById("stopTrackingBtn");
        const badge = document.getElementById("transmitterStatusBadge");

        if (startBtn) startBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = false;
        if (badge) {
            badge.className = "badge badge-pulse live";
            badge.innerText = "TRANSMITTING";
        }

        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
        }

        watchId = navigator.geolocation.watchPosition(
            handleGpsPosition,
            handleGpsError,
            {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 10000
            }
        );
    }
    window.startTracking = startTracking;

    function handleGpsPosition(pos) {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const accuracy = pos.coords.accuracy;
        const speed = pos.coords.speed;
        const heading = pos.coords.heading;
        const timestamp = Date.now();

        // Filter GPS drift BEFORE broadcasting or updating the map.
        const accepted = shouldAcceptGpsPosition(
            selectedVehicleId, lat, lng, accuracy, speed
        );

        const nameInput = document.getElementById("deviceDisplayNameInput");
        const typedName = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : "";
        const displayName = typedName || `Ambulance ${selectedVehicleId}`;

        const latEl = document.getElementById("latitude");
        const lngEl = document.getElementById("longitude");
        const accEl = document.getElementById("accuracy");
        const spdEl = document.getElementById("speed");
        const updEl = document.getElementById("lastUpdate");

        // Always show the raw GPS quality so you can diagnose the phone.
        if (latEl) latEl.innerText = lat.toFixed(6);
        if (lngEl) lngEl.innerText = lng.toFixed(6);
        if (accEl) accEl.innerText = Number.isFinite(Number(accuracy))
            ? `${Number(accuracy).toFixed(1)} m` : "Unavailable";
        if (spdEl) spdEl.innerText = Number.isFinite(Number(speed))
            ? `${(Number(speed) * 3.6).toFixed(1)} km/h` : "0.0 km/h";

        if (!accepted) {
            updateAmbulanceStatus("🟡 GPS stable — ignoring small GPS drift");
            return;
        }

        if (updEl) updEl.innerText = new Date(timestamp).toLocaleTimeString();

        const telemetryPayload = {
            vehicleId: selectedVehicleId,
            displayName,
            deviceName: detectDeviceName(),
            latitude: lat,
            longitude: lng,
            accuracy: accuracy,
            speed: speed,
            heading: heading,
            timestamp
        };

        activeVehiclesData[selectedVehicleId] = telemetryPayload;
        updateVehicleMarkerOnMap(selectedVehicleId, telemetryPayload);
        recalculateActiveRoutes();
        broadcastTelemetry(telemetryPayload);

        updateAmbulanceStatus(`🟢 Live GPS broadcast active (${selectedVehicleId})`);
    }

    function handleGpsError(err) {
        console.error("GPS Error:", err);
        let msg = "GPS error occurred.";

        switch (err.code) {
            case err.PERMISSION_DENIED:
                msg = "❌ Location permission denied. Please allow location or use Simulation mode.";
                const alertBox = document.getElementById("insecureOriginAlert");
                if (alertBox) alertBox.classList.remove("hidden");
                break;
            case err.POSITION_UNAVAILABLE:
                msg = "❌ GPS position unavailable (weak satellite signal).";
                break;
            case err.TIMEOUT:
                msg = "⏳ GPS request timed out. Retrying...";
                break;
        }

        updateAmbulanceStatus(msg);
    }

    function stopTracking() {
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }

        const startBtn = document.getElementById("startTrackingBtn");
        const stopBtn = document.getElementById("stopTrackingBtn");
        const badge = document.getElementById("transmitterStatusBadge");

        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
        if (badge) {
            badge.className = "badge badge-pulse";
            badge.innerText = "STANDBY";
        }

        updateAmbulanceStatus("⏹️ GPS tracking stopped.");
    }
    window.stopTracking = stopTracking;

    function sendTestPing() {
        const lat = 13.0700 + (Math.random() - 0.5) * 0.02;
        const lng = 80.2600 + (Math.random() - 0.5) * 0.02;

        const testData = {
            vehicleId: selectedVehicleId,
            displayName: `Ambulance ${selectedVehicleId}`,
            deviceName: detectDeviceName(),
            latitude: lat,
            longitude: lng,
            accuracy: 4.0,
            speed: 10.0,
            heading: 90,
            timestamp: Date.now()
        };

        activeVehiclesData[selectedVehicleId] = testData;
        updateVehicleMarkerOnMap(selectedVehicleId, testData);
        recalculateActiveRoutes();
        broadcastTelemetry(testData);

        const latEl = document.getElementById("latitude");
        const lngEl = document.getElementById("longitude");
        const spdEl = document.getElementById("speed");
        const updEl = document.getElementById("lastUpdate");

        if (latEl) latEl.innerText = lat.toFixed(6);
        if (lngEl) lngEl.innerText = lng.toFixed(6);
        if (spdEl) spdEl.innerText = "36.0 km/h";
        if (updEl) updEl.innerText = new Date().toLocaleTimeString();

        updateAmbulanceStatus(`⚡ Test telemetry packet sent to Room ${currentRoomId}!`);
    }
    window.sendTestPing = sendTestPing;

    // ====================================================================
    // SIMULATION MODE
    // ====================================================================
    function toggleSimulation() {
        const btn = document.getElementById("simulateBtn");

        if (simulatedVehicleActive) {
            simulatedVehicleActive = false;
            clearInterval(simulationTimer);
            simulationTimer = null;
            if (btn) btn.innerText = "🚗 Simulate Movement";
            updateAmbulanceStatus("⏹️ Simulation stopped.");
        } else {
            simulatedVehicleActive = true;
            if (btn) btn.innerText = "⏹️ Stop Simulation";
            updateAmbulanceStatus(`🚗 Simulating real-time movement for ${selectedVehicleId}...`);

            // Start near Chennai Anna Salai
            simLat = 13.0450;
            simLng = 80.2400;

            simulationTimer = setInterval(() => {
                const targetLat = trafficJunctionLocation[0];
                const targetLng = trafficJunctionLocation[1];

                const step = 0.0004; // ~40 km/h step
                simLat += (targetLat > simLat ? step : -step) + (Math.random() - 0.5) * 0.00008;
                simLng += (targetLng > simLng ? step : -step) + (Math.random() - 0.5) * 0.00008;

                const simData = {
                    vehicleId: selectedVehicleId,
                    displayName: `Simulated Ambulance (${selectedVehicleId})`,
                    deviceName: "🚗 Virtual Mobile",
                    latitude: simLat,
                    longitude: simLng,
                    accuracy: 3.5,
                    speed: 11.2, // ~40 km/h
                    heading: 45,
                    timestamp: Date.now()
                };

                activeVehiclesData[selectedVehicleId] = simData;
                updateVehicleMarkerOnMap(selectedVehicleId, simData);
                recalculateActiveRoutes();
                broadcastTelemetry(simData);

                if (currentMode === "ambulance") {
                    const latEl = document.getElementById("latitude");
                    const lngEl = document.getElementById("longitude");
                    const spdEl = document.getElementById("speed");
                    const updEl = document.getElementById("lastUpdate");

                    if (latEl) latEl.innerText = simLat.toFixed(6);
                    if (lngEl) lngEl.innerText = simLng.toFixed(6);
                    if (spdEl) spdEl.innerText = "40.3 km/h";
                    if (updEl) updEl.innerText = new Date().toLocaleTimeString();
                }

            }, 1200);
        }
    }
    window.toggleSimulation = toggleSimulation;

    // ====================================================================
    // TRAFFIC CONTROL UI RENDERING
    // ====================================================================
    function renderTrafficVehiclesUI() {
        const listContainer = document.getElementById("trafficVehiclesList");
        const countBadge = document.getElementById("activeUnitsCount");
        if (!listContainer) return;

        const vehicleKeys = Object.keys(activeVehiclesData);

        if (countBadge) {
            countBadge.innerText = `${vehicleKeys.length} Connected`;
        }

        if (vehicleKeys.length === 0) {
            listContainer.innerHTML = `
                <div class="empty-state-card">
                    <div class="empty-icon">📱</div>
                    <h4>No active mobile GPS signals received yet</h4>
                    <p>Open this page on your mobile phone in <strong>Ambulance Mode</strong> with Room <code id="emptyRoomCode">${currentRoomId}</code>, or click <strong>Pair Mobile (QR)</strong> above.</p>
                </div>
            `;
            return;
        }

        let html = "";
        vehicleKeys.forEach((vId) => {
            const item = activeVehiclesData[vId];
            if (!item) return;

            const secondsAgo = item.timestamp ? Math.floor((Date.now() - item.timestamp) / 1000) : 999;
            let connectionBadge = `<span class="vehicle-badge active">🟢 ONLINE (${secondsAgo}s)</span>`;
            if (secondsAgo > 30) {
                connectionBadge = `<span class="vehicle-badge" style="background:#ef4444; color:white;">🔴 OFFLINE (${secondsAgo}s)</span>`;
            } else if (secondsAgo > 10) {
                connectionBadge = `<span class="vehicle-badge" style="background:#f59e0b; color:white;">🟡 IDLE (${secondsAgo}s)</span>`;
            }

            const { distKm, etaMins } = calculateDirectDistanceAndEta(
                trafficJunctionLocation[0],
                trafficJunctionLocation[1],
                Number(item.latitude),
                Number(item.longitude)
            );

            const isSelected = selectedVehicleId === vId;
            const colorClass = vId.toLowerCase();

            html += `
                <div class="vehicle-card ${colorClass} ${isSelected ? 'selected-route-card' : ''}">
                    <div class="vehicle-header">
                        <h3>🚑 ${item.displayName || vId}</h3>
                        ${connectionBadge}
                    </div>
                    <div class="vehicle-body">
                        <p><span>ID:</span> <strong>${vId}</strong></p>
                        <p><span>Distance to Signal:</span> <strong style="color:#0284c7;">${distKm} km</strong></p>
                        <p><span>Estimated Time (ETA):</span> <strong style="color:#16a34a;">${etaMins} mins</strong></p>
                        <p><span>Coordinates:</span> <code>${Number(item.latitude).toFixed(5)}, ${Number(item.longitude).toFixed(5)}</code></p>
                        <p><span>Speed:</span> <strong>${item.speed ? (item.speed * 3.6).toFixed(1) + " km/h" : "0.0 km/h"}</strong></p>
                        <p><span>Accuracy:</span> <strong>${item.accuracy ? item.accuracy.toFixed(1) + " m" : "--"}</strong></p>
                    </div>
                    <button class="btn-xs btn-primary" style="width: 100%; margin-top: 10px;" onclick="window.focusAndRouteToVehicle('${vId}')">
                        🎯 Focus Route on ${vId}
                    </button>
                </div>
            `;
        });

        listContainer.innerHTML = html;
    }

    function calculateDirectDistanceAndEta(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distKm = (R * c * 1.25).toFixed(2);
        const etaMins = Math.max(1, Math.round(distKm * 2.0));
        return { distKm, etaMins };
    }

    function focusAndRouteToVehicle(vId) {
        selectedVehicleId = vId;
        const display = document.getElementById("activeVehicleDisplay");
        if (display) display.innerText = selectedVehicleId;
        renderTrafficVehiclesUI();
        recalculateActiveRoutes();
    }
    window.focusAndRouteToVehicle = focusAndRouteToVehicle;

    // ====================================================================
    // MAP MARKERS & OSRM DRIVING ROUTE
    // ====================================================================
    function haversineMeters(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function shouldAcceptGpsPosition(vehicleId, lat, lng, accuracy, speed) {
        const accuracyM = Number(accuracy);
        const speedKmh = Number.isFinite(Number(speed)) && Number(speed) >= 0
            ? Number(speed) * 3.6
            : 0;

        // Bad accuracy readings are much more likely to create "jumping".
        if (Number.isFinite(accuracyM) && accuracyM > MIN_GPS_ACCURACY_M) {
            return false;
        }

        const state = gpsStateMap[vehicleId];

        if (!state) {
            gpsStateMap[vehicleId] = {
                lat, lng,
                lastAcceptedAt: Date.now(),
                stationarySince: speedKmh <= STATIONARY_SPEED_KMH ? Date.now() : null
            };
            return true;
        }

        const movedM = haversineMeters(state.lat, state.lng, lat, lng);
        const elapsedS = Math.max(0.5, (Date.now() - state.lastAcceptedAt) / 1000);

        // Reject a single implausibly large jump (common GPS reacquisition error).
        const impliedKmh = (movedM / elapsedS) * 3.6;
        if (movedM > MAX_REASONABLE_JUMP_M && impliedKmh > 100) {
            return false;
        }

        // If both reported speed and displacement indicate the phone is stationary,
        // keep the old coordinate. This prevents GPS jitter from moving the marker.
        if (movedM < MIN_MOVEMENT_M && speedKmh <= STATIONARY_SPEED_KMH) {
            return false;
        }

        // When speed is near zero, require a larger displacement before moving.
        if (speedKmh <= STATIONARY_SPEED_KMH && movedM < Math.max(MIN_MOVEMENT_M, accuracyM || 0)) {
            return false;
        }

        state.lat = lat;
        state.lng = lng;
        state.lastAcceptedAt = Date.now();
        return true;
    }

    function animateMarkerTo(marker, targetLatLng, duration = MARKER_ANIMATION_MS) {
        if (!marker) return;

        const from = marker.getLatLng();
        const start = performance.now();

        if (marker._animationFrame) cancelAnimationFrame(marker._animationFrame);

        function frame(now) {
            const progress = Math.min(1, (now - start) / duration);
            const eased = progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;

            const lat = from.lat + (targetLatLng[0] - from.lat) * eased;
            const lng = from.lng + (targetLatLng[1] - from.lng) * eased;
            marker.setLatLng([lat, lng]);

            if (progress < 1) {
                marker._animationFrame = requestAnimationFrame(frame);
            }
        }

        marker._animationFrame = requestAnimationFrame(frame);
    }

    function updateVehicleMarkerOnMap(vehicleId, data) {
        if (!map || typeof L === "undefined") return;

        const lat = Number(data.latitude);
        const lng = Number(data.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const pos = [lat, lng];

        const iconHtml = `
            <div class="ambulance-map-marker"
                 style="background:#dc2626;color:white;width:34px;height:34px;border-radius:50%;
                 display:flex;align-items:center;justify-content:center;font-size:18px;
                 box-shadow:0 3px 8px rgba(0,0,0,.4);border:2px solid white;">
                🚑
            </div>`;

        const ambulanceIcon = L.divIcon({
            className: "custom-amb-icon",
            html: iconHtml,
            iconSize: [34, 34],
            iconAnchor: [17, 17]
        });

        const popup = `
            <div style="font-family:inherit;font-size:13px;">
                <b style="color:#c62828;">🚑 ${data.displayName || vehicleId}</b><br>
                <b>ID:</b> ${vehicleId}<br>
                <b>Lat:</b> ${lat.toFixed(6)} | <b>Lng:</b> ${lng.toFixed(6)}<br>
                <b>Accuracy:</b> ${Number.isFinite(Number(data.accuracy)) ? Number(data.accuracy).toFixed(1) + " m" : "--"}<br>
                <b>Updated:</b> ${new Date(data.timestamp || Date.now()).toLocaleTimeString()}
            </div>`;

        if (!markersMap[vehicleId]) {
            markersMap[vehicleId] = L.marker(pos, { icon: ambulanceIcon }).addTo(map).bindPopup(popup);
        } else {
            animateMarkerTo(markersMap[vehicleId], pos);
            markersMap[vehicleId].getPopup().setContent(popup);
        }

        // IMPORTANT: Do not draw raw GPS breadcrumbs. The road route is drawn separately
        // by OSRM, which prevents the old "messy thread" effect.
    }

    function formatEtaSeconds(seconds) {
        const s = Math.max(0, Math.round(Number(seconds) || 0));
        const m = Math.floor(s / 60);
        const r = s % 60;
        return m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
    }

    async function updateEsp32Signal(distanceM, etaSeconds) {
        if (!esp32BaseUrl) return;
        if (!Number.isFinite(distanceM) || !Number.isFinite(etaSeconds)) return;
        if (distanceM > APPROACH_DISTANCE_M) return;
        if (Date.now() - lastEsp32Update < ESP32_UPDATE_INTERVAL) return;

        lastEsp32Update = Date.now();

        const base = esp32BaseUrl.replace(/\/+$/, "");
        const url = `${base}/traffic/update?distance=${encodeURIComponent(Math.round(distanceM))}&eta=${encodeURIComponent(Math.round(etaSeconds))}`;

        try {
            await fetch(url, { method: "GET", mode: "cors" });
            console.log("🚦 ESP32 updated:", Math.round(distanceM), "m /", Math.round(etaSeconds), "s");
        } catch (err) {
            console.warn("ESP32 update failed:", err);
        }
    }

    function updateTrafficJunctionMarker() {
        if (!map || typeof L === "undefined") return;

        const popup = `
            <div style="font-family: inherit; font-size: 13px;">
                <b style="color: #15803d;">🚦 Traffic Signal Control Post</b><br>
                <b>Lat:</b> ${trafficJunctionLocation[0].toFixed(5)}<br>
                <b>Lng:</b> ${trafficJunctionLocation[1].toFixed(5)}
            </div>
        `;

        if (!trafficJunctionMarker) {
            const trafficIcon = L.divIcon({
                className: "traffic-post-icon",
                html: "<div style='font-size: 28px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));'>🚦</div>",
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            });

            trafficJunctionMarker = L.marker(trafficJunctionLocation, { icon: trafficIcon })
                .addTo(map)
                .bindPopup(popup);
        } else {
            trafficJunctionMarker.setLatLng(trafficJunctionLocation);
            trafficJunctionMarker.getPopup().setContent(popup);
        }
    }

    async function recalculateActiveRoutes() {
        updateTrafficJunctionMarker();

        const keys = Object.keys(activeVehiclesData);
        if (keys.length === 0) return;

        const activeId = activeVehiclesData[selectedVehicleId] ? selectedVehicleId : keys[0];
        const amb = activeVehiclesData[activeId];
        if (!amb) return;

        const now = Date.now();
        if (now - lastRoutingTime < 2000) return;
        lastRoutingTime = now;

        const ambCoords = [Number(amb.latitude), Number(amb.longitude)];
        const trafficCoords = trafficJunctionLocation;

        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${ambCoords[1]},${ambCoords[0]};${trafficCoords[1]},${trafficCoords[0]}?overview=full&geometries=geojson`;

        try {
            const res = await fetch(osrmUrl);
            const data = await res.json();

            if (data.code === "Ok" && data.routes && data.routes.length > 0) {
                const route = data.routes[0];
                const distKm = (route.distance / 1000).toFixed(2);
                const durationMins = Math.max(1, Math.round(route.duration / 60));
                const latLngs = route.geometry.coordinates.map(c => [c[1], c[0]]);

                if (routePolyline && map) map.removeLayer(routePolyline);

                if (map) {
                    routePolyline = L.polyline(latLngs, {
                        color: "#0284c7",
                        weight: 6,
                        opacity: 0.85,
                        lineJoin: "round"
                    }).addTo(map);
                }

                updateRouteTelemetryUI(distKm, durationMins);

                // Send the physical controller the real road distance and ETA.
                updateEsp32Signal(route.distance, route.duration);

                // Expose precise values for other UI functions.
                window.__ambulanceRouteTelemetry = {
                    distanceM: route.distance,
                    distanceKm: route.distance / 1000,
                    etaSeconds: route.duration,
                    etaMinutes: route.duration / 60
                };

                if (autoCenterEnabled && map) {
                    const bounds = L.latLngBounds([trafficCoords, ambCoords]);
                    map.fitBounds(bounds, { padding: [50, 50] });
                }
            } else {
                fallbackDirectLine(ambCoords, trafficCoords);
            }
        } catch (e) {
            fallbackDirectLine(ambCoords, trafficCoords);
        }
    }

    function fallbackDirectLine(ambCoords, trafficCoords) {
        const { distKm, etaMins } = calculateDirectDistanceAndEta(
            trafficCoords[0], trafficCoords[1],
            ambCoords[0], ambCoords[1]
        );

        if (routePolyline && map) map.removeLayer(routePolyline);
        if (map && typeof L !== "undefined") {
            routePolyline = L.polyline([ambCoords, trafficCoords], {
                color: "#dc2626",
                weight: 4,
                dashArray: "6, 6"
            }).addTo(map);
        }

        updateRouteTelemetryUI(distKm, etaMins);
    }

    function updateRouteTelemetryUI(distKm, durationMins) {
        const distEl = document.getElementById("routeDistance");
        const etaEl = document.getElementById("routeETA");
        const badgeEl = document.getElementById("routeAlertBadge");

        if (distEl) distEl.innerText = `${distKm} km`;
        if (etaEl) etaEl.innerText = `${durationMins} mins`;

        if (badgeEl) {
            const d = Number(distKm);
            if (d < 1.0) {
                badgeEl.className = "status-badge imminent";
                badgeEl.innerText = `🚨 IMMINENT (< 1 km) - CLEAR SIGNAL`;
            } else if (d < 3.0) {
                badgeEl.className = "status-badge approaching";
                badgeEl.innerText = `⚠️ APPROACHING (${distKm} km)`;
            } else {
                badgeEl.className = "status-badge normal";
                badgeEl.innerText = `🟢 IN TRANSIT (${distKm} km)`;
            }
        }
    }

    // ====================================================================
    // HELPERS
    // ====================================================================
    function detectDeviceName() {
        const ua = navigator.userAgent;
        if (/android/i.test(ua)) return "📱 Android Mobile";
        if (/iphone|ipad|ipod/i.test(ua)) return "📱 Apple iOS Device";
        if (/windows/i.test(ua)) return "💻 Windows PC";
        if (/macintosh/i.test(ua)) return "💻 Mac Computer";
        return "📱 Mobile Device";
    }

    function updateAmbulanceStatus(msg) {
        const el = document.getElementById("status");
        if (el) el.innerText = msg;
    }

    function updateTrafficStatus(msg) {
        const el = document.getElementById("trafficStatus");
        if (el) el.innerText = msg;
    }

})();
