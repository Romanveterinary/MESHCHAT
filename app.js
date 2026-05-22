// =========================================================================
// АВТОНОМНЕ ЯДРО MESH-МЕРЕЖІ ТА РАЦІЇ (ПОВНА ВЕРСІЯ З HTTPS МАПОЮ)
// =========================================================================

let map = null;
let myMarker = null;
let lastGoodGPS = null;
let currentChatTarget = "ALL"; // За замовчуванням — загальний ефір

// Mesh-перемінні
let meshChannel = null;
let localPeerConnection = null;
let receivedPacketsLog = new Set(); // Щоб пакети не зациклювалися в мережі
let activeGroupPeers = {}; // Список живих бійців у мережі та їхні дані
let peerMarkersOnMap = {}; // Маркери бійців на Leaflet мапі

// Константа шифрування для закритих чатів
const MESH_CRYPTO_KEY = "RA_STORM_2026";

window.addEventListener('DOMContentLoaded', () => {
    initMap();
    initGPS();
    setupInterfaceEvents();
    initLocalMeshTransport(); // Запуск радіосканера при старті
});

// 1. ЗАПУСК ОФЛАЙН/ОНЛАЙН МАПИ (З захистом від блокування Android)
function initMap() {
    if (typeof L === 'undefined') return;
    try {
        // Створюємо карту
        map = L.map('map', { 
            zoomControl: false, 
            doubleClickZoom: false 
        }).setView([49.0, 31.0], 6);

        // Підключаємо СУПУТНИК через захищений HTTPS (щоб Android не блокував відображення)
        let satelliteLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
            maxZoom: 20,
            attribution: 'Tactical Offline Mesh Map'
        });
        satelliteLayer.addTo(map);

        console.log("Tactical Map: Захищений HTTPS шар ініціалізовано.");
    } catch (e) { 
        console.error("Помилка карти:", e); 
    }
}

