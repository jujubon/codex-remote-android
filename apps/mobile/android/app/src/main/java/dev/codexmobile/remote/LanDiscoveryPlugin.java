package dev.codexmobile.remote;

import android.annotation.TargetApi;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.TetheringInterface;
import android.net.TetheringManager;
import android.os.Build;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
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
                if (address == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
                    address = HotspotDiscovery.discover(getContext(), token);
                }
                if (address != null) result.put("address", address);
            } catch (Exception ignored) {
                // Network availability can change during discovery.
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
                if (!isDiscoveryAddress(link.getAddress(), link.getPrefixLength())) continue;
                try {
                    return exchange(network, link.getAddress(), link.getPrefixLength(), token);
                } catch (IOException ignored) {
                    // This Wi-Fi route may have disappeared while checking it.
                    return null;
                }
            }
        }
        return null;
    }

    @TargetApi(Build.VERSION_CODES.BAKLAVA)
    private static final class HotspotDiscovery {
        private static final int INTERFACE_TIMEOUT_MS = 400;

        static String discover(Context context, String token) throws Exception {
            TetheringManager manager = context.getSystemService(TetheringManager.class);
            if (manager == null) return null;
            CompletableFuture<Set<TetheringInterface>> downstream = new CompletableFuture<>();
            TetheringManager.TetheringEventCallback callback = new TetheringManager.TetheringEventCallback() {
                @Override
                public void onTetheredInterfacesChanged(Set<TetheringInterface> interfaces) {
                    downstream.complete(interfaces);
                }
            };
            manager.registerTetheringEventCallback(Runnable::run, callback);
            Set<TetheringInterface> interfaces;
            try {
                interfaces = downstream.get(INTERFACE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } finally {
                manager.unregisterTetheringEventCallback(callback);
            }
            for (TetheringInterface tether : interfaces) {
                if (tether.getType() != TetheringManager.TETHERING_WIFI) continue;
                try {
                    NetworkInterface hotspot = NetworkInterface.getByName(tether.getInterface());
                    if (hotspot == null || !hotspot.isUp()) continue;
                    for (InterfaceAddress entry : hotspot.getInterfaceAddresses()) {
                        if (!isDiscoveryAddress(entry.getAddress(), entry.getNetworkPrefixLength())) continue;
                        // The tethered interface is not a Wi-Fi client Network.
                        String address = exchange(null, entry.getAddress(), entry.getNetworkPrefixLength(), token);
                        if (address != null) return address;
                    }
                } catch (IOException ignored) {
                    // The hotspot may have been disabled since Android reported it.
                }
            }
            return null;
        }
    }

    private static String exchange(Network network, InetAddress localAddress, int prefix, String token) throws Exception {
        byte[] random = new byte[16];
        new SecureRandom().nextBytes(random);
        String nonce = hex(random);
        Mac authenticator = Mac.getInstance("HmacSHA256");
        authenticator.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String proof = signature(authenticator, "codex-remote-discover-v1:" + nonce);
        byte[] query = ("CMR1 " + nonce + " " + proof).getBytes(StandardCharsets.US_ASCII);

        try (DatagramSocket socket = new DatagramSocket(null)) {
            if (network != null) network.bindSocket(socket);
            socket.bind(new InetSocketAddress(localAddress, 0));
            socket.setBroadcast(true);
            socket.send(new DatagramPacket(query, query.length, broadcastAddress(localAddress, prefix), PORT));
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
        } catch (SocketTimeoutException ignored) {
            return null;
        }
        return null;
    }

    private static InetAddress broadcastAddress(InetAddress address, int prefix) throws Exception {
        byte[] bytes = address.getAddress();
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

    private static boolean isDiscoveryAddress(InetAddress address, int prefix) {
        return prefix >= 1 && prefix <= 30 && isPrivateIpv4(address);
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
