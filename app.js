// =========================================================================
// АВТОНОМНЕ ЛЕГКЕ ЯДРО: ЛОКАЛЬНИЙ ПРЯМИЙ ЕФІР (БЕЗ ШИФРУВАННЯ ТА БЛОКУВАНЬ)
// =========================================================================

let map = null;
let myMarker = null;
let lastGoodGPS = null;

let activeGroupPeers = {}; 
let peerMarkersOnMap = {}; // Глобальний об'єкт для маркерів напарників

window.addEventListener('DOMContentLoaded', () => {
    initMap();
    initGPS();
    initCompass();
    setupInterfaceEvents();
    initNativeMeshListener(); // Запуск прослуховування радіоефіру
    startAutomaticGpsPing();   // Запуск фонової розсилки координат кожні 12 секунд
    
    // Прив'язка кліку для нової кнопки сканування Bluetooth
    const scanBtBtn = document.getElementById('scan-bt-btn');
    if (scanBtBtn) {
        scanBtBtn.onclick = () => window.startBluetoothScan();
    }
});

// Ініціалізація офлайн-сумісної карти Leaflet
function initMap() {
    try {
        map = L.map('map', {
            zoomControl: false,
            attributionControl: false
        }).setView([49.42, 26.98], 13); // Центр за замовчуванням (Хмельницький)

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19
        }).addTo(map);

        // Кнопка швидкого центрування мапи на власному маркері
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
            if (lastGoodGPS && map) {
                map.setView([lastGoodGPS.lat, lastGoodGPS.lon], 16);
            }
        };
        document.body.appendChild(zoomBtn);
    } catch (e) {
        console.error("Помилка карти:", e);
    }
}

// Ініціалізація та фонове відстеження GPS координат
function initGPS() {
    if (!navigator.geolocation) return;

    navigator.geolocation.watchPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            const alt = position.coords.altitude || 0;
            const acc = position.coords.accuracy || 0;

            lastGoodGPS = { lat, lon, alt, acc };

            // Оновлення текстової телеметрії в інфо-барі
            document.getElementById('gps-lat').innerText = lat.toFixed(5);
            document.getElementById('gps-lon').innerText = lon.toFixed(5);
            document.getElementById('gps-alt').innerText = `${Math.round(alt)} м`;
            document.getElementById('gps-acc').innerText = `${Math.round(acc)} м`;

            // Відображення мого маркера на карті
            if (map) {
                if (myMarker) {
                    myMarker.setLatLng([lat, lon]);
                } else {
                    myMarker = L.marker([lat, lon]).addTo(map)
                        .bindPopup('<b>Я (Мій маркер)</b>')
                        .openPopup();
                    map.setView([lat, lon], 15);
                }
            }
        },
        (error) => { console.error("GPS Error:", error); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
    );
}

// Магнітний компас на Північ Землі
function initCompass() {
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientationabsolute', (event) => {
            let heading = event.alpha; // Кут відносно магнітного Півночі
            if (heading !== null) {
                let roundedHeading = Math.round(heading);
                document.getElementById('azimuth-val').innerText = `${roundedHeading}°`;
                const rose = document.getElementById('compass-rose');
                if (rose) {
                    rose.style.transform = `rotate(${-roundedHeading}deg)`;
                }
            }
        }, true);
    }
}

