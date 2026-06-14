// =========================================================================
// АВТОНОМНЕ ЛЕГКЕ ЯДРО: ЛОКАЛЬНИЙ ПРЯМИЙ ЕФІР (БЕЗ ШИФРУВАННЯ ТА БЛОКУВАНЬ)
// =========================================================================

let map = null;
let myMarker = null;
let lastGoodGPS = null;

let activeGroupPeers = {}; 
let peerMarkersOnMap = {};

window.addEventListener('DOMContentLoaded', () => {
    initMap();
    initGPS();
    initCompass();
    setupInterfaceEvents();
    initNativeMeshListener();
    startAutomaticGpsPing();
    
    const scanBtBtn = document.getElementById('scan-bt-btn');
    if (scanBtBtn) {
        scanBtBtn.onclick = () => window.startBluetoothScan();
    }
});

function initMap() {
    try {
        map = L.map('map', { zoomControl: false, attributionControl: false }).setView([49.42, 26.98], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

        const zoomBtn = document.createElement('div');
        zoomBtn.style.position = 'absolute';
        zoomBtn.style.bottom = '20px';
        zoomBtn.style.right = '20px';
        zoomBtn.style.zIndex = '1000';
        zoomBtn.style.background = '#0c0c0c';
        zoomBtn.style.color = '#4ade80';
        zoomBtn.style.border = '1px solid #4ade80';
        zoomBtn.style.padding = '10px';
        zoomBtn.style.borderRadius = '50%';
        zoomBtn.style.cursor = 'pointer';
        zoomBtn.innerHTML = '🎯';
        zoomBtn.onclick = () => {
            if (lastGoodGPS && map) map.setView([lastGoodGPS.lat, lastGoodGPS.lon], 16);
        };
        document.body.appendChild(zoomBtn);
    } catch (e) { console.error("Помилка карти:", e); }
}

function initGPS() {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            const alt = position.coords.altitude || 0;
            const acc = position.coords.accuracy || 0;
            lastGoodGPS = { lat, lon, alt, acc };

            document.getElementById('gps-lat').innerText = lat.toFixed(5);
            document.getElementById('gps-lon').innerText = lon.toFixed(5);
            document.getElementById('gps-alt').innerText = `${Math.round(alt)} м`;
            document.getElementById('gps-acc').innerText = `${Math.round(acc)} м`;

            if (map) {
                if (myMarker) myMarker.setLatLng([lat, lon]);
                else {
                    myMarker = L.marker([lat, lon]).addTo(map).bindPopup('<b>Я</b>').openPopup();
                    map.setView([lat, lon], 15);
                }
            }
        },
        (error) => { console.error("GPS Error:", error); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
    );
}

function initCompass() {
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientationabsolute', (event) => {
            let heading = event.alpha;
            if (heading !== null) {
                let roundedHeading = Math.round(heading);
                document.getElementById('azimuth-val').innerText = `${roundedHeading}°`;
                const rose = document.getElementById('compass-rose');
                if (rose) rose.style.transform = `rotate(${-roundedHeading}deg)`;
            }
        }, true);
    }
}

function setupInterfaceEvents() {
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.onclick = () => window.sendMeshMessage();

    const resetBtn = document.getElementById('reset-chat-btn');
    if (resetBtn) {
        resetBtn.onclick = () => {
            if (lastGoodGPS) {
                const callsign = document.getElementById('my-callsign').value.trim() || "Оператор";
                const color = document.getElementById('my-color').value || "#4ade80";
                const packet = {
                    sender: callsign,
                    color: color,
                    payload: "📡 Ручний запит ефіру (ПІНГ)",
                    type: "TEXT",
                    lat: lastGoodGPS.lat,
                    lon: lastGoodGPS.lon
                };
                broadcastThroughHardware(packet);
            }
        };
    }
}

window.sendMeshMessage = function() {
    const callsignInput = document.getElementById('my-callsign');
    const colorInput = document.getElementById('my-color');
    const msgInput = document.getElementById('msg-input');

    if (!msgInput || !callsignInput) return;

    const text = msgInput.value.trim();
    const callsign = callsignInput.value.trim() || "Оператор";
    const color = colorInput ? colorInput.value : "#4ade80";
    if (!text) return;

    const packet = {
        sender: callsign,
        color: color,
        payload: text,
        type: "TEXT",
        lat: lastGoodGPS ? lastGoodGPS.lat : 0,
        lon: lastGoodGPS ? lastGoodGPS.lon : 0
    };

    displayIncomingMessage(packet);
    broadcastThroughHardware(packet);
    msgInput.value = "";
};

function broadcastThroughHardware(packet) {
    const hardwareSelector = document.getElementById('hardware-select');
    const mode = hardwareSelector ? hardwareSelector.value : "WIFI_DIRECT";

    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TargetHardware) {
        window.Capacitor.Plugins.TargetHardware.broadcastPacket({
            mode: mode,
            data: JSON.stringify(packet)
        }).catch(err => console.error("Апаратний збій передачі:", err));
    }
}

