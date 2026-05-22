// =========================================================================
// АВТОНОМНЕ ЯДРО MESH-МЕРЕЖІ С СЕНСОРАМИ ТА АВТОНОМНИМ СИНХРО-МІСТКОМ
// =========================================================================

let map = null;
let myMarker = null;
let lastGoodGPS = null;
let currentChatTarget = "ALL"; 

let meshChannel = null;
let localPeerConnection = null;
let receivedPacketsLog = new Set(); 
let activeGroupPeers = {}; 
let peerMarkersOnMap = {}; 

const MESH_CRYPTO_KEY = "RA_STORM_2026";

window.addEventListener('DOMContentLoaded', () => {
    initMap();
    initGPS();
    initCompass();
    setupInterfaceEvents();
    initLocalMeshTransport(); 
});

function initMap() {
    if (typeof L === 'undefined') return;
    try {
        map = L.map('map', { zoomControl: false, doubleClickZoom: false }).setView([49.0, 31.0], 6);
        L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
            maxZoom: 20, attribution: 'Mesh Map'
        }).addTo(map);
    } catch (e) { console.error(e); }
}

function initGPS() {
    if ('geolocation' in navigator) {
        navigator.geolocation.watchPosition(pos => {
            const { latitude: lat, longitude: lon, altitude: alt, accuracy: acc } = pos.coords;
            lastGoodGPS = { lat, lon };

            document.getElementById('gps-lat').innerText = lat.toFixed(5);
            document.getElementById('gps-lon').innerText = lon.toFixed(5);
            document.getElementById('gps-alt').innerText = alt ? `${Math.round(alt)} м` : "0 м";
            document.getElementById('gps-acc').innerText = `${Math.round(acc)} м`;

            if (!myMarker && map) {
                myMarker = L.marker([lat, lon], {
                    icon: L.divIcon({
                        className: 'my-pos-icon',
                        html: `<div style="background:#4ade80; width:12px; height:12px; border-radius:50%; border:2px solid #fff; box-shadow: 0 0 8px #4ade80;"></div>`,
                        iconSize: [12, 12]
                    })
                }).addTo(map);
                map.setView([lat, lon], 16);
            } else if (myMarker) {
                myMarker.setLatLng([lat, lon]);
            }
            updatePeersDistances(); 
        }, err => {}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    }
}

function initCompass() {
    if ('deviceorientation' in window) {
        window.addEventListener('deviceorientationabsolute', handleOrientation, true);
        window.addEventListener('deviceorientation', handleOrientation, true);
    }
}

function handleOrientation(event) {
    let azimuth = event.webkitCompassHeading || (event.alpha ? 360 - event.alpha : 0);
    if (!azimuth) return;
    document.getElementById('azimuth-val').innerText = `${Math.round(azimuth)}°`;
    document.getElementById('compass-rose').style.transform = `rotate(${-azimuth}deg)`;
}

function initLocalMeshTransport() {
    if (localPeerConnection) return;
    try {
        localPeerConnection = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        
        meshChannel = localPeerConnection.createDataChannel("tactical_mesh_data", { negotiated: true, id: 1 });
        
        meshChannel.onopen = () => {
            document.getElementById('peers-zone').innerHTML = `<div style="color:#4ade80;">📡 ЕФІР СТАБІЛЬНИЙ. Очікування пакетів...</div>`;
            sendTacticalPing(); 
        };

        meshChannel.onclose = () => {
            document.getElementById('peers-zone').innerHTML = `📡 Пошук радіосигналу...`;
        };

        meshChannel.onmessage = (e) => {
            try {
                let packet = JSON.parse(e.data);
                processIncomingMeshPacket(packet);
            } catch(err) { console.error(err); }
        };

        // Створення Offer для офлайн-конекту
        localPeerConnection.createOffer().then(o => localPeerConnection.setLocalDescription(o));
    } catch(e) { console.error(e); }
}

// ГЕНЕРАЦІЯ ОФЛАЙН КЛЮЧА (QR)
function generateOfflineLink() {
    if (!localPeerConnection || !localPeerConnection.localDescription) return;
    let modal = document.getElementById('qr-modal');
    let canvas = document.getElementById('qr-canvas');
    
    // Запаковуємо технічний токен підключення
    let sdpToken = btoa(JSON.stringify(localPeerConnection.localDescription));
    
    QRCode.toCanvas(canvas, sdpToken, { width: 150 }, function (error) {
        if (error) console.error(error);
        modal.style.display = modal.style.display === "none" ? "block" : "none";
    });
}

// ВВЕДЕННЯ КЛЮЧА ВІД СУСІДА (РУЧНИЙ/QR МІСТОК)
function scanOfflineLink() {
    let rawToken = prompt("Вставте скопійований ключ або токен підключення від іншого пристрою:");
    if (!rawToken) return;
    try {
        let parsedDesc = JSON.parse(atob(rawToken));
        localPeerConnection.setRemoteDescription(new RTCSessionDescription(parsedDesc)).then(() => {
            if (parsedDesc.type === "offer") {
                localPeerConnection.createAnswer().then(a => {
                    localPeerConnection.setLocalDescription(a);
                    alert("Ланк створено! Покажіть у відповідь згенерований токен вашому напарнику.");
                });
            }
        });
    } catch (e) { alert("Невірний код ланки."); }
}

function processIncomingMeshPacket(packet) {
    if (receivedPacketsLog.has(packet.packet_id)) return;
    receivedPacketsLog.add(packet.packet_id);
    packet.ttl -= 1;

    let myCallsign = document.getElementById('my-callsign').value.trim() || "Боєць";

    if (packet.sender && packet.sender !== myCallsign) {
        activeGroupPeers[packet.sender] = {
            coords: packet.coords, lastSeen: Date.now(), route: packet.ttl === 4 ? "прямий" : `міст`
        };
        updatePeersUIList(); 
        if (packet.coords) updatePeerMarkerOnMap(packet.sender, packet.coords); 
    }

    if (packet.type === "TEXT" && (packet.receiver === "ALL" || packet.receiver === myCallsign)) {
        displayIncomingMessage(packet, packet.receiver === myCallsign);
    }

    if (packet.ttl > 0 && meshChannel && meshChannel.readyState === "open") {
        meshChannel.send(JSON.stringify(packet));
    }
}

function updatePeerMarkerOnMap(callsign, coords) {
    if (!map || typeof L === 'undefined') return;
    if (peerMarkersOnMap[callsign]) {
        peerMarkersOnMap[callsign].setLatLng([coords.lat, coords.lon]);
    } else {
        peerMarkersOnMap[callsign] = L.marker([coords.lat, coords.lon], {
            icon: L.divIcon({ className: 'peer-tactical-icon', html: `<div class="peer-marker-label">🟢 ${callsign}</div>`, iconAnchor: [30, 0] })
        }).addTo(map);
    }
}

function updatePeersDistances() {
    if (!lastGoodGPS || typeof L === 'undefined') return;
    for (let callsign in activeGroupPeers) {
        let peer = activeGroupPeers[callsign];
        if (peer.coords) {
            peer.distance = Math.round(L.latLng(lastGoodGPS.lat, lastGoodGPS.lon).distanceTo(L.latLng(peer.coords.lat, peer.coords.lon)));
        }
    }
    updatePeersUIList();
}

function updatePeersUIList() {
    const listZone = document.getElementById('peers-zone');
    if (!listZone) return;
    let peersArray = [];
    for (let name in activeGroupPeers) {
        if (Date.now() - activeGroupPeers[name].lastSeen > 60000) continue;
        peersArray.push({ name: name, ...activeGroupPeers[name] });
    }
    if (peersArray.length === 0) { listZone.innerHTML = `📡 Пошук радіосигналу...`; return; }
    listZone.innerHTML = "";
    peersArray.forEach(peer => {
        let div = document.createElement('div');
        div.className = "peer-item";
        div.innerHTML = `<span>🟢 <b>${peer.name}</b></span> <span style="color:#0cf; font-weight:bold;">${peer.distance || 0} м</span>`;
        listZone.appendChild(div);
    });
}

window.sendMeshMessage = function() {
    const input = document.getElementById('msg-input');
    const chatBox = document.getElementById('chat-box');
    let text = input.value.trim();
    let myCallsign = document.getElementById('my-callsign').value.trim() || "Боєць";
    if (!text) return;

    let packetId = "id_" + Math.random().toString(36).substr(2, 9);
    let packet = {
        "packet_id": packetId, "sender": myCallsign, "receiver": currentChatTarget,
        "type": "TEXT", "payload": text, "timestamp": Math.floor(Date.now() / 1000), "ttl": 5,
        "coords": lastGoodGPS ? { lat: lastGoodGPS.lat, lon: lastGoodGPS.lon } : null
    };

    let msgDiv = document.createElement('div');
    msgDiv.style.color = "#ffffff"; 
    msgDiv.innerText = `Я: ${text}`;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    if (meshChannel && meshChannel.readyState === "open") meshChannel.send(JSON.stringify(packet));
    input.value = "";
};

function displayIncomingMessage(packet, isPrivate) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;
    let msgDiv = document.createElement('div');
    msgDiv.style.color = "#4ade80"; 
    msgDiv.innerText = `${packet.sender}: ${packet.payload}`;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function sendTacticalPing() {
    if (meshChannel && meshChannel.readyState === "open" && lastGoodGPS) {
        let ping = {
            "packet_id": "p_" + Math.random().toString(36).substr(2, 9), "sender": document.getElementById('my-callsign').value,
            "receiver": "ALL", "type": "GPS", "payload": "PING", "timestamp": Math.floor(Date.now() / 1000), "ttl": 5,
            "coords": { lat: lastGoodGPS.lat, lon: lastGoodGPS.lon }
        };
        meshChannel.send(JSON.stringify(ping));
    }
}
setInterval(sendTacticalPing, 10000); 

function setupInterfaceEvents() {
    document.getElementById('send-btn').onclick = () => sendMeshMessage();
    document.getElementById('gen-qr-btn').onclick = () => generateOfflineLink();
    document.getElementById('scan-qr-btn').onclick = () => scanOfflineLink();
    document.getElementById('reset-chat-btn').onclick = () => {
        currentChatTarget = "ALL";
        document.getElementById('chat-target').innerText = "🌍 РЕЖИМ: ЗАГАЛЬНИЙ ЕФІР (ДЛЯ ВСІХ)";
    };
}
