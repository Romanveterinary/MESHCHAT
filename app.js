// =========================================================================
// АВТОНОМНЕ ЛЕГКЕ ЯДРО: ЛОКАЛЬНИЙ ПРЯМИЙ ЕФІР (БЕЗ ШИФРУВАННЯ ТА БЛОКУВАНЬ)
// =========================================================================

let map = null;
let myMarker = null;
let lastGoodGPS = null;

let activeGroupPeers = {}; 
let peerMarkersOnMap = {}; 

// Локальні IP-адреси для зв'язку в точці доступу Android
// Зазвичай телефон-точка має адресу 192.168.43.1, а підключений планшет - 192.168.43.2 - 192.168.43.50
const LOCAL_IP_TARGETS = [
    "192.168.43.1", "192.168.43.2", "192.168.43.3", "192.168.43.4", 
    "192.168.43.5", "192.168.43.10", "192.168.43.20", "192.168.43.100"
];

window.addEventListener('DOMContentLoaded', () => {
    initMap();
    initGPS();
    initCompass();
    setupInterfaceEvents();
    
    // Вмикаємо постійне прослуховування ефіру на пристрої
    startLocalServerListener(); 
});

function initMap() {
    if (typeof L === 'undefined') return;
    try {
        map = L.map('map', { zoomControl: false, doubleClickZoom: false }).setView([49.0, 31.0], 6);
        L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
            maxZoom: 20
        }).addTo(map);
        console.log("Мапа готова.");
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
        }, err => {}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    }
}

function initCompass() {
    if ('deviceorientation' in window) {
        window.addEventListener('deviceorientation', (e) => {
            let azimuth = e.webkitCompassHeading || (e.alpha ? 360 - e.alpha : 0);
            if (azimuth) {
                document.getElementById('azimuth-val').innerText = `${Math.round(azimuth)}°`;
                document.getElementById('compass-rose').style.transform = `rotate(${-azimuth}deg)`;
            }
        }, true);
    }
}

// ПРИЙОМ ПОВІДОМЛЕНЬ ТА КООРДИНАТ БЕЗ СЕРВЕРІВ
function startLocalServerListener() {
    document.getElementById('peers-zone').innerHTML = `<div style="color:#4ade80;">🟢 РАДІОЕФІР АКТИВНИЙ (Очікування)</div>`;
    
    // Перехоплюємо вхідні пакети, які приходять на наш пристрій
    window.addEventListener('message', (event) => {
        try {
            let packet = JSON.parse(event.data);
            processIncomingPacket(packet);
        } catch (e) {}
    });
}

// ОБРОБКА ДАНИХ СУСІДА
function processIncomingPacket(packet) {
    if (!packet.sender) return;

    // Фіксуємо напарника в списку
    activeGroupPeers[packet.sender] = {
        coords: packet.coords,
        lastSeen: Date.now()
    };
    updatePeersUIList();

    // Якщо прийшов текст — виводимо в чат
    if (packet.type === "TEXT" && packet.payload) {
        displayIncomingMessage(packet);
    }
}

function updatePeersUIList() {
    const listZone = document.getElementById('peers-zone');
    if (!listZone) return;
    
    let names = Object.keys(activeGroupPeers);
    if (names.length === 0) {
        listZone.innerHTML = `📡 Пошук радіосигналу...`;
        return;
    }

    listZone.innerHTML = "";
    names.forEach(name => {
        let div = document.createElement('div');
        div.className = "peer-item";
        div.innerHTML = `<span>🟢 <b>${name}</b></span> <span style="color:#0cf; font-weight:bold;">в ефірі</span>`;
        listZone.appendChild(div);
        
        // Рухаємо його маркер на мапі
        let peer = activeGroupPeers[name];
        if (peer.coords && map) {
            if (peerMarkersOnMap[name]) {
                peerMarkersOnMap[name].setLatLng([peer.coords.lat, peer.coords.lon]);
            } else {
                peerMarkersOnMap[name] = L.marker([peer.coords.lat, peer.coords.lon], {
                    icon: L.divIcon({ className: 'peer-tactical-icon', html: `<div class="peer-marker-label">🟢 ${name}</div>` })
                }).addTo(map);
            }
        }
    });
}

// ВІДПРАВКА В ЛОКАЛЬНИЙ ЕФІР
window.sendMeshMessage = function() {
    const input = document.getElementById('msg-input');
    const chatBox = document.getElementById('chat-box');
    let text = input.value.trim();
    let myCallsign = document.getElementById('my-callsign').value.trim() || "Боєць";
    if (!text) return;

    let packet = {
        "sender": myCallsign,
        "type": "TEXT",
        "payload": text,
        "coords": lastGoodGPS ? { lat: lastGoodGPS.lat, lon: lastGoodGPS.lon } : null
    };

    // Відображаємо у себе на екрані
    let msgDiv = document.createElement('div');
    msgDiv.style.color = "#ffffff"; 
    msgDiv.innerText = `Я: ${text}`;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    // Стріляємо пакетом по всіх можливих локальних IP-адресах у Wi-Fi мережі
    LOCAL_IP_TARGETS.forEach(ip => {
        try {
            // Використовуємо стандартний фоновий запит без блокувань
            fetch(`http://${ip}:8080`, {
                method: 'POST',
                mode: 'no-cors',
                body: JSON.stringify(packet)
            }).catch(()=>{});
        } catch (e) {}
    });

    input.value = "";
};

function displayIncomingMessage(packet) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;
    let msgDiv = document.createElement('div');
    msgDiv.style.color = "#4ade80"; 
    msgDiv.innerText = `${packet.sender}: ${packet.payload}`;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function setupInterfaceEvents() {
    document.getElementById('send-btn').onclick = () => sendMeshMessage();
    document.getElementById('reset-chat-btn').onclick = () => {
        // Простий ручний імпульс координатами в ефір
        if (lastGoodGPS) {
            let ping = { "sender": document.getElementById('my-callsign').value, "type": "GPS", "coords": lastGoodGPS };
            LOCAL_IP_TARGETS.forEach(ip => {
                fetch(`http://${ip}:8080`, { method: 'POST', mode: 'no-cors', body: JSON.stringify(ping) }).catch(()=>{});
            });
            alert("Координати відправлено в ефір!");
        }
    };
}
