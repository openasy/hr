// Personal data at rest (ADR 0021, KVKK md. 12): every sensitive field, salary, document and note is encrypted with a
// data key of its own (AES-256-GCM), and the data key with the install's key-encryption key, `openasy-kek`, which lives
// outside the data volume. A backup of /data holds only ciphertext. Values that must be found again, such as the
// T.C. kimlik number, are also kept as a keyed hash (HMAC-SHA256 under a key derived from the same KEK), so a duplicate
// is refused without decrypting every record.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

function gcm(key: Buffer, plain: Buffer, aad: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}

function ungcm(key: Buffer, sealed: Buffer, aad: Buffer) {
  const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}

export function createKeyring(kek: Buffer) {
  if (kek.length !== 32) throw new Error("the key-encryption key must be 32 bytes");
  const indexKey = Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), "openasy-hr-blind-index", 32));
  return {
    /**
     * `v1.<wrapped data key>.<ciphertext>`, both base64url. `context` (such as the employee's id and the field) is
     * bound to the ciphertext, so a value copied to another row or field does not open there.
     */
    seal(plain: string | Buffer, context: string): string {
      const dataKey = randomBytes(32);
      const aad = Buffer.from(context);
      const out = `v1.${gcm(kek, dataKey, aad).toString("base64url")}.${gcm(dataKey, Buffer.from(plain), aad).toString("base64url")}`;
      dataKey.fill(0);
      return out;
    },
    open(sealed: string, context: string): Buffer {
      const [v, wrapped, data] = sealed.split(".");
      if (v !== "v1" || !wrapped || !data) throw new Error("not a sealed value");
      const aad = Buffer.from(context);
      const dataKey = ungcm(kek, Buffer.from(wrapped, "base64url"), aad);
      try {
        return ungcm(dataKey, Buffer.from(data, "base64url"), aad);
      } finally {
        dataKey.fill(0);
      }
    },
    /** A keyed hash that finds equal values without revealing them. */
    index: (value: string) => createHmac("sha256", indexKey).update(value).digest("base64url"),
  };
}

export type Keyring = ReturnType<typeof createKeyring>;
