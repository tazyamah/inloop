// 同期の暗号（WebCrypto）。端末の鍵（署名とECDH）、リストの暗号鍵（グループ鍵）、招待、確認の数字を作る。
// 中継（サーバー）は、グループ鍵も招待の秘密も知らないので、リストの内容を読めない。
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = crypto.subtle;

export const b64 = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
export const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const t = s.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
export const hex = (b: ArrayBuffer | Uint8Array): string => [...(b instanceof Uint8Array ? b : new Uint8Array(b))].map((x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
export const sha256 = async (data: string | Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : (data as Uint8Array<ArrayBuffer>)));
export const random = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n));

// ── 端末の鍵 ──
export interface Identity {
  /** 署名の公開鍵（raw、base64url）。端末の身元。 */
  sign: string;
  ecdh: string;
  /** 秘密鍵（JWK）。端末のSQLiteにだけ置く。 */
  signPriv: JsonWebKey;
  ecdhPriv: JsonWebKey;
}

export async function newIdentity(): Promise<Identity> {
  const s = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const e = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    sign: b64((await subtle.exportKey("raw", s.publicKey)) as ArrayBuffer),
    ecdh: b64((await subtle.exportKey("raw", e.publicKey)) as ArrayBuffer),
    signPriv: (await subtle.exportKey("jwk", s.privateKey)) as JsonWebKey,
    ecdhPriv: (await subtle.exportKey("jwk", e.privateKey)) as JsonWebKey,
  };
}

/** 端末の識別子。署名の公開鍵のハッシュ。 */
export const deviceId = async (signPub: string): Promise<string> => hex(await sha256(unb64(signPub))).slice(0, 32);

export async function sign(id: Identity, data: string): Promise<string> {
  const key = await subtle.importKey("jwk", id.signPriv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return b64(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(data)));
}

export async function verify(signPub: string, data: string, sig: string): Promise<boolean> {
  try {
    const key = await subtle.importKey("raw", unb64(signPub), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64(sig), enc.encode(data));
  } catch {
    return false;
  }
}

// ── グループ鍵（リストの暗号鍵）──
export const newGroupKey = (): string => b64(random(32));

export interface GroupKeys {
  /** 行の識別子（表名とuidから作る、不透明な値）。 */
  rid(table: string, uid: string): Promise<string>;
  encrypt(value: unknown): Promise<string>;
  decrypt(blob: string): Promise<unknown>;
}

export async function groupKeys(key: string): Promise<GroupKeys> {
  const base = await subtle.importKey("raw", unb64(key), "HKDF", false, ["deriveKey"]);
  const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: enc.encode("inloop-sync-v2"), info: enc.encode(info) });
  const aes = await subtle.deriveKey(hkdf("enc"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const mac = await subtle.deriveKey(hkdf("rid"), base, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return {
    rid: async (table, uid) => hex(await subtle.sign("HMAC", mac, enc.encode(`${table}:${uid}`))),
    encrypt: async (value) => {
      const iv = random(12);
      const body = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, aes, enc.encode(JSON.stringify(value))));
      const out = new Uint8Array(12 + body.length);
      out.set(iv);
      out.set(body, 12);
      return b64(out);
    },
    decrypt: async (blob) => {
      const all = unb64(blob);
      return JSON.parse(dec.decode(await subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, aes, all.slice(12)))) as unknown;
    },
  };
}

// ── グループ鍵の受け渡し（ECDHで包む）──
async function sharedKey(myEcdhPriv: JsonWebKey, theirEcdhPub: string, info: string): Promise<CryptoKey> {
  const priv = await subtle.importKey("jwk", myEcdhPriv, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pub = await subtle.importKey("raw", unb64(theirEcdhPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await subtle.deriveBits({ name: "ECDH", public: pub } as never, priv, 256);
  const base = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("inloop-wrap-v2"), info: enc.encode(info) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** グループ鍵を、相手の端末だけが開けるように包む。info には、部屋と世代を入れる（別の文脈で使い回されないように）。 */
export async function wrapGroupKey(me: Identity, theirEcdhPub: string, groupKey: string, info: string): Promise<string> {
  const iv = random(12);
  const k = await sharedKey(me.ecdhPriv, theirEcdhPub, info);
  const body = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, k, unb64(groupKey)));
  const out = new Uint8Array(12 + body.length);
  out.set(iv);
  out.set(body, 12);
  return b64(out);
}

export async function unwrapGroupKey(me: Identity, senderEcdhPub: string, wrapped: string, info: string): Promise<string> {
  const all = unb64(wrapped);
  const k = await sharedKey(me.ecdhPriv, senderEcdhPub, info);
  return b64(await subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, k, all.slice(12)));
}

// ── 招待 ──
export interface Invite {
  /** 招待コード（部屋の名前＋秘密）。人が渡す。 */
  code: string;
  roomId: string;
  /** 秘密（端末だけが知る）。 */
  secret: string;
  /** 中継に渡す照合用の値（秘密のハッシュ）。 */
  verifier: string;
  /** 照合用の値の識別子。 */
  id: string;
}

const inviteParts = async (roomId: string, secret: Uint8Array) => {
  const verifier = b64(await sha256(new Uint8Array([...enc.encode("inloop-invite-v2"), ...secret])));
  const id = hex(await sha256(verifier)).slice(0, 16);
  return { roomId, secret: b64(secret), verifier, id };
};

export async function newInvite(roomId: string): Promise<Invite> {
  const secret = random(10);
  return { code: b64(new Uint8Array([...unhex(roomId), ...secret])), ...(await inviteParts(roomId, secret)) };
}

export async function parseInvite(code: string): Promise<Omit<Invite, "code"> | null> {
  if (!/^[A-Za-z0-9_-]{35}$/.test(code)) return null;
  const all = unb64(code);
  if (all.length !== 26) return null;
  return inviteParts(hex(all.slice(0, 16)), all.slice(16));
}

/** 招待の秘密を知っていることの証明（中継が覚えている照合用の値で確かめられる）。 */
export async function inviteProof(verifier: string, nonce: string, applicantSign: string, applicantEcdh: string): Promise<string> {
  const key = await subtle.importKey("raw", unb64(verifier), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await subtle.sign("HMAC", key, enc.encode(`${nonce}|${applicantSign}|${applicantEcdh}`)));
}

export async function verifyInviteProof(verifier: string, nonce: string, applicantSign: string, applicantEcdh: string, proof: string): Promise<boolean> {
  return (await inviteProof(verifier, nonce, applicantSign, applicantEcdh)) === proof;
}

/** 確認の数字（4桁）。参加する端末とオーナーの端末で、同じになることを人が見比べる。招待の秘密を含むので、中継は偽造できない。 */
export async function confirmDigits(ownerSign: string, ownerEcdh: string, applicantSign: string, applicantEcdh: string, secret: string): Promise<string> {
  const h = await sha256(`${ownerSign}|${ownerEcdh}|${applicantSign}|${applicantEcdh}|${secret}`);
  const n = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  return String(n % 10000).padStart(4, "0");
}
