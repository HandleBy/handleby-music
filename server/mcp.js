// Minimal, dependency-free MCP server over stdio (JSON-RPC 2.0, one message per line),
// plus a tiny schema builder for tool inputs. Supports exactly what this plugin needs:
// initialize, ping, tools/list and tools/call.

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// ---------------------------------------------------------------------------
// Schema builder: z.string(), z.number(), z.boolean(), z.enum([...]), z.array(item)
// Each schema renders to JSON Schema and validates/normalizes incoming arguments.
// ---------------------------------------------------------------------------

class Schema {
  constructor(kind, extra = {}) {
    Object.assign(this, { kind, isOptional: false, defaultValue: undefined }, extra);
  }
  optional() { this.isOptional = true; return this; }
  default(v) { this.defaultValue = v; this.isOptional = true; return this; }
  describe(d) { this.description = d; return this; }
  min(n) { this.minValue = n; return this; }
  max(n) { this.maxValue = n; return this; }
  int() { this.integer = true; return this; }
  url() { this.format = "uri"; return this; }

  toJSONSchema() {
    const s = {};
    switch (this.kind) {
      case "string":
        s.type = "string";
        if (this.minValue !== undefined) s.minLength = this.minValue;
        if (this.maxValue !== undefined) s.maxLength = this.maxValue;
        if (this.format) s.format = this.format;
        break;
      case "number":
        s.type = this.integer ? "integer" : "number";
        if (this.minValue !== undefined) s.minimum = this.minValue;
        if (this.maxValue !== undefined) s.maximum = this.maxValue;
        break;
      case "boolean":
        s.type = "boolean";
        break;
      case "enum":
        s.type = "string";
        s.enum = this.values;
        break;
      case "array":
        s.type = "array";
        s.items = this.item.toJSONSchema();
        if (this.minValue !== undefined) s.minItems = this.minValue;
        if (this.maxValue !== undefined) s.maxItems = this.maxValue;
        break;
    }
    if (this.description) s.description = this.description;
    if (this.defaultValue !== undefined) s.default = this.defaultValue;
    return s;
  }

  parse(v, path) {
    if (v === undefined || v === null) {
      if (this.defaultValue !== undefined) return structuredClone(this.defaultValue);
      if (this.isOptional) return undefined;
      throw new Error(`${path} is required`);
    }
    switch (this.kind) {
      case "string":
        if (typeof v !== "string") throw new Error(`${path} must be a string`);
        if (this.minValue !== undefined && v.length < this.minValue) throw new Error(`${path} must be at least ${this.minValue} characters`);
        if (this.maxValue !== undefined && v.length > this.maxValue) throw new Error(`${path} must be at most ${this.maxValue} characters`);
        if (this.format === "uri") {
          try { new URL(v); } catch { throw new Error(`${path} must be a URL`); }
        }
        return v;
      case "number": {
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
        if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${path} must be a number`);
        if (this.integer && !Number.isInteger(n)) throw new Error(`${path} must be an integer`);
        if (this.minValue !== undefined && n < this.minValue) throw new Error(`${path} must be ≥ ${this.minValue}`);
        if (this.maxValue !== undefined && n > this.maxValue) throw new Error(`${path} must be ≤ ${this.maxValue}`);
        return n;
      }
      case "boolean":
        if (v === "true") return true;
        if (v === "false") return false;
        if (typeof v !== "boolean") throw new Error(`${path} must be true or false`);
        return v;
      case "enum":
        if (!this.values.includes(v)) throw new Error(`${path} must be one of: ${this.values.join(", ")}`);
        return v;
      case "array":
        if (!Array.isArray(v)) throw new Error(`${path} must be a list`);
        if (this.minValue !== undefined && v.length < this.minValue) throw new Error(`${path} needs at least ${this.minValue} item(s)`);
        if (this.maxValue !== undefined && v.length > this.maxValue) throw new Error(`${path} allows at most ${this.maxValue} items`);
        return v.map((x, i) => this.item.parse(x, `${path}[${i}]`));
    }
    return v;
  }
}

export const z = {
  string: () => new Schema("string"),
  number: () => new Schema("number"),
  boolean: () => new Schema("boolean"),
  enum: (values) => new Schema("enum", { values }),
  array: (item) => new Schema("array", { item }),
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class McpServer {
  constructor(info) {
    this.info = info;
    this.tools = new Map();
  }

  registerTool(name, { title, description, inputSchema = {}, annotations }, handler) {
    this.tools.set(name, { title, description, inputSchema, annotations, handler });
  }

  listTools() {
    return [...this.tools.entries()].map(([name, t]) => {
      const properties = {};
      const required = [];
      for (const [key, schema] of Object.entries(t.inputSchema)) {
        properties[key] = schema.toJSONSchema();
        if (!schema.isOptional) required.push(key);
      }
      const out = {
        name,
        title: t.title,
        description: t.description,
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
      };
      if (t.annotations) out.annotations = { title: t.title, ...t.annotations };
      return out;
    });
  }

  async callTool(name, args = {}) {
    const t = this.tools.get(name);
    if (!t) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    let parsed = {};
    try {
      for (const [key, schema] of Object.entries(t.inputSchema)) {
        const v = schema.parse(args[key], key);
        if (v !== undefined) parsed[key] = v;
      }
    } catch (e) {
      return { content: [{ type: "text", text: `Invalid arguments: ${e.message}` }], isError: true };
    }
    try {
      return await t.handler(parsed);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message || e}` }], isError: true };
    }
  }

  async handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      let result;
      switch (method) {
        case "initialize": {
          const requested = params?.protocolVersion;
          result = {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: this.info,
          };
          break;
        }
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools: this.listTools() };
          break;
        case "tools/call":
          result = await this.callTool(params?.name, params?.arguments || {});
          break;
        default:
          if (!isRequest) return null; // notifications such as notifications/initialized
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
      return isRequest ? { jsonrpc: "2.0", id, result } : null;
    } catch (e) {
      return isRequest ? { jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } } : null;
    }
  }

  connectStdio() {
    let buffer = "";
    const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          continue;
        }
        const batch = Array.isArray(msg) ? msg : [msg];
        for (const m of batch) {
          this.handle(m).then((reply) => reply && send(reply));
        }
      }
    });
    process.stdin.on("end", () => process.exit(0));
  }
}
