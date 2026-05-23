package tactical.mesh.navigator;

import android.content.Context;
import android.net.wifi.p2p.WifiP2pManager;
import android.net.wifi.p2p.WifiP2pInfo;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.net.ServerSocket;
import java.net.Socket;

@CapacitorPlugin(name = "TargetHardware")
public class TargetHardwarePlugin extends Plugin {

    private static final int TCP_PORT = 8080;
    private ServerSocket serverSocket;
    private boolean isServerRunning = false;
    private String targetPeerIp = null;

    @PluginMethod
    public void broadcastPacket(PluginCall call) {
        String mode = call.getString("mode");
        String data = call.getString("data");

        if ("wifi".equalsIgnoreCase(mode) || mode == null) {
            sendTcpDataOverWifi(data);
            call.resolve();
        } else {
            call.resolve();
        }
    }

    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        initWifiDirectMesh();
    }

    private void initWifiDirectMesh() {
        Context ctx = getContext();
        if (ctx == null) return;

        final WifiP2pManager manager = (WifiP2pManager) ctx.getSystemService(Context.WIFI_P2P_SERVICE);
        if (manager != null) {
            final WifiP2pManager.Channel channel = manager.initialize(ctx, ctx.getMainLooper(), null);
            
            manager.createGroup(channel, new WifiP2pManager.ActionListener() {
                @Override
                public void onSuccess() {
                    manager.requestConnectionInfo(channel, new WifiP2pManager.ConnectionInfoListener() {
                        @Override
                        public void onConnectionInfoAvailable(WifiP2pInfo info) {
                            if (info.groupFormed) {
                                if (info.isGroupOwner) {
                                    startLocalTcpServer();
                                } else {
                                    targetPeerIp = info.groupOwnerAddress.getHostAddress();
                                    startLocalTcpServer();
                                }
                            }
                        }
                    });
                }

                @Override
                public void onFailure(int reason) {
                    startLocalTcpServer();
                }
            });
        }
    }

    private void startLocalTcpServer() {
        if (isServerRunning) return;
        isServerRunning = true;

        new Thread(() -> {
            try {
                serverSocket = new ServerSocket(TCP_PORT);
                while (isServerRunning) {
                    Socket clientSocket = serverSocket.accept();
                    
                    String senderIp = clientSocket.getInetAddress().getHostAddress();
                    if (targetPeerIp == null || !targetPeerIp.equals(senderIp)) {
                        targetPeerIp = senderIp;
                    }

                    BufferedReader reader = new BufferedReader(new InputStreamReader(clientSocket.getInputStream()));
                    String rawLine = reader.readLine();
                    
                    if (rawLine != null && !rawLine.trim().isEmpty()) {
                        sendDataToJavaScript(rawLine);
                    }
                    
                    clientSocket.close();
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }).start();
    }

    private void sendTcpDataOverWifi(final String jsonPacket) {
        if (targetPeerIp == null) {
            targetPeerIp = "192.168.43.1"; 
        }

        new Thread(() -> {
            try {
                Socket socket = new Socket(targetPeerIp, TCP_PORT);
                PrintWriter out = new PrintWriter(socket.getOutputStream(), true);
                out.println(jsonPacket);
                socket.close();
            } catch (Exception e) {
                e.printStackTrace();
            }
        }).start();
    }

    private void sendDataToJavaScript(String rawJson) {
        getActivity().runOnUiThread(() -> {
            com.getcapacitor.JSObject ret = new com.getcapacitor.JSObject();
            ret.put("data", rawJson);
            notifyListeners("onPacketReceived", ret);
        });
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        isServerRunning = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (Exception e) { e.printStackTrace(); }
    }
}
