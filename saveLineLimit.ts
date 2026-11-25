// The largest line a graph-format POST /jinaga/save may carry, in bytes.
//
// The graph format puts one value on each line: a fact's type, its predecessor
// indexes, its fields, a public key, or a signature. A fact's fields are the
// only line whose size an application controls, so in practice this is the
// largest fact the replicator will accept.
//
// The replicator defaults to 1 MiB, rather than the 16 MiB jinaga-server
// defaults to, because:
//
//   * Facts are meant to be small. They are replicated to every node and client
//     that a distribution rule shares them with, and they are immutable, so
//     large content belongs in a content store, with only its hash in a fact.
//     That is how the Jinaga applications in this ecosystem store images.
//   * A request over 1 MB is already refused by nginx's default
//     client_max_body_size, the most common reverse proxy in front of a
//     replicator, and jinaga's web client sizes its save batches (256 KiB) to
//     stay under that same 1 MB. A fact that cannot pass through such a proxy
//     gains nothing from a larger limit here.
//   * The limit bounds the memory a single request can pin before the request
//     is refused. That memory grows with the limit, and a replicator may accept
//     anonymous saves, so a smaller bound is a smaller exposure.
//
// A deployment that does store larger facts raises the limit with
// JINAGA_MAX_SAVE_LINE_BYTES. Every replicator in a mesh should use the same
// value: a fact one node accepts and another refuses can never be pushed
// upstream, and stays queued on the node that accepted it.
export const defaultMaxSaveLineBytes = 1024 * 1024;

// Reads JINAGA_MAX_SAVE_LINE_BYTES. Unset or empty means the default, because a
// container that declares the variable without a value supplies an empty
// string. Anything other than a whole number of bytes, at least 1, is refused
// rather than guessed at, so the replicator never serves with a limit nobody
// chose.
export function readMaxSaveLineBytes(value: string | undefined = process.env.JINAGA_MAX_SAVE_LINE_BYTES): number {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return defaultMaxSaveLineBytes;
  }
  const bytes = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error(`The environment variable JINAGA_MAX_SAVE_LINE_BYTES is set to ${JSON.stringify(value)}, which is not a whole number of bytes of at least 1. The default is ${defaultMaxSaveLineBytes} (1 MiB).`);
  }
  return bytes;
}
