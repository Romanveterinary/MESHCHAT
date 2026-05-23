package tactical.mesh.navigator;

import android.os.Bundle;
import android.content.Context;
import android.net.wifi.p2p.WifiP2pManager;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pInfo;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.net.ServerSocket;
import java.net.Socket;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TargetHardwarePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @CapacitorPlugin(name = "TargetHardware")
    public static class TargetHardwarePlugin extends Plugin {

        private static final int PORT = 8080;
        private ServerSocket serverSocket;
        private boolean isRunning = false;
        private String targetIpAddress = "192.168.43.1"; // Default IP для клієнта (Group Owner)

        @PluginMethod
        public void broadcastPacket(PluginCall call) {
            String mode = call.getString("mode"); // "wifi" або "bluetooth"
            String data = call.getString("data"); // Чистий JSON рядок з чату

            if ("wifi".equalsIgnoreCase(mode)) {
                sendWifiData(data);
                call.resolve();
            } else {
                // Залишаємо заглушку для Bluetooth на наступний крок
                call.resolve();
            }
        }

        // Ініціалізація мережі Wi-Fi Direct та запуск Сервера/Клієнта
        @Override
        protected void handleOnStart() {
            super.handleOnStart();
            startMeshNetwork();
        }

        private void startMeshNetwork() {
            Context ctx = getContext();
            if (ctx == null) return;

            WifiP2pManager manager = (WifiP2pManager) ctx.getSystemService(Context.WIFI_P2P_SERVICE);
            if (manager != null) {
                WifiP2pManager.Channel channel = manager.initialize(ctx, ctx.getMainLooper(), null);
                
                // Створюємо автономну P2P групу (один з девайсів автоматично стане власником групи)
                manager.createGroup(channel, new WifiP2pManager.ActionListener() {
                    @Override
                    public void onSuccess() {
                        // Група створена успішно. Запитуємо інформацію про лінк (хто сервер, яка IP)
                        manager.requestConnectionInfo(channel, new WifiP2pManager.ConnectionInfoListener() {
                            @Override
                            public void onConnectionInfoAvailable(WifiP2pInfo info) {
                                if (info.groupFormed) {
                                    if (info.isGroupOwner) {
                                        // Цей пристрій — Сервер (Group Owner)
                                        targetIpAddress = null; 
                                        startTcpServer();
                                    } else {
                                        // Цей пристрій — Клієнт. Отримуємо IP-адресу власника групи
                                        targetIpAddress = info.groupOwnerAddress.getHostAddress();
                                        startTcpServer(); // Клієнт теж тримає сервер для двостороннього обміну
                                    }
                                }
                            }
                        });
                    }

                    @Override
                    public void onFailure(int reason) {}
                });
            }
        }

        // Нативний легкий TCP-сервер, який слухає ефір у фоновому потоці
        private void startTcpServer() {
            if (isRunning) return;
            isRunning = true;

            new Thread(() -> {
                try {
                    serverSocket = new ServerSocket(PORT);
                    while (isRunning) {
                        Socket socket = serverSocket.accept();
                        
                        // Зберігаємо IP пристрою, який до нас звернувся, для оперативної відповіді
                        String senderIp = socket.getInetAddress().getHostAddress();
                        if (targetIpAddress == null || !targetIpAddress.equals(senderIp)) {
                            targetIpAddress = senderIp;
                        }

                        BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream()));
                        String incomingLine = reader.readLine(); // Читаємо чистий JSON рядок
                        
                        if (incomingLine != null && !incomingLine.trim().isEmpty()) {
                            triggerJSListener(incomingLine);
                        }
                        
                        socket.close();
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }).start();
        }

        // Функція відправки текстового пакету по сокету прямо на IP напарника
        private void sendWifiData(final String data) {
            if (targetIpAddress == null) return; // Якщо напарник ще не підключився

            new Thread(() -> {
                try {
                    Socket socket = new Socket(targetIpAddress, PORT);
                    PrintWriter writer = new PrintWriter(socket.getOutputStream(), true);
                    writer.println(data); // Відправляємо чистим текстом із символом перенесення рядка
                    socket.close();
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }).start();
        }

        private void triggerJSListener(String rawJsonData) {
            getActivity().runOnUiThread(() -> {
                com.getcapacitor.JSObject ret = new com.getcapacitor.JSObject();
                ret.put("data", rawJsonData);
                notifyListeners("onPacketReceived", ret);
            });
        }

        @Override
        protected void handleOnStop() {
            super.handleOnStop();
            isRunning = false;
            try {
                if (serverSocket != null) serverSocket.close();
            } catch (Exception e) { e.printStackTrace(); }
        }
    }
}
