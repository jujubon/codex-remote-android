package dev.codexmobile.remote;

import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

@CapacitorPlugin(name = "LanDiscovery")
public class LanDiscoveryPlugin extends Plugin {
    private static final int PORT = 18788;
    private static final int TIMEOUT_MS = 900;
    private static final char[] HEX = "0123456789abcdef".toCharArray();
    private final AtomicBoolean searching = new AtomicBoolean();

    @PluginMethod
    public void discover(PluginCall call) {
        String token = call.getString("token");
        if (token == null || token.length() < 32 || !searching.compareAndSet(false, true)) {
            call.resolve(new JSObject());
            return;
        }
        new Thread(() -> {
            JSObject result = new JSObject();
            try {
                String address = discoverOnWifi(token);
                if (address != null) result.put("address", address);
            } catch (Exception ignored) {
                // Wi-Fi may disconnect or reject local traffic during discovery.
            } finally {
                searching.set(false);
                call.resolve(result);
            }
        }, "codex-lan-discovery").start();
    }

    private String discoverOnWifi(String token) throws Exception {
        ConnectivityManager manager = getContext().getSystemService(ConnectivityManager.class);
        if (manager == null) return null;
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities == null || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)) continue;
            LinkProperties properties = manager.getLinkProperties(network);
            if (properties == null) continue;
            for (LinkAddress link : properties.getLinkAddresses()) {
                if (isPrivateIpv4(link.getAddress()) && link.getPrefixLength() >= 1 && link.getPrefixLength() <= 30) {
                    return exchange(network, link, token);
                }
            }
        }
        return null;
    }

    private static String exchange(Network network, LinkAddress link, String token) throws Exception {
        byte[] random = new byte[16];
        new SecureRandom().nextBytes(random);
        String nonce = hex(random);
        Mac authenticator = Mac.getInstance("HmacSHA256");
        authenticator.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String proof = signature(authenticator, "codex-remote-discover-v1:" + nonce);
        byte[] query = ("CMR1 " + nonce + " " + proof).getBytes(StandardCharsets.US_ASCII);

        try (DatagramSocket socket = new DatagramSocket(null)) {
            network.bindSocket(socket);
            socket.bind(new InetSocketAddress(link.getAddress(), 0));
            socket.setBroadcast(true);
            socket.send(new DatagramPacket(query, query.length, broadcastAddress(link), PORT));
            long end = SystemClock.elapsedRealtime() + TIMEOUT_MS;
            byte[] buffer = new byte[160];
            DatagramPacket reply = new DatagramPacket(buffer, buffer.length);
            while (SystemClock.elapsedRealtime() < end) {
                socket.setSoTimeout((int) Math.max(1, end - SystemClock.elapsedRealtime()));
                reply.setLength(buffer.length);
                socket.receive(reply);
                if (reply.getPort() != PORT || !isPrivateIpv4(reply.getAddress())) continue;
                String address = reply.getAddress().getHostAddress();
                String expected = "CMR1 " + nonce + " " + address + " "
                        + signature(authenticator, "codex-remote-endpoint-v1:" + nonce + ":" + address);
                if (MessageDigest.isEqual(Arrays.copyOf(buffer, reply.getLength()), expected.getBytes(StandardCharsets.US_ASCII))) {
                    return address;
                }
            }
        }
        return null;
    }

    private static InetAddress broadcastAddress(LinkAddress link) throws Exception {
        byte[] bytes = link.getAddress().getAddress();
        int prefix = link.getPrefixLength();
        for (int i = 0; i < bytes.length; i++) {
            int networkBits = Math.max(0, Math.min(8, prefix - i * 8));
            bytes[i] |= (byte) (0xff >>> networkBits);
        }
        return InetAddress.getByAddress(bytes);
    }

    private static boolean isPrivateIpv4(InetAddress address) {
        if (!(address instanceof Inet4Address)) return false;
        byte[] bytes = address.getAddress();
        int first = bytes[0] & 0xff;
        int second = bytes[1] & 0xff;
        return first == 10 || (first == 192 && second == 168) || (first == 172 && second >= 16 && second <= 31);
    }

    private static String signature(Mac mac, String value) {
        return hex(mac.doFinal(value.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String hex(byte[] input) {
        char[] result = new char[input.length * 2];
        for (int i = 0; i < input.length; i++) {
            result[i * 2] = HEX[(input[i] & 0xff) >>> 4];
            result[i * 2 + 1] = HEX[input[i] & 0xf];
        }
        return new String(result);
    }
}
