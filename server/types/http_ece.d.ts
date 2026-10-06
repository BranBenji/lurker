// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Minimal ambient declaration for the `http_ece` npm package (RFC 8188/8291),
// which web-push encrypts with. Only the aes128gcm options the relay vectors
// use are declared.
declare module 'http_ece' {
  import type { ECDH } from 'node:crypto';

  interface Aes128gcmParams {
    version: 'aes128gcm';
    privateKey: ECDH;
    authSecret: string;
    /** Receiver public key, base64url; needed to encrypt. */
    dh?: string;
    salt?: string;
  }

  const ece: {
    encrypt(plaintext: Buffer, params: Aes128gcmParams): Buffer;
    decrypt(body: Buffer, params: Aes128gcmParams): Buffer;
  };
  export default ece;
}
