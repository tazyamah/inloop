// 共有の参加者の記録（鎖）。オーナーが署名した記録を、順に連ねる。端末も中継も、鎖を検証する。
// 鎖が分かれた（同じ番号の別の記録がある）、オーナー以外の署名がある、といった不整合は、
// 「別のオーナーがいる（オーナーの鍵が複製された）」可能性として、画面でアラートにする。
import { deviceId, hex, sha256, sign, verify, type Identity } from "./crypto.ts";

export interface Device { id: string; sign: string; ecdh: string; name: string }

export interface MemberRecord {
  ver: number;
  /** 前の記録のハッシュ（最初は空）。 */
  prev: string;
  type: "root" | "add" | "remove";
  device: Device;
  ts: number;
  /** オーナーの署名。 */
  sig: string;
}

export const bodyOf = (r: Omit<MemberRecord, "sig">): string => JSON.stringify([r.ver, r.prev, r.type, r.device.id, r.device.sign, r.device.ecdh, r.device.name, r.ts]);
export const recordHash = async (r: MemberRecord): Promise<string> => hex(await sha256(`${bodyOf(r)}|${r.sig}`));

export async function deviceOf(id: Identity, name: string): Promise<Device> {
  return { id: await deviceId(id.sign), sign: id.sign, ecdh: id.ecdh, name };
}

/** オーナーの署名つきの記録を作る。 */
export async function makeRecord(owner: Identity, fields: Omit<MemberRecord, "sig">): Promise<MemberRecord> {
  return { ...fields, sig: await sign(owner, bodyOf(fields)) };
}

export interface Chain {
  owner: Device;
  /** オーナーを含む、今の参加者。 */
  members: Device[];
  headVer: number;
  headHash: string;
}

export type ChainResult = { ok: true; chain: Chain } | { ok: false; reason: string };

const validDevice = async (d: unknown): Promise<boolean> => {
  if (typeof d !== "object" || d === null) return false;
  const x = d as Record<string, unknown>;
  return typeof x.id === "string" && typeof x.sign === "string" && typeof x.ecdh === "string" && typeof x.name === "string" && x.name.length >= 1 && x.name.length <= 40 && x.id === (await deviceId(x.sign).catch(() => ""));
};

/** 記録を最初から検証して、今の参加者を求める。pinnedOwner があれば、オーナーの鍵がそれと一致することも確かめる。 */
export async function verifyChain(records: MemberRecord[], pinnedOwner?: string): Promise<ChainResult> {
  if (records.length === 0) return { ok: false, reason: "記録がありません" };
  let owner: Device | null = null;
  const members = new Map<string, Device>();
  let prevHash = "";
  for (const [i, r] of records.entries()) {
    if (r.ver !== i + 1) return { ok: false, reason: "記録の番号が連続していません" };
    if (r.prev !== prevHash) return { ok: false, reason: "記録のつながりが合いません" };
    if (!(await validDevice(r.device))) return { ok: false, reason: "端末の記録が不正です" };
    if (i === 0) {
      if (r.type !== "root") return { ok: false, reason: "最初の記録が不正です" };
      if (pinnedOwner !== undefined && r.device.sign !== pinnedOwner) return { ok: false, reason: "オーナーの鍵が、参加時に確かめたものと違います" };
      owner = r.device;
      members.set(r.device.id, r.device);
    } else {
      if (r.type === "root") return { ok: false, reason: "オーナーが2つあります" };
      if (!owner) return { ok: false, reason: "記録が不正です" };
      if (r.type === "add") {
        if (members.has(r.device.id)) return { ok: false, reason: "すでにいる端末が、再び追加されています" };
        members.set(r.device.id, r.device);
      } else {
        if (r.device.id === owner.id || !members.delete(r.device.id)) return { ok: false, reason: "外す対象が不正です" };
      }
    }
    // 署名は、必ずオーナー。別の鍵の署名は、別のオーナーがいるということ。
    if (!(await verify(owner!.sign, bodyOf(r), r.sig))) return { ok: false, reason: "オーナー以外の署名の記録があります（別のオーナーがいる可能性）" };
    prevHash = await recordHash(r);
  }
  return { ok: true, chain: { owner: owner!, members: [...members.values()], headVer: records.length, headHash: prevHash } };
}

/** 新しい記録を、今の鎖の次につなげられるか（中継と端末の両方が使う）。 */
export async function extendChain(records: MemberRecord[], next: MemberRecord, pinnedOwner?: string): Promise<ChainResult> {
  return verifyChain([...records, next], pinnedOwner);
}
