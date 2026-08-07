import { createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import { base58Encode } from "./base58.js";

/**
 * SLIP-0010 ed25519 hardened derivation, path m/44'/501'/{index}'/0' —
 * the standard Solana wallet scheme, implemented with node:crypto only.
 * The master seed comes from the environment (KMS in production) and must
 * never appear in a log line or the repo.
 */

interface Node {
  key: Buffer;
  chainCode: Buffer;
}

function master(seed: Buffer): Node {
  const i = createHmac("sha512", "ed25519 seed").update(seed).digest();
  return { key: i.subarray(0, 32), chainCode: i.subarray(32) };
}

function childHardened(parent: Node, index: number): Node {
  const data = Buffer.alloc(37);
  data[0] = 0;
  parent.key.copy(data, 1);
  data.writeUInt32BE(index + 0x80000000, 33);
  const i = createHmac("sha512", parent.chainCode).update(data).digest();
  return { key: i.subarray(0, 32), chainCode: i.subarray(32) };
}

/** PKCS8 DER prefix for a raw 32-byte ed25519 private key. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519PublicKey(privateSeed: Buffer): Buffer {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, privateSeed]),
    format: "der",
    type: "pkcs8"
  });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)); // raw key is the DER tail
}

export interface AddressDeriver {
  deriveAddress(index: number): string;
  /**
   * The 32-byte ed25519 seed for a derivation index, which is what signs a
   * sweep out of that deposit address. Verified to produce the same public
   * key as deriveAddress — if those ever diverged, funds sent to an
   * advertised address would be unspendable.
   *
   * Never log this, never return it over HTTP, never store it.
   */
  deriveSigningSeed(index: number): Buffer;
}

export class HdAddressDeriver implements AddressDeriver {
  private root: Node;

  constructor(masterSeedHex: string) {
    if (!/^[0-9a-fA-F]{64,128}$/.test(masterSeedHex)) {
      throw new Error("DEPOSIT_MASTER_SEED must be 64-128 hex chars");
    }
    this.root = master(Buffer.from(masterSeedHex, "hex"));
  }

  deriveAddress(index: number): string {
    return base58Encode(ed25519PublicKey(this.deriveSigningSeed(index)));
  }

  deriveSigningSeed(index: number): Buffer {
    let node = this.root;
    for (const step of [44, 501, index, 0]) node = childHardened(node, step);
    return Buffer.from(node.key);
  }
}
