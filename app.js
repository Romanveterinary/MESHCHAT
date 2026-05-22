// =========================================================================
// АВТОНОМНЕ ЯДРО MESH-МЕРЕЖІ, РАЦІЇ, GPS-ТЕЛЕМЕТРІЇ ТА КОМПАСА
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
    initCompass(); // Запуск компаса
    setupInterfaceEvents();
    initLocalMeshTransport(); 
});

// 1. ЗАПУСК ОФЛАЙН/ОНЛАЙН МАПИ
function initMap() {
    if (typeof L === 'undefined') return;
    try {
        map = L.map('map', { 
            zoomControl: false, 
            doubleClickZoom: false 
        }).setView([49.0, 31.0], 6);

        let satelliteLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
            maxZoom: 20,
            attribution: 'Tactical Mesh Map'
        });
        satelliteLayer.addTo(map);
        console.log("Map initialized.");
    } catch (e) { console.error("Помилка карти:", e); }
}

// 2. АВТОНОМНИЙ ПОШУК СУПУТНИКІВ ТА ВИВІД GPS ПАРАМЕТРІВ
function initGPS() {
    if ('geolocation' in navigator) {
        navigator.geolocation.watchPosition(pos => {
            const { latitude: lat, longitude: lon, altitude: alt, accuracy: acc } = pos.coords;
            lastGoodGPS = { lat, lon };

            // Виводимо параметри на тактичну панель користувача
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
        }, err => {
            console.warn("GPS чекає на супутники...");
        }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    }
}

// 3. ЖИВИЙ ТАКТИЧНИЙ КОМПАС (Обробка гіроскопа/магнітометра)
function initCompass() {
    // Перевіряємо підтримку сенсора орієнтації в просторі
    if ('deviceorientation' in window) {
        window.addEventListener('deviceorientationabsolute', handleOrientation, true);
        window.addEventListener('deviceorientation', handleOrientation, true);
    } else {
        document.getElementById('compass-rose').innerText = "❌";
    }
}

function handleOrientation(event) {
    let azimuth = 0;
    
    // Для Android пристроїв використовуємо webkitCompassHeading або alpha
    if (event.webkitCompassHeading) {
        azimuth = event.webkitCompassHeading;
    } else if (event.alpha) {
        azimuth = 360 - event.alpha; 
    } else { return; }

    let roundedAzimuth = Math.round(azimuth);
    document.getElementById('azimuth-val').innerText = `${roundedAzimuth}°`;
    
    // Обертаємо стрілку компаса проти годинникової стрілки, щоб вона тримала Північ
    document.getElementById('compass-rose').style.transform = `rotate(${-roundedAzimuth}deg)`;
}

// 4. ЛОКАЛЬНИЙ ТРАНСПОРТ
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
            } catch(err) { console.error("Помилка пакета", err); }
        };
    } catch(e) { console.error("Транспорт не підтримується залізом", e); }
}

// 5. ОБРОБКА ПАКЕТІВ
function processIncomingMeshPacket(packet) {
    if (receivedPacketsLog.has(packet.packet_id)) return;
    receivedPacketsLog.add(packet.packet_id);
    packet.ttl -= 1;

    let myCallsign = document.getElementById('my-callsign').value.trim() || "Боєць";

    if (packet.sender && packet.sender !== myCallsign) {
        let hopRoute = packet.ttl === 4 ? "прямий" : `міст: ${packet.via || "ретранс"}`;
        
        activeGroupPeers[packet.sender] = {
            coords: packet.coords,
            lastSeen: Date.now(),
            route: hopRoute
        };
        updatePeersUIList(); 
        if (packet.coords) updatePeerMarkerOnMap(packet.sender, packet.coords); 
    }

    if (packet.type === "TEXT") {
        let isForMe = packet.receiver === myCallsign;
        let isGeneral = packet.receiver === "ALL";
        if (isGeneral || isForMe) {
            displayIncomingMessage(packet, isForMe);
            if (isForMe) sendAckPulse(packet.packet_id, packet.sender);
        }
    }

    if (packet.type === "ACK" && packet.receiver === myCallsign) {
        markMessageAsDelivered(packet.payload); 
    }

    if (packet.ttl > 0 && meshChannel && meshChannel.readyState === "open") {
        packet.via = myCallsign; 
        meshChannel.send(JSON.stringify(packet));
    }
}

