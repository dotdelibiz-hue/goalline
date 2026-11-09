// Node 向けコードを Deno で動かすための最小限の下準備
import { Buffer } from 'node:buffer';
import process from 'node:process';
globalThis.Buffer ??= Buffer;
globalThis.process ??= process;