// Налаштування подій елементів інтерфейсу
function setupInterfaceEvents() {
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) {
        sendBtn.onclick = () => window.sendMeshMessage();
    }

    // Ручний імпульс в ефір при натисканні на кнопку "ЕФІР"
    const resetBtn = document.getElementById('reset-chat-btn');
    if (resetBtn) {
        resetBtn.onclick = () => {
            if (lastGoodGPS) {
                const callsign = document.getElementById('my-callsign').value.trim() || "Оператор";
                const packet = {
                    sender: callsign,
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

// НАДШИЛАННЯ ПОВІДОМЛЕННЯ ЧЕРЕЗ ПЛАГІН СAPАСIТОR
window.sendMeshMessage = function() {
    const callsignInput = document.getElementById('my-callsign');
    const msgInput = document.getElementById('msg-input');

    if (!msgInput || !callsignInput) return;

    const text = msgInput.value.trim();
    const callsign = callsignInput.value.trim() || "Оператор";
    if (!text) return;

    const packet = {
        sender: callsign,
        payload: text,
        type: "TEXT",
        lat: lastGoodGPS ? lastGoodGPS.lat : 0,
        lon: lastGoodGPS ? lastGoodGPS.lon : 0
    };

    // Відображаємо у власному логу чату відразу
    displayIncomingMessage(packet);

    // Стріляємо в нативний апаратний ефір
    broadcastThroughHardware(packet);

    msgInput.value = "";
};

// Допоміжна функція передачі пакета в Java-шар
function broadcastThroughHardware(packet) {
    // ВИПРАВЛЕНО: ID елемента в HTML 'hardware-select' замість 'hardware-selector'
    const hardwareSelector = document.getElementById('hardware-select');
    const mode = hardwareSelector ? hardwareSelector.value : "WIFI_DIRECT";

    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TargetHardware) {
        window.Capacitor.Plugins.TargetHardware.broadcastPacket({
            mode: mode,
            data: JSON.stringify(packet)
        }).catch(err => console.error("Апаратний збій передачі:", err));
    }
}

// 📡 АВТОМАТИЧНИЙ ФОНОВИЙ GPS-ПІНГ КОЖНІ 12 СЕКУНД
function startAutomaticGpsPing() {
    setInterval(() => {
        if (!lastGoodGPS) return;
        
        const callsign = document.getElementById('my-callsign').value.trim() || "Оператор";
        const pingPacket = {
            sender: callsign,
            payload: "", // Порожній текст, це суто службовий пінг
            type: "GPS_PING",
            lat: lastGoodGPS.lat,
            lon: lastGoodGPS.lon
        };

        // Передаємо в ефір фоном
        broadcastThroughHardware(pingPacket);
    }, 12000);
}

// 📡 СЛУХАЧ НАВКОЛИШНЬОГО РАДІОЕФІРУ
function initNativeMeshListener() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TargetHardware) {
        window.Capacitor.Plugins.TargetHardware.addListener('onPacketReceived', (info) => {
            try {
                const receivedPacket = JSON.parse(info.data);
                
                // Якщо прилетів текст (і це не пустий авто-пінг) — виводимо у чат
                if (receivedPacket.payload && receivedPacket.payload.trim() !== "" && receivedPacket.type === "TEXT") {
                    displayIncomingMessage(receivedPacket);
                }
                
                // Якщо пакет містить координати напарника — оновлюємо його положення на мапі
                if (receivedPacket.lat && receivedPacket.lon) {
                    window.updatePeerMarkerOnMap(receivedPacket.sender, receivedPacket.lat, receivedPacket.lon);
                }
            } catch (e) {
                console.error("Помилка парсингу радіопакета:", e);
            }
        });
    }
}

// Відображення тексту в чат-боксі
function displayIncomingMessage(packet) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;
    
    let msgDiv = document.createElement('div');
    msgDiv.style.color = "#4ade80"; 
    msgDiv.innerText = `${packet.sender}: ${packet.payload}`;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

// Керування маркерами напарників на офлайн-карті
window.updatePeerMarkerOnMap = function(peerName, lat, lon) {
    if (!map) return;
    
    if (peerMarkersOnMap[peerName]) {
        peerMarkersOnMap[peerName].setLatLng([lat, lon]);
    } else {
        // Якщо напарник з'явився вперше — створюємо маркер із його позивним
        peerMarkersOnMap[peerName] = L.marker([lat, lon]).addTo(map)
            .bindPopup(`<b>${peerName}</b><br>На зв'язку по Mesh`)
            .openPopup();
        
        // Оновлюємо інформаційну зону пошуку сигналу
        const peersZone = document.getElementById('peers-zone');
        if (peersZone) {
            peersZone.innerText = `📡 Активні оператори: ${Object.keys(peerMarkersOnMap).join(', ')}`;
        }
    }
};

// =========================================================================
// БЛОК КЕРУВАННЯ АВТОНОМНИМ BLUETOOTH СКАНУВАННЯМ ТА ПІДКЛЮЧЕННЯМ
// =========================================================================

// Запуск сканування через нативний Java-міст
window.startBluetoothScan = function() {
    const btModal = document.getElementById('bt-modal');
    const btList = document.getElementById('bt-devices-list');
    
    btList.innerHTML = '<span style="color:#00ccff; font-size:11px;">📡 Сканування ефіру...</span>';
    btModal.style.display = 'block';

    if (window.Capacitor && window.Capacitor.Plugins.TargetHardware) {
        window.Capacitor.Plugins.TargetHardware.scanBluetooth().catch(err => console.error(err));
    }
};

// Рендеринг знайденого пристрою у випадаючий список
window.addBluetoothDeviceToList = function(name, mac) {
    const btList = document.getElementById('bt-devices-list');
    
    if(btList.innerHTML.includes("Сканування")) btList.innerHTML = "";
    if(document.getElementById('bt-' + mac)) return; // Уникнення дублікатів

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
    
    // Подія ініціалізації з'єднання при тапі на девайс
    devDiv.onclick = () => {
        devDiv.innerHTML += '<br><span style="color:#eab308; font-size:10px;">⏳ Підключення...</span>';
        if (window.Capacitor && window.Capacitor.Plugins.TargetHardware) {
            window.Capacitor.Plugins.TargetHardware.connectToBluetoothDevice({ mac: mac });
        }
    };

    btList.appendChild(devDiv);
};

// Слухачі подій від Android ОС через Capacitor
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TargetHardware) {
    // Коли знайдено пристрій у радіоефірі
    window.Capacitor.Plugins.TargetHardware.addListener('onBluetoothDeviceFound', (device) => {
        window.addBluetoothDeviceToList(device.name, device.mac);
    });

    // Коли підключення пройшло успішно
    window.Capacitor.Plugins.TargetHardware.addListener('onBluetoothConnected', (info) => {
        const devDiv = document.getElementById('bt-' + info.mac);
        if (devDiv) {
            devDiv.innerHTML = `<span style="color:#4ade80;"><b>✅ Підключено успішно!</b></span>`;
            setTimeout(() => {
                document.getElementById('bt-modal').style.display = 'none'; // Закриваємо панель
            }, 2000);
        }
    });
}
