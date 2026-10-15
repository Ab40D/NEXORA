/**
 * Minimal Server-Sent Events parser for fetch() response streams.
 *
 * EventSource cannot send an Authorization header and gets no Local Network
 * Access mixed-content exemption, so the bridge event stream is consumed via
 * fetch() + ReadableStream instead.
 */

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;

  /** Feed a decoded text chunk; returns complete messages. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, idx);
      const sepLen = this.buffer.startsWith("\r\n", idx) ? 2 : 1;
      this.buffer = this.buffer.slice(idx + sepLen);
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    if (this.buffer.length > 1_000_000) {
      // protect against a misbehaving server
      this.buffer = "";
      this.reset();
    }
    return out;
  }

  private reset(): void {
    this.event = "";
    this.data = [];
    this.id = undefined;
  }

  private line(line: string): SseMessage | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.reset();
        return null;
      }
      const msg: SseMessage = { event: this.event || "message", data: this.data.join("\n") };
      if (this.id !== undefined) msg.id = this.id;
      this.reset();
      return msg;
    }
    if (line.startsWith(":")) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id") this.id = value;
    return null;
  }
}
