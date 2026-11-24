import { createHmac } from "node:crypto";
import type { NetworkInterfaceInfo } from "node:os";
import { expect, it } from "vitest";
import { lanDiscoveryReply, trustedLanAddress } from "../src/lan-discovery.js";

it("only answers a signed request and authenticates the current LAN address", () => {
  const nonce = "01".repeat(16);
  const token = "test pairing token";
  const mac = (value: string) => createHmac("sha256", token).update(value).digest("hex");
  const request = Buffer.from(`CMR1 ${nonce} ${mac(`codex-remote-discover-v1:${nonce}`)}`);
  const address = "192.168.20.25";
  expect(lanDiscoveryReply(request, token, address)?.toString()).toBe(
    `CMR1 ${nonce} ${address} ${mac(`codex-remote-endpoint-v1:${nonce}:${address}`)}`,
  );
  expect(lanDiscoveryReply(request, "a different phone pairing", address)).toBeUndefined();
  expect(lanDiscoveryReply(Buffer.from(`CMR1 ${nonce} ${"0".repeat(64)}`), token, address)).toBeUndefined();
});

it("follows new private IPv4 addresses on the selected Windows adapter", () => {
  const address = (ip: string): NetworkInterfaceInfo => ({
    family: "IPv4", address: ip, cidr: `${ip}/24`, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", internal: false,
  });
  const interfaces = { WiFi: [address("192.168.20.26")], Other: [address("192.168.20.25")] };
  expect(trustedLanAddress(interfaces, "wifi", "192.168.20.25")?.address).toBe("192.168.20.26");
  expect(trustedLanAddress(interfaces, "Unknown")).toBeUndefined();
  expect(trustedLanAddress({ WiFi: [address("203.0.113.8")] }, "WiFi")).toBeUndefined();
});