function startAutomaticGpsPing() {
    setInterval(() => {
        if (!lastGoodGPS) return;
        const callsign = document.getElementById('my-callsign').value.trim() || "Оператор";
        const color = document.getElementById('my-color').value || "#4ade80";
        const pingPacket = {
            sender: callsign,
            color: color,
            payload: "", 
            type: "GPS_PING",
            lat: lastGoodGPS.lat,
            lon: lastGoodGPS.lon
        };
        broadcastThroughHardware(pingPacket);
    }, 12000);
}

function initNativeMeshListener() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TargetHardware) {
        window.Capacitor.Plugins.TargetHardware.addListener('onPacketReceived', (info) => {
            try {
                const receivedPacket = JSON.parse(info.data);
                
                if (receivedPacket.payload && receivedPacket.payload.trim() !== "" && receivedPacket.type === "TEXT") {
                    displayIncomingMessage(receivedPacket);
                }
                
                if (receivedPacket.lat && receivedPacket.lon) {
                    window.updatePeerMarkerOnMap(receivedPacket.sender, receivedPacket.lat, receivedPacket.lon, receivedPacket.color);
                }
            } catch (e) {
                console.error("Помилка парсингу радіопакета:", e);
            }
        });
    }
}

window.displayIncomingMessage = function(packet) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;
    
    let msgDiv = document.createElement('div');
    const senderColor = packet.color || "#4ade80";
    
    msgDiv.innerHTML = `<b style="color: ${senderColor};">${packet.sender}</b>: <span style="color: #ddd;">${packet.payload}</span>`;
    
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
};

window.updatePeerMarkerOnMap = function(peerName, lat, lon, color) {
    if (!map) return;
    
    if (peerMarkersOnMap[peerName]) {
        peerMarkersOnMap[peerName].setLatLng([lat, lon]);
    } else {
        peerMarkersOnMap[peerName] = L.marker([lat, lon]).addTo(map)
            .bindPopup(`<b style="color:${color || '#000'};">${peerName}</b><br>На зв'язку по Mesh`)
            .openPopup();
        
        const peersZone = document.getElementById('peers-zone');
        if (peersZone) {
            peersZone.innerText = `📡 Активні оператори: ${Object.keys(peerMarkersOnMap).join(', ')}`;
        }
    }
};

// =========================================================================
// BLUETOOTH СКАНУВАННЯ ТА ПІДКЛЮЧЕННЯ
// =========================================================================
window.startBluetoothScan = function() {
    const btModal = document.getElementById('bt-modal');
    const btList = document.getElementById('bt-devices-list');
    
    btList.innerHTML = '<span style="color:#00ccff; font-size:11px;">📡 Сканування ефіру...</span>';
    btModal.style.display = 'block';

    if (window.Capacitor && window.Capacitor.Plugins) {
        window.Capacitor.Plugins.TargetHardware.scanBluetooth().catch(err => console.error(err));
    }
};

window.addBluetoothDeviceToList = function(name, mac) {
    const btList = document.getElementById('bt-devices-list');
    
    if(btList.innerHTML.includes("Сканування")) btList.innerHTML = "";
    if(document.getElementById('bt-' + mac)) return; 

    const devDiv = document.createElement('div');
    devDiv.id = 'bt-' + mac;
    devDiv.style.background = '#111';
    devDiv.style.border = '1px solid #333';
    devDiv.style.padding = '8px';
    devDiv.style.margin = '4px 0';
    devDiv.style.borderRadius = '4px';
    devDiv.style.cursor = 'pointer';
    devDiv.style.fontSize = '12px';
    devDiv.innerHTML = `<span style="color:#fff;"><b>${name}</b></span> <br><span style="color:#666; font-size:10px;">${mac}</span>`;
    
    devDiv.onclick = () => {
        devDiv.innerHTML += '<br><span style="color:#eab308; font-size:10px;">⏳ Підключення...</span>';
        if (window.Capacitor && window.Capacitor.Plugins) {
            window.Capacitor.Plugins.TargetHardware.connectToBluetoothDevice({ mac: mac });
        }
    };

    btList.appendChild(devDiv);
};

if (window.Capacitor && window.Capacitor.Plugins) {
    window.Capacitor.Plugins.TargetHardware.addListener('onBluetoothDeviceFound', (device) => {
        window.addBluetoothDeviceToList(device.name, device.mac);
    });

    window.Capacitor.Plugins.TargetHardware.addListener('onBluetoothConnected', (info) => {
        const devDiv = document.getElementById('bt-' + info.mac);
        if (devDiv) {
            devDiv.innerHTML = `<span style="color:#4ade80;"><b>✅ Підключено успішно!</b></span>`;
            setTimeout(() => {
                document.getElementById('bt-modal').style.display = 'none';
            }, 2000);
        }
    });
}
