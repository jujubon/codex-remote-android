import { createHmac, timingSafeEqual } from "node:crypto";
import { createSocket } from "node:dgram";
import { BlockList, isIPv4 } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

export const LAN_PORT = 18788;
const REQUEST = /^CMR1 ([a-f0-9]{32}) ([a-f0-9]{64})$/;

export function trustedLanAddress(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>,
  adapterName: string,
  previousAddress?: string,
): NetworkInterfaceInfo | undefined {
  const matching = Object.entries(interfaces).find(([name]) => name.toLowerCase() === adapterName.toLowerCase())?.[1] ?? [];
  const addresses = matching.filter(entry => entry.family === "IPv4" && !entry.internal
    && isIPv4(entry.address) && /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(entry.address)
    && entry.cidr != null && /\/(?:[1-9]|[12]\d|30)$/.test(entry.cidr));
  return addresses.find(entry => entry.address === previousAddress) ?? addresses[0];
}

function mac(token: string, message: string): Buffer {
  return createHmac("sha256", token).update(message).digest();
}

export function lanDiscoveryReply(message: Buffer, token: string, address: string): Buffer | undefined {
  if (message.length !== 102) return;
  const match = REQUEST.exec(message.toString("utf8"));
  if (!match) return;
  const [, nonce, proof] = match;
  const expected = mac(token, `codex-remote-discover-v1:${nonce}`);
  if (!timingSafeEqual(expected, Buffer.from(proof, "hex"))) return;
  const signature = mac(token, `codex-remote-endpoint-v1:${nonce}:${address}`).toString("hex");
  return Buffer.from(`CMR1 ${nonce} ${address} ${signature}`, "ascii");
}

export function listenForLanDiscovery(token: string, binding: () => { address: string; subnet: BlockList } | undefined): () => void {
  const socket = createSocket("udp4");
  socket.on("message", (message, sender) => {
    const current = binding();
    if (!current?.subnet.check(sender.address)) return;
    const reply = lanDiscoveryReply(message, token, current.address);
    if (reply) socket.send(reply, sender.port, sender.address, () => {});
  });
  socket.on("error", (error) => console.warn("[server] LAN discovery unavailable:", error.message));
  socket.bind(LAN_PORT, "0.0.0.0");
  return () => {
    try { socket.close(); } catch { /* UDP bind already failed. */ }
  };
}
