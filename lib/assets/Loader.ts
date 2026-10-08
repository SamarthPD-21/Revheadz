/**
 * Fetches and decodes a vehicle's sounds. Raw bytes are fetched as soon as the
 * drive page mounts (no AudioContext needed); decoding happens after the ignition
 * tap creates the context.
 */
const bytes = new Map<string, Promise<ArrayBuffer>>();

let preferred: "ogg" | "mp3" | null = null;
function preferredExt(): "ogg" | "mp3" {
  if (preferred) return preferred;
  const probe = typeof document !== "undefined" ? document.createElement("audio") : null;
  preferred = probe && probe.canPlayType('audio/ogg; codecs="vorbis"') ? "ogg" : "mp3";
  return preferred;
}

const withExt = (url: string, ext: "ogg" | "mp3") => url.replace(/\.(ogg|mp3)$/, `.${ext}`);

function fetchBytes(url: string): Promise<ArrayBuffer> {
  let p = bytes.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.arrayBuffer();
    });
    p.catch(() => bytes.delete(url)); // allow retry
    bytes.set(url, p);
  }
  return p;
}

export function prefetch(urls: readonly string[]): Promise<unknown> {
  const ext = preferredExt();
  return Promise.all(urls.map((u) => fetchBytes(withExt(u, ext))));
}

async function decodeOne(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const first = preferredExt();
  const order: ("ogg" | "mp3")[] = first === "ogg" ? ["ogg", "mp3"] : ["mp3", "ogg"];
  let lastError: unknown;
  for (const ext of order) {
    try {
      const data = await fetchBytes(withExt(url, ext));
      return await ctx.decodeAudioData(data.slice(0)); // slice: decode detaches its input
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/** Decodes all urls (de-duplicated). Throws if any file cannot be loaded. */
export async function decodeAll(ctx: BaseAudioContext, urls: readonly string[]): Promise<Map<string, AudioBuffer>> {
  const unique = [...new Set(urls)];
  const buffers = await Promise.all(unique.map((u) => decodeOne(ctx, u)));
  return new Map(unique.map((u, i) => [u, buffers[i]]));
}