// 6. КЕРУВАННЯ МАРКЕРАМИ НА МАПІ
function updatePeerMarkerOnMap(callsign, coords) {
    if (!map || typeof L === 'undefined') return;
    if (peerMarkersOnMap[callsign]) {
        peerMarkersOnMap[callsign].setLatLng([coords.lat, coords.lon]);
    } else {
        let tacticalIcon = L.divIcon({
            className: 'peer-tactical-icon',
            html: `<div class="peer-marker-label">🟢 ${callsign}</div>`,
            iconAnchor: [30, 0]
        });
        peerMarkersOnMap[callsign] = L.marker([coords.lat, coords.lon], { icon: tacticalIcon }).addTo(map);
    }
}

// 7. РОЗРАХУНОК ВІДСТАНЕЙ
function updatePeersDistances() {
    if (!lastGoodGPS || typeof L === 'undefined') return;
    for (let callsign in activeGroupPeers) {
        let peer = activeGroupPeers[callsign];
        if (peer.coords) {
            peer.distance = Math.round(L.latLng(lastGoodGPS.lat, lastGoodGPS.lon).distanceTo(L.latLng(peer.coords.lat, peer.coords.lon)));
        } else { peer.distance = 99999; }
    }
    updatePeersUIList();
}

function updatePeersUIList() {
    const listZone = document.getElementById('peers-zone');
    if (!listZone) return;

    let peersArray = [];
    for (let name in activeGroupPeers) {
        if (Date.now() - activeGroupPeers[name].lastSeen > 60000) {
            if(peerMarkersOnMap[name]) { map.removeLayer(peerMarkersOnMap[name]); delete peerMarkersOnMap[name]; }
            delete activeGroupPeers[name];
            continue;
        }
        peersArray.push({ name: name, ...activeGroupPeers[name] });
    }

    if (peersArray.length === 0) {
        listZone.innerHTML = `📡 Пошук радіосигналу...`;
        return;
    }

    peersArray.sort((a, b) => a.distance - b.distance);
    listZone.innerHTML = "";
    peersArray.forEach(peer => {
        let distText = peer.distance === 99999 ? "--- м" : `${peer.distance} м`;
        let div = document.createElement('div');
        div.className = "peer-item";
        div.onclick = () => window.selectPeerForPrivateChat(peer.name);
        div.innerHTML = `<span>🟢 <b>${peer.name}</b> (${peer.route})</span> <span style="color:#0cf; font-weight:bold;">${distText}</span>`;
        listZone.appendChild(div);
    });
}

window.selectPeerForPrivateChat = function(name) {
    currentChatTarget = name;
    document.getElementById('chat-target').innerText = `🔒 ПРИВАТНИЙ ЧАТ: ${name}`;
    document.getElementById('chat-target').style.color = "#00ccff";
};

