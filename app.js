// Функція відправки повідомлення через нативне залізо пристрою
window.sendMeshMessage = function() {
    const callsignInput = document.getElementById('my-callsign');
    const msgInput = document.getElementById('msg-input');
    const hardwareSelector = document.getElementById('hardware-selector'); // Ваш <select> у файлі index.html

    if (!msgInput || !callsignInput) return;

    const text = msgInput.value.trim();
    const callsign = callsignInput.value.trim() || "Анон";
    if (!text) return;

    // Збираємо легкий пакет відповідно до технічних вимог
    const packet = {
        sender: callsign,
        payload: text,
        type: "TEXT",
        lat: lastGoodGPS ? lastGoodGPS.lat : 0,
        lon: lastGoodGPS ? lastGoodGPS.lon : 0
    };

    // Відображаємо у власному логу чату відразу
    displayIncomingMessage(packet);

    // Визначаємо обраний користувачем канал (wifi або bluetooth)
    const selectedMode = hardwareSelector ? hardwareSelector.value : "wifi";

    // Стріляємо пакетом чистим текстом через нативний плагін Capacitor
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TargetHardware) {
        window.Capacitor.Plugins.TargetHardware.broadcastPacket({
            mode: selectedMode,
            data: JSON.stringify(packet)
        }).catch(err => console.error("Помилка нативної передачі:", err));
    }

    msgInput.value = "";
};

// Слухач вхідних пакетів із нативного ефіру Android
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TargetHardware) {
    window.Capacitor.Plugins.TargetHardware.addListener('onPacketReceived', (info) => {
        try {
            const receivedPacket = JSON.parse(info.data);
            
            // Якщо це текстове повідомлення — виводимо в чат
            if (receivedPacket.type === "TEXT" || receivedPacket.payload) {
                displayIncomingMessage(receivedPacket);
            }
            
            // Якщо є координати — оновлюємо маркер напарника на карті Leaflet
            if (receivedPacket.lat && receivedPacket.lon && window.updatePeerLocation) {
                window.updatePeerLocation(receivedPacket.sender, receivedPacket.lat, receivedPacket.lon);
            }
        } catch (e) {
            console.error("Помилка парсингу вхідного пакету:", e);
        }
    });
}
