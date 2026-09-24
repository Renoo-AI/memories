import { POW_WASM_BASE64 } from "./pow-wasm-base64.js";
import { cleanToken } from "./token-utils.js";

let wasmModuleInstance = null;

async function getWasmInstance() {
  if (wasmModuleInstance) return wasmModuleInstance;

  let bytes = null;

  // Try loading from extension URL first if available
  const getUrlFn =
    (typeof browser !== "undefined" && browser?.runtime?.getURL) ||
    (typeof chrome !== "undefined" && chrome?.runtime?.getURL);
  if (getUrlFn) {
    try {
      const url = getUrlFn("lib/pow_solver.wasm");
      const resp = await fetch(url);
      if (resp.ok) {
        bytes = await resp.arrayBuffer();
      }
    } catch {
      // fallback to embedded base64
    }
  }

  // Fallback to embedded base64 bytes
  if (!bytes) {
    if (typeof Buffer !== "undefined") {
      bytes = Buffer.from(POW_WASM_BASE64, "base64");
    } else {
      const bin = atob(POW_WASM_BASE64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
    }
  }

  const { instance } = await WebAssembly.instantiate(bytes, {});
  wasmModuleInstance = instance;
  return instance;
}

export async function solvePow(challenge, salt, expireAt, difficulty) {
  const instance = await getWasmInstance();
  const {
    memory,
    __wbindgen_export_0: malloc,
    __wbindgen_add_to_stack_pointer: stack,
    wasm_solve: solve,
  } = instance.exports;

  function writeString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const ptr = malloc(data.length, 1);
    const targetPtr = typeof ptr === "object" ? ptr[0] : ptr;
    new Uint8Array(memory.buffer).set(data, targetPtr);
    return [targetPtr, data.length];
  }

  try {
    const [cPtr, cLen] = writeString(challenge);
    const [pPtr, pLen] = writeString(`${salt}_${expireAt}_`);
    const sp = stack(-16);
    solve(sp, cPtr, cLen, pPtr, pLen, Number(difficulty));
    const view = new DataView(memory.buffer);
    const rc = view.getInt32(sp, true);
    const ans = view.getFloat64(sp + 8, true);
    stack(16);
    return rc === 0 ? null : ans;
  } catch (err) {
    console.error("solvePow error:", err);
    return null;
  }
}

export async function getPowHeader(rawToken, targetPath = "/api/v0/chat/completion") {
  const dsToken = cleanToken(rawToken);
  const headers = {
    "Content-Type": "application/json",
    "X-App-Version": "20241129.1",
  };
  if (dsToken) {
    headers["Authorization"] = `Bearer ${dsToken}`;
  }

  const resp = await fetch("https://chat.deepseek.com/api/v0/chat/create_pow_challenge", {
    method: "POST",
    headers,
    body: JSON.stringify({ target_path: targetPath }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`create_pow_challenge error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const resJson = await resp.json();
  const challenge = resJson?.data?.biz_data?.challenge;
  if (!challenge) {
    throw new Error(`No challenge returned: ${JSON.stringify(resJson)}`);
  }

  const answer = await solvePow(
    challenge.challenge,
    challenge.salt,
    challenge.expire_at,
    challenge.difficulty
  );

  if (answer === null) {
    throw new Error("Failed to solve DeepSeek PoW challenge");
  }

  const powPayload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer: Math.floor(answer),
    signature: challenge.signature,
    target_path: targetPath,
  };

  const jsonStr = JSON.stringify(powPayload);
  let b64 = "";
  if (typeof Buffer !== "undefined") {
    b64 = Buffer.from(jsonStr).toString("base64");
  } else {
    b64 = btoa(jsonStr);
  }

  return { "X-DS-PoW-Response": b64 };
}