// 8. НАДІСЛАННЯ ПОВІДОМЛЕНЬ
window.sendMeshMessage = function() {
    const input = document.getElementById('msg-input');
    const chatBox = document.getElementById('chat-box');
    let text = input.value.trim();
    let myCallsign = document.getElementById('my-callsign').value.trim() || "Боєць";
    if (!text) return;

    let packetId = "id_" + Math.random().toString(36).substr(2, 9);
    let payloadData = text;

    let isPrivate = currentChatTarget !== "ALL";
    if (isPrivate) payloadData = "SEC:" + encryptXOR(text);

    let packet = {
        "packet_id": packetId,
        "sender": myCallsign,
        "receiver": currentChatTarget,
        "type": "TEXT",
        "payload": payloadData,
        "timestamp": Math.floor(Date.now() / 1000),
        "ttl": 5,
        "coords": lastGoodGPS ? { lat: lastGoodGPS.lat, lon: lastGoodGPS.lon } : null
    };

    let msgDiv = document.createElement('div');
    msgDiv.id = packetId;
    msgDiv.style.color = "#ffffff"; 
    msgDiv.innerText = `[📡 Виліт] Я ➡️ ${currentChatTarget}: ${text}`;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    if (meshChannel && meshChannel.readyState === "open") {
        meshChannel.send(JSON.stringify(packet));
        if (!isPrivate) {
            setTimeout(() => {
                if(msgDiv) { msgDiv.style.color = "#4ade80"; msgDiv.innerText = `[🌍 Ефір] Я: ${text}`; }
            }, 1000);
        }
    }

    if (isPrivate) {
        setTimeout(() => {
            let el = document.getElementById(packetId);
            if (el && el.style.color === "rgb(255, 255, 255)") { 
                el.style.color = "#ff3333"; 
                el.innerText = `[❌ Немає зв'язку] Я ➡️ ${packet.receiver}: ${text}`;
            }
        }, 15000);
    }
    input.value = "";
};

function displayIncomingMessage(packet, isPrivate) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;
    let rawText = packet.payload;
    if (rawText.startsWith("SEC:")) rawText = "🔒 " + decryptXOR(rawText.substring(4));

    let msgDiv = document.createElement('div');
    msgDiv.style.color = isPrivate ? "#00ccff" : "#4ade80"; 
    msgDiv.innerText = `[📥] ${packet.sender}: ${rawText}`;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
}

function sendAckPulse(origPacketId, targetPeer) {
    if (!meshChannel || meshChannel.readyState !== "open") return;
    let ack = {
        "packet_id": "ack_" + Math.random().toString(36).substr(2, 9),
        "sender": document.getElementById('my-callsign').value,
        "receiver": targetPeer,
        "type": "ACK",
        "payload": origPacketId,
        "timestamp": Math.floor(Date.now() / 1000),
        "ttl": 5
    };
    meshChannel.send(JSON.stringify(ack));
}

function markMessageAsDelivered(packetId) {
    let el = document.getElementById(packetId);
    if (el) {
        el.style.color = "#4ade80"; 
        el.innerText = el.innerText.replace("[📡 Виліт]", "[✔️ Отримано]");
    }
}

function sendTacticalPing() {
    if (meshChannel && meshChannel.readyState === "open" && lastGoodGPS) {
        let ping = {
            "packet_id": "ping_" + Math.random().toString(36).substr(2, 9),
            "sender": document.getElementById('my-callsign').value,
            "receiver": "ALL",
            "type": "GPS",
            "payload": "PING",
            "timestamp": Math.floor(Date.now() / 1000),
            "ttl": 5,
            "coords": { lat: lastGoodGPS.lat, lon: lastGoodGPS.lon }
        };
        meshChannel.send(JSON.stringify(ping));
    }
}
setInterval(sendTacticalPing, 12000); 

function encryptXOR(text) {
    let res = "";
    for (let i = 0; i < text.length; i++) {
        res += String.fromCharCode(text.charCodeAt(i) ^ MESH_CRYPTO_KEY.charCodeAt(i % MESH_CRYPTO_KEY.length));
    }
    return btoa(unescape(encodeURIComponent(res)));
}

function decryptXOR(encoded) {
    let text = decodeURIComponent(escape(atob(encoded)));
    let res = "";
    for (let i = 0; i < text.length; i++) {
        res += String.fromCharCode(text.charCodeAt(i) ^ MESH_CRYPTO_KEY.charCodeAt(i % MESH_CRYPTO_KEY.length));
    }
    return res;
}

function setupInterfaceEvents() {
    const resetBtn = document.getElementById('reset-chat-btn');
    if (resetBtn) {
        resetBtn.onclick = () => {
            currentChatTarget = "ALL";
            document.getElementById('chat-target').innerText = "🌍 РЕЖИМ: ЗАГАЛЬНИЙ ЕФІР (ДЛЯ ВСІХ)";
            document.getElementById('chat-target').style.color = "#fff";
            updatePeersUIList();
        };
    }
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.onclick = () => sendMeshMessage();
}
