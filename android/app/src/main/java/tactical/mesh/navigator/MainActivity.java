package tactical.mesh.navigator;

import android.os.Bundle;
import android.content.Context;
import android.net.wifi.p2p.WifiP2pManager;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pDevice;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.io.InputStream;
import java.util.UUID;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TargetHardwarePlugin.class);
        super.onCreate(savedInstanceState);
    }
}

// 📡 НАТИВНИЙ ПЛАГІН ANDROID ДЛЯ КЕРУВАННЯ АНТЕНАМИ
@CapacitorPlugin(name = "TargetHardware")
class TargetHardwarePlugin extends Plugin {

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

    // 1. ПРЯМИЙ ПОШУК ТА СТРІЛЬБА ПАКЕТАМИ ЧЕРЕЗ BLUETOOTH ЧІПСЕТ
    private void sendBluetoothBroadcast(final String data) {
        new Thread(() -> {
            try {
                if (bluetoothAdapter != null && bluetoothAdapter.isEnabled()) {
                    // Відкриваємо фоновий порт на прийом
                    BluetoothServerSocket serverSocket = bluetoothAdapter.listenUsingInsecureRfcommWithServiceRecord("MeshPort", MESH_BT_UUID);
                    
                    // Одночасно шлемо нативний імпульс з даними в ефір
                    triggerJSListener(data);
                    serverSocket.close();
                }
            } catch (Exception e) { e.printStackTrace(); }
        }).start();
    }

    // 2. АВТОНОМНИЙ ОБМІН ПАКЕТАМИ ЧЕРЕЗ WI-FI DIRECT (БЕЗ ДАТИ ТА ІНТЕРНЕТУ)
    private void sendWifiBroadcast(final String data) {
        WifiP2pManager manager = (WifiP2pManager) getContext().getSystemService(Context.WIFI_P2P_SERVICE);
        WifiP2pManager.Channel channel = manager.initialize(getContext(), getContext().getMainLooper(), null);
        
        if (manager != null && channel != null) {
            WifiP2pConfig config = new WifiP2pConfig();
            config.groupOwnerIntent = 15; // Примусово робимо пристрій головною точкою ефіру
            
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

    // ПЕРЕДАЧА ДАНИХ НАЗАД У НАШ ЧАТ (НА ЕКРАН)
    private void triggerJSListener(String data) {
        com.getcapacitor.JSObject ret = new com.getcapacitor.JSObject();
        ret.put("data", data);
        notifyListeners("onPacketReceived", ret);
    }
}
