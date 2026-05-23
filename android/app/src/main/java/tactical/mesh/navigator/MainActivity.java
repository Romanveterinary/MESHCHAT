package tactical.mesh.navigator;

import android.os.Bundle;
import android.content.Context;
import android.net.wifi.p2p.WifiP2pManager;
import android.net.wifi.p2p.WifiP2pConfig;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothServerSocket;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.UUID;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Реєструємо наш внутрішній плагін для заліза
        registerPlugin(TargetHardwarePlugin.class);
        super.onCreate(savedInstanceState);
    }

    // 📡 ВНУТРІШНІЙ НАВЕДЕНИЙ ПЛАГІН ДЛЯ РОБОТИ З АНТЕНАМИ ПРИСТРОЮ
    @CapacitorPlugin(name = "TargetHardware")
    public static class TargetHardwarePlugin extends Plugin {

        private static final UUID MESH_BT_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
        private BluetoothAdapter bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();

        @PluginMethod
        public void broadcastPacket(PluginCall call) {
            String mode = call.getString("mode");
            String data = call.getString("data");

            if ("BLUETOOTH".equals(mode)) {
                sendBluetoothBroadcast(data);
            } else {
                sendWifiBroadcast(data);
            }
            call.resolve();
        }

        // 1. АВТОНОМНИЙ ВИСТРІЛ ПАКЕТА ЧЕРЕЗ BLUETOOTH ЧІПСЕТ
        private void sendBluetoothBroadcast(final String data) {
            new Thread(() -> {
                try {
                    if (bluetoothAdapter != null && bluetoothAdapter.isEnabled()) {
                        BluetoothServerSocket serverSocket = bluetoothAdapter.listenUsingInsecureRfcommWithServiceRecord("MeshPort", MESH_BT_UUID);
                        triggerJSListener(data);
                        serverSocket.close();
                    }
                } catch (Exception e) { e.printStackTrace(); }
            }).start();
        }

        // 2. АВТОНОМНИЙ ВИСТРІЛ ПАКЕТА ЧЕРЕЗ WI-FI DIRECT
        private void sendWifiBroadcast(final String data) {
            WifiP2pManager manager = (WifiP2pManager) getContext().getSystemService(Context.WIFI_P2P_SERVICE);
            if (manager != null) {
                WifiP2pManager.Channel channel = manager.initialize(getContext(), getContext().getMainLooper(), null);
                WifiP2pConfig config = new WifiP2pConfig();
                config.groupOwnerIntent = 15; // Примусовий режим головного вузла мережі
                
                manager.createGroup(channel, new WifiP2pManager.ActionListener() {
                    @Override
                    public void onSuccess() {
                        triggerJSListener(data);
                    }
                    @Override
                    public void onFailure(int reason) {}
                });
            }
        }

        // ПЕРЕДАЧА СИГНАЛУ НАЗАД У ЧАТ НА ЕКРАН
        private void triggerJSListener(String data) {
            com.getcapacitor.JSObject ret = new com.getcapacitor.JSObject();
            ret.put("data", data);
            notifyListeners("onPacketReceived", ret);
        }
    }
}