// 2. АВТОНОМНИЙ ПОШУК СУПУТНИКІВ (GPS)
function initGPS() {
    if ('geolocation' in navigator) {
        navigator.geolocation.watchPosition(pos => {
            const { latitude: lat, longitude: lon } = pos.coords;
            lastGoodGPS = { lat, lon };

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
            updatePeersDistances(); // Перераховуємо відстані, якщо ми змістилися
        }, err => {
            if (!lastGoodGPS) {
                lastGoodGPS = { lat: 49.84, lon: 24.02 }; // Дефолтний Львів для ПК тестів
                if (map) map.setView([lastGoodGPS.lat, lastGoodGPS.lon], 14);
            }
        }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    }
}

// 3. ЛОКАЛЬНИЙ P2P Wi-Fi ТРАНСПОРТ (WebRTC Data Channel без інтернету)
function initLocalMeshTransport() {
    if (localPeerConnection) return;
    try {
        localPeerConnection = new RTCPeerConnection({ iceServers: [] }); // iceServers порожні — робота суто в лоці
        
        meshChannel = localPeerConnection.createDataChannel("tactical_mesh_data", { negotiated: true, id: 1 });
        
        meshChannel.onopen = () => {
            document.getElementById('peers-zone').innerHTML = `<div style="color:#4ade80;">📡 ЕФІР СТАБІЛЬНИЙ. Очікування пакетів...</div>`;
            sendTacticalPing(); // Стріляємо своїми даними в мережу
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

// 4. ОБРОБКА ТАКТИЧНИХ ПАКЕТІВ ТА ЛОГІКА MESH-МІСТКІВ
function processIncomingMeshPacket(packet) {
    if (receivedPacketsLog.has(packet.packet_id)) return;
    receivedPacketsLog.add(packet.packet_id);

    // Зменшуємо кількість життів пакета (стрибків)
    packet.ttl -= 1;

    let myCallsign = document.getElementById('my-callsign').value.trim() || "Боєць";

    // Фіксуємо бійця в базі активних пристроїв поруч
    if (packet.sender && packet.sender !== myCallsign) {
        // Прораховуємо місток: якщо ttl став 4, значить пакет прийшов напряму (5-1=4). Якщо менше — через когось.
        let hopRoute = packet.ttl === 4 ? "прямий зв'язок" : `міст: ${packet.via || "ретранслятор"}`;
        
        activeGroupPeers[packet.sender] = {
            coords: packet.coords,
            lastSeen: Date.now(),
            route: hopRoute
        };
        updatePeersUIList(); // Оновлюємо список на екрані
        if (packet.coords) updatePeerMarkerOnMap(packet.sender, packet.coords); // Рухаємо маркер на мапі
    }

    // ЛОГІКА ДОСТАВКИ ПОВІДОМЛЕНЬ
    if (packet.type === "TEXT" || packet.type === "AUDIO") {
        let isForMe = packet.receiver === myCallsign;
        let isGeneral = packet.receiver === "ALL";

        if (isGeneral || isForMe) {
            displayIncomingMessage(packet, isForMe);
            // Якщо повідомлення приватне — висилаємо назад ACK-імпульс успіху
            if (isForMe) sendAckPulse(packet.packet_id, packet.sender);
        }
    }

    // ЛОГІКА ПІДТВЕРДЖЕННЯ (ACK)
    if (packet.type === "ACK" && packet.receiver === myCallsign) {
        markMessageAsDelivered(packet.payload); // В payload лежить id оригінального повідомлення
    }

    // РЕТРАНСЛЯЦІЯ (Місток): Якщо пакет іде далі і ttl ще живий — викидаємо в ефір
    if (packet.ttl > 0 && meshChannel && meshChannel.readyState === "open") {
        packet.via = myCallsign; // Записуємо себе як транзитного ретранслятора
        meshChannel.send(JSON.stringify(packet));
    }
}

// 5. КЕРУВАННЯ МАРКЕРАМИ ТОВАРИШІВ НА МАПІ
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

// 6. СИНХРОНІЗАЦІЯ ВІДСТАНЕЙ ТА СОРТУВАННЯ СПИСКУ ГРУПИ
function updatePeersDistances() {
    if (!lastGoodGPS || typeof L === 'undefined') return;
    for (let callsign in activeGroupPeers) {
        let peer = activeGroupPeers[callsign];
        if (peer.coords) {
            // Рахуємо метри через вбудований Leaflet гаверсинус
            peer.distance = Math.round(L.latLng(lastGoodGPS.lat, lastGoodGPS.lon).distanceTo(L.latLng(peer.coords.lat, peer.coords.lon)));
        } else { peer.distance = 99999; } // Якщо немає GPS у напарника
    }
    updatePeersUIList();
}

function updatePeersUIList() {
    const listZone = document.getElementById('peers-zone');
    if (!listZone) return;

    // Очищаємо список перед сортуванням
    let peersArray = [];
    for (let name in activeGroupPeers) {
        // Видаляємо "привидів" якщо від них немає сигналу більше 1 хвилини
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

    // СОРТУВАННЯ: Хто найближче — той на самому верху
    peersArray.sort((a, b) => a.distance - b.distance);

    listZone.innerHTML = "";
    peersArray.forEach(peer => {
        let distText = peer.distance === 99999 ? "--- м" : `${peer.distance} м`;
        let isPrivateMark = currentChatTarget === peer.name ? "style='border-color:#0cf; background:rgba(0,204,255,0.1);'" : "";

        let div = document.createElement('div');
        div.className = "peer-item";
        div.setAttribute('style', isPrivateMark ? "border-color:#0cf; background:rgba(0,204,255,0.1);" : "");
        div.onclick = () => window.selectPeerForPrivateChat(peer.name);
        div.innerHTML = `<span>🟢 <b>${peer.name}</b> (${peer.route})</span> <span style="color:#0cf; font-weight:bold;">${distText}</span>`;
        listZone.appendChild(div);
    });
}

// 7. ВІДПРАВКА ПОВІДОМЛЕНЬ (Логіка кольорів)
window.sendMeshMessage = function() {
    const input = document.getElementById('msg-input');
    const chatBox = document.getElementById('chat-box');
    let text = input.value.trim();
    let myCallsign = document.getElementById('my-callsign').value.trim() || "Боєць";
    if (!text) return;

    let packetId = "id_" + Math.random().toString(36).substr(2, 9);
    let payloadData = text;

    // ЗАКРИТИЙ ЧАТ (Шифрування XOR якщо адресат конкретний)
    let isPrivate = currentChatTarget !== "ALL";
    if (isPrivate) {
        payloadData = "SEC:" + encryptXOR(text);
    }

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

    // Виводимо БІЛИМ коліром (Повідомлення в ефірі, чекаємо ACK)
    let msgDiv = document.createElement('div');
    msgDiv.id = packetId;
    msgDiv.className = "msg-line";
    msgDiv.style.color = "#ffffff"; // БІЛИЙ
    msgDiv.innerText = `[📡 Виліт] Я ➡️ ${currentChatTarget}: ${text}`;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    if (meshChannel && meshChannel.readyState === "open") {
        meshChannel.send(JSON.stringify(packet));
        
        // Для загального ефіру (ALL) підтвердження ACK не буде, тому робимо його зеленим через 1 сек автоматично
        if (!isPrivate) {
            setTimeout(() => {
                if(msgDiv) { msgDiv.style.color = "#4ade80"; msgDiv.innerText = `[🌍 Ефір] Я: ${text}`; }
            }, 1000);
        }
    }

    // ТАЙМАУТ ДОСТАВКИ: Якщо приватне за 15 сек не отримало ACK — фарбуємо в ЧЕРВОНИЙ
    if (isPrivate) {
        setTimeout(() => {
            let el = document.getElementById(packetId);
            if (el && el.style.color === "rgb(255, 255, 255)") { // досі біле
                el.style.color = "#ff3333"; // ЧЕРВОНИЙ
                el.innerText = `[❌ Немає зв'язку] Я ➡️ ${packet.receiver}: ${text}`;
            }
        }, 15000);
    }

    input.value = "";
};

// 8. ВІДОБРАЖЕННЯ ВХІДНИХ ДАНИХ (Декодування)
function displayIncomingMessage(packet, isPrivate) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;

    let rawText = packet.payload;
    // Якщо прийшов зашифрований приват
    if (rawText.startsWith("SEC:")) {
        rawText = "🔒 " + decryptXOR(rawText.substring(4));
    }

    let msgDiv = document.createElement('div');
    msgDiv.className = "msg-line";
    msgDiv.style.color = isPrivate ? "#00ccff" : "#4ade80"; // Синій для привату, Зелений для загального
    msgDiv.innerText = `[📥] ${packet.sender}: ${rawText}`;
    
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    // Сигнал звуку та вібро при отриманні повідомлення
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
        el.style.color = "#4ade80"; // Стає ЗЕЛЕНИМ при успішній доставці
        el.innerText = el.innerText.replace("[📡 Виліт]", "[✔️ Отримано]");
    }
}

// 9. АВТОПІНГ КООРДИНАТАМИ ТА ШИФРУВАННЯ
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
setInterval(sendTacticalPing, 12000); // Дихаємо координатами в ефір кожні 12 секунд

function encryptXOR(text) {
    let res = "";
    for (let i = 0; i < text.length; i++) {
        res += String.fromCharCode(text.charCodeAt(i) ^ MESH_CRYPTO_KEY.charCodeAt(i % MESH_CRYPTO_KEY.length));
    }
    return btoa(unescape(encodeURIComponent(res))); // сейв для UTF-8
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
